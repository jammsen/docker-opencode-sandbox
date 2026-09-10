#!/usr/bin/env node
'use strict';
/**
 * upload-server.js — image upload companion for the agentic harness sandbox.
 *
 * Pure Node.js stdlib — zero npm packages.
 * Reuses the same self-signed TLS cert as wetty so the browser grants
 * a secure context (required for the Copy button to work).
 *
 * Listens on port 1112.
 * Saves uploads to UPLOAD_DIR (/home/agent/workspace/uploads by default).
 * Serves static assets from STATIC_DIR (/upload-server by default).
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT        = parseInt(process.env.UPLOAD_PORT || '1112', 10);
const UPLOAD_DIR  = process.env.UPLOAD_DIR  || '/home/agent/workspace/uploads';
const STATIC_DIR  = process.env.STATIC_DIR  || '/upload-server';
const MAX_BYTES   = 50 * 1024 * 1024; // 50 MB
const SSL_KEY     = process.env.SSL_KEY  || '/etc/wetty/key.pem';
const SSL_CERT    = process.env.SSL_CERT || '/etc/wetty/cert.pem';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Returns true when rawName is a safe, known image filename. */
function isValidImageName(rawName) {
  return /^[\w ()-]+\.(png|jpg|gif|webp)$/i.test(rawName);
}

// ---------------------------------------------------------------------------
// Static assets — loaded from STATIC_DIR at startup and cached in memory
// ---------------------------------------------------------------------------

const HTML_BUF = fs.readFileSync(path.join(STATIC_DIR, 'index.html'));
const CSS_BUF  = fs.readFileSync(path.join(STATIC_DIR, 'style.css'));
const JS_BUF   = fs.readFileSync(path.join(STATIC_DIR, 'app.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect image type by magic bytes. Returns 'png'|'jpg'|'gif'|'webp' or null. */
function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)                    return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)                    return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
   && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

