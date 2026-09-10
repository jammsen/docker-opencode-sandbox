'use strict';
// The terminal's real defaults are the bundle's `mi` object, which ships no theme key at
// all — so xterm.js falls back to its own black-on-white palette. xterm_config/
// xterm_defaults.js only seeds the settings-panel iframe; the bundle never loads it
// (`grep -c xterm_defaults wetty.js` == 0), so editing that file alone changes nothing.
// Keep the palette in sync with config/wetty/xterm_defaults.js, which is what the panel shows.
//
// Must run AFTER wetty-font.js: that patch anchors on `mi={xterm:{fontSize:14`, which this
// one would break by injecting ahead of it.
// Only affects the DEFAULTS — a user's saved settings in WeTTY's panel (localStorage) still override.

const fs = require('fs');
const BUNDLE = '/usr/local/lib/node_modules/wetty/build/client/wetty.js';

// Windows Terminal "Dark+", verbatim from microsoft/terminal defaults.json.
// WT's purple/brightPurple are xterm.js's magenta/brightMagenta. WT's selectionBackground is
// an opaque #ffffff — it blends, xterm.js does not and would hide the selected text.
const THEME = {
  foreground: '#cccccc',
  background: '#1e1e1e',
  cursor: '#808080',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#ffffff4d',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

const src = fs.readFileSync(BUNDLE, 'utf8');
if (src.includes(THEME.background)) {
  console.log('wetty-theme: already patched, skipping');
  process.exit(0);
}
const ANCHOR = 'mi={xterm:{';
if (!src.includes(ANCHOR)) {
  console.error('wetty-theme: bundle anchor not found — wetty version changed?');
  process.exit(1);
}
fs.writeFileSync(BUNDLE, src.replace(ANCHOR, `${ANCHOR}theme:${JSON.stringify(THEME)},`));
console.log('wetty-theme: Dark+ palette patched into bundle defaults OK');
