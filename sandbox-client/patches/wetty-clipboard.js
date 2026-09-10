'use strict';
// WeTTY's xterm.js ignores OSC 52, so in-container copies (Claude Code copy
// actions, /export) never reach the browser clipboard. Injects a write-only
// OSC 52 handler into the minified client bundle; read requests ("?") are
// ignored — answering them would let program output read the clipboard.

const fs = require('fs');
const FILE = '/usr/local/lib/node_modules/wetty/build/client/wetty.js';

const src = fs.readFileSync(FILE, 'utf8');
// Also matches a future WeTTY/xterm.js registering OSC 52 natively — skip then too.
if (src.includes('registerOscHandler(52')) {
  console.log('wetty-clipboard: already patched, skipping');
  process.exit(0);
}

// Runs in the terminal constructor's comma chain (`this` = xterm Terminal).
// Payload is "Pc;Pd", Pd base64 UTF-8 — decoded via TextDecoder since bare
// atob mangles multibyte. Clipboard failures (no focus/permission) stay silent.
const handler =
  'this.parser.registerOscHandler(52,(d)=>{' +
    'const i=d.indexOf(";");' +
    'if(i<0)return true;' +
    'const b=d.slice(i+1);' +
    'if(!b||b==="?")return true;' +
    'try{' +
      'const s=atob(b),a=new Uint8Array(s.length);' +
      'for(let j=0;j<s.length;j++)a[j]=s.charCodeAt(j);' +
      'const t=new TextDecoder().decode(a);' +
      'if(t)navigator.clipboard.writeText(t).catch(()=>{});' +
    '}catch{}' +
    'return true;' +
  '})';

// Anchor uses only property names (loadAddon/fitAddon), which survive
// minification — unlike the single-letter class names around them.
const ANCHOR = 'this.loadAddon(this.fitAddon),';

const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  console.error(`wetty-clipboard: anchor found ${count}x (expected 1) — wetty version changed?`);
  process.exit(1);
}

fs.writeFileSync(FILE, src.replace(ANCHOR, ANCHOR + handler + ','));
console.log('wetty-clipboard: OSC 52 clipboard handler injected OK');
