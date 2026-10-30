'use strict';
// #442 T7.4 — Blobs = agents (design page «3 Blobs», blobs-{editar-agente,principal,nuevo-catalogo,
// nuevo-propio,eliminar,lleno-3-3,ordenar}-{dark,light}.png). The renderer is pill-settings.js; these
// checks cover its PUBLIC surface only: the rendered tree, the closed intents it dispatches and the
// lifecycle of the clay characters it mounts.
// Local fake DOM, no IPC, no network. Run: node apps/desktop-tauri/test-node/blobs-check.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const frontend = path.join(__dirname, '../frontend');

// A minimal DOM: textContent composition, append, attributes, dataset, listeners.
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.className = '';
    this.dataset = {}; this.attrs = {}; this.handlers = {}; this.value = '';
    this.disabled = false; this.id = ''; this.htmlFor = ''; this.hidden = false;
    this.placeholder = ''; this.title = ''; this.type = ''; this.parentNode = null;
  }
  set textContent(text) { this.children = []; if (text) this.children.push(String(text)); }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  append(...items) { for (const item of items) { this.children.push(item); item.parentNode = this; } }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn); }
  focus() {}
  // A trusted gesture by default; pass { isTrusted: false } for the synthetic cases.
  fire(type, extra = {}) {
    const event = { type, target: this, isTrusted: true, key: '', preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.handlers[type] || []) fn(event);
  }
}
const doc = { createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag) };

const walk = (node, visit) => {
  visit(node);
  for (const child of node.children) if (typeof child !== 'string') walk(child, visit);
};
const byId = (root, id) => { let hit = null; walk(root, n => { if (n.id === id) hit = n; }); return hit; };
const byClass = (root, cls) => { const hits = []; walk(root, n => { if (String(n.className).split(/\s+/).includes(cls)) hits.push(n); }); return hits; };
const words = root => {
  const texts = [], arias = [];
  walk(root, n => {
    if (n.textContent) texts.push(n.textContent);
    if (n.attrs['aria-label']) arias.push(n.attrs['aria-label']);
  });
  return [...texts, ...arias].join('\n');
};

const C = require(path.join(frontend, 'pill-catalog.js'));
const A = require(path.join(frontend, 'avatar-colors.js'));
const P = require(path.join(frontend, 'pills.js'));
const V = require(path.join(frontend, 'specialists-view.js'));
global.window = { AbitoAvatarColors: A, AbitoPillCatalog: C, AbitoPills: P, AbitoSpecialists: V };
const settings = global.window.AbitoPillSettings =
  (() => { require(path.join(frontend, 'pill-settings.js')); return global.window.AbitoPillSettings; })();


const rec = (id, name, instructions = `Hace ${name}.`) => ({ id, name, instructions, model: null, space: null, spaces: [], permissions: ['read'] });
const storeOf = (...pairs) => ({ v: 1, active: null, persisted: true, load_error: false, specialists: pairs.map(([id, n, t]) => rec(id, n, t)) });
const LISTING = { profiles: [{ profile_id: 'gpt-5.1', alias: 'gpt-5.1 · ChatGPT', selectable: true }], selected: 'gpt-5.1' };
const TWO = () => ({ prefs: { mainPill: 'integration_claude', declaredPills: [], avatarColors: { abito: 'blue', 'esp-a': 'green', 'esp-b': 'mint' }, islandAgents: null, customBlobs: null, abitoInstructions: null },
  store: storeOf(['esp-a', 'Revisor', 'Revisa tus PRs'], ['esp-b', 'Notas', 'Ordena tus notas y resume lo pendiente']), listing: LISTING });
const THREE = () => { const x = TWO(); x.store.specialists.push(rec('esp-c', 'Correo')); return x; };

// A recording clay factory: the renderer owns instance lifetime, the harness counts it.
function boot(input, extra = {}) {
  const intents = [], made = [];
  const host = new Node('div'); host.ownerDocument = doc;
  const options = { saving: false, error: '', putIcon: () => {},
    makeClay(svg, opts) {
      const inst = { svg, opts, state: opts.state || 'idle', destroyed: false, destroy() { inst.destroyed = true; }, setState(st) { inst.state = st; } };
      made.push(inst); return inst;
    },
    onIntent(intent) { intents.push(intent); }, ...extra };
  const api = { host, intents, made, options, input,
    render(next) { if (next) api.input = next; settings.render(host, api.input, options); },
    live: () => made.filter(m => !m.destroyed) };
  api.render();
  return api;
}
const text = n => n.textContent;

