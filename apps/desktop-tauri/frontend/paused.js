'use strict';
/* abito-pausa (human 0.1.2: «vale todo lo que este en pausa se puede ocultar?» → yes; supersedes 26-oct «Visibles en gris y
   apagadas»): a paused feature is hidden in Ajustes (hub/shell.ts PAUSED_PAGES) and switched off here on the island and in Rust
   (src/paused.rs). Stored preferences are never rewritten, so the next version turns a feature back on by removing it from PAUSED.
   K2 T1 (S2, S3): `phone` is out of the pause — Ajustes › Teléfono is live, and the link still starts OFF until the human turns it
   on there. Classic script (window.AbitoPaused). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoPaused = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const PAUSED = Object.freeze(['dictation', 'voice', 'integrations', 'spotify']);
  const paused = feature => PAUSED.includes(feature);
  return { PAUSED, paused, LABEL: 'En pausa · próxima versión' };
});
