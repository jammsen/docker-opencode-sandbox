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
//   catalog (~/.config/models/models.json, written by the model-config wizard) and are re-read
//   whenever that file changes — no restart needed. Env MODEL_VISION/MODEL_ID/VISION_MODEL_ID
//   remain the fallback when there is no catalog.
//   Images that only sit in OLDER turns don't hijack the routing: the user's model choice is
//   kept and the stale image blocks are replaced with text placeholders — the vision model's
//   earlier textual analysis is already in the history, which is what the brain works from.
//   Requests already addressed to `vision` pass through untouched.
//
//   Third job — catalog alias resolution and multi-server dispatch. This client owns the model
//   catalog (the server never sees it — see ../../server/scripts/reasoning-normalizer.js's
//   header). Before forwarding, any alias (opus/sonnet/haiku/fable/brain/vision, or a raw catalog
//   id) is resolved against the catalog to the real served model id (ported from
//   reasoning-normalizer.js's resolve(), since the server no longer does this). EVERY resolved
//   catalog entry is dispatched to directly, at its own URL — never silently funneled through
//   LITELLM_UPSTREAM. A server marked `anthropic: true` already speaks Anthropic's wire format
//   (another server/litellm instance), so its bytes go through untouched; any other server is a
//   plain OpenAI-compatible endpoint (raw vLLM/llama.cpp/SGLang), so this shim translates
//   Anthropic <-> OpenAI itself before/after talking to it — see anthropicToOpenAI() /
//   openAIJsonToAnthropic() / streamOpenAIToAnthropic() below. Only when NO catalog exists yet
//   (bootstrap) does anything fall back to the default LITELLM_UPSTREAM.
//
// Pure Node stdlib (no deps), matching upload-server.js. Listens on 127.0.0.1:SHIM_PORT and
// forwards to LITELLM_UPSTREAM (default http://agentic-litellm:4000).

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const SHIM_PORT          = parseInt(process.env.CLAUDE_SHIM_PORT    || '4001',   10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '600000', 10); // 10 min — LLM inference is slow
const UPSTREAM = new URL(process.env.LITELLM_UPSTREAM || 'http://agentic-litellm:4000');

// Vision fallback config — routing rules are described under "Second job" above.
const VISION_MODEL_ALIAS = process.env.VISION_MODEL_ALIAS || 'vision';
const MODELS_FILE = process.env.MODELS_FILE || `${process.env.HOME || '/home/agent'}/.config/models/models.json`;
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

// --- catalog alias resolution (ported from ../../server/scripts/reasoning-normalizer.js's
// resolve(), which no longer runs server-side) — full servers/roles/byId parse, separate from the
// brain/vision-only cfg() above which only needs ids + vision flags for the reroute decision.
//
// Dispatch: every catalog server is reached directly, at its own url — full stop, that is the
// point of adding it. `anthropic: true` only changes HOW the bytes are handled once we're
// dispatching there: true means the url already speaks Anthropic's wire format (another
// server/litellm instance, run by this user or someone else) and bytes go through untouched;
// false/absent means it's a plain OpenAI-compatible endpoint (raw vLLM/llama.cpp/SGLang) that
// needs translating both ways. The only case that still uses the default LITELLM_UPSTREAM is
// having no catalog at all yet (bootstrap) or an alias that doesn't resolve to any server.
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

// --- Anthropic <-> OpenAI translation (for a direct:false target — a raw OpenAI-compatible
// server with no Anthropic surface of its own). Covers what Claude Code actually sends: text,
// images (top-level and inside tool_result), tool_use/tool_result round-tripping, thinking (via
// the same reasoning_content convention reasoning-normalizer.js and litellm already use), system
// prompt, streaming and non-streaming. Not covered: prompt-cache hints (cache_control) — dropped,
// harmless, purely an optimization signal with no OpenAI equivalent.
const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };

function imagePart(source) {
  if (!source) return null;
  if (source.type === 'base64') return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  if (source.type === 'url') return { type: 'image_url', image_url: { url: source.url } };
  return null;
}

