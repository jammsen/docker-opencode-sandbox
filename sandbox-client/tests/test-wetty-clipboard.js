#!/usr/bin/env node
'use strict';
// Build-time test for patches/wetty-clipboard.js: extracts the injected OSC 52
// handler from the patched wetty bundle and exercises it with mocked browser
// APIs — tests the code as shipped, not a copy. Only runs where the bundle
// exists (image build / container), not in the bare repo.

const fs = require('fs');
const FILE = process.env.WETTY_BUNDLE || '/usr/local/lib/node_modules/wetty/build/client/wetty.js';
const src = fs.readFileSync(FILE, 'utf8');

const start = src.indexOf('this.parser.registerOscHandler(52');
if (start === -1) { console.error('FAIL: OSC 52 handler not found in bundle'); process.exit(1); }
// The injection sits between the fitAddon anchor and the next original addon load.
const end = src.indexOf(',this.loadAddon(new', start);
const snippet = src.slice(start, end);

// Browser-faithful atob: throws on invalid base64 like the real one.
global.atob = (s) => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('InvalidCharacterError');
  return Buffer.from(s, 'base64').toString('binary');
};
const written = [];
// Node 22's global navigator only has a getter — defineProperty to replace it.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } },
});

let handler = null;
const fakeTerm = { parser: { registerOscHandler: (id, cb) => { if (id !== 52) throw new Error('wrong id'); handler = cb; } } };
new Function('return ' + snippet).call(fakeTerm);
if (typeof handler !== 'function') { console.error('FAIL: handler not registered'); process.exit(1); }

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failures++; };

written.length = 0;
check('copy returns true', handler('c;' + b64('hello world')) === true);
check('clipboard received text', written.length === 1 && written[0] === 'hello world');

written.length = 0;
handler('c;' + b64('héllo ✓ 日本語'));
check('multibyte UTF-8 decodes correctly', written[0] === 'héllo ✓ 日本語');

written.length = 0;
handler(';' + b64('x'));
check('empty Pc still copies', written[0] === 'x');

written.length = 0;
check('read request "c;?" ignored', handler('c;?') === true && written.length === 0);

written.length = 0;
check('no-semicolon payload ignored', handler('garbage') === true && written.length === 0);

written.length = 0;
let threw = false;
try { handler('c;!!!not-base64!!!'); } catch { threw = true; }
check('invalid base64 swallowed, no throw', !threw && written.length === 0);

written.length = 0;
check('empty Pd ignored', handler('c;') === true && written.length === 0);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
