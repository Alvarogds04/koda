'use strict';
/* HU-063 T2 «Ajustes · página Isla» (S2). Pure model, no DOM writes, no IPC: the live preview of the notch scale (it reuses the island's own
   AbitoNusa.sizeScale, never a copy) and the card filters that MOVE the «Isla» card and «Colores de identidad» out of General without losing
   a control. The browser mount is settings-isla-mount.js. Classic script (window.AbitoSettingsIsla) and test-node module. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSettingsIsla = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, root => {
  const nusa = () => (typeof module === 'object' && module.exports ? require('./island-nusa.js') : root.AbitoNusa);
  const IDS = Object.freeze(['s', 'm', 'l', 'auto']);
  const PREVIEW_BASE = 144; // px of the preview notch at scale 1 (the real one is 752 px wide in its window)
  const clean = size => (typeof size === 'string' && IDS.includes(size) ? size : 'auto');

  // scale k the island will really use for `size` on a screen `areaW` css px wide (the island's own pure model decides)
  function preview(size, areaW) {
    const id = clean(size), N = nusa();
    const k = N && typeof N.sizeScale === 'function' ? N.sizeScale(id, Number(areaW) > 0 ? Number(areaW) : 0, 0) : 1;
    const x = Math.round(k * 100) / 100;
    return Object.freeze({ id, k: x, width: Math.round(PREVIEW_BASE * x), factor: `×${x}`, caption: id === 'auto' ? `Auto · ×${x} en esta pantalla` : `${id.toUpperCase()} · ×${x}` });
  }

  // ---- card filters (duck-typed: real DOM and the test fakes) ----
  const tag = el => String((el && el.tagName) || '').toLowerCase();
  const classes = el => String((el && el.className) || '').split(/\s+/);
  const isIslaCard = el => tag(el) === 'section' && !!el.getAttribute && el.getAttribute('aria-label') === 'Isla';
  const isColors = el => {
    const first = el && el.children && el.children[0];
    return tag(el) === 'section' && !!first && classes(first).includes('hub-label') && String(first.textContent || '').trim() === 'Colores de identidad';
  };
  const isNote = el => classes(el).includes('hub-note');
  const KEEP = Object.freeze({
    general: el => !isIslaCard(el),            // General keeps Apariencia, Sonido and the status line
    islaCard: el => isIslaCard(el) || isNote(el), // the Isla page keeps ONLY the vendor «Isla» card (and the status line)
    abitoGeneral: el => !isColors(el),         // General keeps «Instrucciones»
    abitoIsla: el => isColors(el) || isNote(el),
  });

  // Keep only the children of `root` that pass `keep`, now and after every repaint of the vendor renderer. Returns a stop function.
  function confine(root_, keep, Observer) {
    const apply = () => { for (const c of Array.from(root_.children || [])) if (!keep(c)) root_.removeChild(c); };
    apply();
    const O = Observer === undefined ? (typeof MutationObserver === 'function' ? MutationObserver : null) : Observer;
    if (!O) return () => {};
    const ob = new O(apply);
    ob.observe(root_, { childList: true });
    return () => ob.disconnect();
  }

  return { IDS, PREVIEW_BASE, preview, isIslaCard, isColors, KEEP, confine };
});
