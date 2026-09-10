#!/usr/bin/env node
// claude-shim — request-rewriting reverse proxy between Claude Code and LiteLLM.
//
// Why this exists:
//   Claude Code's Read tool delivers images as Anthropic `tool_result` blocks. When LiteLLM
//   translates an Anthropic /v1/messages request to the OpenAI chat/completions format that
//   vLLM speaks, it DROPS images nested inside tool_result blocks (OpenAI tool-role messages
//   cannot carry images). The model then receives an empty tool result and hallucinates.
//
//   This shim rewrites each request before LiteLLM sees it: any image inside a tool_result is
//   lifted out into a fresh user message (a placement vLLM handles correctly), with a text
//   placeholder left in the tool_result so the tool-call/result pairing stays valid. Everything
//   else — including streaming SSE responses and all non-/v1/messages paths — is proxied verbatim.
//
//   Second job (dual-model setups): when the brain is text-only (catalog: brain model has
//   vision=false), a request whose NEWEST message carries an image is rerouted to the `vision`
//   alias so a text-only brain never hallucinates over pixels. Brain/vision come from the model
//   catalog (~/.config/agentic-harness-native/models.json, written by setup.sh) and are re-read
//   whenever that file changes — no restart needed. Env MODEL_VISION/MODEL_ID/VISION_MODEL_ID
//   remain the fallback when there is no catalog.
//   Images that only sit in OLDER turns don't hijack the routing: the user's model choice is
//   kept and the stale image blocks are replaced with text placeholders — the vision model's
//   earlier textual analysis is already in the history, which is what the brain works from.
//   Requests already addressed to `vision` pass through untouched.
//
//   Third job — catalog alias resolution and multi-server dispatch. This client owns the model
//   catalog (the server never sees it — see ../server/scripts/reasoning-normalizer.js's
//   header). Before forwarding, any alias (opus/sonnet/haiku/fable/brain/vision, or a raw catalog
//   id) is resolved against the catalog to the real served model id (ported from
//   reasoning-normalizer.js's resolve(), since the server no longer does this). A catalog server
//   marked `anthropic: true` is dispatched to directly instead of the default LITELLM_UPSTREAM —
//   see resolveDispatch() below for why that flag is what makes mixing servers actually work
//   without reimplementing Anthropic<->OpenAI translation here.
//
// Pure Node stdlib (no deps). Listens on 127.0.0.1:SHIM_PORT and forwards to LITELLM_UPSTREAM —
// this is the native-client copy (see ../native-client/README.md and setup.sh); run standalone
// with plain `node claude-shim.js`, no Docker required. Identical logic to ../client/scripts/
// claude-shim.js, kept as a separate file since the two pieces are meant to stay independently
// runnable — this one is for someone who already runs Claude Code natively and just wants to
// point it at a server (../server/) without adopting the sandbox container.

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const SHIM_PORT          = parseInt(process.env.CLAUDE_SHIM_PORT    || '4001',   10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '600000', 10); // 10 min — LLM inference is slow
const UPSTREAM = new URL(process.env.LITELLM_UPSTREAM || (() => { throw new Error('LITELLM_UPSTREAM not set — run setup.sh first, or export it yourself'); })());

// Vision fallback config — routing rules are described under "Second job" above.
const VISION_MODEL_ALIAS = process.env.VISION_MODEL_ALIAS || 'vision';
const MODELS_FILE = process.env.MODELS_FILE || `${process.env.HOME || process.env.USERPROFILE || '.'}/.config/agentic-harness-native/models.json`;
const fs = require('fs');

// Model-class slots Claude Code sends (mapped in config/claude/settings.json).
// VISION_SIDE = aliases the reasoning-normalizer resolves to roles.vision (must match its
// VISION_ALIASES). Requests to these may carry images even when the brain is text-only.
const CLASS_SLOTS  = new Set(['haiku', 'sonnet', 'opus', 'fable']);
const VISION_SIDE  = new Set([VISION_MODEL_ALIAS, 'haiku', 'sonnet']);

