'use strict';
/* UI.1 — Abito's own inline SVG icons (docs/desktop-visual-language.md §1.2).
   20px grid, 2px round stroke, one colour (currentColor). No icon font, no
   package, no remote file, nothing copied from Coucou. Pure strings: the
   page writes them with innerHTML from THIS closed registry only (never from
   data). Loaded as a classic script (window.AbitoIcons) and by
   test-node/overview-view-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoIcons = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SLASH = 'M3 3l14 14';
  const CLOCK = '<circle cx="10" cy="10" r="8"/><path d="M10 5.5V10l3 2"/>';
  const PLUG = '<path d="M7 2v4M13 2v4M5 6h10v3a5 5 0 0 1-10 0zM10 14v4"/>';
  const EYE = '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.5"/>';
  const PATHS = Object.freeze({
    'bubble': '<path d="M4 4h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>',
    'mic': '<path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5zM4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/>',
    'arrow-up': '<path d="M10 16V4M5 9l5-5 5 5"/>',
    'square': '<rect x="4" y="4" width="12" height="12" rx="2"/>',
    'arrow-left': '<path d="M16 10H4M9 5l-5 5 5 5"/>',
    'plus': '<path d="M10 4v12M4 10h12"/>', // T7.3: «+ nueva conversación» (isla-chat-*)
    'arrow-right': '<path d="M4 10h12M11 5l5 5-5 5"/>', // T7.3: the approval fold chevron (isla-approval)
    'chip': '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2v3M12 2v3M8 15v3M12 15v3M2 8h3M2 12h3M15 8h3M15 12h3"/>',
    'plug': PLUG,
    'plug-off': `${PLUG}<path d="${SLASH}"/>`,
    'check': '<path d="M4 10.5l4 4 8-9"/>',
    'cross': '<path d="M5 5l10 10M15 5L5 15"/>',
    'clock': CLOCK,
    'clock-off': `${CLOCK}<path d="${SLASH}"/>`,
    'triangle': '<path d="M10 3l8 14H2z"/><path d="M10 8v4M10 14.5v.01"/>',
    'eye-off': `${EYE}<path d="${SLASH}"/>`,
    'lock': '<rect x="4" y="9" width="12" height="8" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/>',
    'refresh': '<path d="M16 10a6 6 0 1 1-2-4.5M16 3v3.5h-3.5"/>',
    'info': '<circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6v.01"/>',
    'plane': '<path d="M18 2L9 11M18 2l-6 16-3-7-7-3z"/>', // paper plane: sent, result not confirmed
    'load-off': `<path d="M10 3v8M6.5 8L10 11.5 13.5 8M3 13v3h14v-3"/><path d="${SLASH}"/>`, // loading needed (Abito never loads)
    'eye': EYE,
    'arrow-down': '<path d="M10 4v12M5 11l5 5 5-5"/>',
    'gear': '<path d="M8.4 4.1L8.8 2.2L11.2 2.2L11.6 4.1L13.1 4.7L14.6 3.6L16.4 5.4L15.3 6.9L15.9 8.4L17.8 8.8L17.8 11.2L15.9 11.6L15.3 13.0L16.4 14.6L14.6 16.4L13.0 15.3L11.6 15.9L11.2 17.8L8.8 17.8L8.4 15.9L7.0 15.3L5.4 16.4L3.6 14.6L4.7 13.1L4.1 11.6L2.2 11.2L2.2 8.8L4.1 8.4L4.7 6.9L3.6 5.4L5.4 3.6L6.9 4.7z"/><circle cx="10" cy="10" r="2.6"/>', // settings cog: 8-tooth outline + hub (stroke only, 20px grid)
    'user': '<circle cx="10" cy="7" r="3"/><path d="M4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/>', // #310 Cuentas
    'ring': '<path d="M10 2a8 8 0 1 0 8 8"/>', // open arc; the page spins it
  });
  const NAMES = Object.freeze(Object.keys(PATHS));
  const OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
  const svg = name => (Object.prototype.hasOwnProperty.call(PATHS, name) ? `${OPEN}${PATHS[name]}</svg>` : '');
  // Time ring (docs §1.3): the arc EMPTIES as the time runs out; the value is
  // the geometry itself, so a still frame (reduced motion) already shows it.
  function ring(fraction) {
    const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false">' +
      `<circle cx="14" cy="14" r="12" pathLength="100" stroke-dasharray="${Math.round(f * 100)} 100" transform="rotate(-90 14 14)"/></svg>`;
  }
  // Usage meter (docs §1.3): the fill IS the value, so a still frame already
  // shows it. 56x8, rounded track + fill; colour from currentColor.
  function meter(fraction) {
    const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const w = Math.round(f * 52 * 10) / 10;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 8" width="56" height="8" aria-hidden="true" focusable="false">' +
      '<rect x="0" y="0" width="56" height="8" rx="4" fill="currentColor" opacity=".22"/>' +
      (w > 0 ? `<rect x="2" y="2" width="${w}" height="4" rx="2" fill="currentColor"/>` : '') + '</svg>';
  }
  return { NAMES, svg, ring, meter };
});
