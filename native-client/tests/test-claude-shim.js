#!/usr/bin/env node
'use strict';
// test-claude-shim — exercises native-client/claude-shim.js end-to-end against a stub upstream.
// Native-client copy of ../../sandbox-client/tests/test-claude-shim.js — same coverage, ported
// here since native-client's shim got the same translation-layer port (2026-09-11).
// Covers the tool_result image hoist and the dual-model vision routing
// (MODEL_VISION=false → image-bearing requests rewritten to the `vision` model).
//
// Usage: node scripts/test-claude-shim.js   (no deps, exits non-zero on failure)

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// native-client keeps the shim flat in its own root, not under scripts/.
const SHIM = process.env.SHIM_PATH || path.join(__dirname, '..', 'claude-shim.js');
// Distinct ports from sandbox-client/tests/test-claude-shim.js so both suites can run concurrently.
const UPSTREAM_PORT = 4019;
const SHIM_PORT = 4018;

let lastBody = null, lastPath = null;
const upstream = http.createServer((req, res) => {
  lastPath = req.url;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: SHIM_PORT, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

let shimOut = '';
function startShim(env) {
  shimOut = '';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM], {
      env: { ...process.env, ...env, CLAUDE_SHIM_PORT: String(SHIM_PORT), LITELLM_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.on('data', (d) => { shimOut += d; resolve(child); }); // listening banner
  });
}

const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

  // --- dual-model mode: text-only primary --------------------------------
  // NOTE: with no catalog present, dispatch now defaults to translated /v1/chat/completions (see
  // "reasoning-effort bucket mapping" below for why) — this stub upstream therefore receives the
  // OpENAI-shaped, post-translation body, not the raw Anthropic one. Checks below are written
  // against that translated shape.
  let shim = await startShim({ MODEL_VISION: 'false' });

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  check('text request keeps primary model', lastBody.model === 'brain');
  check('bootstrap default dispatch is translated to /v1/chat/completions', lastPath === '/v1/chat/completions');

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, IMG] }] });
  check('user-message image reroutes to vision', lastBody.model === 'vision');

  await post({ model: 'brain', messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'read ok' }, IMG] },
  ] }] });
  check('tool_result image reroutes to vision', lastBody.model === 'vision');
  // Hoisting happens pre-translation on the Anthropic-shaped body, then anthropicToOpenAI()
  // converts the (now imageless) tool_result into a role:"tool" message and the hoisted
  // image lands in the following role:"user" message as an image_url part.
  const hoisted = lastBody.messages.length === 2
    && lastBody.messages[0].role === 'tool' && typeof lastBody.messages[0].content === 'string'
    && lastBody.messages[1].role === 'user' && Array.isArray(lastBody.messages[1].content)
    && lastBody.messages[1].content.some((b) => b.type === 'image_url');
  check('tool_result image still hoisted to follow-up user message (translated shape)', hoisted);

  // --- reasoning-effort bucket mapping (this same default/bootstrap path) ------------------
  // Confirmed live against the real litellm+vLLM stack (2026-09-11) that litellm's own
  // /v1/messages translation caps reasoning_effort at "high", which Qwen3's chat template
  // rejects (only xhigh/medium/low exist); /v1/chat/completions passes chat_template_kwargs
  // through untouched instead — hence dispatch now goes through it by default, and the shim
  // has to compute chat_template_kwargs.reasoning_effort itself from thinking.budget_tokens.
  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 1000 } });
  check('low budget_tokens (1000) maps to low effort', lastBody.chat_template_kwargs && lastBody.chat_template_kwargs.reasoning_effort === 'low');
  check('chat_template_kwargs.enable_thinking is true when thinking enabled', lastBody.chat_template_kwargs.enable_thinking === true);

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 5999 } });
  check('just-under-medium boundary (5999) still maps to low', lastBody.chat_template_kwargs.reasoning_effort === 'low');

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 6000 } });
  check('medium boundary (6000) maps to medium effort', lastBody.chat_template_kwargs.reasoning_effort === 'medium');

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 19999 } });
  check('just-under-xhigh boundary (19999) still maps to medium', lastBody.chat_template_kwargs.reasoning_effort === 'medium');

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 20000 } });
  check('xhigh boundary (20000) maps to xhigh effort', lastBody.chat_template_kwargs.reasoning_effort === 'xhigh');

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'enabled', budget_tokens: 500000 } });
  check('very large budget_tokens still maps to xhigh (no overflow/crash)', lastBody.chat_template_kwargs.reasoning_effort === 'xhigh');

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  check('no thinking block at all: no chat_template_kwargs added (server default applies)', lastBody.chat_template_kwargs === undefined);

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking: { type: 'disabled' } });
  check('thinking explicitly disabled: no chat_template_kwargs added', lastBody.chat_template_kwargs === undefined);

  await post({ model: 'vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, IMG] }] });
  check('explicit vision model is respected (no rewrite loop)', lastBody.model === 'vision');

  // Image only in an OLDER turn, newest message is text: the model choice must
  // survive (no pinning to vision) and the stale image gets stripped so the
  // text-only primary can accept the payload.
  // Post-translation, an image is always an OpenAI-shaped image_url part (top-level array content
  // on any message) — a Anthropic tool_result never survives translation as a nested block, it
  // becomes its own role:"tool" message (see the hoist check above), so no separate case is needed.
  const hasAnyImage = (msgs) => msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image_url'));
  await post({ model: 'brain', messages: [
    { role: 'user', content: [{ type: 'text', text: 'who is this?' }, IMG] },
    { role: 'assistant', content: [{ type: 'text', text: 'Two wrestlers: A and B.' }] },
    { role: 'user', content: [{ type: 'text', text: 'how old are they today?' }] },
  ] });
  check('stale image: explicit brain choice survives', lastBody.model === 'brain');
  check('stale image: image blocks stripped for text-only primary', !hasAnyImage(lastBody.messages));

  // Same history but explicitly addressed to vision: nothing is stripped.
  await post({ model: 'vision', messages: [
    { role: 'user', content: [{ type: 'text', text: 'who is this?' }, IMG] },
    { role: 'assistant', content: [{ type: 'text', text: 'Two wrestlers: A and B.' }] },
    { role: 'user', content: [{ type: 'text', text: 'more detail please' }] },
  ] });
  check('stale image + explicit vision: images kept', lastBody.model === 'vision' && hasAnyImage(lastBody.messages));

  // Old tool_result image (gets hoisted mid-history) + new text turn: still
  // brain, and the hoisted copy is stripped too.
  await post({ model: 'brain', messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'read ok' }, IMG] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Screenshot shows a login page.' }] },
    { role: 'user', content: [{ type: 'text', text: 'write the test plan' }] },
  ] });
  check('stale hoisted tool_result image: stays on brain, stripped', lastBody.model === 'brain' && !hasAnyImage(lastBody.messages));

  // Class slots: haiku/sonnet are vision-side (their backend can see — never
  // reroute or strip), opus/fable are brain-side (same treatment as brain).
  await post({ model: 'haiku', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, IMG] }] });
  check('haiku-class with fresh image: not rerouted', lastBody.model === 'haiku');

  await post({ model: 'haiku', messages: [
    { role: 'user', content: [{ type: 'text', text: 'who?' }, IMG] },
    { role: 'assistant', content: [{ type: 'text', text: 'A and B.' }] },
    { role: 'user', content: [{ type: 'text', text: 'more' }] },
  ] });
  check('haiku-class with stale image: images kept', lastBody.model === 'haiku' && hasAnyImage(lastBody.messages));

  await post({ model: 'opus', messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, IMG] }] });
  check('opus-class with fresh image reroutes to vision', lastBody.model === 'vision');
  await new Promise((r) => setTimeout(r, 150)); // let the stdout pipe deliver the log line
  check('routing log line emitted', shimOut.includes("Req: opus-class called — routing to") && shimOut.includes('rerouted'));

  shim.kill();

  // --- single-model mode: vision-capable primary (default) ---------------
  // Empty string = shim's unset default; plain {} would inherit whatever
  // MODEL_VISION the surrounding container/shell has via ...process.env.
  shim = await startShim({ MODEL_VISION: '' });

  await post({ model: 'brain', messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, IMG] }] });
  check('MODEL_VISION unset: image request NOT rerouted', lastBody.model === 'brain');

  await post({ model: 'brain', messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [IMG] },
  ] }] });
  check('MODEL_VISION unset: hoist still active', lastBody.messages.length === 2 && lastBody.model === 'brain');

  shim.kill();

  // --- catalog alias resolution + multi-server dispatch -------------------
  // A real catalog: one plain server (a raw OpenAI-compatible endpoint — dispatched to directly,
  // translated Anthropic<->OpenAI) and one marked anthropic:true (a full Anthropic-speaking
  // gateway of its own, e.g. another ../server/ instance — dispatched to directly, raw bytes).
  // Neither ever touches the default LITELLM_UPSTREAM once a catalog resolves them.
  const fs = require('fs');
  const os = require('os');
  const SECOND_SERVER_PORT = 4020;
  let secondHits = 0, secondPath = null, secondModel = null;
  const secondServer = http.createServer((req, res) => {
    secondHits++; secondPath = req.url;
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      secondModel = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":"second"}');
    });
  });
  await new Promise((r) => secondServer.listen(SECOND_SERVER_PORT, '127.0.0.1', r));

  // Plain (non-anthropic) target: speaks OpenAI chat/completions, not Anthropic — the shim must
  // translate both the outgoing request and the incoming response.
  const PLAIN_SERVER_PORT = 4021;
  let plainHits = 0, plainPath = null, plainReqBody = null;
  const plainServer = http.createServer((req, res) => {
    plainHits++; plainPath = req.url;
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      plainReqBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (plainReqBody.tool_choice_probe_only) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (plainReqBody.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] })}\n\n`);
        chunk({ reasoning_content: 'thinking a bit' });
        chunk({ content: 'Hello' });
        chunk({ content: ' world' });
        chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Berlin"}' } }] }, 'tool_calls');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // Tool-call round trip: if the request carries tool_calls (assistant turn) or a tool result
      // (role:"tool" message), just echo a plain confirmation — the test only checks the REQUEST
      // shape for those; this response path is for the plain text case.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-plain', object: 'chat.completion', model: plainReqBody.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello from plain server' } }],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }));
    });
  });
  await new Promise((r) => plainServer.listen(PLAIN_SERVER_PORT, '127.0.0.1', r));

  function postCapture(reqBody) {
    return new Promise((resolve) => {
      const payload = JSON.stringify(reqBody);
      const req = http.request({ hostname: '127.0.0.1', port: SHIM_PORT, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
      req.end(payload);
    });
  }

  const catalogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-catalog-')), 'models.json');
  fs.writeFileSync(catalogFile, JSON.stringify({
    servers: {
      myserver: { url: `http://127.0.0.1:${PLAIN_SERVER_PORT}/v1`, models: { 'qwen3.6-35b': { vision: true } } },
      friend:   { url: `http://127.0.0.1:${SECOND_SERVER_PORT}/v1`, anthropic: true, models: { 'llama-vision': {} } },
    },
    roles: { brain: 'myserver/qwen3.6-35b', vision: 'myserver/qwen3.6-35b' },
  }));
  shim = await startShim({ MODELS_FILE: catalogFile });

  lastBody = null; // reset: prove the plain-server dispatch below never reaches the default upstream
  const plainRespRaw = await postCapture({ model: 'opus', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  const plainResp = JSON.parse(plainRespRaw);
  check('plain server dispatched to directly (not default upstream)', plainHits === 1 && lastBody === null);
  check('alias resolved to real served id', plainReqBody.model === 'qwen3.6-35b');
  check('translated request path is /v1/chat/completions', plainPath === '/v1/chat/completions');
  check('translated request uses plain OpenAI messages shape', plainReqBody.messages[0].role === 'user' && plainReqBody.messages[0].content === 'hi');
  check('translated response is Anthropic-shaped', plainResp.type === 'message' && plainResp.role === 'assistant');
  check('translated response text carried through', plainResp.content[0].type === 'text' && plainResp.content[0].text === 'hello from plain server');
  check('translated response stop_reason mapped', plainResp.stop_reason === 'end_turn');
  check('translated response usage mapped', plainResp.usage.input_tokens === 5 && plainResp.usage.output_tokens === 4);

  // Streaming translation: reasoning_content -> thinking block, content -> text block, tool_calls
  // -> tool_use block, each opened/closed correctly, finish_reason mapped, stream terminated.
  const streamRespRaw = await postCapture({ model: 'opus', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }] });
  const events = streamRespRaw.split('\n\n').filter((e) => e.trim()).map((e) => {
    const [, ev] = /^event: (\S+)/.exec(e) || [];
    const [, data] = /^data: (.+)$/m.exec(e) || [];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
  const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.type);
  const textDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join('');
  const thinkingDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta').map((e) => e.data.delta.thinking).join('');
  const jsonDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  const stops = events.filter((e) => e.event === 'content_block_stop').length;
  const msgDelta = events.find((e) => e.event === 'message_delta');
  check('stream: three blocks opened in order (thinking, text, tool_use)', starts.join(',') === 'thinking,text,tool_use');
  check('stream: thinking text reassembled', thinkingDeltas === 'thinking a bit');
  check('stream: text reassembled', textDeltas === 'Hello world');
  check('stream: tool_use input_json reassembled to valid JSON', (() => { try { return JSON.parse(jsonDeltas).city === 'Berlin'; } catch { return false; } })());
  check('stream: every opened block was closed', stops === starts.length);
  check('stream: finish_reason mapped to tool_use', msgDelta && msgDelta.data.delta.stop_reason === 'tool_use');
  check('stream: ends with message_stop', events[events.length - 1].event === 'message_stop');

  // Image + tool round trip through the request translator (Anthropic -> OpenAI shape).
  await postCapture({
    model: 'opus',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '18C sunny' }] }] },
    ],
    tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  });
  const userMsg = plainReqBody.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
  const assistantMsg = plainReqBody.messages.find((m) => m.role === 'assistant');
  const toolMsg = plainReqBody.messages.find((m) => m.role === 'tool');
  check('image translated to image_url data URI', userMsg && userMsg.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
  check('tool_use translated to tool_calls', assistantMsg && assistantMsg.tool_calls && assistantMsg.tool_calls[0].function.name === 'get_weather'
    && JSON.parse(assistantMsg.tool_calls[0].function.arguments).city === 'Berlin');
  check('tool_result translated to role:tool message', toolMsg && toolMsg.tool_call_id === 'toolu_1' && toolMsg.content === '18C sunny');
  check('tools array translated to OpenAI function shape', plainReqBody.tools && plainReqBody.tools[0].type === 'function' && plainReqBody.tools[0].function.name === 'get_weather');

  // Real bug, found live: Claude Code injects a mid-conversation "# Environment" reminder message
  // with role:"system" (not just the leading system prompt). vLLM's chat template rejects any
  // system message that isn't first ("System message must be at the beginning."), so a non-leading
  // one must be demoted to role:"user" rather than forwarded as-is.
  await postCapture({
    model: 'opus',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '# Environment\nreminder text' },
      { role: 'assistant', content: 'ok' },
    ],
  });
  const roles = plainReqBody.messages.map((m) => m.role);
  check('mid-conversation system message demoted to user', roles.filter((r) => r === 'system').length === 0 && roles.includes('user'));

  await post({ model: 'friend/llama-vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  check('anthropic:true server dispatched to directly', secondHits === 1);
  check('dispatch path joined correctly (raw, no translation)', secondPath === '/v1/messages');
  check('model id forwarded unchanged for an explicit server/id ref', secondModel === 'llama-vision');

  shim.kill();
  secondServer.close();
  plainServer.close();
  upstream.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