// Claude Code's thinking.budget_tokens is a raw token count with no fixed scale. LiteLLM's own
// /v1/messages translation maps any budget above ~2k to the single string "high" — but Qwen3's
// chat template (and vLLM's --reasoning-parser qwen3) uses a totally different, coarser vocabulary
// (xhigh/medium/low, no "high" tier at all) and hard-rejects "high" with a 400. Confirmed live
// 2026-09-11: litellm ignores/overrides any chat_template_kwargs bolted on alongside `thinking` on
// the /v1/messages route, so there is no fix on that path — this bucket mapping only matters
// because dispatch now goes through /v1/chat/completions (see dispatchTranslated), which litellm
// (and raw vLLM) both pass through to the backend untouched.
function effortFromBudget(budgetTokens) {
  const n = Number(budgetTokens) || 0;
  if (n >= 20000) return 'xhigh';
  if (n >= 6000) return 'medium';
  return 'low';
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => (b && b.text) || '').join('\n') : '';
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      // Claude Code injects mid-conversation reminder messages with role:"system" (e.g. an
      // "# Environment" block after the first turn) — vLLM's chat template rejects any system
      // message that isn't the very first one ("System message must be at the beginning.").
      // Demote any non-leading one to a user message rather than erroring the whole request.
      const role = (m.role === 'system' && messages.length > 0) ? 'user' : m.role;
      messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const parts = [];
    const toolCalls = [];
    const toolResultMsgs = [];
    let reasoning = '';
    for (const block of m.content) {
      if (!block) continue;
      if (block.type === 'text') parts.push({ type: 'text', text: block.text || '' });
      else if (block.type === 'thinking') reasoning += block.thinking || '';
      else if (block.type === 'image') { const p = imagePart(block.source); if (p) parts.push(p); }
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      } else if (block.type === 'tool_result') {
        let text = ''; const imgs = [];
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (!sub) continue;
            if (sub.type === 'text') text += sub.text || '';
            else if (sub.type === 'image') { const p = imagePart(sub.source); if (p) imgs.push(p); }
          }
        }
        toolResultMsgs.push({
          role: 'tool', tool_call_id: block.tool_use_id,
          content: imgs.length ? [{ type: 'text', text: text || '(see attached image)' }, ...imgs] : (text || ''),
        });
      }
    }
    if (m.role === 'assistant') {
      const out = { role: 'assistant' };
      out.content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : (parts.length ? parts : null);
      if (reasoning) out.reasoning_content = reasoning;
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else {
      if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      for (const tr of toolResultMsgs) messages.push(tr);
    }
  }

  const out = { model: body.model, messages, max_tokens: body.max_tokens, stream: !!body.stream };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : 'auto';
  }
  if (body.thinking && body.thinking.type === 'enabled') {
    out.chat_template_kwargs = { enable_thinking: true, reasoning_effort: effortFromBudget(body.thinking.budget_tokens) };
  }
  return out;
}

function openAIJsonToAnthropic(json, model) {
  const choice = (json.choices && json.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  // vLLM's own native field is "reasoning"; litellm normalizes it to "reasoning_content" — accept
  // either, since a direct (non-gateway) target is raw vLLM/SGLang/llama.cpp, never litellm.
  const reasoningText = msg.reasoning_content || msg.reasoning;
  if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText, signature: null });
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { /* leave {} */ }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input });
    }
  }
  return {
    id: json.id || `msg_${Date.now().toString(36)}`,
    type: 'message', role: 'assistant', model, content,
    stop_reason: STOP_REASON[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: (json.usage && json.usage.prompt_tokens) || 0, output_tokens: (json.usage && json.usage.completion_tokens) || 0 },
  };
}

