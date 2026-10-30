'use strict';
// #503 T3 · S27 · 27 Dictado (Flow) → Opción B: a «Probar» area on top of the settings: «mantené Ctrl+Alt+V y hablá» and a
// field where the last dictation shows up, plus the microphone and the recognition engine. Honest by construction: the host
// delivers dictation to the CLIPBOARD (never into a field), so the field shows the last dictation read from the local history
// when a new one lands. The microphone meter (human L5) is read-only: it listens to `dictation:level` and sends nothing.
const assert = require('node:assert/strict');
const { test, all, text, dom, load } = require('./settings-designs-check.cjs');

async function mount({ history = [], mics = [{ name: 'Micrófono USB' }], parakeet = 'ready', keys = 'ok' } = {}) {
  dom();
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const { flowSettingsPage } = await load('dictation-pages.js'); const { setInvoke } = await load('flow-shim.js'); const { hero } = await load('hero.js');
  const events = new Map(), calls = []; let entries = history;
  global.window = { __TAURI__: { event: { listen: async (name, fn) => { const l = events.get(name) || new Set(); events.set(name, l); l.add(fn); return () => l.delete(fn); } } } };
  const state = { prefs: { enabled: true, key: 'right_ctrl', edge: 'bottom', mic: '', keepDays: 30, cleanup: false, defaultStyle: 'natural' }, models: { parakeet: { state: parakeet }, downloadMb: 612 }, keys, hasClaudeKey: false, mics, platform: 'linux', autostarted: false };
  setInvoke(async (cmd, { payload: p }) => {
    calls.push([cmd, structuredClone(p)]);
    if (p.action === 'status') return structuredClone(state);
    if (p.action === 'history') return structuredClone(entries);
    if (p.action === 'prefs_action' || cmd === 'prefs_action') return { openSettingsAtLaunch: false };
    return { ok: true };
  });
  let status = structuredClone(state), leave;
  const ctx = { get status() { return status; }, hero, navigate() {}, refresh: async () => status, setPrefs: async () => {}, updateModels() {}, get onLeave() { return leave; }, set onLeave(fn) { leave = fn; } };
  const page = new Element_();
  await flowSettingsPage(page, ctx, async (cmd, { payload: p }) => { calls.push([cmd, p]); return { openSettingsAtLaunch: false }; });
  await Promise.resolve(); await Promise.resolve();
  const emit = async (name, payload) => { for (const fn of events.get(name) || []) fn({ payload }); await new Promise(r => setImmediate(r)); };
  return { page, calls, emit, setEntries: next => { entries = next; }, flush: () => new Promise(r => setImmediate(r)) };
}
function Element_() { return new (require('./settings-accounts-check.cjs').Element)('div'); }
const byId = (page, id) => all(page).find(e => e.attrs.id === id);
const words = e => text(e).replace(/\s+/g, ' ').trim();
const labels = page => all(page).filter(e => e.className === 'hub-label').map(e => e.textContent);

test('S27 Dictado: the «Probar» area comes FIRST (right after the hero), with the instruction and the key', async () => {
  const { page } = await mount();
  assert(String(page.children[0].className).includes('hub-hero'), 'the hero stays the first thing');
  const area = byId(page, 'dictation-try'); assert(area);
  assert.equal(page.children[1].className, 'hub-label', 'the section label sits right after the hero'); assert.equal(page.children[2], area, 'and the area right after it, before every setting');
  assert(words(area).includes('Probar: mantené Ctrl+Alt+V y hablá'));
  assert.deepEqual(labels(page), ['Probar', 'Activación', 'Audio', 'Datos'], '0.2.1 L2 (Ajustes de dictado: A): Probar first, then Activación, Audio, Datos');
});

test('S27 Dictado: the test field is read-only, labelled, and says WHERE the dictation goes (the clipboard), not pretending to be the paste target', async () => {
  const { page } = await mount();
  const field = byId(page, 'dictation-try-field'); assert.equal(field.tagName, 'textarea'); assert(field.attrs.readonly !== undefined || field.readOnly === true || field.attrs.readonly === 'true');
  assert.equal(field.attrs['aria-label'], 'Lo que dictaste'); assert.equal(field.attrs.placeholder, 'Lo que dictes aparece acá');
  assert.equal(field.value, '', 'empty until something is dictated: nothing is invented');
  assert(words(byId(page, 'dictation-try')).includes('Se copia al portapapeles: pegá con Ctrl+V donde escribas.'));
});