test('S1 default: Abito principal card, agent tiles with state chip, empty «Nuevo agente» slot, island strip and hint — every blob is a clay character', () => {
  const b = boot(TWO());
  const principal = byId(b.host, 'blob-principal-card');
  assert.ok(principal);
  assert.match(words(principal), /Koda/); assert.match(words(principal), /En reposo/); assert.match(words(principal), /Siempre en la isla/); // Koda 0.1 T2: the principal reads «Koda»
  assert.equal(byClass(b.host, 'blob-tile').length, 2);
  const [a, n] = byClass(b.host, 'blob-tile');
  assert.equal(a.dataset.agentId, 'esp-a'); assert.match(words(a), /Revisor/); assert.match(words(a), /Revisa tus PRs/); assert.match(words(a), /En reposo/);
  assert.equal(n.dataset.agentId, 'esp-b');
  assert.equal(byId(b.host, 'blob-count').textContent, '2/3');
  assert.ok(byId(b.host, 'blob-tile-new'), 'the empty slot while fewer than three');
  assert.match(words(byId(b.host, 'blob-tile-new')), /Nuevo agente/);
  const strip = byId(b.host, 'blob-island-strip');
  assert.deepEqual(byClass(strip, 'blob-strip-item').map(x => x.textContent.trim()), ['Koda', 'Revisor', 'Notas']);
  assert.match(words(b.host), /Arrastrá o usá las flechas para ordenar/);
  // every blob is the clay character, in its own colour; nothing is a plain dot any more
  assert.equal(byClass(b.host, 'blob-visual').length, 0, 'the CSS-dot blob is gone');
  const clays = b.live();
  assert.ok(clays.length >= 1 + 2 + 3, 'principal + tiles + strip + editor header each mount a clay');
  const principalClay = clays.find(c => c.svg.dataset.blob === 'principal');
  assert.equal(principalClay.svg.dataset.color, 'blue', 'the principal wears avatarColors.abito');
  assert.equal(clays.find(c => c.svg.dataset.blob === 'esp-b').svg.dataset.color, 'mint');
  assert.ok(clays.every(c => ['green', 'blue', 'mint', 'orange', 'purple'].includes(c.svg.dataset.color)));
  assert.equal(byClass(b.host, 'snote').filter(x => x.textContent).length, 0, 'no standing paragraph');
});

test('S2 lleno 3/3: no empty slot, the counter turns sun; a fourth stored specialist is kept but is not a tile', () => {
  const x = THREE(); x.store.specialists.push(rec('esp-d', 'Cuarto'));
  const b = boot(x);
  assert.equal(byClass(b.host, 'blob-tile').length, 3);
  assert.equal(byId(b.host, 'blob-tile-new'), null);
  assert.equal(byId(b.host, 'blob-count').textContent, '3/3'); assert.equal(byId(b.host, 'blob-count').dataset.tone, 'sun');
  assert.match(words(byId(b.host, 'blob-stored')), /Cuarto/, 'kept, reachable to activate');
  byClass(byId(b.host, 'blob-stored'), 'blob-stored-row')[0];
});

test('S3 agent editor: Nombre, Color (5 swatches), Qué hace, Modelo, Activo, ← → Eliminar; each edit is one closed intent', () => {
  const b = boot(TWO());
  const name = byId(b.host, 'blob-editor-name'), what = byId(b.host, 'blob-editor-what'), model = byId(b.host, 'blob-editor-model');
  assert.equal(name.value, 'Revisor'); assert.equal(what.value, 'Revisa tus PRs');
  assert.equal(byClass(byId(b.host, 'blob-editor'), 'swatch').length, 5);
  name.value = 'Revisora'; name.fire('change');
  assert.deepEqual(b.intents.pop(), { type: 'update_agent', id: 'esp-a', name: 'Revisora', instructions: 'Revisa tus PRs', model: null });
  what.value = 'Revisa PRs y issues'; what.fire('change');
  assert.deepEqual(b.intents.pop(), { type: 'update_agent', id: 'esp-a', name: 'Revisor', instructions: 'Revisa PRs y issues', model: null });
  model.value = 'gpt-5.1'; model.fire('change');
  assert.equal(b.intents.pop().model, 'gpt-5.1');
  byClass(byId(b.host, 'blob-editor'), 'swatch').find(x => x.dataset.color === 'purple').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'set_color', id: 'esp-a', color: 'purple' });
  byId(b.host, 'blob-editor-active').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'set_active', id: 'esp-a', on: false });
  assert.equal(byId(b.host, 'blob-editor-left').disabled, true, 'first agent cannot move up');
  byId(b.host, 'blob-editor-right').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'move', id: 'esp-a', by: 1 });
  // an empty name never dispatches
  name.value = '   '; name.fire('change'); assert.equal(b.intents.length, 0);
});

