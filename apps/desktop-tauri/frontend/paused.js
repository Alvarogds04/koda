'use strict';
/* abito-pausa (human 0.1.2: «vale todo lo que este en pausa se puede ocultar?» → yes; supersedes 26-oct «Visibles en gris y
   apagadas»): this version works on Chat and Agentes. The other features are paused:
   hidden in Ajustes (hub/shell.ts PAUSED_PAGES) and switched off here on the island and in Rust (src/paused.rs). Stored preferences are
   never rewritten, so the next version turns a feature back on by removing it from PAUSED. Classic script (window.AbitoPaused). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoPaused = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const PAUSED = Object.freeze(['dictation', 'voice', 'integrations', 'spotify', 'phone']);
  /* K2-10 T4 (S11): the island's MAIL has its own entry and is NOT paused in this version — the feature
     has to work (`Feature::Mail => false` in src/paused.rs). It is listed here, NOT in PAUSED, so the next
     version pauses it by moving one id: test-node/paused-check.cjs keeps both files in agreement. */
  const NOT_PAUSED = Object.freeze(['mail']);
  const paused = feature => PAUSED.includes(feature);
  return { PAUSED, NOT_PAUSED, paused, LABEL: 'En pausa · próxima versión' };
});
