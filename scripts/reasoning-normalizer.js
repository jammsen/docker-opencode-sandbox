#!/usr/bin/env node
// reasoning-normalizer — response-rewriting reverse proxy between LiteLLM and vLLM.
//
// Why this exists:
//   deepseek-v4-flash emits a chunk carrying BOTH delta.reasoning and delta.content — the last
//   reasoning token and the first answer token in a single delta — and no boundary event between
//   reasoning and content (openclaw#95280). LiteLLM then disagrees with itself: it picks the block
//   type from the raw chunk (sees content -> opens a text block) but translates the delta
//   separately (sees reasoning -> emits a thinking_delta). The thinking delta lands in a text block
//   and Claude Code's SDK aborts the turn with "Content block is not a thinking block".
//
//   Splitting that chunk in two (reasoning-only, then content-only) makes deepseek look like
//   qwen3.6-35b, which never bundles the two and which every gateway already handles correctly.
//   Measured: 0/20 failures vs 3-6/10 without, with thinking still intact. See
//   ideas/done/deepseek-thinking-block-bug.md.
//
//   Everything else — non-SSE responses, other paths, all requests — is proxied verbatim.
//
// Second job — model ROUTER for the catalog (config/models/models.yml, see
//   ideas/done/model-catalog.md): LiteLLM sends every request here with the alias the tool
//   asked for; we resolve it against models.json (rendered from the yaml by the sandbox) to a real
//   model id + server URL, rewrite `model`, and forward. This is what lets the wizard change
//   servers/roles without restarting anything: the file is re-read whenever its mtime changes.
//   Aliases: brain/opus/fable/claude-* -> roles.brain, vision/sonnet/haiku -> roles.vision,
//   "<server>/<id>" explicit, "<id>" when exactly one server serves it. Unknown -> 404 JSON.
//   Without MODELS_FILE (or while it doesn't exist yet) it behaves as before: single VLLM_UPSTREAM.
//
// Pure Node stdlib (no deps), matching claude-shim.js. Listens on 0.0.0.0:NORMALIZER_PORT and
// forwards to the resolved server (or VLLM_UPSTREAM).

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = parseInt(process.env.NORMALIZER_PORT || '4002', 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '600000', 10); // LLM inference is slow
const UPSTREAM = new URL(process.env.VLLM_UPSTREAM || 'http://127.0.0.1:8000');
const MODELS_FILE = process.env.MODELS_FILE || '';   // e.g. /config/models/models.json; empty = legacy single upstream
const fs = require('fs');

// --- catalog (models.json) — re-read on mtime change, never crashes the proxy on a bad file -----
const BRAIN_ALIASES  = new Set(['brain', 'opus', 'fable']);   // plus any 'claude-*' id (compat), see resolve()
const VISION_ALIASES = new Set(['vision', 'sonnet', 'haiku']);
let catalog = null, catalogMtime = 0, catalogWarned = false;
function loadCatalog() {
  if (!MODELS_FILE) return null;
  let st;
  try { st = fs.statSync(MODELS_FILE); } catch { catalog = null; return null; }
  if (st.mtimeMs === catalogMtime && catalog) return catalog;
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const servers = {}, roles = raw.roles || {};
    const byId = {};                                    // id -> [server, ...]
    for (const [srv, def] of Object.entries(raw.servers || {})) {
      let url;                                          // parse once here: a bad url in a hand-edited yaml must not throw per request
      try { url = new URL(def.url); } catch { console.error(`> catalog: server '${srv}' has an invalid url (${def.url}) — skipped`); continue; }
      servers[srv] = { url, models: def.models || {} };
      for (const id of Object.keys(def.models || {})) (byId[id] ||= []).push(srv);
    }
    catalog = { servers, roles, byId }; catalogMtime = st.mtimeMs; catalogWarned = false;
    console.log(`> catalog loaded: ${Object.keys(servers).length} server(s), ${Object.keys(byId).length} model id(s), brain=${roles.brain} vision=${roles.vision}`);
  } catch (e) {
    if (!catalogWarned) { console.error(`> catalog unreadable (${e.message}) — keeping previous / legacy upstream`); catalogWarned = true; }
  }
  return catalog;
}
// resolve(alias) -> { id, url } | null. `server/id` wins over a bare id that happens to contain '/'.
function resolve(alias, cat) {
  if (!cat || typeof alias !== 'string') return null;
  const ref = (BRAIN_ALIASES.has(alias) || alias.startsWith('claude-')) ? cat.roles.brain
            : VISION_ALIASES.has(alias) ? (cat.roles.vision || cat.roles.brain)   // vision is optional: brain answers
            : alias;
  if (!ref) return null;
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const srv = ref.slice(0, slash), id = ref.slice(slash + 1);
    if (cat.servers[srv]?.models?.[id]) return { id, url: cat.servers[srv].url };
  }
  const owners = cat.byId[ref] || [];
  if (owners.length === 1) return { id: ref, url: cat.servers[owners[0]].url };
  return null;                                          // unknown, or ambiguous (needs server/id)
}
// LiteLLM's api_base ends in /v1 and so does every catalog url: join "<url path>" + req.url minus "/v1".
function targetPath(base, reqUrl) {
  const p = reqUrl.startsWith('/v1/') ? reqUrl.slice(3) : reqUrl;
  return base.pathname.replace(/\/$/, '') + p;
}