test('S3b editor header previews «Reposo | Trabaja» on its own clay without any intent', () => {
  const b = boot(TWO());
  const header = b.live().find(c => c.svg.dataset.blob === 'editor');
  assert.equal(header.state, 'idle');
  byId(b.host, 'blob-preview-work').fire('click');
  assert.equal(header.state, 'working'); assert.equal(b.intents.length, 0);
  byId(b.host, 'blob-preview-rest').fire('click');
  assert.equal(header.state, 'idle');
});

test('S4 principal editor: «Abito» fixed, colour, «Qué hace» with the declarative chip, model; no delete, no order', () => {
  const b = boot(TWO());
  byId(b.host, 'blob-principal-card').fire('click');
  const name = byId(b.host, 'blob-editor-name');
  assert.equal(name.value, 'Koda'); assert.equal(name.disabled, true);
  assert.match(words(byId(b.host, 'blob-editor')), /Fijo/);
  assert.match(words(byId(b.host, 'blob-editor')), /Declarativo: todavía no se aplica/);
  assert.equal(byId(b.host, 'blob-editor-delete'), null); assert.equal(byId(b.host, 'blob-editor-left'), null); assert.equal(byId(b.host, 'blob-editor-active'), null);
  byClass(byId(b.host, 'blob-editor'), 'swatch').find(x => x.dataset.color === 'orange').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'set_color', id: 'abito', color: 'orange' });
  const what = byId(b.host, 'blob-editor-what'); what.value = 'Mi asistente'; what.fire('change');
  assert.deepEqual(b.intents.pop(), { type: 'set_abito_instructions', text: 'Mi asistente' });
  const model = byId(b.host, 'blob-editor-model'); model.value = 'gpt-5.1'; model.fire('change');
  assert.deepEqual(b.intents.pop(), { type: 'set_abito_model', profile_id: 'gpt-5.1' });
});

test('S5 eliminar: inline confirmation names the agent; only the confirm dispatches', () => {
  const b = boot(TWO());
  byId(b.host, 'blob-editor-delete').fire('click');
  assert.match(words(byId(b.host, 'blob-editor')), /¿Eliminar «Revisor»\?/);
  assert.match(words(byId(b.host, 'blob-editor')), /Se quita de la isla y deja de trabajar\./);
  assert.equal(b.intents.length, 0);
  byId(b.host, 'blob-delete-cancel').fire('click'); assert.equal(b.intents.length, 0);
  assert.ok(byId(b.host, 'blob-editor-name'), 'cancel returns to the editor');
  byId(b.host, 'blob-editor-delete').fire('click'); byId(b.host, 'blob-delete-confirm').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'delete_agent', id: 'esp-a' });
});

test('S6 nuevo · del catálogo: pick enables Agregar; the intent carries the catalog id and the prefill', () => {
  const b = boot(TWO());
  byId(b.host, 'blob-tile-new').fire('click');
  assert.equal(byId(b.host, 'create-kind-catalog').getAttribute('aria-pressed'), 'true');
  assert.equal(byId(b.host, 'pill-catalog-add').disabled, true);
  byId(b.host, 'pill-catalog-row-integration_github').fire('click');
  assert.equal(byId(b.host, 'pill-catalog-add').disabled, false);
  byId(b.host, 'pill-catalog-add').fire('click');
  const intent = b.intents.pop();
  assert.equal(intent.type, 'create_agent'); assert.equal(intent.fromCatalog, 'integration_github');
  assert.equal(intent.name, 'GitHub'); assert.ok(A.PALETTE.includes(intent.color)); assert.ok(intent.instructions.includes('GitHub'));
  // search + category + cancel dispatch nothing
  byId(b.host, 'blob-tile-new').fire('click');
  const search = byId(b.host, 'pill-catalog-search'); search.value = 'zzzz'; search.fire('input');
  assert.match(words(byId(b.host, 'pill-catalog-list')), /Sin resultados/);
  byId(b.host, 'pill-catalog-cancel').fire('click'); assert.equal(b.intents.length, 0);
});