test('S27 Dictado: a new dictation shows its text in the field (read from the local history), never from the event payload', async () => {
  const { page, calls, emit, setEntries } = await mount();
  const field = byId(page, 'dictation-try-field');
  setEntries([{ id: 'e1', text: 'hola mundo desde el micrófono', date: 1, words: 5, seconds: 2 }]);
  calls.length = 0; await emit('dictation:history', { text: 'LEAKED FROM EVENT' });
  assert.equal(field.value, 'hola mundo desde el micrófono'); assert(!words(page).includes('LEAKED FROM EVENT'));
  assert.deepEqual(calls.filter(([c]) => c === 'dictation_action').map(([, p]) => p), [{ action: 'history' }], 'one closed read of the local history');
  setEntries([{ id: 'e2', text: 'segundo dictado', date: 2, words: 2, seconds: 1 }, { id: 'e1', text: 'hola mundo desde el micrófono', date: 1, words: 5, seconds: 2 }]);
  await emit('dictation:history', {}); assert.equal(field.value, 'segundo dictado', 'the newest entry');
  setEntries([]); await emit('dictation:history', {}); assert.equal(field.value, '', 'an emptied history empties the field');
  const status = byId(page, 'dictation-try-status'); assert(status); assert.equal(status.attrs.role, 'status');
});

test('S27 Dictado: the area confirms microphone and key from the REAL status and carries the read-only microphone meter', async () => {
  const ok = await mount(); const s = words(byId(ok.page, 'dictation-try-checks'));
  assert(s.includes('✓ Micrófono: Micrófono USB') || s.includes('✓ Micrófono: predeterminado del sistema'), s); assert(s.includes('✓ Tecla: Ctrl+Alt+V')); assert(s.includes('✓ Reconocimiento: Parakeet'));
  const none = await mount({ mics: [], parakeet: 'missing', keys: 'unsupported' }); const w = words(byId(none.page, 'dictation-try-checks'));
  assert(w.includes('✗ Reconocimiento: falta descargar Parakeet')); assert(w.includes('✗ Tecla: no disponible aquí'), w);
  const meter = byId(ok.page, 'dictation-mic-meter'); assert(meter, 'the meter is in the Probar area');
  assert.equal(meter.attrs.role, 'meter'); assert.equal(meter.attrs['data-state'], 'none', 'no level yet: «sin señal»'); assert(words(meter).includes('sin señal'), words(meter));
  assert.equal(all(ok.page).filter(e => e.tagName === 'canvas' && e.className.includes('level')).length, 0, 'it is drawn with segments, not a canvas');
  assert(all(byId(ok.page, 'dictation-try-checks')).every(e => e.attrs['aria-hidden'] !== 'true' || e.className === 'state-ico'), 'icons are decorative, the words carry the state');
});

test('S27 Dictado: every existing control and closed command survives, and the area adds NO command', async () => {
  const { page, calls } = await mount();
  const sw = all(page).filter(e => e.className.includes('switch')); assert(sw.length >= 1, 'the dictation switch is kept (the manual-open switch moved to General, 0.2.1 L2)');
  assert(all(page).some(e => e.tagName === 'select'), 'microphone and keep-days selects kept'); assert(!byId(page, 'hub-open-at-launch'));
  const repaste = all(page).find(e => e.tagName === 'button' && e.textContent === 'Pegar de nuevo'); assert(repaste && !repaste.disabled);
  calls.length = 0; repaste.fire('click', false); await new Promise(r => setImmediate(r)); assert.deepEqual(calls, []);
  repaste.fire('click'); await new Promise(r => setImmediate(r)); assert.deepEqual(calls.filter(([c]) => c === 'dictation_action').map(([, p]) => p), [{ action: 'copy_last' }]);
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../frontend/vendor/coucou/hub/dictation-pages.ts'), 'utf8');
  assert(!/innerHTML|setAttribute\('style|console\./.test(src));
});