// Split one `data: {...}` line into reasoning-only + content-only lines when it carries both.
// Returns null when the line needs no rewrite, so the common path forwards bytes untouched.
function splitDualDelta(line) {
  const payload = line.startsWith('data: ') ? line.slice(6).trim() : null;
  if (!payload || payload === '[DONE]') return null;

  let parsed;
  try { parsed = JSON.parse(payload); } catch { return null; }
  const delta = parsed?.choices?.[0]?.delta;
  if (!delta || !delta.reasoning || !delta.content) return null;

  const reasoningOnly = JSON.parse(payload);
  const contentOnly = JSON.parse(payload);
  delete reasoningOnly.choices[0].delta.content;
  // finish_reason belongs with the content half — the reasoning half is not the end of the turn.
  reasoningOnly.choices[0].finish_reason = null;
  delete contentOnly.choices[0].delta.reasoning;
  return `data: ${JSON.stringify(reasoningOnly)}\ndata: ${JSON.stringify(contentOnly)}\n`;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let target = UPSTREAM, path = req.url;

    // Catalog routing: rewrite `model` and pick the server. Only JSON bodies with a model field.
    const cat = loadCatalog();
    if (cat) {
      let parsed = null;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* not JSON — forward as-is */ }
      if (parsed && typeof parsed.model === 'string') {
        const hit = resolve(parsed.model, cat);
        if (!hit) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'unknown_model',
            message: `model '${parsed.model}' is not in the catalog (config/models/models.yml) — run the model configuration` } }));
          return;
        }
        if (parsed.model !== hit.id) { parsed.model = hit.id; body = Buffer.from(JSON.stringify(parsed)); }
        target = hit.url; path = targetPath(hit.url, req.url);
      }
    }

    const headers = { ...req.headers, host: target.host, 'content-length': String(body.length) };
    delete headers['transfer-encoding'];

    const transport = target.protocol === 'https:' ? https : http;
    const defaultPort = target.protocol === 'https:' ? 443 : 80;
    let timedOut = false;

    const upstreamReq = transport.request(
      {
        hostname: target.hostname,
        port: parseInt(target.port || defaultPort, 10),
        method: req.method,
        path,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);

        // Only SSE needs line-wise inspection; anything else streams through untouched.
        if (!String(upstreamRes.headers['content-type'] || '').includes('text/event-stream')) {
          upstreamRes.pipe(res);
          return;
        }

        let buf = '';
        upstreamRes.setEncoding('utf8');
        upstreamRes.on('data', (d) => {
          buf += d;
          let nl;
          // SSE lines can span chunk boundaries — only process complete lines.
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            res.write(splitDualDelta(line) ?? `${line}\n`);
          }
        });
        upstreamRes.on('end', () => { if (buf) res.write(buf); res.end(); });
      }
    );

    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => { timedOut = true; upstreamReq.destroy(); });
    upstreamReq.on('error', (err) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          type: timedOut ? 'normalizer_upstream_timeout' : 'normalizer_upstream_error',
          message: timedOut ? `upstream did not respond within ${UPSTREAM_TIMEOUT_MS}ms` : String(err),
        },
      }));
    });

    if (body.length) upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const mode = MODELS_FILE ? `routing by catalog ${MODELS_FILE} (fallback ${UPSTREAM.origin})` : `→ ${UPSTREAM.origin}`;
  console.log(`> reasoning-normalizer listening on 0.0.0.0:${PORT} ${mode} (splitting dual reasoning+content deltas)`);
  loadCatalog();
});
