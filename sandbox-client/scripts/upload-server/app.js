'use strict';

// --- State ---
let queue = [];
let nextId = 0;

// --- DOM refs ---
const dropZone     = document.getElementById('dropZone');
const fileInput    = document.getElementById('fileInput');
const queueSection = document.getElementById('queueSection');
const queueGrid    = document.getElementById('queueGrid');
const queueCount   = document.getElementById('queueCount');
const btnUpload    = document.getElementById('btnUpload');
const btnClearAll  = document.getElementById('btnClearAll');

// --- Helpers ---

function fmtBytes(n) {
  if (n < 1024)    return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function copyText(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash(btn)).catch(() => fallbackCopy(text, btn));
  } else {
    fallbackCopy(text, btn);
  }
}

function fallbackCopy(text, btn) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  flash(btn);
}

function flash(btn) {
  const orig = btn.textContent;
  btn.textContent = 'Copied!';
  btn.classList.add('ok');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('ok'); }, 2000);
}

// --- Queue management ---

function addFiles(fileList) {
  const MAX = 50 * 1024 * 1024;
  let added = 0;
  Array.from(fileList).forEach(file => {
    if (!file.type.startsWith('image/')) return;
    const oversized = file.size > MAX;
    const item = {
      id:      nextId++,
      file,
      preview: null,
      status:  oversized ? 'error' : 'pending',
      error:   oversized ? 'File exceeds 50 MB limit' : null,
      path:    null,
    };
    queue.push(item);
    added++;
    if (!oversized) {
      // createObjectURL is a cheap pointer into the browser's file cache — no base64 copy in JS memory.
      item.preview = URL.createObjectURL(file);
    }
  });
  if (added) renderQueue();
}

function removeFromQueue(id) {
  const item = queue.find(i => i.id === id);
  if (item && item.preview) URL.revokeObjectURL(item.preview);
  queue = queue.filter(i => i.id !== id);
  renderQueue();
}

function clearAll() {
  queue.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); });
  queue = [];
  renderQueue();
}

function renderQueue() {
  queueGrid.innerHTML = '';

  queue.forEach(item => {
    const wrapper = document.createElement('div');
    wrapper.className = 'queue-item ' + item.status;

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'queue-thumb';

    if (item.preview) {
      const img = document.createElement('img');
      img.src = item.preview;
      img.alt = item.file.name;
      thumb.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'queue-thumb-placeholder';
      ph.textContent = '🖼';
      thumb.appendChild(ph);
    }

    // Status overlay
    if (item.status === 'uploading') {
      const spinner = document.createElement('div');
      spinner.className = 'queue-spinner';
      thumb.appendChild(spinner);
    } else if (item.status === 'done') {
      const badge = document.createElement('div');
      badge.className = 'queue-badge done';
      badge.textContent = '✓';
      thumb.appendChild(badge);
    } else if (item.status === 'error') {
      const badge = document.createElement('div');
      badge.className = 'queue-badge error';
      badge.textContent = '✗';
      thumb.appendChild(badge);
    }

    // Remove button (not visible while uploading)
    if (item.status !== 'uploading') {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'queue-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', e => { e.stopPropagation(); removeFromQueue(item.id); });
      thumb.appendChild(removeBtn);
    }

    // Click thumbnail to preview in modal
    if (item.preview) {
      thumb.setAttribute('tabindex', '0');
      thumb.setAttribute('role', 'button');
      thumb.setAttribute('aria-label', 'Preview ' + item.file.name);
      const openThumbModal = () => openModal({
        src:  item.preview,
        name: item.file.name,
        size: item.file.size,
        path: item.path || null,
      });
      thumb.addEventListener('click', openThumbModal);
      thumb.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThumbModal(); }
      });
    } else {
      thumb.style.cursor = 'default';
    }

    wrapper.appendChild(thumb);

    // Filename
    const nameEl = document.createElement('div');
    nameEl.className = 'queue-name';
    nameEl.textContent = item.file.name;
    wrapper.appendChild(nameEl);

    // Path + copy (shown after successful upload)
    if (item.status === 'done' && item.path) {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'queue-result';

      const pathSpan = document.createElement('span');
      pathSpan.className = 'queue-path';
      pathSpan.textContent = item.path;
      resultDiv.appendChild(pathSpan);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'queue-copy';
      copyBtn.textContent = 'Copy prompt';
      const prompt = 'Analyze the image at ' + item.path + ' and describe what you see.';
      copyBtn.addEventListener('click', e => { e.stopPropagation(); copyText(prompt, copyBtn); });
      resultDiv.appendChild(copyBtn);

      wrapper.appendChild(resultDiv);
    }

    // Error text (shown on failure)
    if (item.status === 'error' && item.error) {
      const errEl = document.createElement('div');
      errEl.className = 'queue-error-text';
      errEl.textContent = item.error;
      wrapper.appendChild(errEl);
    }

    queueGrid.appendChild(wrapper);
  });

  // Update count label and upload button
  const pending = queue.filter(i => i.status === 'pending').length;
  const total   = queue.length;

  queueCount.textContent = total === 1 ? '1 image in queue' : total + ' images in queue';

  if (pending === 0) {
    btnUpload.disabled = true;
    btnUpload.textContent = 'Upload';
  } else if (pending === 1) {
    btnUpload.disabled = false;
    btnUpload.textContent = 'Upload 1 image';
  } else {
    btnUpload.disabled = false;
    btnUpload.textContent = 'Upload ' + pending + ' images';
  }

  queueSection.style.display = total > 0 ? '' : 'none';
}

// --- Upload ---

