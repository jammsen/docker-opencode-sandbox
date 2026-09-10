#!/usr/bin/env node
'use strict';
// test-reasoning-normalizer — exercises reasoning-normalizer.js against a stub vLLM.
// The stub emits a deepseek-style SSE stream whose reasoning→content transition packs BOTH
// delta.reasoning and delta.content into one chunk (the bug). The normalizer must split that into
// two, so no chunk carries both fields, while preserving every reasoning and content token and the
// finish_reason. Also covers the no-op paths: a qwen-style stream (no dual chunk) and a plain JSON
// response, and the catalog ROUTER mode (MODELS_FILE): alias resolution, path join, 404s, live reload.
// response must pass through untouched.
//
// Usage: node tests/test-reasoning-normalizer.js   (no deps, exits non-zero on failure)

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const NORM = process.env.NORMALIZER_PATH || path.join(__dirname, '..', 'scripts', 'reasoning-normalizer.js');
const UPSTREAM_PORT = 4019;
const NORM_PORT = 4018;

// --- stub vLLM: replays a canned body with the content-type the test asks for --------------
let responder = null; // (res) => void
let lastReq = null;   // { path, body } of the most recent upstream request (router assertions)
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
    lastReq = { path: req.url, body };
    responder(res);
  });
});

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// deepseek-shaped stream: reasoning tokens, then ONE dual chunk (reasoning+content), then content.
function deepseekStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sseChunk({ choices: [{ delta: { role: 'assistant', content: '' } }] }));
  res.write(sseChunk({ choices: [{ delta: { reasoning: 'We' } }] }));
  res.write(sseChunk({ choices: [{ delta: { reasoning: ' add 3+3' } }] }));
  // The bug: last reasoning token + first content token in the same delta, no boundary event.
  res.write(sseChunk({ choices: [{ delta: { reasoning: '.', content: '6' } }] }));
  res.write(sseChunk({ choices: [{ delta: { content: ' total' }, finish_reason: 'stop' }] }));
  res.write('data: [DONE]\n\n');
  res.end();
}

// qwen-shaped stream: reasoning then content, never bundled. Must pass through byte-identical.
function qwenStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sseChunk({ choices: [{ delta: { reasoning: 'think' } }] }));
  res.write(sseChunk({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }));
  res.write('data: [DONE]\n\n');
  res.end();
}

function post(bodyStr = '{"stream":true}', reqPath = '/v1/chat/completions') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: NORM_PORT, path: reqPath, method: 'POST',
        headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end(bodyStr);
  });
}

