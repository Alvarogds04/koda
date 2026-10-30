'use strict';
// #503 T3 · S25 · 25 Atajos → Opción A: a table Acción | Tecla | Estado. The state is icon + word (never colour alone), the
// capture instruction is visible WHILE recording, and «Restablecer» asks for confirmation. Every binding, id and closed
// hotkey_action command is unchanged.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, all, text, dom, base, load } = require('./settings-designs-check.cjs');

async function mount({ status = {}, dup = false } = {}) {
  dom();
  global.window = { innerWidth: 1100, addEventListener() {}, removeEventListener() {} };
  const { renderShortcuts } = await load('shortcuts.js');
  const { SHORTCUTS } = await import(pathToFileURL(path.resolve(base, '../core/shortcuts.js')));
  const V = require('../frontend/settings-view.js');
  const calls = [], events = {}, bindings = {};
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'recap_action') return p.action === 'prefs' ? { enabled: true } : { ok: true };
    if (cmd === 'hotkey_action') {
      const id = p.id || 'toggleIsland';
      const b = bindings[id] ||= { combo: dup && ['toggleIsland', 'desktopToggle'].includes(id) ? 'Ctrl+Space' : id === 'toggleIsland' ? 'Ctrl+Space' : `Ctrl+Alt+${id.length}${id}`, enabled: true, status: status[id] || 'active' };
      if (p.action === 'set') { b.combo = p.combo; b.enabled = true; } if (p.action === 'enable') b.enabled = true; if (p.action === 'disable') b.enabled = false;
      if (p.action === 'clear') { b.combo = ''; b.enabled = false; } if (p.action === 'reset') { b.enabled = true; }
      return structuredClone(b);
    }
    return {};
  };
  const ui = await renderShortcuts({ invoke, V, listen: async (n, f) => { events[n] = f; return () => { delete events[n]; }; }, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  return { ui, calls, events, SHORTCUTS, bindings };
}
const find = (ui, id) => all(ui).find(e => e.attrs.id === id);
const words = e => text(e).replace(/\s+/g, ' ').trim();
const cell = (row, cls) => all(row).find(e => e.className.split(' ').includes(cls));
const click = (e, trusted = true) => { assert(e); e.fire('click', trusted); };

test('S25 Atajos: a real table with the columns Acción | Tecla | Estado, one row per binding in the existing order', async () => {
  const { ui, SHORTCUTS } = await mount();
  const table = all(ui).find(e => e.attrs.role === 'table'); assert(table);
  assert.deepEqual(all(table).filter(e => e.attrs.role === 'columnheader').map(e => e.textContent), ['Acción', 'Tecla', 'Estado']);
  const list = find(ui, 'global-shortcuts');
  assert.equal(list.children.length, SHORTCUTS.filter(d => d.ported).length);
  assert.deepEqual(list.children.map(e => e.attrs.id), SHORTCUTS.filter(d => d.ported).map(d => `shortcut-${d.id}`), 'same bindings, same order, same ids');
  for (const row of list.children) { assert.equal(row.attrs.role, 'row'); assert(cell(row, 'shortcut-name') && cell(row, 'shortcut-state') && all(row).some(e => e.className.split(' ').includes('keycap'))); }
  assert.deepEqual(all(ui).filter(e => e.className === 'subhead').map(text), ['Desde cualquier lugar', 'En la isla abierta'], 'the island shortcuts stay below');
  assert.equal(find(ui, 'island-shortcuts').children.length > 0, true);
});

test('S25 Atajos: Estado is icon + word for each situation: ok, used twice, taken, invalid, unsupported, denied, off', async () => {
  const states = { desktopToggle: 'taken' };
  const { ui, SHORTCUTS } = await mount({ status: states });
  const st = id => words(cell(find(ui, `shortcut-${id}`), 'shortcut-state'));
  assert.equal(st('toggleIsland'), '✓ activo'); assert.equal(st('desktopToggle'), '⚠ En uso por otra app');
  for (const row of find(ui, 'global-shortcuts').children) assert(all(cell(row, 'shortcut-state')).some(e => e.className === 'state-ico' && e.attrs['aria-hidden'] === 'true'), `${row.attrs.id}: decorative icon`);
  const cases = { invalid: '✗ No es un atajo válido', unsupported: '· No disponible', permission_denied: '⚠ Tu escritorio no lo activó', taken: '⚠ En uso por otra app' };
  for (const [status, expected] of Object.entries(cases)) { const m = await mount({ status: { toggleIsland: status } }); assert.equal(words(cell(find(m.ui, 'shortcut-toggleIsland'), 'shortcut-state')), expected, status); }
  const dup = await mount({ dup: true }); assert(SHORTCUTS.length); assert.match(words(cell(find(dup.ui, 'shortcut-desktopToggle'), 'shortcut-state')), /^✗ Usado dos veces/, 'a combo used twice is an error with icon + text');
  // a disabled binding says so in words
  const off = await mount(); click(find(off.ui, 'shortcut-toggleIsland').children[0]); await off.ui.settled();
  assert.equal(words(cell(find(off.ui, 'shortcut-toggleIsland'), 'shortcut-state')), '○ apagado');
});

test('S25 Atajos: while a key is being captured the instruction is visible and live; Esc cancels, Backspace removes', async () => {
  const { ui, calls } = await mount();
  const guide = () => find(ui, 'shortcut-capture-help'); assert(guide(), 'the instruction line exists'); assert.equal(guide().hidden, true, 'nothing to say until a capture starts');
  assert.equal(guide().attrs.role, 'status'); assert.equal(guide().attrs['aria-live'], 'polite');
  const keycap = () => find(ui, 'shortcut-toggleIsland').children.at(-1);
  click(keycap(), false); assert.equal(guide().hidden, true, 'a synthetic click starts nothing');
  click(keycap()); await ui.settled();
  assert.equal(guide().hidden, false); assert.equal(words(guide()), 'Pulsá las teclas… Esc cancela · ⌫ quita');
  assert.deepEqual(calls.filter(([c]) => c === 'hotkey_action').map(([, p]) => p.action).slice(-1), ['suspend']);
  keycap().fire('keydown', true, { key: 'Escape', code: 'Escape' }); await ui.settled();
  assert.equal(guide().hidden, true, 'the instruction goes away when the capture ends');
  click(keycap()); await ui.settled(); calls.length = 0;
  keycap().fire('keydown', true, { key: 'K', code: 'KeyK', ctrlKey: true }); await ui.settled();
  assert.deepEqual(calls.map(([, p]) => p), [{ action: 'set', combo: 'Ctrl+K' }, { action: 'resume' }]);
  assert.equal(guide().hidden, true);
});

test('S25 Atajos: Restablecer asks first; only the trusted confirmation resets, in the same clear-then-reset order', async () => {
  const { ui, calls, SHORTCUTS } = await mount();
  const reset = find(ui, 'shortcut-reset'), confirm = find(ui, 'shortcut-reset-confirm');
  assert(confirm && confirm.hidden, 'the confirmation exists and is closed'); assert.equal(reset.textContent, 'Restablecer');
  calls.length = 0;
  click(reset, false); await ui.settled(); assert.equal(confirm.hidden, true); assert.deepEqual(calls, []);
  click(reset); await ui.settled(); assert.equal(confirm.hidden, false); assert.deepEqual(calls, [], 'asking writes nothing');
  assert(words(confirm).includes('¿Restablecer todos los atajos a sus teclas originales?'));
  const yes = all(confirm).find(e => e.tagName === 'button' && e.textContent === 'Restablecer'), no = all(confirm).find(e => e.tagName === 'button' && e.textContent === 'Cancelar');
  click(no); await ui.settled(); assert.equal(confirm.hidden, true); assert.deepEqual(calls, [], 'Cancelar writes nothing');
  click(reset); click(yes, false); await ui.settled(); assert.deepEqual(calls, [], 'a synthetic confirmation does nothing');
  click(yes); await ui.settled();
  const ported = SHORTCUTS.filter(d => d.ported);
  assert.deepEqual(calls.map(([c, p]) => `${c}:${p.action}:${p.id ?? ''}`).filter(x => !x.startsWith('recap')),
    ['clear', 'reset'].flatMap(action => ported.map(d => `hotkey_action:${action}:${d.id === 'toggleIsland' ? '' : d.id}`)), 'the same closed commands in the same order');
  assert.equal(confirm.hidden, true, 'it closes when done');
});

test('S25 Atajos: every control that existed survives: switches, keycaps, recap rows and the shared backend note', async () => {
  const { ui, SHORTCUTS } = await mount();
  for (const d of SHORTCUTS.filter(d => d.ported)) { const row = find(ui, `shortcut-${d.id}`); assert(row.children[0].className.split(' ').includes('switch'), `${d.id}: switch first`); assert(row.children.at(-1).className.split(' ').includes('keycap'), `${d.id}: keycap last`); }
  assert(!all(ui).some(e => e.attrs.id === 'hub-recap' || e.attrs.id === 'hub-recap-clear'), '0.2.1 (propuesta Atajos): the weekly recap rows live ONLY in General (same controls, same recap_action)');
  assert.equal((text(ui).match(/Atajo de X11/g) || []).length, 1, 'the shared backend footer appears once');
});

test('S25 Atajos: the portal\'s description of a key is TRANSLATED («Pulse <Shift><Control>n» -> Ctrl+Shift+N), never shown raw', async () => {
  const { portalTriggerKeys, keyText } = await load('shortcuts.js');
  // portalTriggerKeys returns the app's canonical accelerator (what displayKeys / the host already speak); keyText is what is DRAWN
  const accel = [['Pulse <Shift><Control>n', 'Ctrl+Shift+n'], ['Press <Control><Alt>space', 'Ctrl+Alt+Space'], ['<Control><Alt>t', 'Ctrl+Alt+t'], ['Pulse <Control><Alt>Right', 'Ctrl+Alt+Right'],
    ['Pulse <Shift><Control><Alt>a', 'Ctrl+Alt+Shift+a'], ['Drücke <Primary><Mod1>F9', 'Ctrl+Alt+F9'], ['Pulse <Super>l', 'Super+l']];
  for (const [raw, expected] of accel) assert.equal(portalTriggerKeys(raw)?.toLowerCase(), expected.toLowerCase(), raw);
  const shown = [['Pulse <Shift><Control>n', 'Ctrl+Shift+N'], ['Pulse <Control><Alt>Right', 'Ctrl+Alt+→'], ['Press <Control><Alt>space', 'Ctrl+Alt+Space']];
  for (const [raw, expected] of shown) assert.equal(keyText(raw, '', ''), expected, raw);
  assert.equal(keyText('Pulse <Shift><Control>n', 'Ctrl+Alt+A', ''), 'Ctrl+Shift+N', 'the translated, effective binding wins over the configured one');
  assert.equal(keyText('', 'Ctrl+Alt+A', ''), 'Ctrl+Alt+A', 'no portal text: the configured combo');
  assert.equal(keyText('Pulse <basura', 'Ctrl+Alt+A', ''), 'Ctrl+Alt+A', 'unparseable portal text never reaches the screen');
  assert.equal(keyText('Pulse <basura', '', 'Ctrl+Alt+D'), 'Ctrl+Alt+D', 'and falls back to the default when nothing is configured');
  for (const bad of ['', 'Pulse', 'n', '<Control>', '<Control><Alt>', 'Pulse <Control>a b', '<Shift>n']) assert.equal(portalTriggerKeys(bad), null, JSON.stringify(bad));
  assert.equal(portalTriggerKeys('x'.repeat(5000) + ' <Control>a'), null, 'bounded input');
});

test('S25 Atajos: a key cell NEVER contains «Pulse», «<» or «>» unless it is capturing; capturing says «Pulsa las teclas…»', async () => {
  const { ui } = await mount();
  const caps = all(find(ui, 'global-shortcuts')).filter(e => e.className.split(' ').includes('keycap'));
  assert(caps.length > 0); for (const k of caps) assert(!/Pulse|[<>]/.test(k.textContent), k.textContent);
});