async function uploadOne(item) {
  item.status = 'uploading';
  renderQueue();
  try {
    const res  = await fetch('/upload', {
      method:  'POST',
      headers: { 'Content-Type': item.file.type },
      body:    item.file,
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      item.status = 'error';
      item.error  = data.error || 'Upload failed (HTTP ' + res.status + ')';
    } else {
      item.status = 'done';
      item.path   = data.path;
    }
  } catch (err) {
    item.status = 'error';
    item.error  = 'Network error: ' + err.message;
  }
  renderQueue();
}

async function doUpload() {
  const pending = queue.filter(i => i.status === 'pending');
  if (!pending.length) return;
  btnUpload.disabled = true;
  await Promise.allSettled(pending.map(item => uploadOne(item)));
  renderQueue();
  loadGallery();
}

// --- Drop zone & file input events ---

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
['dragleave', 'dragend'].forEach(ev =>
  dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'))
);
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

document.addEventListener('paste', e => {
  const items = Array.from((e.clipboardData || {}).items || []);
  const imgs  = items.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (imgs.length) addFiles(imgs);
});

btnUpload.addEventListener('click', doUpload);
btnClearAll.addEventListener('click', clearAll);

// --- Modal ---

const modalEl          = document.getElementById('modal');
const modalImgEl       = document.getElementById('modalImg');
const modalNameEl      = document.getElementById('modalName');
const modalPathRowEl   = document.getElementById('modalPathRow');
const modalPromptRowEl = document.getElementById('modalPromptRow');
const modalDeleteRowEl = document.getElementById('modalDeleteRow');
const modalPathEl      = document.getElementById('modalPath');
const modalPromptEl    = document.getElementById('modalPrompt');
let _modalCurrentFile  = null;

function openModal(opts) {
  // opts: { src, name, size, path (optional), isGallery (optional), filename (optional) }
  if (!opts.src) return;

  modalImgEl.src = opts.src;
  modalNameEl.textContent = opts.name || '';
  modalImgEl.onload = function() {
    const dims    = modalImgEl.naturalWidth + ' \xd7 ' + modalImgEl.naturalHeight + ' px';
    const sizeStr = opts.size != null ? '  \xb7  ' + fmtBytes(opts.size) : '';
    modalNameEl.textContent = (opts.name || '') + '  \xb7  ' + dims + sizeStr;
  };

  if (opts.path) {
    modalPathRowEl.style.display   = '';
    modalPromptRowEl.style.display = '';
    modalPathEl.textContent   = opts.path;
    modalPromptEl.textContent = 'Analyze the image at ' + opts.path + ' and describe what you see.';
  } else {
    modalPathRowEl.style.display   = 'none';
    modalPromptRowEl.style.display = 'none';
  }

  if (opts.isGallery && opts.filename) {
    modalDeleteRowEl.style.display = '';
    _modalCurrentFile = opts.filename;
    const btnDel = document.getElementById('btnModalDelete');
    btnDel.textContent = '🗑 Delete image';
    btnDel.classList.remove('confirming');
  } else {
    modalDeleteRowEl.style.display = 'none';
    _modalCurrentFile = null;
  }

  modalEl.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalEl.classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => { modalImgEl.src = ''; }, 200);
}

document.getElementById('btnModalClose').addEventListener('click', closeModal);
document.getElementById('modalBackdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

document.getElementById('btnModalCopyPath').addEventListener('click', function() {
  copyText(modalPathEl.textContent, this);
});
document.getElementById('btnModalCopyPrompt').addEventListener('click', function() {
  copyText(modalPromptEl.textContent, this);
});

document.getElementById('btnModalDelete').addEventListener('click', function() {
  if (!this.classList.contains('confirming')) {
    this.textContent = 'Confirm delete?';
    this.classList.add('confirming');
    setTimeout(() => {
      this.textContent = '🗑 Delete image';
      this.classList.remove('confirming');
    }, 3000);
    return;
  }
  const filename = _modalCurrentFile;
  if (!filename) return;
  fetch('/image/' + encodeURIComponent(filename), { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.error) { alert('Delete failed: ' + data.error); return; }
      closeModal();
      loadGallery();
    })
    .catch(() => alert('Delete request failed.'));
});

// --- Gallery ---

const galleryGrid  = document.getElementById('galleryGrid');
const galleryEmpty = document.getElementById('galleryEmpty');

async function loadGallery() {
  try {
    const res  = await fetch('/images');
    const data = await res.json();
    renderGallery(data.images || []);
  } catch { /* ignore network errors */ }
}

function renderGallery(images) {
  galleryGrid.innerHTML = '';
  if (!images.length) {
    galleryEmpty.style.display = '';
    galleryGrid.style.display  = 'none';
    return;
  }
  galleryEmpty.style.display = 'none';
  galleryGrid.style.display  = 'flex';
  images.forEach(item => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.setAttribute('tabindex', '0');
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label', 'Preview ' + item.filename);
    const img = document.createElement('img');
    img.src     = '/image/' + encodeURIComponent(item.filename);
    img.alt     = item.filename;
    img.loading = 'lazy';
    div.appendChild(img);
    const openGalleryModal = () => openModal({
      src:      '/image/' + encodeURIComponent(item.filename),
      name:     item.filename,
      size:     item.size,
      path:     item.path,
      isGallery: true,
      filename:  item.filename,
    });
    div.addEventListener('click', openGalleryModal);
    div.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGalleryModal(); }
    });
    galleryGrid.appendChild(div);
  });
}

document.getElementById('btnRefresh').addEventListener('click', loadGallery);

// --- Init ---
loadGallery();
if (window.parent !== window) window.parent.postMessage('upload-ready', '*');