function startNormalizer(extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NORM], {
      env: { ...process.env, NORMALIZER_PORT: String(NORM_PORT), VLLM_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`, ...extraEnv },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.once('data', () => resolve(child)); // listening banner
  });
}

// Parse an SSE body into the array of delta objects (skips [DONE] and the role chunk's noise).
function deltas(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const p = line.slice(6).trim();
    if (p === '[DONE]') continue;
    try { out.push(JSON.parse(p)); } catch { /* ignore */ }
  }
  return out;
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${name}`);
  if (!cond) failures++;
}

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
  const child = await startNormalizer();

  try {
    // --- Case 1: deepseek dual chunk gets split, N times (mirrors the live x/20 gate) ----------
    responder = deepseekStream;
    const RUNS = 20;
    let dualSeen = 0, reasoningOk = 0, contentOk = 0, orderOk = 0, finishOk = 0;
    for (let i = 0; i < RUNS; i++) {
      const { body } = await post();
      const ds = deltas(body);
      const dual = ds.filter((d) => d.choices?.[0]?.delta?.reasoning && d.choices?.[0]?.delta?.content);
      if (dual.length === 0) dualSeen++;
      const reasoning = ds.map((d) => d.choices?.[0]?.delta?.reasoning || '').join('');
      const content = ds.map((d) => d.choices?.[0]?.delta?.content || '').join('');
      if (reasoning === 'We add 3+3.') reasoningOk++;
      if (content === '6 total') contentOk++;
      // every reasoning delta must precede every content delta
      const kinds = ds.flatMap((d) => {
        const dl = d.choices?.[0]?.delta || {};
        const k = [];
        if (dl.reasoning) k.push('R');
        if (dl.content) k.push('C');
        return k;
      });
      if (kinds.join('').indexOf('C') === -1 || kinds.join('').lastIndexOf('R') < kinds.join('').indexOf('C')) orderOk++;
      // finish_reason must ride the content-only half, never a reasoning delta
      const finishOnReasoning = ds.some((d) => d.finish_reason && d.choices?.[0]?.delta?.reasoning);
      if (!finishOnReasoning) finishOk++;
    }
    check(`${RUNS}/${RUNS} runs: no chunk carries both reasoning+content`, dualSeen === RUNS);
    check(`${RUNS}/${RUNS} runs: reasoning text preserved intact`, reasoningOk === RUNS);
    check(`${RUNS}/${RUNS} runs: content text preserved intact`, contentOk === RUNS);
    check(`${RUNS}/${RUNS} runs: all reasoning precedes all content`, orderOk === RUNS);
    check(`${RUNS}/${RUNS} runs: finish_reason never on a reasoning delta`, finishOk === RUNS);

    // --- Case 2: qwen stream (no dual chunk) passes through unchanged ---------------------------
    responder = qwenStream;
    const q = await post();
    const qd = deltas(q.body);
    check('qwen stream: reasoning + content intact, no split',
      qd.map((d) => d.choices?.[0]?.delta?.reasoning || '').join('') === 'think' &&
      qd.map((d) => d.choices?.[0]?.delta?.content || '').join('') === 'answer' &&
      qd.length === 2);

    // --- Case 3: non-SSE JSON response passes through untouched ---------------------------------
    responder = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
    const j = await post();
    check('non-SSE response passed through verbatim', j.body === '{"ok":true}');
    check('legacy mode: model untouched, path forwarded as-is',
      lastReq && lastReq.path === '/v1/chat/completions' && lastReq.body?.stream === true && !('model' in (lastReq.body || {})));

  } finally {
    child.kill();
  }

  // --- Case 4: catalog router mode (MODELS_FILE) — aliases resolve, model rewritten, path joined ----
  const fs = require('fs'), os = require('os');
  const catalogFile = path.join(os.tmpdir(), `models-test-${process.pid}.json`);
  const writeCatalog = (obj) => fs.writeFileSync(catalogFile, JSON.stringify(obj));
  const base = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;
  writeCatalog({
    servers: {
      a: { url: base, models: { 'deep-1': { vision: false }, 'shared': {} } },
      b: { url: `${base}/b`, models: { 'qwen-1': { vision: true }, 'shared': {} } },   // /v1/b: distinguishable path
      broken: { url: 'not a url', models: { 'ghost': {} } },                             // must be skipped, not crash
    },
    roles: { brain: 'a/deep-1', vision: 'b/qwen-1' },
  });
  const rchild = await startNormalizer({ MODELS_FILE: catalogFile });
  responder = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
  try {
    const cases = [
      ['brain',            'deep-1', '/v1/chat/completions'],
      ['opus',             'deep-1', '/v1/chat/completions'],
      ['claude-sonnet-4-5','deep-1', '/v1/chat/completions'],
      ['claude-3-5-haiku-20241022','deep-1', '/v1/chat/completions'],   // any claude-* id -> brain
      ['vision',           'qwen-1', '/v1/b/chat/completions'],
      ['haiku',            'qwen-1', '/v1/b/chat/completions'],
      ['qwen-1',           'qwen-1', '/v1/b/chat/completions'],   // bare id, unique
      ['b/shared',         'shared', '/v1/b/chat/completions'],   // explicit server/id
    ];
    let ok = 0;
    for (const [alias, id, p] of cases) {
      const r = await post(JSON.stringify({ model: alias, stream: false }));
      const good = r.status === 200 && lastReq?.body?.model === id && lastReq?.path === p;
      if (!good) console.log(`     ${alias}: status=${r.status} model=${lastReq?.body?.model} path=${lastReq?.path}`);
      ok += good ? 1 : 0;
    }
    check(`router: ${cases.length}/${cases.length} aliases resolve to the right model + server path`, ok === cases.length);

    let r = await post(JSON.stringify({ model: 'ghost' }));
    check('router: server with invalid url is skipped (404, no crash)', r.status === 404);
    r = await post(JSON.stringify({ model: 'shared' }));
    check('router: ambiguous bare id (on two servers) is rejected with 404', r.status === 404 && /not in the catalog/.test(r.body));
    r = await post(JSON.stringify({ model: 'nope' }));
    check('router: unknown model -> 404 with the wizard hint', r.status === 404 && /model configuration/.test(r.body));
    r = await post('not json at all');
    check('router: non-JSON body forwarded to legacy upstream unchanged', r.status === 200 && lastReq?.body === null);

    // catalog change is picked up without restart (mtime): swap brain to server b
    await new Promise((res) => setTimeout(res, 20));   // ensure a distinct mtime
    writeCatalog({ servers: { a: { url: base, models: { 'deep-1': {} } }, b: { url: `${base}/b`, models: { 'qwen-1': {} } } },
                   roles: { brain: 'b/qwen-1', vision: 'b/qwen-1' } });
    r = await post(JSON.stringify({ model: 'brain' }));
    check('router: catalog change applied on the next request (no restart)',
      r.status === 200 && lastReq?.body?.model === 'qwen-1' && lastReq?.path === '/v1/b/chat/completions');
  } finally {
    rchild.kill();
    upstream.close();
    try { fs.unlinkSync(catalogFile); } catch { /* ignore */ }
  }

  console.log(failures === 0 ? '\nAll reasoning-normalizer checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