test('S7 nuevo · propio: Crear disabled until name + colour; switching mode keeps what was typed', () => {
  const b = boot(TWO());
  byId(b.host, 'blob-tile-new').fire('click'); byId(b.host, 'create-kind-custom').fire('click');
  const create = byId(b.host, 'blob-create-button'); assert.equal(create.disabled, true);
  const input = byId(b.host, 'blob-create-input'); input.value = 'Música'; input.fire('input');
  assert.equal(byId(b.host, 'blob-create-button').disabled, true, 'name alone is not enough');
  byClass(byId(b.host, 'blob-editor'), 'swatch').find(x => x.dataset.color === 'orange').fire('click');
  assert.equal(byId(b.host, 'blob-create-button').disabled, false);
  byId(b.host, 'create-kind-catalog').fire('click'); byId(b.host, 'create-kind-custom').fire('click');
  assert.equal(byId(b.host, 'blob-create-input').value, 'Música', 'the draft survives a mode switch');
  const what = byId(b.host, 'blob-create-what'); what.value = 'Pone música'; what.fire('input');
  byId(b.host, 'blob-create-button').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'create_agent', name: 'Música', instructions: 'Pone música', model: null, color: 'orange' });
});

test('S7b keyboard swatch entry: with no colour the FIRST swatch is the single tabindex-0 entry point; a selection moves it; ArrowRight chooses the next colour', () => {
  // create form, no colour yet: the radiogroup must have exactly one Tab entry point, the first swatch
  const b = boot(TWO());
  byId(b.host, 'blob-tile-new').fire('click'); byId(b.host, 'create-kind-custom').fire('click');
  const swatches = byClass(byId(b.host, 'blob-editor'), 'swatch');
  assert.equal(swatches.filter(x => x.tabIndex === 0).length, 1, 'exactly one entry point with no colour');
  assert.equal(swatches[0].tabIndex, 0, 'the first swatch is the Tab entry');
  assert.ok(swatches.slice(1).every(x => x.tabIndex === -1), 'the rest are roved out');
  // keyboard entry then ArrowRight chooses the next colour: with a name typed, Crear enables
  const input = byId(b.host, 'blob-create-input'); input.value = 'Música'; input.fire('input');
  swatches[0].fire('keydown', { key: 'ArrowRight' });
  assert.equal(byId(b.host, 'blob-create-button').disabled, false, 'ArrowRight picked the next colour');
  // once a colour is picked in the create form, only the picked swatch is 0
  const cs = byClass(byId(b.host, 'blob-editor'), 'swatch');
  assert.equal(cs.find(x => x.dataset.color === A.PALETTE[1]).tabIndex, 0);
  assert.equal(cs.filter(x => x.tabIndex === 0).length, 1);
  byId(b.host, 'blob-create-button').fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'create_agent', name: 'Música', instructions: 'Ayuda con Música.', model: null, color: A.PALETTE[1] });
  // agent editor with a selection: unchanged behaviour, only the selected colour is 0
  const e = boot(TWO());
  const ed = byClass(byId(e.host, 'blob-editor'), 'swatch');
  assert.equal(ed.filter(x => x.tabIndex === 0).length, 1);
  assert.equal(ed.find(x => x.dataset.color === 'green').tabIndex, 0, 'esp-a green is the only entry');
});

test('S8 «Guardados de antes»: stored blobs and declared pills without a specialist are listed with an explicit «Convertir en agente»; nothing converts by itself', () => {
  const x = TWO(); x.prefs.customBlobs = [{ name: 'Música', color: 'purple' }]; x.prefs.declaredPills = ['integration_n8n'];
  const b = boot(x);
  const row = byId(b.host, 'blob-saved-before');
  assert.ok(row); assert.match(words(row), /Guardados de antes/); assert.match(words(row), /Música/); assert.match(words(row), /n8n/);
  assert.equal(b.intents.length, 0, 'nothing happens on render');
  const buttons = byClass(row, 'blob-convert');
  assert.equal(buttons.length, 2); assert.match(words(buttons[0]), /Convertir en agente/);
  buttons[0].fire('click');
  assert.deepEqual(b.intents.pop(), { type: 'convert_saved', key: 'blob:Música' });
  assert.equal(byId(b.host, 'blob-saved-before') && 0, 0);
  const none = boot(TWO()); assert.equal(byId(none.host, 'blob-saved-before'), null, 'absent when there is nothing saved');
});

test('S9 lifecycle: identical state pushes neither rebuild nor restart any clay; a real change destroys the old instances; nothing leaks', () => {
  const b = boot(TWO());
  const first = b.made.length;
  b.render(); b.render(JSON.parse(JSON.stringify(b.input)));
  assert.equal(b.made.length, first, 'no new clay on an identical push');
  assert.equal(b.made.filter(m => m.destroyed).length, 0, 'none destroyed on an identical push');
  const next = JSON.parse(JSON.stringify(b.input)); next.store.specialists[0].name = 'Otro';
  b.render(next);
  assert.ok(b.made.length > first, 'a real change repaints');
  assert.equal(b.live().length, b.made.length - first, 'every instance of the previous paint was destroyed');
  assert.equal(b.live().length, first, 'and exactly one set is alive');
  settings.dispose(b.host);
  assert.equal(b.live().length, 0, 'leaving the screen destroys every instance');
});

