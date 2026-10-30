'use strict';
// #503 T3 (S18-S27): the chosen option of every Ajustes screen, asserted through the public render functions:
// card structure, titles, order, state labels, and that every pre-existing control and closed command survives.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { all, text, dom, Element } = require('./settings-accounts-check.cjs');
const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
const load = name => import(pathToFileURL(path.join(base, name)));
const cards = ui => all(ui).filter(e => e.tagName === 'section' && e.className.split(' ').includes('abito-card'));
const titleOf = card => text(card.children.find(c => c.tagName === 'h2')).trim();
const labelsIn = node => all(node).filter(e => e.tagName === 'label').map(e => e.textContent);
const byId = (ui, id) => all(ui).find(e => e.attrs.id === id);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
module.exports = { test, cards, titleOf, labelsIn, byId, load, all, text, dom, Element, base };

// ---------------------------------------------------------------- S18 · 18 General → Opción A (tarjetas)
test('S18 General: three titled cards (Apariencia, Isla, Sonido), every control in its task group, none removed', async () => {
  dom();
  const { renderGeneral } = await load('general.js');
  const V = require('../frontend/settings-view.js');
  let prefs = { sound: true, gain: .12, autoCloseSeconds: 15, openOnHover: false, declaredPills: [], pillColors: {}, mainPill: 'integration_claude', theme: 'system', displayName: '', monitor: null, absenceSeconds: 10 };
  const invoke = async (cmd, { payload: p }) => {
    if (cmd === 'prefs_action' && p.action === 'autostart_view') return { enabled: false };
    if (cmd === 'recap_action') return p.action === 'prefs' ? { enabled: true } : { ok: true };
    if (cmd === 'monitor_action') return { monitors: [{ key: 'DP-1' }] };
    if (cmd === 'sound_action') return p.action === 'list' ? { names: [] } : { ok: true };
    if (cmd === 'hotkey_action') return { combo: 'Ctrl+Space', enabled: true, status: 'active', backend: 'portal' };
    return structuredClone(prefs);
  };
  const ui = await renderGeneral({ invoke, V }); await ui.settled();
  const c = cards(ui);
  assert.deepEqual(c.map(titleOf), ['Apariencia', 'Isla', 'Sonido']);
  assert.equal(all(ui).filter(e => e.tagName === 'section').length, 3, 'no stray sections: exactly the three cards');
  // each task group holds its own controls; the order inside a card follows the wireframe
  const [look, island, sound] = c.map(labelsIn);
  assert.deepEqual(look.slice(0, 2), ['Idioma', 'Tema'], 'Apariencia opens with Idioma and Tema, as in the wireframe');
  for (const l of ['Nombre visible', 'Abrir al iniciar sesión']) assert(look.includes(l), l);
  assert.deepEqual(island.slice(0, 3), ['Abrir al pasar el cursor', 'Plegar tras (s)', 'Ocultar plegada tras (s)']);
  for (const l of ['La isla vive en', 'Atajo global', 'Resumen semanal']) assert(island.includes(l), l);
  assert.deepEqual(sound.slice(0, 1), ['Sonido']);
  assert(byId(c[2], 'hub-volume') && byId(c[2], 'hub-sounds-folder') && byId(c[2], 'hub-sounds-reload'), 'Volumen, Abrir carpeta y Recargar live in Sonido');
  assert(byId(c[0], 'hub-language') && byId(c[0], 'hub-autostart'));
  assert(byId(c[1], 'hub-hover') && byId(c[1], 'hub-absence') && byId(c[1], 'hub-screen'));
  // nothing that existed disappeared
  for (const id of ['hub-sound', 'hub-volume', 'hub-hover', 'hub-absence', 'hub-screen', 'hub-language', 'hub-autostart', 'hub-sounds-folder', 'hub-sounds-reload', 'hub-recap', 'hub-recap-clear']) assert(byId(ui, id), id);
  for (const label of ['Nombre visible', 'Atajo global', 'Cierre automático en segundos', 'Segundos antes de ocultar la isla plegada']) assert(all(ui).some(e => e.attrs['aria-label'] === label || e.textContent === label), label);
  // visible helper text under the fields (input-helper-text), and the one status line is outside the cards
  assert(all(ui).some(e => e.attrs.role === 'tooltip' && e.textContent.includes('Sistema sigue el tema de tu escritorio.')), '0.2.1 S7: an ⓘ');
  // the mechanism that registers the global shortcut is a sentence, never a bare label with nothing to show
  assert(!all(ui).some(e => e.className === 'hint' && /^Atajo (del sistema|de GNOME|de X11|de Windows|limitado)/.test(e.textContent || '')), 'no bare backend label');
  assert(all(ui).some(e => e.attrs.role === 'tooltip' && e.textContent.includes('Se registra como: Atajo del sistema')), 'the mechanism reads as a sentence (in the ⓘ)');
  assert(c.every(card => all(card).some(e => e.className === 'hint')), 'every card carries helper text');
  assert(ui.children.at(-1).className === 'hub-note' && ui.children.at(-1).attrs.role === 'status', 'the one global status line is the last child, outside every card');
  ui.dispose();
});

test('S18 General: cards are styled as cards with 44px rows and a 44px switch hit area (CSS contract)', () => {
  const css = fs.readFileSync(path.join(base, 'abito.css'), 'utf8');
  assert(/section\.abito-card\s*>\s*\.row\s*\{[^}]*min-height:\s*44px/.test(css), '44px rows');
  assert(/section\.abito-card\s+\.switch::before\s*\{[^}]*inset:\s*-12px/.test(css), '44px switch hit area');
});

if (require.main === module) (async () => {
  // A test whose promise never settles must not end the process as a silent green run.
  process.exitCode = 1;
  process.on('beforeExit', () => { if (!done) console.error('not ok - a test never settled (hung promise)'); });
  let done = false;
  // later screens register themselves here
  for (const f of fs.readdirSync(__dirname).filter(f => /^settings-designs-[a-z-]+-check\.cjs$/.test(f))) require(path.join(__dirname, f));
  let failed = 0;
  for (const [name, fn] of tests) { try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`not ok - ${name}\n`, e); } }
  done = true;
  if (failed) process.exitCode = 1; else { process.exitCode = 0; console.log(`PASS settings-designs: ${tests.length} checks`); }
})();
