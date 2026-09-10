#!/usr/bin/env node
'use strict';
/**
 * analyze-image — direct vLLM vision analysis for opencode / OMP.
 *
 * Reads an image file, sends it to vLLM as a base64 image_url vision request,
 * and prints the model's description to stdout.
 *
 * Usage: analyze-image <path-to-image>
 */

const fs   = require('fs');
const http = require('http');

const imagePath = process.argv[2];
if (!imagePath) {
  process.stderr.write('Usage: analyze-image <path-to-image> [prompt]\n');
  process.exit(1);
}
const userPrompt = process.argv[3] || 'Describe this image in detail. What do you see?';

// Explicit vision call — always target the catalog's vision role (config/models/models.yml, read
// via its rendered models.json so a wizard change applies to the next call). Env VISION_MODEL_URL/
// _ID (or MODEL_URL/_ID) remain the fallback when there is no catalog.
function visionFromCatalog() {
  const file = process.env.MODELS_FILE || `${process.env.HOME || '/home/agent'}/.config/models/models.json`;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ref = String(raw.roles?.vision || raw.roles?.brain || ''); const i = ref.indexOf('/');   // no vision role -> the brain, if it can see
    if (i <= 0) return null;
    const srv = raw.servers?.[ref.slice(0, i)], id = ref.slice(i + 1);
    return srv?.url && srv.models?.[id]?.vision === true ? { url: srv.url, id } : null;
  } catch { return null; }
}
const fromCatalog = visionFromCatalog();
const API_URL = fromCatalog?.url || process.env.VISION_MODEL_URL || process.env.MODEL_URL;
const MODEL   = fromCatalog?.id  || process.env.VISION_MODEL_ID  || process.env.MODEL_ID;
if (!API_URL || !MODEL) {
  process.stderr.write('Error: no vision model configured — run "model configuration" from the session menu\n');
  process.exit(1);
}
const REQUEST_TIMEOUT_MS = parseInt(process.env.MODEL_REQUEST_TIMEOUT_MS || '300000', 10); // 5 min

function mimeFromMagic(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)                    return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)                    return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length > 11 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

let imageData;
try {
  imageData = fs.readFileSync(imagePath);
} catch (e) {
  process.stderr.write('Error reading file: ' + e.message + '\n');
  process.exit(1);
}

const mime = mimeFromMagic(imageData);
if (!mime) {
  process.stderr.write('Error: ' + imagePath + ' is not a valid PNG, JPEG, GIF, or WEBP image.\n');
  process.exit(1);
}
const dataUrl = 'data:' + mime + ';base64,' + imageData.toString('base64');

const payload = JSON.stringify({
  model: MODEL,
  messages: [{
    role:    'user',
    content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text',      text: userPrompt },
    ],
  }],
  max_tokens: 2048,
});

const base = API_URL.endsWith('/') ? API_URL : API_URL + '/';
const upstreamUrl = new URL('chat/completions', base);
const options = {
  hostname: upstreamUrl.hostname,
  port:     parseInt(upstreamUrl.port || '80', 10),
  path:     upstreamUrl.pathname,
  method:   'POST',
  headers:  {
    'Content-Type':   'application/json',
    'Authorization':  'Bearer dummy',
    'Content-Length': Buffer.byteLength(payload),
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (result.error) {
        process.stderr.write('API error: ' + JSON.stringify(result.error) + '\n');
        process.exit(1);
      }
      const content = result.choices?.[0]?.message?.content;
      if (content) {
        process.stdout.write(content + '\n');
      } else {
        process.stderr.write('Unexpected response: ' + data + '\n');
        process.exit(1);
      }
    } catch (e) {
      process.stderr.write('Parse error: ' + e.message + '\n' + data + '\n');
      process.exit(1);
    }
  });
});

req.setTimeout(REQUEST_TIMEOUT_MS, () => {
  req.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
});

req.on('error', (e) => {
  process.stderr.write('Request error: ' + e.message + '\n');
  process.exit(1);
});

req.write(payload);
req.end();
