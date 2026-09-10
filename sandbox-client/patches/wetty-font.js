'use strict';
// WeTTY defaults to 'courier-new, courier, monospace', whose symbol coverage is
// poor — Claude Code's marker glyphs (U+2058 ⁘, U+2731 ✱, braille spinners)
// render as missing-glyph boxes. Front-load fonts with wide symbol coverage;
// the browser falls back through the stack per glyph.
// Only affects the DEFAULTS — a user's saved settings in WeTTY's panel
// (localStorage) still override.

const fs = require('fs');
const BUNDLE   = '/usr/local/lib/node_modules/wetty/build/client/wetty.js';
const DEFAULTS = '/usr/local/lib/node_modules/wetty/build/client/xterm_config/xterm_defaults.js';

const STACK = "'Cascadia Mono', Consolas, Menlo, 'DejaVu Sans Mono', 'Noto Sans Mono', 'Segoe UI Symbol', monospace";

let src = fs.readFileSync(BUNDLE, 'utf8');
if (src.includes('Cascadia Mono')) {
  console.log('wetty-font: already patched, skipping');
  process.exit(0);
}
const ANCHOR = 'mi={xterm:{fontSize:14';
if (!src.includes(ANCHOR)) {
  console.error('wetty-font: bundle anchor not found — wetty version changed?');
  process.exit(1);
}
fs.writeFileSync(BUNDLE, src.replace(ANCHOR, `mi={xterm:{fontFamily:"${STACK}",fontSize:14`));

src = fs.readFileSync(DEFAULTS, 'utf8');
const OLD_FONT = "fontFamily: 'courier-new, courier, monospace',";
if (!src.includes(OLD_FONT)) {
  console.error('wetty-font: defaults anchor not found — wetty version changed?');
  process.exit(1);
}
fs.writeFileSync(DEFAULTS, src.replace(OLD_FONT, `fontFamily: "${STACK}",`));
console.log('wetty-font: default font stack patched OK');
