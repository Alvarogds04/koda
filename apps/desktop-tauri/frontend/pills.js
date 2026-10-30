'use strict';
// #345 F032: selections, not connections. Pure; stored-load normalization is
// deliberately separate from strict submitted-choice validation.
(function (root, factory) {
  const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./pill-catalog.js') : root.AbitoPillCatalog,
    common ? require('./avatar-colors.js') : root.AbitoAvatarColors);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoPills = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, (C, A) => {
  const DEFAULT_MAIN = 'integration_claude';
  const DEFAULT_DECLARED = Object.freeze(['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github']);
  // #415 WU2: created blobs — label + optional palette colour entries, at most eight,
  // in creation order. Same validation philosophy as src/prefs.rs valid_blob_name:
  // bounded plain text, trimmed, no controls, never the principal's name.
  const MAX_BLOBS = 8;
  const MAX_BLOB_NAME = 40;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const validBlobName = name => typeof name === 'string' && name.length > 0 && [...name].length <= MAX_BLOB_NAME &&
    name.trim() === name && !CONTROL.test(name) && name.toLowerCase() !== 'abito' && name.toLowerCase() !== 'koda'; // Koda 0.1 T2: the principal's visible name is reserved too
  const isBlobColor = color => color === '' || isColor(color);
  const isMain = (id, os) => C.acceptedMain(os).some(def => def.id === id);
  // #346 F033: the ONLY colour vocabulary — avatar-colors.js PALETTE, the same five names
  // src/prefs.rs COLORS holds. A missing palette fails closed: nothing is ever painted.
  const PALETTE = A && Array.isArray(A.PALETTE) ? A.PALETTE : [];
  const isColor = value => typeof value === 'string' && (PALETTE.includes(value) || !!A.normalizeChosenColor(value));
  function normalize(raw, os = C.HOST_OS) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mainPill = isMain(input.mainPill, os) ? input.mainPill : DEFAULT_MAIN;
    const values = Array.isArray(input.declaredPills) ? input.declaredPills : DEFAULT_DECLARED;
    const declaredPills = [];
    for (const id of values) {
      if (id !== mainPill && C.offered(id, os) && !declaredPills.includes(id)) declaredPills.push(id);
    }
    // #346: only a real catalog id carrying a palette name survives; everything else
    // — hostile shape, off-set colour, unknown pill, prototype key — reads as no colour.
    const rawColors = input.pillColors && typeof input.pillColors === 'object' && !Array.isArray(input.pillColors) ? input.pillColors : {};
    const pillColors = {};
    for (const id of Object.keys(rawColors)) {
      if (C.definition(id) && isColor(rawColors[id])) pillColors[id] = PALETTE.includes(rawColors[id]) ? rawColors[id] : A.normalizeChosenColor(rawColors[id]);
    }
    // #415 WU2: created blobs. The Rust wire key is `customBlobs`; an already
    // normalized snapshot (blobs) re-reads the same way. Only valid, deduplicated
    // (case-insensitive, first wins) entries within the cap survive; a hostile
    // entry — non-object, bad name, off-set colour — drops like every hostile input.
    const rawBlobs = Array.isArray(input.customBlobs) ? input.customBlobs : Array.isArray(input.blobs) ? input.blobs : [];
    const blobs = [];
    for (const entry of rawBlobs) {
      const name = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.name : null;
      if (validBlobName(name) && blobs.length < MAX_BLOBS && !blobs.some(b => b.name.toLowerCase() === name.toLowerCase())) {
        blobs.push({ name, color: typeof entry.color === 'string' && isColor(entry.color) ? (PALETTE.includes(entry.color) ? entry.color : A.normalizeChosenColor(entry.color)) : '' });
      }
    }
    return { mainPill, declaredPills, pillColors, blobs };
  }
  function valid(state, os = C.HOST_OS) {
    return !!state && isMain(state.mainPill, os) && Array.isArray(state.declaredPills) &&
      new Set(state.declaredPills).size === state.declaredPills.length &&
      state.declaredPills.every(id => id !== state.mainPill && C.offered(id, os));
  }
  function toggle(state, id, os = C.HOST_OS) {
    if (!valid(state, os) || id === state.mainPill || !C.offered(id, os)) return null;
    const active = state.declaredPills.includes(id);
    return { mainPill: state.mainPill, declaredPills: active ? state.declaredPills.filter(x => x !== id) : [...state.declaredPills, id] };
  }
  function chooseMain(state, id, os = C.HOST_OS) {
    if (!valid(state, os) || !isMain(id, os)) return null;
    return { mainPill: id, declaredPills: state.declaredPills.filter(x => x !== id) };
  }
  // #346 F033: an already-validated palette name, or '' — raw input can never answer,
  // so a renderer can only ever paint what normalize kept.
  function colorOf(state, id) {
    const colors = state && state.pillColors && typeof state.pillColors === 'object' ? state.pillColors : {};
    const value = Object.prototype.hasOwnProperty.call(colors, id) ? colors[id] : '';
    return isColor(value) ? value : '';
  }
  // The closed write gates: offered catalog id in, a NEW state out; null refuses and
  // mutates nothing (mirrors toggle/chooseMain, with the palette check on set).
  function setColor(state, id, color, os = C.HOST_OS) {
    if (!valid(state, os) || typeof id !== 'string' || !C.offered(id, os) || !isColor(color)) return null;
    const colors = state.pillColors && typeof state.pillColors === 'object' ? state.pillColors : {};
    return { mainPill: state.mainPill, declaredPills: state.declaredPills,
      pillColors: { ...colors, [id]: color } };
  }
  function clearColor(state, id, os = C.HOST_OS) {
    if (!valid(state, os) || typeof id !== 'string' || !C.offered(id, os)) return null;
    const colors = state.pillColors && typeof state.pillColors === 'object' ? { ...state.pillColors } : {};
    delete colors[id];
    return { mainPill: state.mainPill, declaredPills: state.declaredPills, pillColors: colors };
  }
  // #415 WU2: the created-blob write gates — same shape as the pill gates: a NEW
  // state out or null, and nothing is ever mutated in place. The principal «Abito»
  // is refused by validBlobName, so the main blob can neither be created nor deleted.
  const keep = state => ({ mainPill: state.mainPill, declaredPills: state.declaredPills, pillColors: state.pillColors });
  function createBlob(state, name, color, os = C.HOST_OS) {
    if (!valid(state, os) || !validBlobName(name) || !isBlobColor(color)) return null;
    const blobs = Array.isArray(state.blobs) ? state.blobs : [];
    if (blobs.length >= MAX_BLOBS || blobs.some(b => b.name.toLowerCase() === name.toLowerCase())) return null;
    return { ...keep(state), blobs: [...blobs, { name, color: color || '' }] };
  }
  function deleteBlob(state, name, os = C.HOST_OS) {
    if (!valid(state, os) || !validBlobName(name)) return null;
    const blobs = Array.isArray(state.blobs) ? state.blobs : [];
    if (!blobs.some(b => b.name === name)) return null;
    return { ...keep(state), blobs: blobs.filter(b => b.name !== name) };
  }
  function setBlobColor(state, name, color, os = C.HOST_OS) {
    if (!valid(state, os) || !validBlobName(name) || !isBlobColor(color)) return null;
    const blobs = Array.isArray(state.blobs) ? state.blobs : [];
    if (!blobs.some(b => b.name === name)) return null;
    return { ...keep(state), blobs: blobs.map(b => b.name === name ? { name: b.name, color: color || '' } : b) };
  }
  // The validated colour of one created blob, or '' — a renderer can only paint
  // what normalize kept.
  function colorOfBlob(state, name) {
    const blobs = state && Array.isArray(state.blobs) ? state.blobs : [];
    const blob = blobs.find(b => b.name === name);
    return blob && isColor(blob.color) ? blob.color : '';
  }
  // #435: a closed permutation gate — exactly the currently declared ids, reordered.
  // Anything else (duplicates, unknown ids, a different set, a wrong type) refuses
  // without mutating, mirroring the other write gates.
  function reorderDeclared(state, order, os = C.HOST_OS) {
    if (!valid(state, os) || !Array.isArray(order) || order.length !== state.declaredPills.length ||
      !order.every(id => typeof id === 'string' && state.declaredPills.includes(id)) ||
      new Set(order).size !== order.length) return null;
    return { mainPill: state.mainPill, declaredPills: [...order], pillColors: state.pillColors };
  }
  // #435: the same gate over the stored custom-blob names (exact, case-sensitive).
  function reorderBlobs(state, order, os = C.HOST_OS) {
    if (!valid(state, os) || !Array.isArray(order)) return null;
    const blobs = Array.isArray(state.blobs) ? state.blobs : [];
    if (order.length !== blobs.length || new Set(order).size !== order.length ||
      !order.every(name => typeof name === 'string' && blobs.some(b => b.name === name))) return null;
    return { ...keep(state), blobs: order.map(name => blobs.find(b => b.name === name)) };
  }
  // #435: main first, then the stored declared order — the persisted order the
  // reorder gates write is what the island shows. Non-catalog ids keep the external
  // seam right after the main, also in their stored (input) order.
  function order(items, mainPill) {
    const rank = id => id === mainPill ? -2 : C.definition(id) ? 0 : -1;
    return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index).map(x => x.item);
  }
  function visible(raw, os = C.HOST_OS) {
    const state = normalize(raw, os);
    return order([state.mainPill, ...state.declaredPills].map(C.definition), state.mainPill);
  }
  // #415 WU2: a created blob's name is a valid selection too — it is chosen in the
  // overview like any catalog pill (still without connecting anything).
  const selection = (raw, id, os = C.HOST_OS) => {
    const state = normalize(raw, os);
    if (state.blobs.some(b => b.name === id)) return id;
    return visible(raw, os).some(def => def.id === id) ? id : state.mainPill;
  };
  function detail(id, os = C.HOST_OS) {
    const def = C.definition(id);
    if (!def) return null;
    const offered = C.offered(id, os);
    const word = offered ? 'Sin conexión' : 'No disponible';
    const detail = def.platform === 'excluded' ? 'Apple Music queda fuera de la versión 0.2.' :
      !offered ? 'Esta integración no tiene soporte en este sistema.' :
      'Elegir este blob no conecta el servicio. No hay una sesión activa disponible para esta vista.';
    return { id, name: def.name, offered, connected: false, word, detail, icon: 'plug-off', tone: 'faint', aria: `${def.name}: ${word}. ${detail}` };
  }
  // 0.2.1 T2 (one «En la isla» control): ONE pure normalizer over the two stored lists that stay on disk untouched. `declaredPills` (pill
  // ids) and `islandAgents` (specialist ids, at most MAX_SPECIALISTS) keep their own order and their own write commands; this only reads.
  // Anything ON in either stays ON (main pill included); nothing is migrated, so an older build reads the same file.
  // `specialists` = specialists-view agentsView() output ({agents: on, stored: off, max}).
  function islandModel(raw, specialists, os = C.HOST_OS) {
    const state = normalize(raw, os);
    const spec = specialists && specialists.kind === 'ready' ? specialists : { agents: [], stored: [], max: 3 };
    const pills = [state.mainPill, ...state.declaredPills].map(id => ({ kind: 'pill', id, on: true, main: id === state.mainPill }));
    const max = Number.isInteger(spec.max) ? spec.max : 3;
    const on = (spec.agents || []).map(a => ({ kind: 'specialist', id: a.id, name: a.name, on: true }));
    const off = (spec.stored || []).map(a => ({ kind: 'specialist', id: a.id, name: a.name, on: false }));
    return { pills, specialists: [...on, ...off], specialistsOn: on.length, specialistsMax: max, specialistsFull: on.length >= max, order: state.declaredPills, specialistOrder: on.map(s => s.id) };
  }
  // The ONE closed command for flipping an entry, or null when refused (main pill, unknown id, specialist cap). Pills keep going through
  // toggle_declared_pill and specialists through set_island_agents, so the stored keys are written exactly as before.
  function islandToggleCommand(model, kind, id, os = C.HOST_OS) {
    if (kind === 'pill') {
      if (!C.offered(id, os) || (model.pills.find(p => p.id === id) || {}).main) return null;
      return { action: 'toggle_declared_pill', id };
    }
    const entry = model.specialists.find(x => x.id === id);
    if (kind !== 'specialist' || !entry) return null;
    if (entry.on) return { action: 'set_island_agents', order: model.specialistOrder.filter(x => x !== id) };
    return model.specialistsFull ? null : { action: 'set_island_agents', order: [...model.specialistOrder, id] };
  }
  return { islandModel, islandToggleCommand, DEFAULT_MAIN, DEFAULT_DECLARED, MAX_BLOBS, MAX_BLOB_NAME, normalize, valid, toggle, chooseMain, order, visible, selection, detail, colorOf, setColor, clearColor, createBlob, deleteBlob, setBlobColor, colorOfBlob, reorderDeclared, reorderBlobs };
});
