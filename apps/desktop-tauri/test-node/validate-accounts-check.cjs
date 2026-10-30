'use strict';
// ajustes-accounts (#503 S26): the validator's read-only engine scene, now on Chat. The generic branch clicked the first `.switch`, and this
// page has none (the gate failed with «no se encontró control seguro en accounts» while the page rendered fine). The scene must instead
// READ the host and compare it with what the page shows, and must NEVER act: no restart, no login, no logout, no key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROVIDERS = [{ id: 'pi', name: 'Pi', configured: false, methods: ['api_key'] }, { id: 'claude', name: 'Claude', configured: true, methods: ['oauth'] }];
const ACCOUNTS = [{ accountId: 'acc-claude', provider: 'claude', configured: true, label: 'dev@x' }];

async function scene({ host = {}, page = {}, buttons } = {}) {
  const calls = [], clicks = [];
  const state = { connection: 'connected', providers: PROVIDERS, accounts: ACCOUNTS, ...host };
  const shown = { engine: '● Motor corriendo', cards: ['provider-pi', 'provider-claude'], ...page };
  const el = (id, text = '', extra = {}) => ({ id, textContent: text, disabled: false, hidden: false, value: '', classList: { contains: () => true }, scrollIntoView() {}, closest: () => null,
    getBoundingClientRect: () => ({ x: 30, y: 0, width: 10, height: 10 }), ...extra });
  const tab = el('tab'); const engine = el('engine-status', shown.engine);
  const cards = shown.cards.map(id => el(id, id.replace('provider-', '')));
  const all = buttons || [el('b1', 'Reiniciar'), el('b2', 'Reintentar'), el('b3', 'Conectar…'), el('b4', 'Salir')];
  const root = { get textContent() { return `Chat El motor de Abito y las cuentas ${shown.engine} Motor local Reiniciar ${shown.cards.join(' ')} y más texto para pasar el mínimo`; },
    scrollIntoView() {}, querySelector: sel => sel === '#engine-status' ? engine : sel === 'button,input,select,textarea' ? all[0] : null,
    querySelectorAll: sel => sel === '[id^="provider-"]' ? cards : sel === 'button' ? all : [...all] };
  let current = null;
  const window = { __validateOrigin: { x: 0, y: 0, scale: 1 }, __TAURI__: { core: { invoke: async (cmd, args) => { calls.push([cmd, args && args.payload && args.payload.action]);
      if (cmd === 'agent_action') return structuredClone(state); if (cmd === 'prefs_action') return {}; if (cmd === 'dictation_action') return { prefs: {} }; if (cmd === 'voice_action') return { prefs: {} }; return {}; } },
    event: { emit: async (_e, payload) => { clicks.push(payload); current = root; } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8'), {
    window, document: { querySelector: sel => (sel === '.hub-page' ? current : sel === '.hub-side .hub-item[data-page="chat"]' ? tab : null), querySelectorAll: () => [tab], getElementById: id => (id === 'engine-status' ? engine : null) },
    addEventListener() {}, console: { error() {} }, performance, setTimeout: fn => { fn(); return 1; }, requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const result = await window.AbitoValidate.hub(0, 'chat');
  return { result, calls, clicks, buttons: all };
}
const ACTING = ['daemon_action', 'account_logout', 'auth_start', 'account_create', 'abito_account_create', 'abito_account_save', 'abito_account_remove', 'secret_action', 'set_prefs'];

(async () => {
  // 1) an honest page passes, and reads real host state
  const ok = await scene();
  assert.equal(ok.result.ok, true, JSON.stringify(ok.result));
  // hub() returns {ok, page, controls, text, effect}: what this scene observed lives in `effect`
  assert.equal(ok.result.page, 'chat'); assert.equal(ok.result.effect.engine, 'connected'); assert.equal(JSON.stringify(ok.result.effect.providers), JSON.stringify(['claude', 'pi'])); // JSON: arrays built inside the vm context have another prototype
  assert(ok.result.effect.observable.includes('ninguna acción pulsada'), 'the evidence says it pressed nothing');
  assert(ok.calls.some(([c, a]) => c === 'agent_action' && a === 'view'), 'it asks the host for the real state');
  // 2) it NEVER acts: only reads go to the host, and the only click is the sidebar tab
  for (const [c, a] of ok.calls) assert(!ACTING.includes(c) && !ACTING.includes(a), `the scene must not act: ${c}/${a}`);
  assert.equal(ok.clicks.length, 1, 'one trusted click (the sidebar entry), none on Reiniciar / Reintentar / Conectar… / Salir');
  // 3) the engine line must AGREE with the host, in every state the host can be in
  for (const [connection, word] of [['no_daemon', '○ Sin motor'], ['lost', '✗ Motor caído'], ['refused', '✗ Motor no responde'], ['bad_session', '✗ Sesión no válida']]) {
    assert.equal((await scene({ host: { connection }, page: { engine: word } })).result.ok, true, `${connection} honestly shown`);
    assert.equal((await scene({ host: { connection }, page: { engine: '● Motor corriendo' } })).result.ok, false, `${connection} shown as running is a lie`);
  }
  assert.equal((await scene({ host: { connection: 'connected' }, page: { engine: '✗ Motor caído' } })).result.ok, false, 'a healthy host shown as down is a lie too');
  // 4) provider rows must be the host's list, regardless of their placement in Chat slots
  assert.equal((await scene({ page: { cards: ['provider-pi'] } })).result.ok, false, 'a missing card');
  assert.equal((await scene({ page: { cards: ['provider-pi', 'provider-claude', 'provider-fake'] } })).result.ok, false, 'an invented card');
  assert.equal((await scene({ page: { cards: ['provider-claude', 'provider-pi'] } })).result.ok, true, 'slots may reorder the list');
  assert.equal((await scene({ host: { providers: [] }, page: { cards: [] } })).result.ok, true, 'an empty account list is a valid state: zero cards');
  // 5) the page fallback text must never be accepted as a pass
  const failing = await scene();
  assert(!/No se pudieron (leer|abrir) los ajustes/.test(JSON.stringify(failing.result)));
  console.log('validate-accounts: 12 scene checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