// cfg() -> { primaryHasVision, brainId, visionId }: from the catalog when present (cached by
// mtime), else from env (legacy single-model contract).
let cfgCache = null, cfgMtime = -1;
function cfg() {
  let st = null;
  try { st = fs.statSync(MODELS_FILE); } catch { /* no catalog */ }
  if (!st) {
    if (cfgMtime !== 0) {
      cfgMtime = 0;
      cfgCache = {
        primaryHasVision: String(process.env.MODEL_VISION || 'true').toLowerCase() !== 'false',
        visionHasVision: true,   // legacy contract: the vision entry is assumed capable
        brainId: process.env.MODEL_ID || 'brain',
        visionId: process.env.VISION_MODEL_ID || process.env.MODEL_ID || 'vision',
      };
    }
    return cfgCache;
  }
  if (st.mtimeMs === cfgMtime && cfgCache) return cfgCache;
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const ref = (r) => { const s = String(r || ''); const i = s.indexOf('/'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : ['', s]; };
    const [bs, bid] = ref(raw.roles?.brain), [, vid] = ref(raw.roles?.vision);
    const brainDef = raw.servers?.[bs]?.models?.[bid] || {};
    const [vs] = ref(raw.roles?.vision);
    const visionDef = raw.servers?.[vs]?.models?.[vid] || {};
    cfgCache = { primaryHasVision: brainDef.vision === true, visionHasVision: visionDef.vision === true,
                 brainId: bid || 'brain', visionId: vid || bid || 'vision' };   // no vision role -> brain answers
    cfgMtime = st.mtimeMs;
    console.log(`> catalog: brain=${cfgCache.brainId} (vision=${cfgCache.primaryHasVision}) vision=${cfgCache.visionId}`);
  } catch (e) {
    console.error(`> catalog unreadable (${e.message}) — keeping previous routing`);
    if (!cfgCache) cfgCache = { primaryHasVision: true, visionHasVision: true, brainId: 'brain', visionId: 'vision' }; // never null: a first bad read must not throw per request
  }
  return cfgCache;
}
const backendFor = (model, c) => VISION_SIDE.has(model)
  ? { id: c.visionId, side: 'vision' }
  : { id: c.brainId,  side: 'brain'  };

// --- catalog alias resolution (ported from ../server/scripts/reasoning-normalizer.js's
// resolve(), which no longer runs server-side) — full servers/roles/byId parse, separate from the
// brain/vision-only cfg() above which only needs ids + vision flags for the reroute decision.
//
// Dispatch: a catalog server is normally just a source of model ids the SINGLE configured
// LITELLM_UPSTREAM is expected to serve (the common case — one server, added here so its models
// are known and its roles assignable). A server marked `anthropic: true` is different: its `url`
// is itself a full Anthropic-speaking gateway (e.g. another ../server/ instance pointed at a
// different vLLM box, run by this user or someone else) — requests for its models are forwarded
// there directly instead of through LITELLM_UPSTREAM. This is what makes "mix my server's brain
// model with my own locally-hosted model" work without reimplementing Anthropic<->OpenAI
// translation here: the other stack's own litellm does that translation, same as ours does for
// LITELLM_UPSTREAM. A plain (non-anthropic) server whose url isn't actually reachable from
// LITELLM_UPSTREAM will just fail loudly there — no fallback.
const BRAIN_ALIASES  = new Set(['brain', 'opus', 'fable']);
const VISION_ALIASES = new Set(['vision', 'sonnet', 'haiku']);
let catalog = null, catalogMtime = 0;
function loadCatalog() {
  let st;
  try { st = fs.statSync(MODELS_FILE); } catch { catalog = null; return null; }
  if (st.mtimeMs === catalogMtime && catalog) return catalog;
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const servers = {}, roles = raw.roles || {}, byId = {};
    for (const [srv, def] of Object.entries(raw.servers || {})) {
      let url = null;
      try { url = new URL(def.url); } catch { /* only needed for anthropic:true dispatch, below */ }
      servers[srv] = { url, anthropic: def.anthropic === true, models: def.models || {} };
      for (const id of Object.keys(def.models || {})) (byId[id] ||= []).push(srv);
    }
    catalog = { servers, roles, byId }; catalogMtime = st.mtimeMs;
  } catch { /* keep previous catalog; cfg() above already logs/handles unreadable files */ }
  return catalog;
}
// Same "/v1/..." join reasoning-normalizer.js's targetPath() uses: catalog server urls end in
// /v1 by wizard convention; join the base's own path with whatever follows /v1 in the request.
function targetPath(base, reqUrl) {
  const p = reqUrl.startsWith('/v1/') ? reqUrl.slice(3) : reqUrl;
  return base.pathname.replace(/\/$/, '') + p;
}
// resolveDispatch(alias) -> { id, target }. id = real served model id (or the alias unchanged if
// it can't be resolved — an unresolvable id is forwarded as-is so the upstream's own error
// explains the problem, no silent fallback). target = a URL to dispatch directly to (server marked
// anthropic:true), or null to use the default LITELLM_UPSTREAM.
function resolveDispatch(alias) {
  const cat = loadCatalog();
  if (!cat || typeof alias !== 'string') return { id: alias, target: null };
  const ref = (BRAIN_ALIASES.has(alias) || alias.startsWith('claude-')) ? cat.roles.brain
            : VISION_ALIASES.has(alias) ? (cat.roles.vision || cat.roles.brain)
            : alias;
  if (!ref) return { id: alias, target: null };
  let srv, id;
  const slash = ref.indexOf('/');
  if (slash > 0 && cat.servers[ref.slice(0, slash)]?.models?.[ref.slice(slash + 1)]) {
    srv = ref.slice(0, slash); id = ref.slice(slash + 1);
  } else {
    // Ambiguous (served by >1 server, needs "server/id") or genuinely unknown: forward the alias
    // unchanged rather than guess — the upstream's own error explains it.
    const owners = cat.byId[ref] || [];
    if (owners.length !== 1) return { id: alias, target: null };
    srv = owners[0]; id = ref;
  }
  const def = cat.servers[srv];
  return { id, target: (def.anthropic && def.url) ? def.url : null };
}

