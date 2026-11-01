(() => {
  const picaInstance = typeof window.pica === 'function' ? window.pica() : null;

  const $ = s => document.querySelector(s);
  const workspace = $('#workspace');
  const canvasWrap = $('#canvasWrap');
  const canvas = $('#mainCanvas');
  const ctx = canvas.getContext('2d');
  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  const openLabel = $('#openLabel');
  const fileNameBadge = $('#fileNameBadge');
  const cropOverlay = $('#cropOverlay');
  const cropSelection = $('#cropSelection');
  const cropBadge = $('#cropBadge');
  const cropActions = $('#cropActions');
  const infoSize = $('#infoSize');
  const toastEl = $('#toast');

  const btnCrop = $('#btnCrop');
  const btnResize = $('#btnResize');
  const btnRotateCW = $('#btnRotateCW');
  const btnRotateCCW = $('#btnRotateCCW');
  const btnFlipH = $('#btnFlipH');
  const btnFlipV = $('#btnFlipV');
  const btnAdjust = $('#btnAdjust');
  const btnFilters = $('#btnFilters');
  const btnFitView = $('#btnFitView');
  const zoomControls = $('#zoomControls');
  const btnZoomIn = $('#btnZoomIn');
  const btnZoomOut = $('#btnZoomOut');
  const btnZoomReset = $('#btnZoomReset');
  const zoomLevel = $('#zoomLevel');
  const btnUndo = $('#btnUndo');
  const btnRedo = $('#btnRedo');
  const btnRevert = $('#btnRevert');
  const btnExport = $('#btnExport');
  const btnCopy = $('#btnCopy');
  const btnCropApply = $('#btnCropApply');
  const btnCropCancel = $('#btnCropCancel');

  const adjustPanel = $('#adjustPanel');
  const filtersPanel = $('#filtersPanel');
  const resizePanel = $('#resizePanel');

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

  const MAX_SIDE = 16384;
  const MAX_PIXELS = isIOS ? 16e6 : 100e6;
  const HISTORY_BUDGET_BYTES = (isIOS || isTouchDevice ? 192 : 512) * 1024 * 1024;
  const MAX_HISTORY = 50;
  const MIN_CROP = 4;
  const PIXELATED_ZOOM = 3;

  let hasImage = false;
  let busy = false;
  let dirty = false;
  let fileBaseName = 'image';
  let originalCanvas = null;
  let loadToken = 0;

  let history = [];
  let historyIdx = -1;

  let zoom = 1;
  let panX = 0, panY = 0;
  let dragSize = null;

  let tool = 'idle';
  const resizeHandles = canvasWrap.querySelectorAll('.resize-handle');

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function releaseCanvas(c) {
    if (c) { c.width = 0; c.height = 0; }
  }

  function copyOfCanvas(src) {
    const c = makeCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  function sizeAllowed(w, h) {
    return w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
  }


  function updateInfo() {
    if (!hasImage) { infoSize.textContent = ''; zoomLevel.textContent = ''; return; }
    infoSize.textContent = dragSize
      ? `${dragSize.w} × ${dragSize.h}`
      : `${canvas.width} × ${canvas.height}`;
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  }

  const editBtns = () => [btnCrop, btnResize, btnRotateCW, btnRotateCCW, btnFlipH, btnFlipV,
    btnAdjust, btnFilters, btnFitView, btnExport, btnCopy];

  function refreshButtons() {
    const on = hasImage && !busy;
    editBtns().forEach(b => b.disabled = !on);
    zoomControls.classList.toggle('visible', hasImage);
    btnUndo.disabled = !on || historyIdx <= 0;
    btnRedo.disabled = !on || historyIdx >= history.length - 1;
    btnRevert.disabled = !on || !originalCanvas;
    btnCrop.classList.toggle('active', tool === 'crop');
    btnResize.classList.toggle('active', tool === 'resize');
    btnAdjust.classList.toggle('active', tool === 'adjust');
    btnFilters.classList.toggle('active', tool === 'filters');
    btnCrop.setAttribute('aria-pressed', tool === 'crop');
    btnResize.setAttribute('aria-pressed', tool === 'resize');
    btnAdjust.setAttribute('aria-pressed', tool === 'adjust');
    btnFilters.setAttribute('aria-pressed', tool === 'filters');
    workspace.setAttribute('aria-busy', busy);
  }

  function setBusy(on) {
    busy = on;
    document.body.style.cursor = on ? 'progress' : '';
    refreshButtons();
  }

  function setPressed(group, active) {
    group.forEach(b => {
      const on = b === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
  }


  const entryBytes = e => e.width * e.height * 4;

  function pushHistory() {
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    history = history.slice(0, historyIdx + 1);
    history.push(snap);
    let total = history.reduce((s, e) => s + entryBytes(e), 0);
    while (history.length > 1 && (history.length > MAX_HISTORY || total > HISTORY_BUDGET_BYTES)) {
      total -= entryBytes(history.shift());
    }
    historyIdx = history.length - 1;
    dirty = true;
    refreshButtons();
  }

  const currentEntry = () => history[historyIdx];

  function showCurrentEntry() {
    const snap = currentEntry();
    if (canvas.width !== snap.width || canvas.height !== snap.height) {
      canvas.width = snap.width;
      canvas.height = snap.height;
    }
    ctx.putImageData(snap, 0, 0);
  }

  function restoreFromHistory() {
    const oldW = canvas.width, oldH = canvas.height;
    showCurrentEntry();
    dirty = true;
    if (canvas.width !== oldW || canvas.height !== oldH) fitToView();
    else applyTransform();
    afterGeometryChange();
    refreshButtons();
  }


  function confirmDiscard() {
    return !hasImage || !dirty || historyIdx <= 0 ||
      window.confirm('Replace the current image? Unsaved edits will be lost.');
  }

  function baseNameOf(name) {
    const n = (name || 'image').replace(/\.[^.]+$/, '').trim();
    return n || 'image';
  }

  function loadImageFromUrl(url, name, revoke) {
    const token = ++loadToken;
    setBusy(true);
    const img = new Image();
    img.onload = () => {
      if (revoke) URL.revokeObjectURL(url);
      if (token !== loadToken) return;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) { setBusy(false); toast('This image has no size and cannot be opened'); return; }
      const scale = Math.min(1, MAX_SIDE / nw, MAX_SIDE / nh, Math.sqrt(MAX_PIXELS / (nw * nh)));
      const w = Math.max(1, Math.floor(nw * scale));
      const h = Math.max(1, Math.floor(nh * scale));
      const loaded = makeCanvas(w, h);
      const lctx = loaded.getContext('2d');
      lctx.imageSmoothingQuality = 'high';
      lctx.drawImage(img, 0, 0, w, h);
      try {
        lctx.getImageData(0, 0, 1, 1);
      } catch {
        releaseCanvas(loaded);
        setBusy(false);
        toast('Browser blocked reading this image. Serve the folder over HTTP.');
        return;
      }
      setTool('idle');
      closeExportPanel();
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(loaded, 0, 0);
      releaseCanvas(originalCanvas);
      originalCanvas = loaded;
      history = [];
      historyIdx = -1;
      hasImage = true;
      pushHistory();
      dirty = false;
      fileBaseName = baseNameOf(name);
      fileNameBadge.textContent = name || '';
      fileNameBadge.title = name || '';

      dropZone.classList.add('hidden');
      canvasWrap.style.display = '';
      setBusy(false);
      fitToView();
      if (scale < 1) toast(`Large image reduced from ${nw} × ${nh} to ${w} × ${h} to fit this device`);
    };
    img.onerror = () => {
      if (revoke) URL.revokeObjectURL(url);
      if (token !== loadToken) return;
      setBusy(false);
      toast('Could not decode this image format');
    };
    img.src = url;
  }

  function loadImage(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) { toast('Not an image file'); return; }
    if (!confirmDiscard()) return;
    loadImageFromUrl(URL.createObjectURL(file), file.name, true);
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadImage(fileInput.files[0]);
    fileInput.value = '';
  });

  openLabel.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  dropZone.addEventListener('click', () => fileInput.click());

  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    dragDepth++;
    workspace.classList.add('drag-over');
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) workspace.classList.remove('drag-over');
  });
  window.addEventListener('dragover', e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    workspace.classList.remove('drag-over');
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) loadImage(file);
  });

  window.addEventListener('paste', e => {
    if (e.target.matches && e.target.matches('input[type="text"], input[type="number"], textarea')) return;
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const item = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    if (!confirmDiscard()) return;
    loadImageFromUrl(URL.createObjectURL(file), 'pasted-image', true);
  });

  window.addEventListener('beforeunload', e => {
    if (hasImage && dirty && historyIdx > 0) { e.preventDefault(); e.returnValue = ''; }
  });


  let transformQueued = false;
  function applyTransform() {
    const w = (dragSize ? dragSize.w : canvas.width) * zoom;
    const h = (dragSize ? dragSize.h : canvas.height) * zoom;
    canvasWrap.style.width = w + 'px';
    canvasWrap.style.height = h + 'px';
    canvasWrap.style.left = panX + 'px';
    canvasWrap.style.top = panY + 'px';
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.classList.toggle('pixelated', zoom >= PIXELATED_ZOOM);
    updateInfo();
  }

  function scheduleTransform() {
    if (transformQueued) return;
    transformQueued = true;
    requestAnimationFrame(() => { transformQueued = false; applyTransform(); });
  }

  function fitToView() {
    if (!hasImage) return;
    const pad = 60;
    const ww = Math.max(1, workspace.clientWidth - pad * 2);
    const wh = Math.max(1, workspace.clientHeight - pad * 2);
    zoom = clamp(Math.min(ww / canvas.width, wh / canvas.height, 2), 0.01, 20);
    panX = (workspace.clientWidth - canvas.width * zoom) / 2;
    panY = (workspace.clientHeight - canvas.height * zoom) / 2;
    applyTransform();
  }

  function zoomAt(newZoom, cx, cy) {
    if (!hasImage) return;
    const oldZoom = zoom;
    zoom = clamp(newZoom, 0.01, 20);
    panX = cx - (cx - panX) * (zoom / oldZoom);
    panY = cy - (cy - panY) * (zoom / oldZoom);
    scheduleTransform();
  }

  const zoomCenter = z => zoomAt(z, workspace.clientWidth / 2, workspace.clientHeight / 2);

  btnZoomIn.addEventListener('click', () => zoomCenter(zoom * 1.25));
  btnZoomOut.addEventListener('click', () => zoomCenter(zoom * 0.8));
  btnZoomReset.addEventListener('click', () => zoomCenter(1));
  btnFitView.addEventListener('click', fitToView);

  workspace.addEventListener('wheel', e => {
    if (!hasImage) return;
    if (e.target.closest('.side-panel') || e.target.closest('.zoom-controls')) return;
    e.preventDefault();
    if (!e.deltaY) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? workspace.clientHeight : 1;
    const delta = clamp(e.deltaY * unit, -200, 200);
    const rect = workspace.getBoundingClientRect();
    zoomAt(zoom * Math.exp(-delta * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  workspace.addEventListener('dblclick', e => {
    if (!hasImage || tool === 'crop') return;
    if (e.target.closest('.side-panel') || e.target.closest('.zoom-controls')) return;
    if (Math.abs(zoom - 1) < 0.001) fitToView();
    else {
      const rect = workspace.getBoundingClientRect();
      zoomAt(1, e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  let panPointer = null, panStartX = 0, panStartY = 0;
  let spaceHeld = false;

  const touches = new Map();
  let pinch = null;

  function touchMidDist() {
    const [a, b] = Array.from(touches.values());
    const rect = workspace.getBoundingClientRect();
    return {
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top,
      d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  workspace.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !hasImage) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2) {
      if (pinch) { e.stopImmediatePropagation(); e.preventDefault(); }
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    panPointer = null;
    canvasWrap.classList.remove('dragging');
    if (cropDrag) { cropRect = cropDrag.prev; cropDrag = null; drawCrop(); }
    if (resizeDrag) cancelResizeDrag();
    const m = touchMidDist();
    pinch = { zoom, panX, panY, ...m };
  }, true);

  window.addEventListener('pointermove', e => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size < 2) return;
    e.stopImmediatePropagation();
    const m = touchMidDist();
    const newZoom = clamp(pinch.zoom * m.d / pinch.d, 0.01, 20);
    const imgX = (pinch.x - pinch.panX) / pinch.zoom;
    const imgY = (pinch.y - pinch.panY) / pinch.zoom;
    zoom = newZoom;
    panX = m.x - imgX * newZoom;
    panY = m.y - imgY * newZoom;
    scheduleTransform();
    if (tool === 'crop') drawCrop();
  }, true);

  const endTouch = e => {
    if (!touches.delete(e.pointerId)) return;
    if (pinch && touches.size === 0) pinch = null;
  };
  window.addEventListener('pointerup', endTouch, true);
  window.addEventListener('pointercancel', endTouch, true);

  workspace.addEventListener('contextmenu', e => e.preventDefault());

  workspace.addEventListener('pointerdown', e => {
    if (!hasImage || e.button !== 0) return;
    if (e.target.closest('.side-panel') || e.target.closest('.zoom-controls') || e.target.closest('.drop-zone')) return;
    if (!spaceHeld) {
      if (e.target.closest('.resize-handle') || e.target.closest('.crop-handle') || e.target.closest('.crop-selection')) return;
      if (tool === 'crop' && e.target.closest('.crop-overlay')) return;
    }
    panPointer = e.pointerId;
    workspace.setPointerCapture(e.pointerId);
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    canvasWrap.classList.add('dragging');
    e.preventDefault();
    e.stopPropagation();
  }, true);

  workspace.addEventListener('pointermove', e => {
    if (e.pointerId !== panPointer) return;
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    scheduleTransform();
  });

  const endPan = e => {
    if (e.pointerId !== panPointer) return;
    panPointer = null;
    canvasWrap.classList.remove('dragging');
  };
  workspace.addEventListener('pointerup', endPan);
  workspace.addEventListener('pointercancel', endPan);

  new ResizeObserver(() => { if (hasImage) applyTransform(); }).observe(workspace);


  function leaveTool() {
    if (tool === 'adjust' || tool === 'filters') {
      cancelPreviewFrame();
      showCurrentEntry();
      filterCache.clear();
    }
    if (tool === 'resize' && resizeDrag) cancelResizeDrag();
    if (tool === 'crop') cropDrag = null;
  }

  function setTool(t) {
    if (t !== 'idle' && (!hasImage || busy)) return;
    leaveTool();
    tool = t;
    cropOverlay.classList.toggle('active', t === 'crop');
    cropActions.classList.toggle('active', t === 'crop');
    resizeHandles.forEach(h => h.style.display = t === 'resize' ? '' : 'none');
    resizePanel.classList.toggle('visible', t === 'resize');
    adjustPanel.classList.toggle('visible', t === 'adjust');
    filtersPanel.classList.toggle('visible', t === 'filters');
    if (t === 'crop') initCrop();
    if (t === 'resize') resetResizeBase();
    if (t === 'adjust') resetAdjustSliders();
    if (t === 'filters') resetFilterSelection();
    refreshButtons();
  }

  const toggleTool = t => setTool(tool === t ? 'idle' : t);

  function beforeGeometryChange() {
    if (tool === 'adjust' || tool === 'filters') setTool('idle');
    if (resizeDrag) cancelResizeDrag();
    cropDrag = null;
  }

  function afterGeometryChange() {
    if (tool === 'crop') initCrop();
    if (tool === 'resize') resetResizeBase();
  }

  btnCrop.addEventListener('click', () => toggleTool('crop'));
  btnResize.addEventListener('click', () => toggleTool('resize'));
  btnAdjust.addEventListener('click', () => toggleTool('adjust'));
  btnFilters.addEventListener('click', () => toggleTool('filters'));


  function rotateCanvas(cw) {
    if (!hasImage || busy) return;
    beforeGeometryChange();
    const tmp = copyOfCanvas(canvas);
    canvas.width = tmp.height;
    canvas.height = tmp.width;
    ctx.save();
    if (cw) {
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(0, canvas.height);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    releaseCanvas(tmp);
    pushHistory();
    fitToView();
    afterGeometryChange();
  }

  function flipCanvas(horizontal) {
    if (!hasImage || busy) return;
    beforeGeometryChange();
    const tmp = copyOfCanvas(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (horizontal) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, canvas.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    releaseCanvas(tmp);
    pushHistory();
    applyTransform();
    afterGeometryChange();
  }

  btnRotateCW.addEventListener('click', () => rotateCanvas(true));
  btnRotateCCW.addEventListener('click', () => rotateCanvas(false));
  btnFlipH.addEventListener('click', () => flipCanvas(true));
  btnFlipV.addEventListener('click', () => flipCanvas(false));


  async function resample(srcCanvas, newW, newH) {
    const dst = makeCanvas(newW, newH);
    const downscale = newW * newH <= srcCanvas.width * srcCanvas.height;
    if (picaInstance) {
      try {
        await picaInstance.resize(srcCanvas, dst, { filter: downscale ? 'mks2013' : 'lanczos2', alpha: true });
        return dst;
      } catch (err) {
        console.warn('pica resize failed, using canvas scaling', err);
      }
    }
    const dctx = dst.getContext('2d');
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(srcCanvas, 0, 0, newW, newH);
    return dst;
  }

  async function commitResize(newW, newH) {
    if (newW === canvas.width && newH === canvas.height) return false;
    if (!sizeAllowed(newW, newH)) {
      toast(`Size must be 1-${MAX_SIDE}px per side and at most ${MAX_PIXELS / 1e6} MP`);
      return false;
    }
    setBusy(true);
    try {
      const src = copyOfCanvas(canvas);
      const dst = await resample(src, newW, newH);
      releaseCanvas(src);
      canvas.width = newW;
      canvas.height = newH;
      ctx.drawImage(dst, 0, 0);
      releaseCanvas(dst);
      pushHistory();
      return true;
    } catch (err) {
      console.error(err);
      showCurrentEntry();
      toast('Resize failed - not enough memory?');
      return false;
    } finally {
      setBusy(false);
    }
  }


  const resizeWInput = $('#resizeW');
  const resizeHInput = $('#resizeH');
  const lockAspect = $('#lockAspect');
  const unitBtns = Array.from(resizePanel.querySelectorAll('.unit-toggle button'));
  let resizeLocked = true;
  let resizeUnit = 'px';
  let resizeBaseW = 0, resizeBaseH = 0;

  function resetResizeBase() {
    resizeBaseW = canvas.width;
    resizeBaseH = canvas.height;
    syncResizeInputs(canvas.width, canvas.height);
  }

  function syncResizeInputs(w, h) {
    if (resizeUnit === 'px') {
      resizeWInput.value = w;
      resizeHInput.value = h;
    } else {
      resizeWInput.value = +(w / resizeBaseW * 100).toFixed(1);
      resizeHInput.value = +(h / resizeBaseH * 100).toFixed(1);
    }
  }

  function readResizeInputs() {
    const wv = parseFloat(resizeWInput.value);
    const hv = parseFloat(resizeHInput.value);
    if (!isFinite(wv) || !isFinite(hv) || wv <= 0 || hv <= 0) return null;
    if (resizeUnit === 'px') return { w: Math.round(wv), h: Math.round(hv) };
    return {
      w: Math.max(1, Math.round(resizeBaseW * wv / 100)),
      h: Math.max(1, Math.round(resizeBaseH * hv / 100)),
    };
  }

  lockAspect.addEventListener('click', () => {
    resizeLocked = !resizeLocked;
    lockAspect.classList.toggle('locked', resizeLocked);
    lockAspect.setAttribute('aria-pressed', resizeLocked);
  });

  unitBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const cur = readResizeInputs() || { w: canvas.width, h: canvas.height };
      resizeUnit = btn.dataset.unit;
      setPressed(unitBtns, btn);
      syncResizeInputs(cur.w, cur.h);
    });
  });

  resizeWInput.addEventListener('input', () => {
    if (!resizeLocked) return;
    const v = parseFloat(resizeWInput.value);
    if (!isFinite(v) || v <= 0) return;
    resizeHInput.value = resizeUnit === 'px' ? Math.max(1, Math.round(v * resizeBaseH / resizeBaseW)) : v;
  });

  resizeHInput.addEventListener('input', () => {
    if (!resizeLocked) return;
    const v = parseFloat(resizeHInput.value);
    if (!isFinite(v) || v <= 0) return;
    resizeWInput.value = resizeUnit === 'px' ? Math.max(1, Math.round(v * resizeBaseW / resizeBaseH)) : v;
  });

  async function applyResizePanel() {
    if (busy) return;
    const size = readResizeInputs();
    if (!size) { toast('Enter a valid width and height'); return; }
    const ok = await commitResize(size.w, size.h);
    if (ok) {
      resetResizeBase();
      applyTransform();
      toast(`Resized to ${size.w} × ${size.h}`);
    }
  }

  $('#resizeApply').addEventListener('click', applyResizePanel);
  $('#resizeCancel').addEventListener('click', () => setTool('idle'));
  $('#resizeClose').addEventListener('click', () => setTool('idle'));
  [resizeWInput, resizeHInput].forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); applyResizePanel(); }
  }));


  let resizeDrag = null;

  resizeHandles.forEach(h => {
    h.addEventListener('pointerdown', e => {
      if (tool !== 'resize' || busy || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      resizeDrag = {
        pointerId: e.pointerId,
        handle: h,
        dir: h.dataset.dir,
        sx: e.clientX, sy: e.clientY,
        ow: canvas.width, oh: canvas.height,
        px: panX, py: panY,
      };
    });

    h.addEventListener('pointermove', e => {
      if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
      const { dir, ow, oh, px, py } = resizeDrag;
      const dx = (e.clientX - resizeDrag.sx) / zoom;
      const dy = (e.clientY - resizeDrag.sy) / zoom;
      let w = ow, hh = oh;
      if (dir.includes('r')) w = ow + dx;
      if (dir.includes('l')) w = ow - dx;
      if (dir.includes('b')) hh = oh + dy;
      if (dir.includes('t')) hh = oh - dy;

      const keepRatio = resizeLocked !== e.shiftKey;
      if (keepRatio) {
        const ratio = ow / oh;
        if (dir === 'tm' || dir === 'bm') w = hh * ratio;
        else if (dir === 'ml' || dir === 'mr') hh = w / ratio;
        else if (Math.abs(w / ow) > Math.abs(hh / oh)) hh = w / ratio;
        else w = hh * ratio;
      }

      w = clamp(Math.round(w), 1, MAX_SIDE);
      hh = clamp(Math.round(hh), 1, MAX_SIDE);
      if (w * hh > MAX_PIXELS) {
        const s = Math.sqrt(MAX_PIXELS / (w * hh));
        w = Math.max(1, Math.floor(w * s));
        hh = Math.max(1, Math.floor(hh * s));
      }

      dragSize = { w, h: hh };
      panX = dir.includes('l') ? px + (ow - w) * zoom : px;
      panY = dir.includes('t') ? py + (oh - hh) * zoom : py;
      if (dir === 'tm' || dir === 'bm') panX = px + (ow - w) * zoom / 2;
      if (dir === 'ml' || dir === 'mr') panY = py + (oh - hh) * zoom / 2;
      scheduleTransform();
      syncResizeInputs(w, hh);
    });

    const finish = async e => {
      if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
      const drag = resizeDrag;
      const size = dragSize;
      resizeDrag = null;
      if (e.type === 'pointercancel' || !size || (size.w === canvas.width && size.h === canvas.height)) {
        dragSize = null;
        panX = drag.px;
        panY = drag.py;
        applyTransform();
        syncResizeInputs(canvas.width, canvas.height);
        return;
      }
      const ok = await commitResize(size.w, size.h);
      dragSize = null;
      if (!ok) { panX = drag.px; panY = drag.py; }
      if (tool === 'resize') resetResizeBase();
      applyTransform();
      if (ok) toast(`Resized to ${size.w} × ${size.h}`);
    };
    h.addEventListener('pointerup', finish);
    h.addEventListener('pointercancel', finish);
  });

  function cancelResizeDrag() {
    if (!resizeDrag) return;
    panX = resizeDrag.px;
    panY = resizeDrag.py;
    resizeDrag = null;
    dragSize = null;
    applyTransform();
  }


  let cropRect = { x: 0, y: 0, w: 0, h: 0 };
  let cropRatio = null;
  let cropDrag = null;
  const presetBtns = Array.from(cropActions.querySelectorAll('.crop-presets button'));

  const minCrop = () => Math.max(1, Math.min(MIN_CROP, canvas.width, canvas.height));

  function ratioFromPreset(p) {
    if (p === 'free') return null;
    if (p === 'orig') return canvas.width / canvas.height;
    const [a, b] = p.split(':').map(Number);
    return a / b;
  }

  function fitRatioInside(x, y, w, h, ratio) {
    let nw = w, nh = h;
    if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
    return { x: x + (w - nw) / 2, y: y + (h - nh) / 2, w: nw, h: nh };
  }

  function roundCrop(r) {
    const x = clamp(Math.round(r.x), 0, canvas.width - 1);
    const y = clamp(Math.round(r.y), 0, canvas.height - 1);
    return {
      x, y,
      w: clamp(Math.round(r.w), 1, canvas.width - x),
      h: clamp(Math.round(r.h), 1, canvas.height - y),
    };
  }

  function initCrop() {
    const m = 0.1;
    let r = { x: canvas.width * m, y: canvas.height * m, w: canvas.width * (1 - 2 * m), h: canvas.height * (1 - 2 * m) };
    if (cropRatio) r = fitRatioInside(r.x, r.y, r.w, r.h, cropRatio);
    cropRect = roundCrop(r);
    drawCrop();
  }

  function drawCrop() {
    cropSelection.style.left = (cropRect.x / canvas.width * 100) + '%';
    cropSelection.style.top = (cropRect.y / canvas.height * 100) + '%';
    cropSelection.style.width = (cropRect.w / canvas.width * 100) + '%';
    cropSelection.style.height = (cropRect.h / canvas.height * 100) + '%';
    cropBadge.textContent = `${cropRect.w} × ${cropRect.h}`;
    cropBadge.style.top = cropRect.y * zoom < 30 ? '4px' : '-26px';
    cropBadge.style.left = cropRect.y * zoom < 30 ? '4px' : '0';
  }

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setPressed(presetBtns, btn);
      cropRatio = ratioFromPreset(btn.dataset.ratio);
      if (cropRatio) {
        cropRect = roundCrop(fitRatioInside(cropRect.x, cropRect.y, cropRect.w, cropRect.h, cropRatio));
        drawCrop();
      }
    });
  });

  function imagePoint(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / zoom, 0, canvas.width),
      y: clamp((e.clientY - r.top) / zoom, 0, canvas.height),
    };
  }

  function startCropDrag(e, data) {
    e.stopPropagation();
    e.preventDefault();
    cropOverlay.setPointerCapture(e.pointerId);
    cropDrag = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, prev: { ...cropRect }, ...data };
  }

  cropOverlay.addEventListener('pointerdown', e => {
    if (tool !== 'crop' || e.button !== 0 || spaceHeld) return;
    const handle = e.target.closest('.crop-handle');
    if (handle) {
      startCropDrag(e, { type: 'resize', dir: handle.dataset.dir, ox: cropRect.x, oy: cropRect.y, ow: cropRect.w, oh: cropRect.h });
    } else if (e.target.closest('.crop-selection')) {
      startCropDrag(e, { type: 'move', ox: cropRect.x, oy: cropRect.y });
    } else {
      const p = imagePoint(e);
      startCropDrag(e, { type: 'new', ax: p.x, ay: p.y });
    }
  });

  function cropResizeTo(dx, dy) {
    const { dir: d, ox, oy, ow, oh } = cropDrag;
    const W = canvas.width, H = canvas.height, min = minCrop();
    let left = ox, top = oy, right = ox + ow, bottom = oy + oh;
    if (d.includes('l')) left = clamp(ox + dx, 0, right - min);
    if (d.includes('r')) right = clamp(right + dx, left + min, W);
    if (d.includes('t')) top = clamp(oy + dy, 0, bottom - min);
    if (d.includes('b')) bottom = clamp(bottom + dy, top + min, H);
    let w = right - left, h = bottom - top;

    if (cropRatio) {
      if (d === 'tm' || d === 'bm') w = h * cropRatio;
      else if (d === 'ml' || d === 'mr') h = w / cropRatio;
      else if (w / h > cropRatio) w = h * cropRatio;
      else h = w / cropRatio;

      const cx = ox + ow / 2, cy = oy + oh / 2;
      const maxW = d.includes('l') ? ox + ow : d.includes('r') ? W - ox : 2 * Math.min(cx, W - cx);
      const maxH = d.includes('t') ? oy + oh : d.includes('b') ? H - oy : 2 * Math.min(cy, H - cy);
      if (w > maxW) { w = maxW; h = w / cropRatio; }
      if (h > maxH) { h = maxH; w = h * cropRatio; }

      left = d.includes('l') ? ox + ow - w : d.includes('r') ? ox : cx - w / 2;
      top = d.includes('t') ? oy + oh - h : d.includes('b') ? oy : cy - h / 2;
    }
    return { x: left, y: top, w, h };
  }

  cropOverlay.addEventListener('pointermove', e => {
    if (!cropDrag || e.pointerId !== cropDrag.pointerId) return;
    const dx = (e.clientX - cropDrag.sx) / zoom;
    const dy = (e.clientY - cropDrag.sy) / zoom;
    let r;
    if (cropDrag.type === 'move') {
      r = {
        x: clamp(cropDrag.ox + dx, 0, canvas.width - cropRect.w),
        y: clamp(cropDrag.oy + dy, 0, canvas.height - cropRect.h),
        w: cropRect.w, h: cropRect.h,
      };
    } else if (cropDrag.type === 'resize') {
      r = cropResizeTo(dx, dy);
    } else {
      const p = imagePoint(e);
      let w = Math.abs(p.x - cropDrag.ax), h = Math.abs(p.y - cropDrag.ay);
      if (cropRatio && w && h) {
        if (w / h > cropRatio) w = h * cropRatio; else h = w / cropRatio;
      }
      r = { x: p.x < cropDrag.ax ? cropDrag.ax - w : cropDrag.ax, y: p.y < cropDrag.ay ? cropDrag.ay - h : cropDrag.ay, w, h };
      if (w < 1 || h < 1) return;
    }
    cropRect = roundCrop(r);
    drawCrop();
  });

  const endCropDrag = e => {
    if (!cropDrag || e.pointerId !== cropDrag.pointerId) return;
    if (e.type === 'pointercancel' || (cropDrag.type === 'new' && (cropRect.w < minCrop() || cropRect.h < minCrop()))) {
      cropRect = cropDrag.prev;
      drawCrop();
    }
    cropDrag = null;
  };
  cropOverlay.addEventListener('pointerup', endCropDrag);
  cropOverlay.addEventListener('pointercancel', endCropDrag);

  function nudgeCrop(dx, dy) {
    cropRect.x = clamp(cropRect.x + dx, 0, canvas.width - cropRect.w);
    cropRect.y = clamp(cropRect.y + dy, 0, canvas.height - cropRect.h);
    drawCrop();
  }

  function applyCrop() {
    if (tool !== 'crop' || busy) return;
    const { x, y, w, h } = roundCrop(cropRect);
    if (x === 0 && y === 0 && w === canvas.width && h === canvas.height) { setTool('idle'); return; }
    const tmp = copyOfCanvas(canvas);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(tmp, x, y, w, h, 0, 0, w, h);
    releaseCanvas(tmp);
    pushHistory();
    setTool('idle');
    fitToView();
    toast(`Cropped to ${w} × ${h}`);
  }

  btnCropApply.addEventListener('click', applyCrop);
  btnCropCancel.addEventListener('click', () => setTool('idle'));


  let previewFrame = 0;
  let previewFn = null;

  function schedulePreview(fn) {
    previewFn = fn;
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      const f = previewFn;
      previewFn = null;
      if (f) f();
    });
  }

  function cancelPreviewFrame() {
    if (previewFrame) cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    previewFn = null;
  }

  function bindCompare(btn) {
    let showing = false;
    const show = e => {
      if (tool !== 'adjust' && tool !== 'filters') return;
      e.preventDefault();
      cancelPreviewFrame();
      showing = true;
      ctx.putImageData(currentEntry(), 0, 0);
    };
    const hide = () => {
      if (!showing) return;
      showing = false;
      if (tool === 'adjust') previewAdjust();
      if (tool === 'filters') previewFilter();
    };
    btn.addEventListener('pointerdown', show);
    btn.addEventListener('pointerup', hide);
    btn.addEventListener('pointerleave', hide);
    btn.addEventListener('pointercancel', hide);
  }


  const brightnessSlider = $('#brightnessSlider');
  const contrastSlider = $('#contrastSlider');
  const saturationSlider = $('#saturationSlider');
  const brightnessVal = $('#brightnessVal');
  const contrastVal = $('#contrastVal');
  const saturationVal = $('#saturationVal');

  const adjustValues = () => ({
    br: +brightnessSlider.value,
    co: +contrastSlider.value,
    sa: +saturationSlider.value,
  });

  function resetAdjustSliders() {
    brightnessSlider.value = 0; contrastSlider.value = 0; saturationSlider.value = 0;
    brightnessVal.textContent = '0'; contrastVal.textContent = '0'; saturationVal.textContent = '0';
  }

  function previewAdjust() {
    if (tool !== 'adjust') return;
    const base = currentEntry();
    const { br, co, sa } = adjustValues();
    if (!br && !co && !sa) { ctx.putImageData(base, 0, 0); return; }

    const cf = (259 * (co + 255)) / (255 * (259 - co));
    const lut = new Float32Array(256);
    for (let v = 0; v < 256; v++) lut[v] = cf * (v + br - 128) + 128;

    const src = base.data;
    const out = new ImageData(base.width, base.height);
    const dst = out.data;
    const s = 1 + sa / 100;

    for (let i = 0; i < src.length; i += 4) {
      let r = lut[src[i]], g = lut[src[i + 1]], b = lut[src[i + 2]];
      if (sa) {
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = gray + s * (r - gray);
        g = gray + s * (g - gray);
        b = gray + s * (b - gray);
      }
      dst[i] = r; dst[i + 1] = g; dst[i + 2] = b;
      dst[i + 3] = src[i + 3];
    }
    ctx.putImageData(out, 0, 0);
  }

  [brightnessSlider, contrastSlider, saturationSlider].forEach(sl => {
    sl.addEventListener('input', () => {
      brightnessVal.textContent = brightnessSlider.value;
      contrastVal.textContent = contrastSlider.value;
      saturationVal.textContent = saturationSlider.value;
      schedulePreview(previewAdjust);
    });
  });

  $('#adjustReset').addEventListener('click', () => {
    resetAdjustSliders();
    cancelPreviewFrame();
    showCurrentEntry();
  });

  function applyAdjust() {
    if (tool !== 'adjust') return;
    const { br, co, sa } = adjustValues();
    if (!br && !co && !sa) { setTool('idle'); return; }
    cancelPreviewFrame();
    previewAdjust();
    pushHistory();
    setTool('idle');
    toast('Adjustments applied');
  }

  $('#adjustApply').addEventListener('click', applyAdjust);
  $('#adjustCancel').addEventListener('click', () => setTool('idle'));
  bindCompare($('#adjustCompare'));


  const filterBtns = Array.from(filtersPanel.querySelectorAll('.filter-grid button'));
  const filterIntensity = $('#filterIntensity');
  const filterIntensityVal = $('#filterIntensityVal');
  const filterCache = new Map();
  let activeFilter = 'none';

  const ctxFilterSupported = (() => {
    const c = makeCanvas(1, 1).getContext('2d');
    if (!('filter' in c)) return false;
    c.filter = 'blur(1px)';
    return c.filter === 'blur(1px)';
  })();

  function resetFilterSelection() {
    activeFilter = 'none';
    filterIntensity.value = 100;
    filterIntensityVal.textContent = '100%';
    filterBtns.forEach(b => {
      const on = b.dataset.filter === 'none';
      b.classList.toggle('active-filter', on);
      b.setAttribute('aria-pressed', on);
    });
    filterCache.clear();
  }

  function boxBlurJS(img, radius) {
    const { width: w, height: h } = img;
    const a = new Float32Array(img.data);
    const b = new Float32Array(a.length);
    const pass = (src, dst, horizontal) => {
      const len = horizontal ? w : h, lines = horizontal ? h : w;
      const step = horizontal ? 4 : w * 4;
      const norm = 1 / (2 * radius + 1);
      for (let line = 0; line < lines; line++) {
        const start = horizontal ? line * w * 4 : line * 4;
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let k = -radius; k <= radius; k++) sum += src[start + clamp(k, 0, len - 1) * step + c];
          for (let p = 0; p < len; p++) {
            dst[start + p * step + c] = sum * norm;
            sum += src[start + Math.min(p + radius + 1, len - 1) * step + c]
                 - src[start + Math.max(p - radius, 0) * step + c];
          }
        }
      }
    };
    for (let i = 0; i < 3; i++) { pass(a, b, true); pass(b, a, false); }
    const out = new ImageData(w, h);
    out.data.set(a);
    return out;
  }

  function blurImageData(img, radius) {
    if (!ctxFilterSupported) return boxBlurJS(img, Math.max(1, Math.round(radius / 2)));
    const { width: w, height: h } = img;
    const pad = Math.ceil(radius * 3);
    const src = makeCanvas(w, h);
    src.getContext('2d').putImageData(img, 0, 0);
    const padded = makeCanvas(w + 2 * pad, h + 2 * pad);
    const p = padded.getContext('2d');
    p.drawImage(src, pad, pad);
    p.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
    p.drawImage(src, w - 1, 0, 1, h, w + pad, pad, pad, h);
    p.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
    p.drawImage(src, 0, h - 1, w, 1, pad, h + pad, w, pad);
    p.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
    p.drawImage(src, w - 1, 0, 1, 1, w + pad, 0, pad, pad);
    p.drawImage(src, 0, h - 1, 1, 1, 0, h + pad, pad, pad);
    p.drawImage(src, w - 1, h - 1, 1, 1, w + pad, h + pad, pad, pad);
    const out = makeCanvas(w, h);
    const o = out.getContext('2d');
    o.filter = `blur(${radius}px)`;
    o.drawImage(padded, -pad, -pad);
    const result = o.getImageData(0, 0, w, h);
    [src, padded, out].forEach(releaseCanvas);
    return result;
  }

  function computeFilter(name) {
    if (filterCache.has(name)) return filterCache.get(name);
    const base = currentEntry();
    const { width: w, height: h } = base;
    const scale = Math.max(1, Math.min(w, h) / 600);
    let out;

    if (name === 'blur') {
      out = blurImageData(base, 3 * scale);
    } else if (name === 'sharpen') {
      const blurred = blurImageData(base, scale);
      out = new ImageData(w, h);
      const s = base.data, bl = blurred.data, d = out.data;
      for (let i = 0; i < s.length; i += 4) {
        d[i] = s[i] + 1.5 * (s[i] - bl[i]);
        d[i + 1] = s[i + 1] + 1.5 * (s[i + 1] - bl[i + 1]);
        d[i + 2] = s[i + 2] + 1.5 * (s[i + 2] - bl[i + 2]);
        d[i + 3] = s[i + 3];
      }
    } else {
      out = new ImageData(w, h);
      const s = base.data, d = out.data;
      for (let i = 0; i < s.length; i += 4) {
        let r = s[i], g = s[i + 1], b = s[i + 2];
        if (name === 'grayscale') {
          r = g = b = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        } else if (name === 'sepia') {
          const tr = 0.393 * r + 0.769 * g + 0.189 * b;
          const tg = 0.349 * r + 0.686 * g + 0.168 * b;
          const tb = 0.272 * r + 0.534 * g + 0.131 * b;
          r = tr; g = tg; b = tb;
        } else if (name === 'invert') {
          r = 255 - r; g = 255 - g; b = 255 - b;
        }
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
      }
    }
    filterCache.clear();
    filterCache.set(name, out);
    return out;
  }

  function previewFilter() {
    if (tool !== 'filters') return;
    const base = currentEntry();
    const t = +filterIntensity.value / 100;
    if (activeFilter === 'none' || t === 0) { ctx.putImageData(base, 0, 0); return; }
    const filtered = computeFilter(activeFilter);
    if (t === 1) { ctx.putImageData(filtered, 0, 0); return; }
    const out = new ImageData(base.width, base.height);
    const s = base.data, f = filtered.data, d = out.data;
    for (let i = 0; i < s.length; i++) d[i] = s[i] + (f[i] - s[i]) * t;
    ctx.putImageData(out, 0, 0);
  }

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      filterBtns.forEach(b => {
        const on = b === btn;
        b.classList.toggle('active-filter', on);
        b.setAttribute('aria-pressed', on);
      });
      schedulePreview(previewFilter);
    });
  });

  filterIntensity.addEventListener('input', () => {
    filterIntensityVal.textContent = filterIntensity.value + '%';
    schedulePreview(previewFilter);
  });

  $('#filtersReset').addEventListener('click', () => {
    resetFilterSelection();
    cancelPreviewFrame();
    showCurrentEntry();
  });

  function applyFilters() {
    if (tool !== 'filters') return;
    if (activeFilter === 'none' || +filterIntensity.value === 0) { setTool('idle'); return; }
    const name = activeFilter;
    cancelPreviewFrame();
    previewFilter();
    pushHistory();
    setTool('idle');
    toast(`${name[0].toUpperCase() + name.slice(1)} applied`);
  }

  $('#filtersApply').addEventListener('click', applyFilters);
  $('#filtersCancel').addEventListener('click', () => setTool('idle'));
  bindCompare($('#filtersCompare'));


  function undo() {
    if (busy || historyIdx <= 0) return;
    beforeGeometryChange();
    historyIdx--;
    restoreFromHistory();
  }

  function redo() {
    if (busy || historyIdx >= history.length - 1) return;
    beforeGeometryChange();
    historyIdx++;
    restoreFromHistory();
  }

  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);

  btnRevert.addEventListener('click', () => {
    if (!originalCanvas || busy) return;
    if (!window.confirm('Revert to the original image? You can undo this.')) return;
    beforeGeometryChange();
    canvas.width = originalCanvas.width;
    canvas.height = originalCanvas.height;
    ctx.drawImage(originalCanvas, 0, 0);
    pushHistory();
    fitToView();
    afterGeometryChange();
    toast('Reverted to original');
  });


  const exportPanel = $('#exportPanel');
  const exportBackdrop = $('#exportBackdrop');
  const exportFileName = $('#exportFileName');
  const formatBtns = Array.from(exportPanel.querySelectorAll('.format-btns button'));
  const qualityRow = $('#qualityRow');
  const qualitySlider = $('#qualitySlider');
  const qualityVal = $('#qualityVal');
  const exportBgRow = $('#exportBgRow');
  const exportBgColor = $('#exportBgColor');
  const exportDimensions = $('#exportDimensions');
  const exportEstSize = $('#exportEstSize');

  const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
  const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

  const webpSupported = makeCanvas(1, 1).toDataURL('image/webp').startsWith('data:image/webp');
  if (!webpSupported) {
    const b = formatBtns.find(x => x.dataset.fmt === 'webp');
    b.disabled = true;
    b.title = 'This browser cannot encode WebP';
  }

  const loadPref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  let exportFmt = loadPref('imageEditor.format', 'png');
  if (!MIME[exportFmt] || (exportFmt === 'webp' && !webpSupported)) exportFmt = 'png';
  qualitySlider.value = clamp(+loadPref('imageEditor.quality', 92) || 92, 10, 100);
  qualityVal.textContent = qualitySlider.value + '%';
  let exportReturnFocus = null;

  function syncExportControls() {
    setPressed(formatBtns, formatBtns.find(b => b.dataset.fmt === exportFmt));
    qualityRow.style.display = exportFmt === 'png' ? 'none' : '';
    exportBgRow.style.display = exportFmt === 'jpeg' ? '' : 'none';
  }

  function exportSource() {
    if (exportFmt !== 'jpeg') return canvas;
    const c = makeCanvas(canvas.width, canvas.height);
    const cctx = c.getContext('2d');
    cctx.fillStyle = exportBgColor.value;
    cctx.fillRect(0, 0, c.width, c.height);
    cctx.drawImage(canvas, 0, 0);
    return c;
  }

  function encode() {
    const src = exportSource();
    const quality = exportFmt === 'png' ? undefined : +qualitySlider.value / 100;
    return new Promise(resolve => src.toBlob(blob => {
      if (src !== canvas) releaseCanvas(src);
      resolve(blob);
    }, MIME[exportFmt], quality));
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  let estimateTimer = 0, estimateToken = 0;
  function scheduleEstimate() {
    clearTimeout(estimateTimer);
    exportEstSize.textContent = 'Estimating…';
    const token = ++estimateToken;
    estimateTimer = setTimeout(async () => {
      const blob = await encode();
      if (token !== estimateToken) return;
      exportEstSize.textContent = blob ? `≈ ${formatBytes(blob.size)}` : '';
    }, 250);
  }

  function openExportPanel() {
    if (!hasImage || busy) return;
    setTool('idle');
    exportReturnFocus = document.activeElement;
    exportFileName.value = `${fileBaseName}-edited`;
    exportDimensions.textContent = `${canvas.width} × ${canvas.height} px`;
    syncExportControls();
    exportPanel.classList.add('visible');
    exportBackdrop.classList.add('visible');
    exportFileName.focus();
    exportFileName.select();
    scheduleEstimate();
  }

  function closeExportPanel() {
    if (!exportPanel.classList.contains('visible')) return;
    clearTimeout(estimateTimer);
    estimateToken++;
    exportPanel.classList.remove('visible');
    exportBackdrop.classList.remove('visible');
    if (exportReturnFocus && exportReturnFocus.focus) exportReturnFocus.focus();
    exportReturnFocus = null;
  }

  const exportOpen = () => exportPanel.classList.contains('visible');

  btnExport.addEventListener('click', openExportPanel);
  $('#exportClose').addEventListener('click', closeExportPanel);
  exportBackdrop.addEventListener('click', closeExportPanel);

  formatBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      exportFmt = btn.dataset.fmt;
      savePref('imageEditor.format', exportFmt);
      syncExportControls();
      scheduleEstimate();
    });
  });

  qualitySlider.addEventListener('input', () => {
    qualityVal.textContent = qualitySlider.value + '%';
    savePref('imageEditor.quality', qualitySlider.value);
    scheduleEstimate();
  });

  exportBgColor.addEventListener('input', scheduleEstimate);

  function sanitizeFileName(name) {
    const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\.(png|jpe?g|webp)$/i, '').trim();
    return n || 'image';
  }

  async function doExport() {
    if (!hasImage || busy) return;
    setBusy(true);
    try {
      const blob = await encode();
      if (!blob) { toast('Export failed - image may be too large for this browser'); return; }
      const fmt = Object.keys(MIME).find(k => MIME[k] === blob.type) || 'png';
      if (fmt !== exportFmt) toast(`${exportFmt.toUpperCase()} is not supported here - saved as ${fmt.toUpperCase()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `${sanitizeFileName(exportFileName.value)}.${EXT[fmt]}`;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      dirty = false;
      closeExportPanel();
      if (fmt === exportFmt) toast(`Exported ${a.download} (${formatBytes(blob.size)})`);
    } finally {
      setBusy(false);
    }
  }

  $('#exportDownload').addEventListener('click', doExport);
  exportFileName.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doExport(); }
  });

  exportPanel.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(exportPanel.querySelectorAll('button:not(:disabled), input'))
      .filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });


  btnCopy.addEventListener('click', async () => {
    if (!hasImage) return;
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      toast('Copying images is not supported here (needs HTTPS or localhost)');
      return;
    }
    const blobPromise = new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image too large')), 'image/png'));
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      toast('Copied to clipboard');
    } catch (err) {
      toast(err && err.message === 'Image too large'
        ? 'Copy failed - image too large'
        : 'Copy failed - check clipboard permissions');
    }
  });


  window.addEventListener('keydown', e => {
    const t = e.target;
    const typing = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'color');
    const onRange = t.tagName === 'INPUT' && t.type === 'range';
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (key === 'Escape') {
      if (exportOpen()) { closeExportPanel(); return; }
      if (tool !== 'idle') { setTool('idle'); return; }
      return;
    }
    if (exportOpen() || typing) return;

    if (e.key === ' ' && !onRange && t.tagName !== 'BUTTON') {
      if (!spaceHeld && hasImage) { spaceHeld = true; workspace.style.cursor = 'grab'; }
      e.preventDefault();
      return;
    }

    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (mod && key === 'e') { e.preventDefault(); openExportPanel(); return; }
    if (mod || e.altKey) return;

    const onToolButton = t.tagName === 'BUTTON' && t.closest('.side-panel, .crop-actions');
    if (key === 'Enter' && tool !== 'idle' && !onToolButton) {
      if (tool === 'crop') { e.preventDefault(); applyCrop(); }
      else if (tool === 'resize') { e.preventDefault(); applyResizePanel(); }
      else if (tool === 'adjust') { e.preventDefault(); applyAdjust(); }
      else if (tool === 'filters') { e.preventDefault(); applyFilters(); }
      return;
    }

    if (tool === 'crop' && e.key.startsWith('Arrow') && !onRange) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudgeCrop(-step, 0);
      if (e.key === 'ArrowRight') nudgeCrop(step, 0);
      if (e.key === 'ArrowUp') nudgeCrop(0, -step);
      if (e.key === 'ArrowDown') nudgeCrop(0, step);
      return;
    }

    if (!hasImage || busy) return;
    if (key === 'c') toggleTool('crop');
    else if (key === 'r') toggleTool('resize');
    else if (key === 'f') fitToView();
    else if (key === '1') zoomCenter(1);
    else if (key === '=' || key === '+') zoomCenter(zoom * 1.25);
    else if (key === '-') zoomCenter(zoom * 0.8);
  });

  window.addEventListener('keyup', e => {
    if (e.key === ' ' && spaceHeld) { spaceHeld = false; workspace.style.cursor = ''; }
  });
  window.addEventListener('blur', () => { spaceHeld = false; workspace.style.cursor = ''; });

  resizeHandles.forEach(h => h.style.display = 'none');
  refreshButtons();
  if (!picaInstance) console.warn('pica.min.js not loaded - resizing falls back to canvas scaling');
})();
