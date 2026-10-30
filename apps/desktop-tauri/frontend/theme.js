'use strict';
/* #380 — the system / light / dark theme of the island.
   - CLOSED shape: the only stored modes are `system`, `light` and `dark`. Anything else
     (a damaged prefs file, an unknown frame) reads as `system`; there is no passthrough.
   - Default = system: the OS choice decides, and an explicit light/dark PINS it and
     ignores the OS until the human chooses `system` again.
   - One listener lifecycle: the `prefers-color-scheme` watcher exists only while the mode
     is `system` (attached on set('system'), removed on any explicit mode and on destroy),
     so an explicit choice can never be overridden by the OS and nothing ever polls.
   - Apply only saved state: the page paints `data-theme` from the host's answers
     (`prefs_action view` and the `prefs:state` publication). A failed save changes
     nothing here, so the visible theme never claims a persistence that did not happen.
   - Presentation only: this module never writes gsettings/user config/GTK, never touches
     the OS theme, and the colour tokens live in style.css (`html[data-theme=...]`).
   Loaded as a classic script (window.AbitoTheme, which installs itself) and by
   test-node/theme-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.AbitoTheme = Object.freeze(api); api.install(root); }
})(typeof self !== 'undefined' ? self : this, () => {
  const MODES = Object.freeze(['system', 'light', 'dark']);
  const isMode = value => typeof value === 'string' && MODES.includes(value);
  // The closed enum: an unknown value is `system`, never an invented third theme.
  const normalize = value => (isMode(value) ? value : 'system');
  // What to paint. An explicit mode wins over the OS unconditionally; `system` follows the
  // OS value, and an unknown/absent OS value keeps Abito's own dark palette (the default).
  const resolve = (mode, systemPrefersDark) => {
    const m = normalize(mode);
    if (m !== 'system') return m;
    return systemPrefersDark === false ? 'light' : 'dark';
  };

  /* One controller owns one document element and one media query object.
     env: { root: Element, media: MediaQueryList-like|null } */
  function createController(env) {
    const media = env && env.media ? env.media : null;
    let root = env && env.root ? env.root : null;
    let mode = 'system';
    let applied = null;
    let attached = false;
    const onChange = () => { paint(); };
    function mediaPrefersDark() {
      if (!media) return undefined;
      return media.matches === true ? true : media.matches === false ? false : undefined;
    }
    function paint() {
      const next = resolve(mode, mediaPrefersDark());
      if (next === applied) return false; // no gratuitous DOM writes, no event storms
      root.setAttribute('data-theme', next);
      applied = next;
      return true;
    }
    // The single listener lifecycle: only `system` listens to the OS.
    function syncListener() {
      const want = mode === 'system' && !!media && typeof media.addEventListener === 'function';
      if (want && !attached) { media.addEventListener('change', onChange); attached = true; }
      else if (!want && attached) { media.removeEventListener('change', onChange); attached = false; }
    }
    return {
      mode: () => mode,
      applied: () => applied,
      listening: () => attached,
      /** Install a mode (unknown reads as `system`) and repaint. Returns whether the DOM changed. */
      set(value) { mode = normalize(value); syncListener(); return paint(); },
      /** Re-read the OS value (only `system` can move). */
      refresh() { return paint(); },
      destroy() { if (attached) { media.removeEventListener('change', onChange); attached = false; } },
    };
  }

  /* The saved state is the ONLY input to a paint. Returns whether it was applied. */
  function applySaved(controller, payload) {
    if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'theme')) return false;
    return controller.set(payload.theme);
  }

  /* Startup: paint `system` immediately (no flash of the wrong palette), subscribe to the
     host's publication, then read the saved mode once. env:
     { root, media, invoke(cmd, {payload}) -> Promise, listen(event, cb) -> Promise } */
  function start(env) {
    const controller = createController(env);
    controller.set('system'); // the safe default until the host answers
    if (env && typeof env.listen === 'function') {
      try { env.listen('prefs:state', event => applySaved(controller, event && event.payload)); } catch { /* no event bus: stays on the saved default */ }
    }
    if (env && typeof env.invoke === 'function') {
      env.invoke('prefs_action', { payload: { action: 'view' } })
        .then(payload => applySaved(controller, payload), () => { /* offline: the default stays */ });
    }
    return controller;
  }

  /* Classic-script install: one controller over the real document element and the real
     OS query. Nothing else in the page may write `data-theme`. */
  function install(win) {
    const doc = win && win.document;
    if (!doc || !doc.documentElement) return null;
    const invoke = (win.__TAURI__ && win.__TAURI__.core && win.__TAURI__.core.invoke)
      || (win.__TAURI_INTERNALS__ && win.__TAURI_INTERNALS__.invoke) || null;
    const listen = (win.__TAURI__ && win.__TAURI__.event && win.__TAURI__.event.listen) || null;
    const media = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null;
    return start({ root: doc.documentElement, media, invoke, listen });
  }

  return { MODES, isMode, normalize, resolve, createController, applySaved, start, install };
});