// --- the rewrite ---------------------------------------------------------
// Walk messages; for every user message, pull image blocks out of tool_result blocks and append
// them in a new user message right after. Returns true if anything changed.
function hoistToolResultImages(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  let changed = false;
  const out = [];
  for (const msg of body.messages) {
    out.push(msg);
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const hoisted = [];
    for (const block of msg.content) {
      if (block && block.type === 'tool_result' && Array.isArray(block.content)) {
        const kept = [];
        for (const sub of block.content) {
          if (sub && sub.type === 'image') {
            hoisted.push(sub);
            kept.push({ type: 'text', text: '[image returned by tool — provided in the next message]' });
            changed = true;
          } else {
            kept.push(sub);
          }
        }
        block.content = kept;
      }
    }
    if (hoisted.length) {
      out.push({
        role: 'user',
        content: [{ type: 'text', text: 'Image(s) returned by the tool call above:' }, ...hoisted],
      });
    }
  }
  if (changed) body.messages = out;
  return changed;
}

// True if one message carries an image block — top-level in a user message or
// nested inside a tool_result. Checked after hoisting, but written to be
// position-independent so it stays correct either way.
function messageHasImage(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  for (const block of msg.content) {
    if (!block) continue;
    if (block.type === 'image') return true;
    if (block.type === 'tool_result' && Array.isArray(block.content)
        && block.content.some((sub) => sub && sub.type === 'image')) return true;
  }
  return false;
}

function containsImages(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  return body.messages.some(messageHasImage);
}

// Replace every image block with a text placeholder the text-only primary can
// accept. Returns the number of blocks replaced.
const STRIPPED_IMAGE_NOTE =
  '[image removed — the current model is text-only; the image was analyzed earlier in this conversation]';
const NO_VISION_NOTE =
  '[image removed — no vision-capable model is configured in the model catalog, so this image could not be delivered; tell the user]';
function stripImages(body, text = STRIPPED_IMAGE_NOTE) {
  let stripped = 0;
  const placeholder = () => { stripped++; return { type: 'text', text }; };
  for (const msg of body.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    msg.content = msg.content.map((block) => {
      if (block && block.type === 'image') return placeholder();
      if (block && block.type === 'tool_result' && Array.isArray(block.content)) {
        block.content = block.content.map((sub) => (sub && sub.type === 'image') ? placeholder() : sub);
      }
      return block;
    });
  }
  return stripped;
}