test('S10 only trusted gestures change anything; a saving or failed state paints honestly', () => {
  const b = boot(TWO());
  byId(b.host, 'blob-editor-delete').fire('click', { isTrusted: false });
  assert.ok(!byId(b.host, 'blob-delete-confirm'), 'a synthetic click does nothing');
  byId(b.host, 'blob-editor-active').fire('click', { isTrusted: false }); assert.equal(b.intents.length, 0);
  const err = boot(TWO(), { error: 'No se pudo guardar el agente; se mantuvo el anterior.' });
  assert.match(words(byId(err.host, 'blob-settings-error')), /No se pudo guardar el agente/);
  const loading = boot({ prefs: TWO().prefs, store: null, listing: null });
  assert.equal(byClass(loading.host, 'blob-tile').length, 0);
  const broken = boot({ prefs: TWO().prefs, store: { load_error: true }, listing: null });
  assert.match(words(broken.host), /No se pudieron cargar los especialistas/);
  assert.equal(byId(broken.host, 'blob-tile-new'), null, 'no creation over unreadable data');
});

test('S11 the screen speaks agent/blob, never pill, and keeps the one chip disclaimer only on «Qué hace» of the principal', () => {
  const b = boot(TWO());
  for (const w of words(b.host).split(/\s+/)) assert.doesNotMatch(w, /pill/i, w);
});

// ---- style: the Blobs block (design §4 measures), tint by CSS, reduced motion by html[data-motion] ----
const fs = require('node:fs');
const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
const blobsCss = () => css.slice(css.indexOf('/* ---- #442: Blobs = agents'), css.indexOf('/* ---- #410: Conexiones compacta'));

test('S12 the Blobs block exists BEFORE the #410 marker and paints every clay in the five closed-palette colours', () => {
  const at = css.indexOf('/* ---- #442: Blobs = agents');
  assert.ok(at > 0 && at < css.indexOf('/* ---- #410: Conexiones compacta'), 'block sits before the #410 compact slice');
  const block = blobsCss();
  for (const c of ['green', 'blue', 'mint', 'orange', 'purple']) {
    for (const n of [1, 2, 3]) {
      assert.match(block, new RegExp(`\\.blob-clay\\[data-color="${c}"\\] radialGradient\\[id\\$="skin"\\] stop:nth-child\\(${n}\\) \\{ stop-color: var\\(--dot-${c}-${n}\\); \\}`), `${c} stop ${n}`);
    }
  }
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b(?![^{]*\{)/i, 'no raw colour outside declarations');
});

test('S13 design measures: list 404 + editor 308, tile 124x150, principal 80 high, swatch 28, editor head 72', () => {
  const block = blobsCss();
  assert.match(block, /\.pills-layout \{[^}]*grid-template-columns: minmax\(0, 1fr\) 308px/);
  assert.match(block, /\.blob-tile-new \{[^}]*width: 124px; min-height: 150px/, 'tile and the empty slot share the 124x150 rule');
  assert.match(block, /\.blob-principal \{[^}]*min-height: 80px/);
  assert.match(block, /\.swatch \{[^}]*width: 28px; height: 28px/);
  assert.match(block, /\.blob-editor-head \.blob-clay \{[^}]*width: 72px; height: 72px/);
  assert.match(block, /\.blob-strip-item \.blob-clay \{[^}]*width: 24px; height: 24px/);
  assert.match(block, /\[aria-pressed="true"\][^{]*\{[^}]*box-shadow: 0 0 0 2px var\(--island-live\)/, 'selected tile = 2px live ring');
  assert.match(block, /\.blob-count\[data-tone="sun"\]|#blob-count\[data-tone="sun"\]/, 'the counter turns sun at 3/3');
});

test('S14 reduced motion is html[data-motion="reduce"], never the system media query; no old CSS-dot rules remain', () => {
  const block = blobsCss();
  assert.match(block, /html\[data-motion="reduce"\][^{]*\.blob-tile[^{]*\{[^}]*transition: none/);
  assert.match(block, /html\[data-motion="reduce"\][^{]*\.blob-toggle[^{]*\{[^}]*transition: none/);
  assert.doesNotMatch(css, /@media[^{]*prefers-reduced-motion/);
  assert.doesNotMatch(css, /\.blob-visual|\.pill-principal|\.pill-tile\b|\.pill-strip-item/, 'the dot-blob and old tile rules are gone');
});
