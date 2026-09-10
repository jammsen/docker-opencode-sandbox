'use strict';
// Injects the image-upload overlay panel into WeTTY's generated HTML page.
// Adds a toggle button next to the settings icon and a slide-in drawer with
// an iframe pointing at the upload server on port 1112.

const fs = require('fs');
const FILE = '/usr/local/lib/node_modules/wetty/build/server/socketServer/html.js';

const src = fs.readFileSync(FILE, 'utf8');
if (src.includes('id="ub"')) {
  console.log('wetty-html: already patched, skipping');
  process.exit(0);
}

// ── Upload toggle button (injected before the xterm iframe) ──────────────────
const btn = `<a id="ub" href="#" class="toggler" title="Upload Images" style="top:36px;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" fill="currentColor" width="1em" height="1em"><path d="M246.6 9.4c-12.5-12.5-32.8-12.5-45.3 0l-128 128c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 109.3 192 320c0 17.7 14.3 32 32 32s32-14.3 32-32l0-210.7 73.4 73.4c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3l-128-128zM64 352c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 64c0 53 43 96 96 96l256 0c53 0 96-43 96-96l0-64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 64c0 17.7-14.3 32-32 32L96 448c-17.7 0-32-14.3-32-32l0-64z"/></svg></a>`;

// ── Overlay panel HTML ───────────────────────────────────────────────────────
const overlay = `<div id="upload-overlay"><div id="upload-panel"><div id="upload-resize-handle"></div><div id="upload-panel-header"><span>Image Upload</span><a id="upload-newtab" href="#" target="_blank" rel="noopener" title="Open in new tab">↗</a><button id="upload-panel-close">✕</button></div><div id="upload-ssl-hint">Panel blank or blocked? Click <b>↗</b> above → accept the SSL certificate in the new tab → return here.</div><iframe id="upload-frame" src="about:blank" frameborder="0" allow="clipboard-write"></iframe></div></div>`;

// ── Overlay styles ───────────────────────────────────────────────────────────
const css = `<style>
#upload-overlay{display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.55);}
#upload-overlay.open{display:flex;align-items:center;justify-content:flex-end;}
#upload-panel{position:relative;height:100%;width:min(480px,100vw);min-width:min(320px,100vw);background:#1a1d2e;border-left:1px solid #2d3148;display:flex;flex-direction:column;box-shadow:-8px 0 32px rgba(0,0,0,.7);}
#upload-resize-handle{position:absolute;top:0;left:-8px;bottom:0;width:8px;cursor:ew-resize;z-index:10;}
#upload-resize-handle:hover,#upload-resize-handle.dragging{background:rgba(129,140,248,.25);}
#upload-panel-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #2d3148;font-size:.85rem;color:#a5b4fc;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;user-select:none;}
#upload-newtab{color:#475569;text-decoration:none;padding:2px 6px;border-radius:4px;font-size:.9rem;line-height:1;margin-left:auto;}
#upload-newtab:hover{background:#2d3148;color:#94a3b8;}
#upload-panel-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:1rem;padding:2px 6px;border-radius:4px;line-height:1;margin-left:4px;}
#upload-panel-close:hover{background:#2d3148;color:#94a3b8;}
#upload-ssl-hint{padding:7px 14px;font-size:.72rem;color:#64748b;background:#0f1117;border-bottom:1px solid #2d3148;text-align:center;line-height:1.5;}
#upload-ssl-hint b{color:#818cf8;font-weight:600;}
#upload-frame{flex:1;border:none;width:100%;}
</style>`;

// ── Overlay behaviour (plain ES5, runs in the WeTTY page context) ────────────
const js = `<script>(function(){
  var o   = document.getElementById("upload-overlay"),
      fr  = document.getElementById("upload-frame"),
      b   = document.getElementById("upload-panel-close"),
      nt  = document.getElementById("upload-newtab"),
      ic  = document.getElementById("ub"),
      u   = location.protocol + "//" + location.hostname + ":1112";

  nt.href = u;

  function op() { if (fr.src !== u) fr.src = u; o.classList.add("open"); }
  function cl() { o.classList.remove("open"); }

  ic.addEventListener("click", function(e) {
    e.preventDefault();
    o.classList.contains("open") ? cl() : op();
  });
  o.addEventListener("click", function(e) {
    if (e.target === o && !_wasResizing) cl();
  });
  b.addEventListener("click", cl);
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && o.classList.contains("open")) cl();
  });
  window.addEventListener("message", function(e) {
    if (e.data === "upload-ready") {
      var h = document.getElementById("upload-ssl-hint");
      if (h) h.style.display = "none";
    }
  });

  // ── Resize handle ──────────────────────────────────────────────────────────
  var rh = document.getElementById("upload-resize-handle"),
      pn = document.getElementById("upload-panel"),
      _sx, _sw, _wasResizing;

  rh.addEventListener("mousedown", function(e) {
    _sx = e.clientX; _sw = pn.offsetWidth;
    rh.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", _rm);
    document.addEventListener("mouseup", _ru);
    e.preventDefault();
  });
  function _rm(e) {
    var dx = _sx - e.clientX,
        maxW = Math.floor(window.innerWidth * 0.5),
        minW = Math.min(320, window.innerWidth),
        nw = Math.min(maxW, Math.max(minW, _sw + dx));
    pn.style.width = nw + "px";
  }
  function _ru() {
    rh.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", _rm);
    document.removeEventListener("mouseup", _ru);
    _wasResizing = true;
    setTimeout(function() { _wasResizing = false; }, 0);
  }
}());<\/script>`;

// ── Apply patches ────────────────────────────────────────────────────────────
let patched = src
  .replace('<iframe class="editor"', btn + '<iframe class="editor"')
  .replace('</body>', overlay + css + js + '</body>');

if (!patched.includes('id="ub"') || !patched.includes('upload-overlay')) {
  console.error('wetty-html: patch markers not found — wetty version changed?');
  process.exit(1);
}

fs.writeFileSync(FILE, patched);
console.log('wetty-html: upload overlay injected OK');