// Apply only to JSON requests that carry a `messages` array (/v1/messages and its count_tokens
// variant). Returns { buf, target }: buf is a Buffer to forward or null to forward the original
// bytes unchanged; target is a URL to dispatch directly to (see resolveDispatch above) or null to
// use the default LITELLM_UPSTREAM.
function maybeRewrite(pathname, raw) {
  if (!pathname.startsWith('/v1/messages')) return { buf: null, target: null };
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { buf: null, target: null }; }
  let changed = hoistToolResultImages(body);
  const requested = body.model; // reroute below may rename it — log the original class
  let note = '';
  const c = cfg();
  if (!c.primaryHasVision
      && typeof body.model === 'string' && !VISION_SIDE.has(body.model)) {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!c.visionHasVision && containsImages(body)) {
      // Nobody can see: the vision role is text-only too (a text-only-only catalog is allowed).
      // Rerouting would just hit a 400 at vLLM; strip instead so the model can SAY so.
      const stripped = stripImages(body, NO_VISION_NOTE);
      changed = true;
      note = ` — ${stripped} image block(s) dropped: no vision-capable model in the catalog`;
    } else if (messageHasImage(msgs[msgs.length - 1])) {
      // Fresh image in the newest turn — this request is about the image.
      // (Hoisting places a tool_result image into an appended user message,
      // so a just-read image is the last message either way.)
      note = ' — image in newest turn, rerouted to vision';
      body.model = VISION_MODEL_ALIAS;
      changed = true;
    } else if (containsImages(body)) {
      // Images only in older turns: keep the chosen model, drop the stale
      // pixels it cannot accept.
      const stripped = stripImages(body);
      if (stripped) {
        changed = true;
        note = ` — ${stripped} stale image block(s) stripped`;
      }
    }
  }
  // Resolve the final alias to a real served model id (and, for a server marked anthropic:true,
  // a direct dispatch target) — the server no longer does this (see the "Third job" note above).
  let target = null;
  if (typeof body.model === 'string') {
    const resolved = resolveDispatch(body.model);
    if (resolved.id !== body.model) { body.model = resolved.id; changed = true; }
    target = resolved.target;
  }
  // One line per completion request; the noisy count_tokens variant is skipped.
  // Colors match includes/colors.sh: INFO \e[38;5;68m, WARNING \e[93m.
  if (pathname === '/v1/messages' && typeof requested === 'string') {
    const cls = CLASS_SLOTS.has(requested) ? `${requested}-class` : `'${requested}'`;
    const { id, side } = backendFor(body.model, c);
    const warn = note ? `\x1b[93m${note}\x1b[0m` : '';
    const via = target ? ` via ${target.host}` : '';
    console.log(`\x1b[38;5;68m> Req: ${cls} called — routing to ${id} (${side})${via}\x1b[0m${warn}`);
  }
  return { buf: changed ? Buffer.from(JSON.stringify(body), 'utf8') : null, target };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const pathname = req.url.split('?')[0];
    const { buf, target } = (req.method === 'POST') ? maybeRewrite(pathname, raw) : { buf: null, target: null };
    const outBody = buf || raw;
    // target set (a catalog server marked anthropic:true) -> dispatch there directly, joining
    // paths the same way reasoning-normalizer.js does for its OpenAI targets (targetPath above).
    // Otherwise -> the default LITELLM_UPSTREAM, forwarding the request path unchanged as always.
    const base = target || UPSTREAM;
    const path = target ? targetPath(target, req.url) : req.url;

    const headers = { ...req.headers, host: base.host };
    if (outBody.length || req.method === 'POST') headers['content-length'] = Buffer.byteLength(outBody);
    delete headers['transfer-encoding'];

    const transport = base.protocol === 'https:' ? https : http;
    const defaultPort = base.protocol === 'https:' ? 443 : 80;
    let timedOut = false;
    const upstreamReq = transport.request(
      {
        hostname: base.hostname,
        port:     parseInt(base.port || defaultPort, 10),
        method:   req.method,
        path,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res); // streams SSE transparently
      }
    );
    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      timedOut = true;
      upstreamReq.destroy();
    });
    upstreamReq.on('error', (err) => {
      if (res.headersSent) { res.end(); return; }
      if (timedOut) {
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'shim_upstream_timeout', message: `upstream did not respond within ${UPSTREAM_TIMEOUT_MS}ms` } }));
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'shim_upstream_error', message: String(err) } }));
      }
    });
    if (outBody.length) upstreamReq.write(outBody);
    upstreamReq.end();
  });
});

server.listen(SHIM_PORT, '127.0.0.1', () => {
  const c = cfg();
  const routing = c.primaryHasVision ? '' : `, routing image requests to '${VISION_MODEL_ALIAS}'`;
  console.log(`> claude-shim listening on 127.0.0.1:${SHIM_PORT} → ${UPSTREAM.origin} (hoisting tool_result images${routing}; catalog ${MODELS_FILE})`);
});