// Translates an OpenAI SSE stream into Anthropic SSE events on the fly. Tracks one open content
// block at a time (thinking / text / tool_use), closing and reopening whenever the delta's field
// changes — the same boundary problem reasoning-normalizer.js's splitDualDelta solves for the
// fused-delta bug, just for a real protocol difference instead of one model's quirk.
function streamOpenAIToAnthropic(upstreamRes, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const messageId = `msg_${Date.now().toString(36)}`;
  send('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

  let blockOpen = false, blockIndex = -1, blockType = null;
  const toolBlockByCallIndex = {};
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

  const closeBlock = () => { if (blockOpen) { send('content_block_stop', { type: 'content_block_stop', index: blockIndex }); blockOpen = false; } };
  const openBlock = (type, startFields) => {
    closeBlock();
    blockIndex++; blockType = type; blockOpen = true;
    send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type, ...startFields } });
    return blockIndex;
  };

  let buf = '';
  upstreamRes.setEncoding('utf8');
  upstreamRes.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      let obj; try { obj = JSON.parse(payload); } catch { continue; }
      const choice = obj.choices && obj.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // vLLM's own native field is "reasoning"; litellm normalizes it to "reasoning_content" —
      // accept either, since a direct (non-gateway) target is raw vLLM/SGLang/llama.cpp, never
      // litellm (see openAIJsonToAnthropic's identical fallback for the non-streaming case).
      const reasoningDelta = delta.reasoning_content || delta.reasoning;
      if (reasoningDelta) {
        if (blockType !== 'thinking') openBlock('thinking', { thinking: '', signature: null });
        send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: reasoningDelta } });
      }
      if (delta.content) {
        if (blockType !== 'text') openBlock('text', { text: '' });
        send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index != null ? tc.index : 0;
          if (!(i in toolBlockByCallIndex)) {
            toolBlockByCallIndex[i] = openBlock('tool_use', { id: tc.id || `toolu_${i}`, name: (tc.function && tc.function.name) || '', input: {} });
          }
          const args = tc.function && tc.function.arguments;
          if (args) send('content_block_delta', { type: 'content_block_delta', index: toolBlockByCallIndex[i], delta: { type: 'input_json_delta', partial_json: args } });
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (obj.usage) usage = { input_tokens: obj.usage.prompt_tokens || 0, output_tokens: obj.usage.completion_tokens || 0 };
    }
  });
  upstreamRes.on('end', () => {
    closeBlock();
    send('message_delta', { type: 'message_delta', delta: { stop_reason: STOP_REASON[finishReason] || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
  upstreamRes.on('error', () => { try { res.end(); } catch { /* client may already be gone */ } });
}
// resolveDispatch(alias) -> { id, target, direct }. id = real served model id (or the alias
// unchanged if it can't be resolved — an unresolvable id is forwarded as-is so the upstream's own
// error explains the problem, no silent fallback). target = the URL to dispatch directly to, or
// null only when there's no catalog yet or the alias didn't resolve to any server (falls back to
// LITELLM_UPSTREAM). direct = true when target already speaks Anthropic's wire format (forward
// bytes untouched), false when it needs Anthropic<->OpenAI translation (see maybeRewrite/dispatch
// below) — meaningless when target is null.
function resolveDispatch(alias) {
  const cat = loadCatalog();
  if (!cat || typeof alias !== 'string') return { id: alias, target: null, direct: true };
  const ref = (BRAIN_ALIASES.has(alias) || alias.startsWith('claude-')) ? cat.roles.brain
            : VISION_ALIASES.has(alias) ? (cat.roles.vision || cat.roles.brain)
            : alias;
  if (!ref) return { id: alias, target: null, direct: true };
  let srv, id;
  const slash = ref.indexOf('/');
  if (slash > 0 && cat.servers[ref.slice(0, slash)]?.models?.[ref.slice(slash + 1)]) {
    srv = ref.slice(0, slash); id = ref.slice(slash + 1);
  } else {
    // Ambiguous (served by >1 server, needs "server/id") or genuinely unknown: forward the alias
    // unchanged rather than guess — the upstream's own error explains it.
    const owners = cat.byId[ref] || [];
    if (owners.length !== 1) return { id: alias, target: null, direct: true };
    srv = owners[0]; id = ref;
  }
  const def = cat.servers[srv];
  if (!def.url) return { id, target: null, direct: true };
  return { id, target: def.url, direct: def.anthropic === true };
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
// variant). Returns { buf, body, target, direct }: buf is a Buffer to forward or null to forward
// the original bytes unchanged; body is the (possibly rewritten) parsed Anthropic-shaped request,
// needed by the caller when direct:false to translate before dispatch; target is the URL to
// dispatch directly to (see resolveDispatch above) or null to use the default LITELLM_UPSTREAM;
// direct is meaningless when target is null.
function maybeRewrite(pathname, raw) {
  if (!pathname.startsWith('/v1/messages')) return { buf: null, body: null, target: null, direct: true };
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { buf: null, body: null, target: null, direct: true }; }
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
  // Resolve the final alias to a real served model id and its dispatch target — the server no
  // longer does this (see the "Third job" note above). EVERY resolved server is dispatched to
  // directly now; `direct` says whether that means raw bytes or an OpenAI translation.
  let target = null, direct = true;
  if (typeof body.model === 'string') {
    const resolved = resolveDispatch(body.model);
    if (resolved.id !== body.model) { body.model = resolved.id; changed = true; }
    target = resolved.target; direct = resolved.direct;
  }
  // One line per completion request; the noisy count_tokens variant is skipped.
  // Colors match includes/colors.sh: INFO \e[38;5;68m, WARNING \e[93m.
  if (pathname === '/v1/messages' && typeof requested === 'string') {
    const cls = CLASS_SLOTS.has(requested) ? `${requested}-class` : `'${requested}'`;
    const { id, side } = backendFor(body.model, c);
    const warn = note ? `\x1b[93m${note}\x1b[0m` : '';
    const via = target ? ` via ${target.host}${direct ? '' : ' (translated)'}` : '';
    console.log(`\x1b[38;5;68m> Req: ${cls} called — routing to ${id} (${side})${via}\x1b[0m${warn}`);
  }
  return { buf: changed ? Buffer.from(JSON.stringify(body), 'utf8') : null, body, target, direct };
}

// A raw OpenAI-compatible target has no Anthropic-shaped count_tokens endpoint to ask — answer
// with a cheap local estimate (chars/4) rather than failing outright; this only feeds a client-side
// context-window display, not anything correctness-critical.
function estimateTokens(body) {
  const text = JSON.stringify(body && body.messages || []);
  return Math.ceil(text.length / 4);
}

function dispatchTranslated(pathname, anthropicBody, target, res) {
  if (pathname !== '/v1/messages') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: estimateTokens(anthropicBody) }));
    return;
  }
  const openaiBody = anthropicToOpenAI(anthropicBody);
  const outBody = Buffer.from(JSON.stringify(openaiBody), 'utf8');
  // Catalog server urls end in /v1 by wizard convention, but the bare LITELLM_UPSTREAM (now also a
  // valid `target` here — see the server handler) does not; ensure the /v1 prefix either way rather
  // than assuming it's already there.
  const basePath = target.pathname.replace(/\/$/, '');
  const path = (basePath.endsWith('/v1') ? basePath : `${basePath}/v1`) + '/chat/completions';
  const transport = target.protocol === 'https:' ? https : http;
  const defaultPort = target.protocol === 'https:' ? 443 : 80;
  let timedOut = false;
  const upstreamReq = transport.request(
    {
      hostname: target.hostname,
      port: parseInt(target.port || defaultPort, 10),
      method: 'POST',
      path,
      headers: { host: target.host, 'content-type': 'application/json', 'content-length': outBody.length },
    },
    (upstreamRes) => {
      if (openaiBody.stream) {
        streamOpenAIToAnthropic(upstreamRes, res, anthropicBody.model);
        return;
      }
      const chunks = [];
      upstreamRes.on('data', (c) => chunks.push(c));
      upstreamRes.on('end', () => {
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'shim_translate_error', message: 'upstream did not return JSON' } }));
          return;
        }
        res.writeHead(upstreamRes.statusCode === 200 ? 200 : (upstreamRes.statusCode || 502), { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstreamRes.statusCode === 200 ? openAIJsonToAnthropic(json, anthropicBody.model) : json));
      });
    }
  );
  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => { timedOut = true; upstreamReq.destroy(); });
  upstreamReq.on('error', (err) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: timedOut ? 'shim_upstream_timeout' : 'shim_upstream_error',
        message: timedOut ? `upstream did not respond within ${UPSTREAM_TIMEOUT_MS}ms` : String(err),
      },
    }));
  });
  upstreamReq.end(outBody);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const pathname = req.url.split('?')[0];
    const result = (req.method === 'POST') ? maybeRewrite(pathname, raw) : { buf: null, body: null, target: null, direct: true };
    const { buf, body, target, direct } = result;

    // Translate-and-dispatch-to-/chat/completions is now the DEFAULT for /v1/messages traffic,
    // not just explicit raw-vLLM catalog targets: litellm's own /v1/messages translation for
    // thinking/reasoning_effort is confirmed broken for non-Anthropic-native backends (see
    // effortFromBudget's comment above), while /v1/chat/completions passes chat_template_kwargs
    // through untouched on both litellm and raw vLLM. Only a target explicitly marked
    // `anthropic: true` (a real Anthropic-speaking gateway, not this stack's own litellm+vLLM) is
    // still forwarded raw/untranslated below.
    if (body && pathname.startsWith('/v1/messages') && !(target && direct)) {
      dispatchTranslated(pathname, body, target || UPSTREAM, res);
      return;
    }

    const outBody = buf || raw;
    // target set -> dispatch there directly, joining paths the same way reasoning-normalizer.js
    // does for its OpenAI targets (targetPath above). Otherwise -> the default LITELLM_UPSTREAM,
    // forwarding the request path unchanged as always (non-/v1/messages paths only, now that
    // /v1/messages itself is handled above).
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
