'use strict';
// #503 T3 · S26 · 26 Cuentas / Conexiones → Opción A: the engine's state comes FIRST (icon + word, with «Reintentar» on a
// failure), then one card per provider/account with its own state and ONE action (Conectar… / Salir / Cancelar).
// Every login flow, closed command and key row that existed is unchanged.
const assert = require('node:assert/strict');
const { test, all, text, dom, load } = require('./settings-designs-check.cjs');

const base = (over = {}) => ({ connection: 'connected', ownedAccounts: { accounts: [] }, providers: [
  { id: 'pi', name: 'Pi', configured: false, methods: ['api_key'] },
  { id: 'claude', name: 'Claude', configured: true, methods: ['oauth'] }], accounts: [{ accountId: 'acc-claude', provider: 'claude', configured: true, label: 'dev@x' }], auth: {}, connectors: { items: [] }, ...over });
async function mount(state, { page = 'chat', slotFor } = {}) {
  dom();
  const { renderAccounts } = await load('accounts.js');
  const V = require('../frontend/settings-view.js');
  const calls = [], events = {}; let current = structuredClone(state);
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'secret_action') return { present: false };
    if (cmd === 'daemon_action') return { ok: true };
    return structuredClone(current);
  };
  const ui = await renderAccounts({ invoke, V, page, slotFor, listen: async (n, f) => { events[n] = f; return () => { delete events[n]; }; }, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  return { ui, calls, events, set: next => { current = structuredClone(next); } };
}
const words = e => text(e).replace(/\s+/g, ' ').trim();
const byId = (ui, id) => all(ui).find(e => e.attrs.id === id);
const btn = (scope, word) => all(scope).find(e => e.tagName === 'button' && !e.hidden && (e.textContent === word || e.attrs['aria-label'] === word));

test('S26 Conexiones: the engine banner is the FIRST thing, with icon + word from the real connection state', async () => {
  const ok = await mount(base());
  const banner = byId(ok.ui, 'engine-status'); assert(banner); assert.equal(ok.ui.children[0], banner, 'first child of the page');
  assert.equal(banner.attrs.role, 'status'); assert.equal(words(banner), '● Motor corriendo Reiniciar');
  assert(all(banner).some(e => e.className === 'state-ico' && e.attrs['aria-hidden'] === 'true'));
  for (const [connection, word] of [['no_daemon', '○ Sin motor'], ['lost', '✗ Motor caído'], ['refused', '✗ Motor no responde'], ['bad_session', '✗ Sesión no válida']]) {
    const m = await mount(base({ connection })); assert.equal(words(byId(m.ui, 'engine-status')).startsWith(word), true, `${connection}: ${words(byId(m.ui, 'engine-status'))}`);
  }
});

test('S2 missing runtimes show installation advice as visible Motor text, not only aria', async () => {
  for (const [code, name, advice] of [
    ['node_missing', 'Falta Node.js', 'instalalo desde nodejs.org.'],
    ['pi_missing', 'Falta Pi', 'instalalo con npm install -g @earendil-works/pi-coding-agent.'],
  ]) {
    const { ui } = await mount(base({ connection: 'no_daemon', last_error: { code, n: 1 } }));
    const banner = byId(ui, 'engine-status');
    assert(words(banner).includes(name), 'runtime name is text content');
    const hint = all(banner).find(e => e.className === 'hint' && e.textContent === advice);
    assert(hint, `${code}: install advice is a rendered text node`);
    assert(!hint.hidden && hint.attrs['aria-hidden'] !== 'true', 'advice is not hidden from sighted users');
  }
});

test('S26 Conexiones: an engine failure offers «Reintentar» through the SAME closed restart command; a healthy engine does not', async () => {
  const bad = await mount(base({ connection: 'lost' }));
  const retry = btn(byId(bad.ui, 'engine-status'), 'Reintentar'); assert(retry, 'retry sits with the failure');
  bad.calls.length = 0; retry.fire('click', false); await bad.ui.settled(); assert.deepEqual(bad.calls, [], 'synthetic click does nothing');
  retry.fire('click'); await bad.ui.settled();
  assert.deepEqual(bad.calls.find(([c]) => c === 'daemon_action'), ['daemon_action', { action: 'restart' }], 'the existing closed command, nothing new');
  const good = await mount(base());
  assert(!btn(byId(good.ui, 'engine-status'), 'Reintentar'), 'nothing to retry when it runs');
  assert(byId(good.ui, 'daemon-restart') || all(good.ui).some(e => e.tagName === 'button' && e.textContent === 'Reiniciar'), 'the manual restart stays available');
});

test('S26 Conexiones: one card per provider, each with its state (icon + word) and a single action', async () => {
  const { ui } = await mount(base());
  const pi = byId(ui, 'provider-pi'), claude = byId(ui, 'provider-claude');
  assert(pi && claude);
  const state = c => words(all(c).find(e => e.className.split(' ').includes('card-state')));
  assert.equal(state(pi), '✗ sin cuenta'); assert.equal(state(claude), '✓ dev@x');
  assert(btn(pi, 'Conectar…')); assert(!btn(pi, 'Salir')); assert(btn(claude, 'Salir')); assert(!btn(claude, 'Conectar…'));
  // HU-044: the apartado chevron (.card-fold) is chrome that folds the card, not an account action
  const actions = c => all(c).filter(e => e.tagName === 'button' && !e.hidden && !e.className.split(' ').some(k => k === 'hub-icon' || k === 'card-fold'));
  assert.equal(actions(pi).length, 1, 'ONE primary action on the Pi card'); assert.equal(actions(claude).length, 1, 'ONE primary action on the Claude card');
  assert.deepEqual(ui.children.map(e => e.attrs?.id).filter(id => /^(engine-status|provider-)/.test(id || '')), ['engine-status', 'provider-pi', 'provider-claude'], 'state first, then the accounts in the engine order');
});

test('S26 Conexiones: Conectar… and Salir send the same closed login/logout commands as before', async () => {
  const { ui, calls } = await mount(base());
  const claude = byId(ui, 'provider-claude'); calls.length = 0;
  btn(claude, 'Salir').fire('click', false); await ui.settled(); assert.deepEqual(calls.filter(([c, p]) => c === 'agent_action' && p.action === 'account_logout'), []);
  btn(claude, 'Salir').fire('click'); await ui.settled();
  assert.deepEqual(calls.find(([, p]) => p.action === 'account_logout'), ['agent_action', { action: 'account_logout', accountId: 'acc-claude' }]);
  const pi = byId(ui, 'provider-pi'); calls.length = 0; btn(pi, 'Conectar…').fire('click'); await ui.settled();
  assert(calls.some(([c, p]) => c === 'agent_action' && ['account_create', 'auth_start'].includes(p.action)), 'starts the existing login flow');
});

test('S26 Conexiones: the unavailable engine disables the account actions and says why; nothing is invented as connected', async () => {
  const { ui } = await mount(base({ connection: 'no_daemon' }));
  assert(all(byId(ui, 'provider-pi')).filter(e => e.tagName === 'button' && !e.className.split(' ').includes('card-fold')).every(e => e.disabled), 'no engine: nothing to connect to (the HU-044 chevron only folds the card)');
  assert(words(byId(ui, 'engine-status')).includes('El motor del agente no está corriendo'));
});

test('S5 Chat: only Otros endpoints remains, with no second provider config, connectors, key list or filter', async () => {
  const { ui, calls } = await mount(base());
  assert(words(ui).includes('Otros endpoints'));
  for (const needle of ['Configuración de proveedores', 'Conectores', 'Claves', 'Buscar proveedor']) assert(!words(ui).includes(needle), needle);
  assert(!all(ui).some(e => e.attrs.id === 'settings-filter' || e.attrs.id?.startsWith('key-input-')));
  assert(!calls.some(([cmd, p]) => cmd === 'secret_action' || ['connectors_list', 'agents_list', 'hooks_preview'].includes(p.action)));
});

test('S5 Chat: prefix aliases share the matching card slot; unknown providers and non-key owned accounts use one extras container', async () => {
  dom();
  const slots = Object.fromEntries(['anthropic', 'openai', 'google', 'openrouter', ''].map(id => [id, document.createElement('div')]));
  const ids = ['anthropic-api', 'claude-code', 'openai-api', 'codex-cli', 'google-ai', 'gemini-cli', 'openrouter-api', 'pi'];
  const owned = accountId => ({ accountId, provider: 'openai', config: { nombre: accountId, baseUrl: 'https://example.com/v1', api: 'openai-completions', models: [] } });
  const { ui, events } = await mount(base({ providers: ids.map(id => ({ id, name: id, methods: ['api_key'] })), ownedAccounts: { accounts: [owned('key-openai'), owned('custom-endpoint')] } }), { slotFor: name => slots[name] });
  for (const [group, expected] of [['anthropic', ids.slice(0,2)], ['openai', ids.slice(2,4)], ['google', ids.slice(4,6)], ['openrouter', ids.slice(6,7)], ['', ['pi']]]) {
    assert.deepEqual(all(slots[group]).map(e => e.attrs.id).filter(id => id?.startsWith('provider-')), expected.map(id => `provider-${id}`));
  }
  assert(!words(slots['']).includes('key-openai')); assert(words(slots['']).includes('custom-endpoint'));
  assert.equal(all(slots['']).filter(e => e.tagName === 'h2' && words(e).replace(/[▸▾]/g, '').trim() === 'Otros endpoints').length, 1); // HU-044: the apartado chevron is part of the heading
  assert(!all(ui).some(e => e.attrs.id?.startsWith('provider-')), 'no second provider list under the engine line');
  events['agent:state']({ payload: { connection: 'lost' } });
  assert.equal(all(slots.anthropic).filter(e => e.attrs.id === 'provider-claude-code').length, 1, 'repaint replaces rather than duplicates slotted rows');
  ui.dispose();
  for (const target of Object.values(slots)) assert.equal(target.children.length, 0, 'dispose releases external slots');
});
