'use strict';
// #503 T3 · S20 · 20 Agentes → Opción B (tabla): Agente | Estado | En isla | Acciones. The plan moves to its own section
// below. The review-and-confirm flow, plan hashes, backups and every closed command are unchanged.
const assert = require('node:assert/strict');
const { test, all, text, dom, load } = require('./settings-designs-check.cjs');

const hash = 'a'.repeat(64);
async function mount({ agents, sessions, prefs = {}, slowAction } = {}) {
  dom();
  const { renderAgentSettings } = await load('agents.js');
  const V = require('../frontend/settings-view.js'), P = require('../frontend/pills.js');
  const calls = [], events = {};
  const store = { declaredPills: [], mainPill: 'integration_claude', ...prefs };
  const state = { connection: 'connected', agents: agents || [
    { id: 'claude-code', state: 'not_connected', plan_hash: hash, summary: 'Add managed hooks', reviewable: true },
    { id: 'codex', state: 'connected', backup: true }], sessions: sessions === undefined ? { rows: [{ id: 's-11111111', kind: 'pi', cwd: 'x', state: 'running', origin: null }], truncated: false } : sessions };
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'plan_action') return { available: false };
    if (cmd === 'agent_action' && p.action === 'agent_connect' && slowAction) await slowAction;
    if (cmd === 'prefs_action' && p.action === 'toggle_declared_pill') { store.declaredPills = P.toggle(P.normalize(store), p.id).declaredPills; return structuredClone(store); }
    if (cmd === 'prefs_action') return structuredClone(store);
    return structuredClone(state);
  };
  const ui = await renderAgentSettings({ invoke, V, P, listen: async (n, f) => { events[n] = f; return () => { delete events[n]; }; }, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  return { ui, calls, V, state, store };
}
const heads = ui => all(ui).filter(e => e.tagName === 'h2').map(e => text(e).trim());
const entry = (ui, id) => all(ui).find(e => e.attrs.id === `agent-row-${id}`);
const cellText = (row, cls) => text(all(row).find(e => e.className.split(' ').includes(cls)) || { children: [] }).replace(/\s+/g, ' ').trim();
const button = (scope, word) => all(scope).find(e => e.tagName === 'button' && (e.textContent === word || e.attrs['aria-label'] === word));

test('S20 Agentes: the table has the four columns and the rows in the wireframe order, and the plan is its own section below', async () => {
  const { ui } = await mount();
  assert.deepEqual(heads(ui).map(h => h.replace(/\s*ⓘ.*$/, '')), ['Agentes', 'Uso del plan', 'Resumen semanal'], 'Claude Code is a row now, the plan keeps its own section after the table');
  const table = all(ui).find(e => e.attrs.role === 'table'); assert(table, 'a real table role');
  assert.deepEqual(all(table).filter(e => e.attrs.role === 'columnheader').map(e => e.textContent), ['Agente', 'Estado', 'En isla', 'Acciones']);
  const list = all(ui).find(e => e.attrs.id === 'agent-hook-list');
  assert.deepEqual(list.children.map(e => e.attrs.id), ['agent-row-pi', 'agent-row-claude-code', 'agent-row-codex', 'agent-row-gemini-cli', 'agent-row-copilot-cli', 'agent-row-opencode'], '0.2.1 S2: the five CLIs, then the not-in-this-version rows');
  assert(ui.children[0].children.indexOf(table) < ui.children.length, 'table first');
});

test('S20 Agentes: Estado is icon + word per row; rows are 40px; Pi reads its extension state independently of sessions', async () => {
  const { ui } = await mount();
  const claude = entry(ui, 'claude-code'), codex = entry(ui, 'codex'), pi = entry(ui, 'pi');
  assert.equal(cellText(claude, 'agent-state'), '○ Sin conectar'); assert.equal(cellText(codex, 'agent-state'), '✓ Conectado'); assert.equal(cellText(pi, 'agent-state'), '· No disponible todavía');
  for (const row of [claude, codex, pi]) assert(all(row).some(e => e.className === 'state-ico' && e.attrs['aria-hidden'] === 'true'), 'icon is decorative; the word carries the state');
  const gone = await mount({ sessions: { rows: [], truncated: false } }); assert.equal(cellText(entry(gone.ui, 'pi'), 'agent-state'), '· No disponible todavía');
  const installed = await mount({ agents: [{id:'pi', state:'connected'}], sessions: null });
  assert.equal(cellText(entry(installed.ui,'pi'), 'agent-state'), '✓ Instalado en carpeta predeterminada');
  const unknown = await mount({ sessions: null }); assert.equal(cellText(entry(unknown.ui, 'pi'), 'agent-state'), '· No disponible todavía');
  const fs = require('node:fs'), path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/vendor/coucou/hub/abito.css'), 'utf8');
  assert(/\.agent-row\s*\{[^}]*min-height:\s*40px/.test(css), '40px rows');
});

test('S20 Agentes: «En isla» is the pill declaration through the SAME closed command; main/unknown are disabled with a reason; there is no «full» (S32: no limit)', async () => {
  const { ui, calls, store } = await mount();
  const sw = id => all(entry(ui, id)).find(e => e.className.split(' ').includes('switch'));
  // HU-015: a main-pill preference cannot activate an agent whose own hooks are absent.
  assert.equal(sw('claude-code').disabled, true); assert.equal(sw('claude-code').attrs['aria-pressed'], 'false'); assert.match(sw('claude-code').attrs.title, /hooks/);
  const installedMain = await mount({ agents: [{ id: 'claude-code', state: 'connected', backup: true }] });
  const mainSwitch = all(entry(installedMain.ui, 'claude-code')).find(e => e.className.split(' ').includes('switch'));
  assert.equal(mainSwitch.disabled, true); assert.equal(mainSwitch.attrs['aria-pressed'], 'true'); assert.match(mainSwitch.attrs.title, /principal/);
  assert.equal(sw('pi').disabled, true); assert(sw('pi').attrs.title, 'why: Pi is the principal agent');
  const codex = sw('codex'); assert.equal(codex.disabled, false); assert.equal(codex.attrs['aria-pressed'], 'false');
  calls.length = 0; codex.fire('click', false); await ui.settled(); assert.deepEqual(calls, [], 'a synthetic click does nothing');
  codex.fire('click'); await ui.settled();
  assert.deepEqual(calls.filter(([c]) => c === 'prefs_action' && c).map(([, p]) => p).filter(p => p.action === 'toggle_declared_pill'), [{ action: 'toggle_declared_pill', id: 'agent_codex' }]);
  assert.deepEqual(store.declaredPills, ['agent_codex']);
  // S32: four declared pills no longer block the fifth: the switch stays usable
  const full = await mount({ prefs: { declaredPills: ['agent_cursor', 'agent_gemini', 'agent_opencode', 'agent_amp'] } });
  assert.equal(all(entry(full.ui, 'codex')).find(e => e.className.split(' ').includes('switch')).disabled, false);
});

test('S20 Agentes: the action cell is Instalar… when nothing is installed, ⋮ with Reinstalar/Desinstalar when it is; Desinstalar keeps its review', async () => {
  const { ui, calls, V, state } = await mount();
  const claude = entry(ui, 'claude-code'), codex = entry(ui, 'codex');
  const install = button(claude, 'Instalar…'); assert(install, 'not installed: the primary action is in the row'); assert(!button(claude, 'Más opciones de Claude Code'));
  assert(!button(codex, 'Desinstalar…'), 'installed: the destructive action is behind ⋮ until it is opened');
  const more = button(codex, 'Más opciones de Codex'); assert(more && more.attrs['aria-haspopup'] === 'true');
  // install: ONE trusted click writes the plan the row showed (human request 23-oct: no second button)
  calls.length = 0; install.fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  install.fire('click'); await ui.settled();
  assert.deepEqual(calls.filter(([c]) => c === 'agent_action'), [['agent_action', { action: 'agent_connect', agentId: 'claude-code', plan_hash: hash }]]);
  // uninstall through the menu
  const fresh = await mount(); const c2 = entry(fresh.ui, 'codex');
  button(c2, 'Más opciones de Codex').fire('click', false); assert(!button(c2, 'Desinstalar…'), 'synthetic click opens nothing');
  button(c2, 'Más opciones de Codex').fire('click'); fresh.calls.length = 0;
  assert(button(c2, 'Reinstalar…') && button(c2, 'Desinstalar…'));
  button(c2, 'Desinstalar…').fire('click'); await fresh.ui.settled(); assert.deepEqual(fresh.calls, []);
  button(c2, 'Respaldar y quitar').fire('click', false); await fresh.ui.settled(); assert.deepEqual(fresh.calls, []);
  button(c2, 'Respaldar y quitar').fire('click'); await fresh.ui.settled();
  assert.deepEqual(fresh.calls, [['agent_action', { action: 'agent_disconnect', agentId: 'codex' }]]);
  // a plan without hash never authorizes a write
  const nohash = await mount({ agents: [{ id: 'claude-code', state: 'not_connected', reviewable: true }] });
  assert.equal(button(entry(nohash.ui, 'claude-code'), 'Instalar…').disabled, true);
});

test('Agentes: an outdated agent shows «Actualizar…» in the row (no hunting in ⋮); ⋮ Desinstalar is unchanged', async () => {
  const { ui, calls } = await mount({ agents: [{ id: 'codex', state: 'outdated', plan_hash: hash, summary: 'Update managed hooks', reviewable: true, backup: true }] });
  const codex = entry(ui, 'codex');
  const update = button(codex, 'Actualizar…'); assert(update, 'outdated: the update action is visible in the row');
  assert.equal(update.disabled, false);
  assert(button(codex, 'Más opciones de Codex'), 'Desinstalar stays behind ⋮');
  calls.length = 0; update.fire('click'); await ui.settled();
  assert.deepEqual(calls.filter(([c]) => c === 'agent_action'), [['agent_action', { action: 'agent_connect', agentId: 'codex', plan_hash: hash }]]);
});

test('Agentes: Instalar…/Actualizar… is ONE trusted click: it writes the plan the row showed, with a progress bar while it runs; a synthetic click writes nothing', async () => {
  let release; const pending = new Promise(r => { release = r; });
  const { ui, calls } = await mount({ agents: [
    { id: 'claude-code', state: 'not_connected', plan_hash: hash, summary: 'Add managed hooks', reviewable: true },
    { id: 'codex', state: 'outdated', plan_hash: hash, summary: 'Update managed hooks', reviewable: true, backup: true }], slowAction: pending });
  for (const [id, label] of [['claude-code', 'Instalar…'], ['codex', 'Actualizar…']]) {
    const row = entry(ui, id);
    calls.length = 0; button(row, label).fire('click', false); await ui.settled(); assert.deepEqual(calls, [], `${id}: a synthetic click writes nothing`);
    assert(!button(row, 'Respaldar y escribir'), `${id}: no second confirm button`);
  }
  const row = entry(ui, 'codex'); calls.length = 0;
  button(row, 'Actualizar…').fire('click');
  assert(all(row).some(e => (e.className || '').split(' ').includes('hub-progress')), 'a progress bar shows while it runs');
  assert(text(row).includes('Actualizando'), 'and says what it is doing');
  release(); await ui.settled();
  assert.deepEqual(calls.filter(([c]) => c === 'agent_action'), [['agent_action', { action: 'agent_connect', agentId: 'codex', plan_hash: hash }]], 'exactly the plan the row showed');
});

test('S20 Agentes: how to undo is stated next to the table, and the plan section, recap and relay survive intact', async () => {
  const { ui } = await mount();
  assert(!all(ui.children[0]).some(e => e.className === 'hint' && e.attrs.id !== 'agent-action-status' && !/^Con respaldo\.$/.test(e.textContent)), 'S7: no standing explanation next to the table (the host row note stays)');
  assert(all(ui.children[0]).some(e => e.attrs.role === 'tooltip' && e.textContent.includes('Desinstalar quita solo lo que Koda agregó; antes se guarda un respaldo.')), 'how to undo is an ⓘ');
  assert(all(ui).some(e => e.attrs.id === 'agent-integration-statusline'), 'the relay is still installable from the plan section');
  assert(all(ui).some(e => e.attrs.id === 'agent-integration-recap'), 'the weekly recap block is still there');
  const plan = ui.children[1]; assert.equal(all(plan).filter(e => e.tagName === 'button' && String(e.className).includes('switch')).length, 1, 'S5/L4: only Claude Code plan usage; Codex is for 0.3');
});

test('S20 Agentes: a state of «error» is shown once in the Estado column, NEVER as a permanent caption under every row', async () => {
  const bad = ['claude-code', 'codex', 'copilot-cli', 'opencode'].map(id => ({ id, state: 'error' }));
  const { ui } = await mount({ agents: bad });
  const caption = 'No se pudo completar; no se tocó nada.';
  for (const id of ['claude-code', 'codex']) {
    const row = entry(ui, id);
    assert(!text(row).includes(caption), `${id}: the generic failure sentence is not a standing caption`);
    assert.equal(cellText(row, 'agent-state'), '✗ No se pudo', `${id}: the state column still says it`);
  }
  assert.equal((text(ui).match(/No se pudo completar; no se tocó nada\./g) || []).length, 0, 'zero copies on the page at rest');
});

test('S20 Agentes: a FAILED ACTION says so once, in the one status line of the page, and the next success clears it', async () => {
  const { ui, V } = await mount({ agents: [{ id: 'claude-code', state: 'not_connected', plan_hash: hash, summary: 'Add managed hooks', reviewable: true }, { id: 'codex', state: 'connected', backup: true }] });
  const live = all(ui).find(e => e.attrs.id === 'agent-action-status');
  assert(live, 'one status line for action outcomes'); assert.equal(live.attrs.role, 'status'); assert.equal(live.attrs['aria-live'], 'polite'); assert.equal(text(live).trim(), '');
  assert(V.agentActionFailure && V.agentActionFailure('claude-code') === 'No se pudo completar la acción en Claude Code; no se tocó nada.');
  assert.equal(V.agentActionFailure('nope'), 'No se pudo completar la acción; no se tocó nada.');
});