/** YYYY-MM-DD-HH-MM-SS (local time) */
function timestamp() {
  const d = new Date();
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`
       + `-${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

/** Send a JSON response. */
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function handleRequest(req, res) {
  // Serve the upload page
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': HTML_BUF.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(HTML_BUF);
  }

  // Serve static CSS
  if (req.method === 'GET' && req.url === '/style.css') {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Content-Length': CSS_BUF.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(CSS_BUF);
  }

  // Serve static JS
  if (req.method === 'GET' && req.url === '/app.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': JS_BUF.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(JS_BUF);
  }

  // List uploaded images — newest first
  if (req.method === 'GET' && req.url === '/images') {
    const exts = new Set(['png', 'jpg', 'gif', 'webp']);
    try {
      const images = fs.readdirSync(UPLOAD_DIR)
        .filter(f => exts.has(path.extname(f).slice(1).toLowerCase()))
        .map(f => { const fp = path.join(UPLOAD_DIR, f); const st = fs.statSync(fp); return { filename: f, path: fp, mtime: st.mtimeMs, size: st.size }; })
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ filename, path: fp, size }) => ({ filename, path: fp, size }));
      return json(res, 200, { images });
    } catch (err) {
      return json(res, 500, { error: 'Could not list images' });
    }
  }

  // Serve an uploaded image by filename (thumbnails + modal)
  const imgServeMatch = req.url.match(/^\/image\/([^?#]+)$/);
  if (req.method === 'GET' && imgServeMatch) {
    let rawName;
    try { rawName = decodeURIComponent(imgServeMatch[1]); } catch { res.writeHead(400); return res.end(); }
    // Strict allow-list: no path separators or traversal — spaces and parens are fine
    if (!isValidImageName(rawName)) {
      res.writeHead(400); return res.end();
    }
    const filePath = path.join(UPLOAD_DIR, rawName);
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const mime = mimeMap[path.extname(rawName).slice(1).toLowerCase()];
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'max-age=3600, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        // Headers already sent — can't change status; just close the response cleanly.
        console.error('[upload-server] read error:', err.message);
        res.end();
      });
      stream.pipe(res);
    } catch {
      res.writeHead(404); return res.end();
    }
    return;
  }

  // Delete an uploaded image
  if (req.method === 'DELETE' && imgServeMatch) {
    let rawName;
    try { rawName = decodeURIComponent(imgServeMatch[1]); } catch { res.writeHead(400); return res.end(); }
    if (!isValidImageName(rawName)) {
      res.writeHead(400); return res.end();
    }
    const filePath = path.join(UPLOAD_DIR, rawName);
    // Defense-in-depth: confirm resolved path is inside UPLOAD_DIR
    if (!path.resolve(filePath).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
      res.writeHead(403); return res.end();
    }
    try {
      fs.unlinkSync(filePath);
      console.log('[upload-server] deleted:', filePath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 404, { error: 'File not found or already deleted' });
    }
  }

  // Accept an uploaded image
  if (req.method === 'POST' && req.url === '/upload') {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (isNaN(contentLength) || contentLength > MAX_BYTES) {
      return json(res, 413, { error: 'File too large (max 50 MB)' });
    }

    // Stream directly to a temp file — avoids holding 2× file size in RAM
    // when multiple concurrent uploads arrive in parallel.
    const rand    = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    const tmpPath = path.join(UPLOAD_DIR, `.tmp-${timestamp()}-${rand}`);
    const ws      = fs.createWriteStream(tmpPath);

    let received = 0;
    let ext      = null; // set from magic bytes on first chunk; '' means check failed
    // Guard: ensure only one response is ever sent regardless of event ordering.
    // req.destroy() can trigger 'error' immediately after 'data',
    // and a client abort can fire 'error' after 'end' — both would double-write.
    let responded = false;
    const respond = (code, body) => { if (responded) return; responded = true; json(res, code, body); };
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* already gone */ } };

    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BYTES) {
        ws.destroy();
        cleanup();
        // Send 413 before tearing down so the client gets an error body, not a TCP reset.
        respond(413, { error: 'File too large (max 50 MB)' });
        req.destroy();
        return;
      }
      if (ext === null) {
        ext = imageExt(chunk) || '';
        if (!ext) {
          ws.destroy();
          cleanup();
          respond(400, { error: 'Not a valid image — PNG, JPEG, GIF or WEBP only' });
          req.destroy();
          return;
        }
      }
      if (!responded) ws.write(chunk);
    });

    req.on('end', () => {
      if (responded) return;
      ws.end(() => {
        if (responded) { cleanup(); return; }
        if (!ext) {
          cleanup();
          return respond(400, { error: 'Not a valid image — PNG, JPEG, GIF or WEBP only' });
        }
        // Append a 4-hex random suffix to survive same-second concurrent uploads.
        const dest = path.join(UPLOAD_DIR, `${timestamp()}-${rand}.${ext}`);
        try {
          fs.renameSync(tmpPath, dest);
        } catch (err) {
          cleanup();
          console.error('[upload-server] rename error:', err.message);
          return respond(500, { error: 'Failed to save file' });
        }
        console.log(`[upload-server] saved: ${dest}`);
        respond(200, { path: dest });
      });
    });

    req.on('error', () => { ws.destroy(); cleanup(); respond(400, { error: 'Request stream error' }); });
    ws.on('error', (err) => {
      console.error('[upload-server] write error:', err.message);
      cleanup();
      respond(500, { error: 'Failed to save file' });
      req.destroy();
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

// ---------------------------------------------------------------------------
// Start server — HTTPS only (reuses wetty's self-signed cert).
// HTTP fallback is intentionally absent: the clipboard API and the WeTTY
// iframe embed both require a secure context. Failing loudly is safer than
// silently serving a broken page over HTTP.
// ---------------------------------------------------------------------------

if (!fs.existsSync(SSL_KEY) || !fs.existsSync(SSL_CERT)) {
  console.error(`[upload-server] TLS cert not found at ${SSL_KEY} / ${SSL_CERT} — cannot start.`);
  console.error('[upload-server] The upload page requires HTTPS for clipboard access and iframe embedding.');
  process.exit(1);
}

const server = https.createServer(
  { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) },
  handleRequest
);
server.listen(PORT, '0.0.0.0', () =>
  console.log(`[upload-server] HTTPS on port ${PORT}, saving to ${UPLOAD_DIR}`)
);
