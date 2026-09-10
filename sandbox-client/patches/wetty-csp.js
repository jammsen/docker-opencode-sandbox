'use strict';
// WeTTY sets strict browser security headers that block loading external content in iframes.
// This patch adds an explicit allow-rule so the upload server (port 1112) can be embedded
// inside WeTTY's page without the browser blocking it. The rule is built at request time
// using the actual hostname, so no IP address is hardcoded in the image.

const fs = require('fs');
const FILE = '/usr/local/lib/node_modules/wetty/build/server/socketServer/security.js';

const src = fs.readFileSync(FILE, 'utf8');
// Check for the specific string we inject, not just any frameSrc — a future WeTTY
// version adding its own frameSrc rule would otherwise silently skip our :1112 allow-rule.
if (src.includes('hostname}:1112')) {
  console.log('wetty-csp: already patched, skipping');
  process.exit(0);
}

const patched = src.replace(
  'connectSrc: [',
  'frameSrc: ["\'self\'", `${req.protocol}://${req.hostname}:1112`],\n                connectSrc: ['
);

if (patched === src) {
  console.error('wetty-csp: marker "connectSrc: [" not found — wetty version changed?');
  process.exit(1);
}

fs.writeFileSync(FILE, patched);
console.log('wetty-csp: frameSrc patched OK');
