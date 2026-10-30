'use strict';
// HU-046: the «Instalar Pi» control. A fake host stands in for pi_install_action; nothing is installed. Checks that the control only
// appears when the engine reports a missing Pi/Node, that nothing runs without TWO trusted clicks (the first one only shows the plan),
// that the page only ever sends {action:'run'|'status'}, and that the words come from the host's fixed sentences.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { all, text, dom } = require('./settings-accounts-check.cjs');
const { load } = require('./settings-designs-check.cjs');

const missing = code => ({ connection: 'no_daemon', last_error: { code, n: 1 } });
async function mount() {
  dom();
  const { piInstallControl, missingPiece, PI_COMMAND } = await load('piinstall.js');
  const calls = [], listeners = {}; let doneCalls = 0;
  const host = { answer: { action: 'status', phase: 'idle' } };
  const call = async (cmd, payload) => { calls.push([cmd, payload]); return ['run', 'open_node', 'install_node', 'check_node'].includes(payload.action) ? host.answer : { action: 'status', phase: 'idle' }; };
  const watch = (name, fn) => { listeners[name] = fn; };
  const work = (fn, done = () => {}, failed = () => {}) => fn().then(done, failed);
  const control = piInstallControl({ call, watch, work, onDone: () => { doneCalls += 1; } });
  const settle = () => new Promise(r => setImmediate(r));
  const buttons = () => all(control.element).filter(e => e.tagName === 'button');
  const click = (word, trusted = true) => { const b = buttons().find(x => x.textContent === word); assert(b, `button «${word}» in: ${text(control.element)}`); b.fire('click', trusted); };
  return { control, calls, listeners, host, buttons, click, settle, missingPiece, PI_COMMAND, done: () => doneCalls };
}

