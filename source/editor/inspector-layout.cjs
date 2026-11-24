'use strict';
(function (global) {
  const STORAGE_KEY = 'uo-map-paint.inspector-layout.v1';
  const instances = new WeakMap();
  function initialize(editor) {
    if (instances.has(editor)) return instances.get(editor);
    const handle = editor.querySelector('#inspector-resize');
    if (!handle) throw new Error('The settings sidebar resize handle is missing');
    const win = editor.ownerDocument.defaultView;
    const defaultWidth = () => win.innerWidth >= 1200 ? 360 : 300;
    let preferred = defaultWidth(), width = preferred, gesture = null;
    try {
      const saved = JSON.parse(win.localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Number.isInteger(saved.width) && saved.width >= 260 && saved.width <= 440) preferred = saved.width;
    } catch {}
    const enabled = () => win.innerWidth >= 900;
    const maximum = () => Math.max(260, Math.min(440, Math.floor(win.innerWidth - 500)));
    const clamp = value => Math.max(260, Math.min(maximum(), Math.round(value)));
    function render() {
      width = clamp(preferred);
      editor.style.setProperty('--inspector-width', width + 'px');
      handle.tabIndex = enabled() ? 0 : -1;
      handle.setAttribute('aria-disabled', String(!enabled()));
      handle.setAttribute('aria-valuemin', '260');
      handle.setAttribute('aria-valuemax', String(maximum()));
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuetext', width + ' pixels wide');
    }
    function persist() {
      try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: preferred })); } catch {}
    }
    function setWidth(value) { preferred = clamp(value); render(); }
    function finish(cancel) {
      if (!gesture) return;
      const previous = gesture; gesture = null;
      if (cancel) preferred = previous.preferred;
      delete editor.dataset.inspectorResizing;
      render();
      if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
      if (!cancel) persist();
    }
    handle.addEventListener('pointerdown', event => {
      if (!enabled() || event.button !== 0 || gesture) return;
      event.preventDefault(); event.stopPropagation();
      gesture = { id: event.pointerId, x: event.clientX, width, preferred };
      editor.dataset.inspectorResizing = 'true';
      handle.focus({ preventScroll: true }); handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (!(event.buttons & 1)) { finish(false); return; }
      setWidth(gesture.width + gesture.x - event.clientX);
    });
    handle.addEventListener('pointerup', event => {
      if (!gesture || gesture.id !== event.pointerId || event.button !== 0 || (event.buttons & 1)) return;
      event.preventDefault(); event.stopPropagation();
      setWidth(gesture.width + gesture.x - event.clientX); finish(false);
    });
    for (const name of ['pointercancel', 'lostpointercapture']) handle.addEventListener(name, event => {
      if (gesture && gesture.id === event.pointerId) finish(true);
    });
    handle.addEventListener('dblclick', event => {
      if (!enabled()) return;
      event.preventDefault(); event.stopPropagation(); finish(true); setWidth(defaultWidth()); persist();
    });
    // Registered before editor shortcuts so Escape cancels only this resize.
    win.addEventListener('keydown', event => {
      if (gesture && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); finish(true); return;
      }
      if (event.target !== handle || !enabled()) return;
      if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (event.ctrlKey || event.altKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation(); if (gesture) return;
      const step = event.shiftKey ? 40 : 10;
      setWidth(event.key === 'Home' ? 260 : event.key === 'End' ? maximum() : width + (event.key === 'ArrowLeft' ? step : -step));
      persist();
    }, { capture: true });
    win.addEventListener('blur', () => finish(true));
    win.addEventListener('resize', () => { finish(true); render(); });
    const instance = Object.freeze({ get width() { return width; }, get preferredWidth() { return preferred; }, storageKey: STORAGE_KEY });
    instances.set(editor, instance); render(); return instance;
  }
  const api = Object.freeze({ initialize, STORAGE_KEY });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    global.MapPaintInspectorLayout = api;
    const editor = global.document.getElementById('chrome-editor');
    if (editor) initialize(editor);
  }
})(typeof window === 'undefined' ? null : window);