(async () => {
  const m = await mount(); await m.settle();
  assert.deepEqual(m.calls, [['pi_install_action', { action: 'status' }]], 'on mount it only READS the status');
  // 1) nothing missing: nothing shown (Claude Code / Codex rows and a healthy chat never see it)
  m.control.update({ connection: 'connected' });
  assert.equal(m.control.element.hidden, true); assert.equal(m.buttons().length, 0);
  for (const state of [null, undefined, {}, { connection: 'connecting' }, { connection: 'lost', last_error: { code: 'pi_missing' } }, { connection: 'no_daemon', last_error: { code: 'host_missing' } }, { connection: 'no_daemon', last_error: { code: 'pi_missing; rm -rf' } }]) {
    m.control.update(state); assert.equal(m.control.element.hidden, true, JSON.stringify(state));
  }
  // 2) Pi missing: the control explains WHY and gives the command; a click only shows the plan; running needs a second trusted click
  m.control.update(missing('pi_missing'));
  assert.equal(m.control.element.hidden, false);
  assert(text(m.control.element).includes('funciona con Pi') && text(m.control.element).includes(m.PI_COMMAND), text(m.control.element));
  m.calls.length = 0;
  m.click('Instalar Pi', false); await m.settle();
  assert(!text(m.control.element).includes('Se va a ejecutar'), 'an untrusted click does nothing'); assert.deepEqual(m.calls, []);
  m.click('Instalar Pi'); await m.settle();
  assert.deepEqual(m.calls, [], 'the first trusted click only SHOWS what will run');
  assert(text(m.control.element).includes(`Se va a ejecutar: ${m.PI_COMMAND}`) && text(m.control.element).includes('No pide permisos de administrador'));
  m.click('Cancelar'); assert(!text(m.control.element).includes('Se va a ejecutar')); assert.deepEqual(m.calls, []);
  m.click('Instalar Pi'); m.click('Instalar ahora', false); await m.settle(); assert.deepEqual(m.calls, [], 'the confirm needs a trusted click too');
  m.host.answer = { action: 'status', phase: 'running' };
  m.click('Instalar ahora'); await m.settle();
  assert.deepEqual(m.calls, [['pi_install_action', { action: 'run' }]], 'exactly {action:run}: no package, path or URL from the page');
  assert(text(m.control.element).includes('Instalando Pi'), 'progress while it runs'); assert.equal(m.buttons().length, 0, 'no second install while one runs');
  // 3) failure: the host's fixed sentence, Pi is NOT shown as installed, and the human can retry
  m.listeners['pi-install:state']({ action: 'status', phase: 'failed', reason: 'install_failed', say: 'No se pudo instalar Pi. Si Node.js está en una carpeta del sistema, instalalo desde una terminal con permisos o configurá una carpeta propia para npm.' });
  assert(text(m.control.element).includes('No se pudo instalar Pi')); assert(!text(m.control.element).includes('quedó instalado'));
  assert(m.buttons().some(b => b.textContent === 'Reintentar'));
  assert.equal(m.done(), 0, 'a failure never triggers the «chat ready» refresh');
  // 4) success: said once, the page refreshes the engine state
  m.listeners['pi-install:state']({ action: 'status', phase: 'done' });
  assert(text(m.control.element).includes('Pi quedó instalado')); assert.equal(m.done(), 1);
  m.listeners['pi-install:state']({ action: 'status', phase: 'done' }); assert.equal(m.done(), 1, 'the refresh happens once');
  // 5) garbage events are ignored
  const before = text(m.control.element);
  for (const junk of [null, 'x', 7, { phase: 'exploding' }, { phase: 5 }, []]) m.listeners['pi-install:state'](junk);
  assert.equal(text(m.control.element), before);
  // 6) Node missing: the one action is «Abrir nodejs.org»; it goes through the same closed command
  const n = await mount(); await n.settle(); n.control.update(missing('node_missing'));
  assert(text(n.control.element).includes('necesita Node.js')); assert(!n.buttons().some(b => b.textContent === 'Instalar Pi'));
  // Security review of HU-046: this button must NEVER start an install. It has its own closed action, `open_node`; if Node showed up
  // since the page last looked, the host opens nothing and the page sends the human back to the normal «Instalar Pi» two-step.
  n.calls.length = 0; n.host.answer = { action: 'status', phase: 'failed', reason: 'node_missing', say: 'Falta Node.js. Instalalo desde nodejs.org y volvé a Abito.' };
  n.click('Abrir nodejs.org', false); await n.settle(); assert.deepEqual(n.calls, [], 'untrusted click does nothing');
  n.click('Abrir nodejs.org'); await n.settle();
  assert.deepEqual(n.calls, [['pi_install_action', { action: 'open_node' }]], 'the node button asks to OPEN nodejs.org, never to run the install');
  assert(!n.calls.some(([, p]) => p.action === 'run'), 'no install was started from the node-missing button');
  assert(text(n.control.element).includes('Falta Node.js. Instalalo desde nodejs.org y volvé a Abito.'));
  // Node appeared meanwhile: the host answers node_appeared; the page then offers the normal two-step «Instalar Pi», still not installing
  const late = await mount(); await late.settle(); late.control.update(missing('node_missing'));
  late.calls.length = 0; late.host.answer = { action: 'status', phase: 'failed', reason: 'node_appeared', say: 'Node.js ya está instalado. Tocá «Instalar Pi».' };
  late.click('Abrir nodejs.org'); await late.settle();
  assert.deepEqual(late.calls, [['pi_install_action', { action: 'open_node' }]]);
  assert(text(late.control.element).includes('Node.js ya está instalado. Tocá «Instalar Pi».'));
  assert(!late.calls.some(([, p]) => p.action === 'run'), 'node appearing meanwhile does not start an install either');
  // the sentence points at «Instalar Pi», so that button must really be there (security re-review: it was a dead end)
  assert(late.buttons().some(b => b.textContent === 'Instalar Pi'), 'after node_appeared the normal «Instalar Pi» two-step is offered');
  assert(!late.buttons().some(b => b.textContent === 'Abrir nodejs.org'), 'and the nodejs.org button is gone');
  late.calls.length = 0; late.click('Instalar Pi'); await late.settle(); assert.deepEqual(late.calls, [], 'still only shows the plan');
  // Pi was already there: nothing was installed, so the page must not claim it was
  const there = await mount(); await there.settle(); there.control.update(missing('pi_missing'));
  there.listeners['pi-install:state']({ action: 'status', phase: 'done', already: true });
  assert(text(there.control.element).includes('Pi ya estaba instalado'), text(there.control.element));
  assert(!text(there.control.element).includes('quedó instalado'), 'no false «installed»');
  // 7) the settings bridge only lets {action:'run'|'status'} through: exercised through the REAL invoke of settings-app.js
  const entry = fs.readFileSync(path.join(__dirname, '../frontend/settings-app.js'), 'utf8');
  const sent = [];
  const context = { window: { __TAURI__: { core: { invoke: async (...args) => sent.push(args) } } }, document: { getElementById: () => ({}) },
    setInvoke() {}, dictationPage() {}, flowSettingsPage() {}, dictionaryPage() {}, snippetsPage() {}, stylesPage() {}, insightsPage() {}, voicePage() {}, inactivePages: {}, startHub: async () => {}, TextEncoder };
  require('node:vm').runInNewContext(entry.replace(/^import .*;\n/gm, '') + '\nglobalThis.closedInvoke = invoke;', context);
  for (const payload of [{ action: 'run' }, { action: 'status' }, { action: 'open_node' }, { action: 'install_node' }, { action: 'check_node' }]) {
    await context.closedInvoke('pi_install_action', { payload }); assert.deepEqual(sent.pop(), ['pi_install_action', { payload }]);
  }
  for (const payload of [{ action: 'install' }, { action: 'run', package: 'x' }, { action: 'run', url: 'https://x' }, {}, { action: ['run'] }, null]) {
    await assert.rejects(context.closedInvoke('pi_install_action', { payload }), /No disponible/, JSON.stringify(payload));
  }
  await assert.rejects(context.closedInvoke('pi_install_action', { payload: { action: 'run' }, extra: 1 }), /No disponible/, 'no extra top-level argument');
  assert.equal(sent.length, 0, 'nothing refused reached the host');
  // 8) HU-069: one-click official Node install. Own closed actions; nothing runs without a trusted click; the page sends no URL.
  const d = await mount(); await d.settle(); d.control.update(missing('node_missing'));
  assert(text(d.control.element).includes('nodejs.org') && text(d.control.element).includes('SHA-256'), 'the plan says where it comes from and that it is verified');
  d.calls.length = 0;
  d.click('Descargar e instalar Node.js', false); await d.settle(); assert.deepEqual(d.calls, [], 'untrusted click does nothing');
  d.host.answer = { action: 'status', phase: 'node_installer', say: 'Se abrió el instalador oficial de Node.js, ya verificado. Terminá la instalación y volvé a tocar «Ya lo instalé».' };
  d.click('Descargar e instalar Node.js'); await d.settle();
  assert.deepEqual(d.calls, [['pi_install_action', { action: 'install_node' }]]);
  assert(d.buttons().some(b => b.textContent === 'Ya lo instalé') && !d.buttons().some(b => b.textContent === 'Descargar e instalar Node.js'));
  d.calls.length = 0; d.host.answer = { action: 'status', phase: 'node_ready', say: 'Node.js quedó instalado. Tocá «Instalar Pi».' };
  d.click('Ya lo instalé'); await d.settle();
  assert.deepEqual(d.calls, [['pi_install_action', { action: 'check_node' }]]);
  assert(d.buttons().some(b => b.textContent === 'Instalar Pi'), 'after Node is found the normal Pi install is offered; nothing was installed for Pi');
  // 9) still missing after «Ya lo instalé»: the fixed sentence, and the human can retry
  const e = await mount(); await e.settle(); e.control.update(missing('node_missing'));
  e.host.answer = { action: 'status', phase: 'node_installer', say: 'x' }; e.click('Descargar e instalar Node.js'); await e.settle();
  e.host.answer = { action: 'status', phase: 'failed', reason: 'node_missing', say: 'Falta Node.js. Instalalo desde nodejs.org y volvé a Abito.' };
  e.click('Ya lo instalé'); await e.settle();
  assert(text(e.control.element).includes('Falta Node.js') && e.buttons().some(b => b.textContent === 'Descargar e instalar Node.js'));
  console.log('pi-install-check: 9 groups passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
