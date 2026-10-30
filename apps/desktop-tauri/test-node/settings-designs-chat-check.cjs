'use strict';
// #503 T3 · S21 · 21 Chat → Opción A: every provider is a card (name, state icon + word) with Clave, show/hide, Guardar,
// Probar and Quitar; validation is inline next to the field; «Contexto de ventana activa» keeps its switch.
const assert = require('node:assert/strict');
const { test, all, text, dom, load } = require('./settings-designs-check.cjs');

async function mount({ present = {}, accounts = [], failPresent = false, oauth = {} } = {}) {
  let failOnce = false;
  dom();
  const { renderChatSettings } = await load('chat.js');
  const V = require('../frontend/settings-view.js');
  const real = a => a.map(x => ({ accountId: x.accountId, provider: x.provider || 'google', hasCredential: true, config: { nombre: 'N', baseUrl: 'https://x', api: 'a', compat: {}, models: ['m'], defaultModel: 'm' } }));
  const calls = [], events = {}, timeouts = new Map(); let timerId = 0;
  const oauthStates = { ...oauth.states };
  const timers = { setTimeout(fn, ms) { assert.equal(ms, 1500); timeouts.set(++timerId, fn); return timerId; }, clearTimeout(id) { timeouts.delete(id); } };
  let ui;
  const state = { connection: 'connected', ownedAccounts: { accounts: real(accounts) }, providers: [], accounts: [], auth: {}, connectors: { items: [] } };
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'secret_action') { if ((failPresent || failOnce) && p.action === 'present') { failOnce = false; throw new Error('keychain'); } return { present: p.action === 'set' ? true : p.action === 'clear' ? false : present[p.key] === true }; }
    if (cmd === 'oauth_action') {
      if (p.action === 'status') return { provider: p.provider, state: oauthStates[p.provider] || 'absent' };
      if (p.action === 'begin') { if (oauth.fail) throw { message: 'No se pudo completar el inicio de sesión. Vuelve a intentarlo.' }; return { state: 'waiting', manual: p.provider === 'claude', browserOpened: oauth.browserOpened !== false, ...(oauth.browserOpened === false ? { authUrl: 'https://claude.ai/oauth/authorize?fixture' } : {}) }; }
      if (p.action === 'poll') { const state = oauth.poll || 'waiting'; if (state === 'done') oauthStates[p.provider] = 'present'; return { state }; }
      if (p.action === 'complete') { assert.equal(field(ui, 'chat-oauth-code-claude').value, '', 'code cleared BEFORE invoke'); oauthStates[p.provider] = 'present'; return { state: 'done' }; }
      if (p.action === 'sign_out') { oauthStates[p.provider] = 'absent'; return { state: 'absent' }; }
      return { state: 'none' };
    }
    if (cmd === 'prefs_action') return { chosenModels: {}, windowContext: false, windowContextAvailable: true };
    if (cmd === 'models_action') return { profiles: [] };
    return structuredClone(state);
  };
  ui = await renderChatSettings({ invoke, V, listen: async (n, f) => { events[n] = f; return () => { delete events[n]; }; }, timers });
  await ui.settled();
  return { ui, calls, state, timeouts, tick: async () => { const fns = [...timeouts.values()]; timeouts.clear(); fns.forEach(f => f()); await ui.settled(); }, failNext: () => { failOnce = true; } };
}
const card = (ui, title) => all(ui).find(e => e.tagName === 'section' && all(e).some(h => h.tagName === 'h2' && text(h).trim().startsWith(title)));
const stateOf = c => text(all(c).find(e => e.className.split(' ').includes('card-state'))).replace(/\s+/g, ' ').trim();
const field = (c, id) => all(c).find(e => e.attrs.id === id);
// a control that is `hidden` is not there for the user: only visible buttons count (a DISABLED one still is)
const btn = (scope, word) => all(scope).find(e => e.tagName === 'button' && !e.hidden && (e.textContent === word || e.attrs['aria-label'] === word));
const rowOf = (c, input) => all(c).find(e => e.className === 'row' && e.children.includes(input));

test('S2 subscription trusted lifecycle, polling, sign-out and dispose', async () => {
  const m = await mount({ oauth: { poll: 'done' } }), {ui,calls} = m;
  const c = card(ui,'OpenAI'); assert(text(c).includes('Suscripción')); assert(text(c).includes('✗ sin sesión'));
  calls.length = 0; btn(c,'Iniciar sesión con suscripción').fire('click',false); await ui.settled(); assert.equal(calls.length,0);
  btn(c,'Iniciar sesión con suscripción').fire('click'); await ui.settled(); assert(text(c).includes('Esperando el navegador…')); assert.equal(m.timeouts.size,1);
  await m.tick(); assert(text(c).includes('✓ sesión iniciada')); assert.equal(m.timeouts.size,0);
  btn(c,'Cerrar sesión').fire('click'); await ui.settled(); assert(text(c).includes('✗ sin sesión'));
  btn(c,'Iniciar sesión con suscripción').fire('click'); await ui.settled(); btn(c,'Cancelar').fire('click'); await ui.settled(); assert.equal(m.timeouts.size,0);
  btn(c,'Iniciar sesión con suscripción').fire('click'); await ui.settled(); assert.equal(m.timeouts.size,1); ui.dispose(); assert.equal(m.timeouts.size,0); await m.tick();
});
test('S2 manual code cleared before IPC, fallback URL plain text, generic error', async () => {
  const {ui,calls,timeouts} = await mount({ oauth: { browserOpened:false } }); const c = card(ui,'Claude');
  btn(c,'Iniciar sesión con suscripción').fire('click'); await ui.settled();
  const code = field(c,'chat-oauth-code-claude'); assert(code); assert.equal(code.maxLength,2048); assert.equal(code.attrs.autocomplete,'off'); assert.equal(code.attrs.spellcheck,'false');
  assert(text(c).includes('https://claude.ai/oauth/authorize?fixture')); assert(!all(c).some(e => e.tagName === 'a'));
  code.value='code-secret#fixture'; btn(c,'Enviar').fire('click'); assert.equal(code.value,''); await ui.settled();
  assert.equal(timeouts.size,0); assert(text(c).includes('✓ sesión iniciada')); assert(!text(ui).includes('code-secret')); assert(all(ui).every(e => !String(e.value || '').includes('code-secret')));
  const sent = calls.findIndex(([cmd,p]) => cmd === 'oauth_action' && p.action === 'complete'); assert(sent >= 0); assert(!JSON.stringify(calls.slice(sent+1)).includes('code-secret'));
  btn(c,'Cerrar sesión').fire('click'); await ui.settled(); btn(c,'Iniciar sesión con suscripción').fire('click'); await ui.settled(); code.value='draft'; ui.dispose(); assert.equal(code.value,''); assert.equal(timeouts.size,0);
  const failed = await mount({ oauth: { fail:true } }); const fc = card(failed.ui,'Claude'); btn(fc,'Iniciar sesión con suscripción').fire('click'); await failed.ui.settled();
  assert(all(fc).some(e => e.attrs.role === 'alert' && text(e).includes('No se pudo completar el inicio de sesión. Vuelve a intentarlo.')));
});

test('S21 Chat: the page is cards in the wireframe order, each provider with its own state badge (icon + word)', async () => {
  const { ui } = await mount({ present: { 'google-api-key': true } });
  assert.deepEqual(all(ui).filter(e => e.tagName === 'h2').map(e => text(e).replace(/\s+/g, ' ').trim()).map(s => s.split(' ').slice(0, 2).join(' ').replace(/ [✓✗·▾▸].*/, '').replace(/ ▾$/, '')),
    ['Claude', 'Google AI', 'OpenAI', 'OpenRouter', 'NaN', 'OpenCode Go', 'Modelos locales', 'Contexto de']);
  assert.equal(stateOf(card(ui, 'Google AI')), '✓ lista'); assert.equal(stateOf(card(ui, 'OpenAI')), '✗ sin clave'); assert.equal(stateOf(card(ui, 'OpenRouter')), '✗ sin clave');
  assert.equal(stateOf(card(ui, 'Claude')), '✗ sin clave');
  for (const t of ['Claude', 'Google AI', 'OpenAI', 'OpenRouter']) assert(all(card(ui, t)).some(e => e.attrs['aria-hidden'] === 'true' && e.className === 'state-ico'), `${t}: the icon is decorative, the word carries the state`);
  assert(card(ui, 'Claude').className.split(' ').includes('abito-card') && card(ui, 'Google AI').className.split(' ').includes('abito-card'));
  // the unreadable keychain says so instead of pretending
  const bad = await mount({ failPresent: true }); assert.equal(stateOf(card(bad.ui, 'OpenAI')), '· No disponible todavía');
});

test('S21 Chat: «Probar» only where a key exists; it checks locally through closed commands and says it did not call the provider', async () => {
  const { ui, calls } = await mount({ present: { 'google-api-key': true }, accounts: [{ accountId: 'key-google' }] });
  const google = card(ui, 'Google AI'), openai = card(ui, 'OpenAI');
  assert(btn(google, 'Probar') && !btn(google, 'Probar').disabled && !btn(google, 'Quitar').hidden);
  // #503 S21 (screen validation): «Probar» is always VISIBLE (the MD shows it on the «sin clave» card too); without a key it is
  // DISABLED and says why, instead of vanishing. «Quitar» has nothing to remove without a key, so it stays hidden.
  const noKey = btn(openai, 'Probar'); assert(noKey && !noKey.hidden, 'visible without a key'); assert.equal(noKey.disabled, true, 'disabled without a key');
  assert.equal(noKey.attrs.title, 'Guarda una clave para poder probarla.'); assert.equal(btn(google, 'Probar').attrs.title, '', 'no tooltip once it can be used'); assert.equal(noKey.attrs['aria-disabled'], 'true');
  assert(!btn(openai, 'Quitar'), 'nothing to remove without a key');
  const reason = all(openai).find(e => e.attrs.id === 'chat-key-test-reason-openai-api-key'); assert(reason, 'the reason is also text, not only a tooltip'); assert.equal(text(reason).trim(), 'Guarda una clave para poder probarla.');
  assert.equal(noKey.attrs['aria-describedby'], reason.attrs.id);
  assert.equal(text(all(google).find(e => e.attrs.id === 'chat-key-test-reason-google-api-key')).trim(), '', 'no reason once a key exists');
  calls.length = 0; btn(google, 'Probar').fire('click', false); await ui.settled(); assert.deepEqual(calls, [], 'synthetic click does nothing');
  btn(google, 'Probar').fire('click'); await ui.settled();
  assert.deepEqual(calls.map(([c, p]) => `${c}:${p.action}`), ['secret_action:present', 'agent_action:view'], 'only closed read commands');
  assert.deepEqual(calls[0][1], { action: 'present', key: 'google-api-key' });
  const verdict = text(google); assert(verdict.includes('Clave guardada y cuenta del chat lista.')); assert(verdict.includes('No se contactó al proveedor.'));
  assert(!calls.some(([, p]) => p.action === 'set' || p.action === 'clear' || /^abito_account/.test(p.action)), 'a test never writes');
  // key stored but no chat account yet
  const noAccount = await mount({ present: { 'openai-api-key': true }, accounts: [] });
  btn(card(noAccount.ui, 'OpenAI'), 'Probar').fire('click'); await noAccount.ui.settled();
  assert(text(card(noAccount.ui, 'OpenAI')).includes('El chat aún no tiene cuenta para este proveedor. Vuelve a guardar la clave.'));
  // the keychain failing while testing is reported, never a green tick
  const failing = await mount({ present: { 'google-api-key': true }, accounts: [{ accountId: 'key-google' }] });
  const probe = btn(card(failing.ui, 'Google AI'), 'Probar'); failing.failNext();
  probe.fire('click'); await failing.ui.settled();
  assert(text(card(failing.ui, 'Google AI')).includes('No se pudo comprobar la clave.'));
  assert(!text(card(failing.ui, 'Google AI')).includes('Clave guardada y cuenta del chat lista.'));
});

test('S21 Chat: show/hide masks the draft only; trusted-only; the field is cleared and re-masked on every save', async () => {
  const { ui, calls } = await mount();
  const c = card(ui, 'OpenAI'), input = field(c, 'chat-key-openai-api-key'), eye = btn(c, 'Mostrar clave');
  assert.equal(input.type, 'password'); assert(eye); assert.equal(eye.attrs['aria-pressed'], 'false');
  eye.fire('click', false); assert.equal(input.type, 'password', 'synthetic click does nothing');
  eye.fire('click'); assert.equal(input.type, 'text'); assert.equal(eye.attrs['aria-pressed'], 'true'); assert.equal(eye.attrs['aria-label'], 'Ocultar clave');
  eye.fire('click'); assert.equal(input.type, 'password'); assert.equal(eye.attrs['aria-pressed'], 'false');
  eye.fire('click'); input.value = 'sk-fixture'; calls.length = 0;
  btn(c, 'Guardar').fire('click'); await ui.settled();
  assert.equal(input.value, ''); assert.equal(input.type, 'password', 'a saved draft is hidden again');
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'secret_action'), [['secret_action', { action: 'set', key: 'openai-api-key', value: 'sk-fixture' }]]);
  assert(!text(ui).includes('sk-fixture'));
});

test('S21 Chat: inline validation sits next to the field, blocks the write, and clears as soon as the user types', async () => {
  const { ui, calls } = await mount();
  const c = card(ui, 'OpenRouter'), input = field(c, 'chat-key-openrouter-api-key');
  const error = () => all(c).find(e => e.className.split(' ').includes('field-error'));
  calls.length = 0; input.value = '   '; btn(c, 'Guardar').fire('click'); await ui.settled();
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'secret_action'), [], 'nothing is written');
  assert.equal(error().textContent, 'Pega la clave antes de guardar.'); assert.equal(error().attrs.role, 'alert');
  assert.equal(input.attrs['aria-invalid'], 'true'); assert.equal(input.attrs['aria-describedby'], error().attrs.id);
  assert(rowOf(c, input).parent === undefined || all(c).indexOf(error()) > all(c).indexOf(input), 'the message comes right after the field, inside the same card');
  input.value = 'sk-or-x'; input.fire('input'); assert.equal(error().textContent, ''); assert.equal(input.attrs['aria-invalid'], 'false');
  input.value = 'bad\u0000key'; btn(c, 'Guardar').fire('click'); await ui.settled();
  assert.equal(error().textContent, 'La clave tiene caracteres no válidos.');
  assert.deepEqual(calls.filter(([cmd]) => cmd === 'secret_action' && true).filter(([, p]) => p.action === 'set'), []);
});

test('S21 Chat: every control and closed command that existed survives: keys, model, local models, window context, account sync', async () => {
  const { ui, calls } = await mount({ present: { 'anthropic-api-key': true } });
  for (const id of ['anthropic-api-key', 'google-api-key', 'openai-api-key', 'openrouter-api-key']) assert(field(ui, `chat-key-${id}`), id);
  assert(field(ui, 'chat-anthropic-model')); assert(all(ui).some(e => e.attrs.id === 'chat-url-ollama') && all(ui).some(e => e.attrs.id === 'chat-url-lmstudio') && all(ui).some(e => e.attrs.id === 'chat-url-custom'));
  assert(text(ui).includes('Contexto de la ventana activa')); assert(all(ui).some(e => e.className.split(' ').includes('switch')), 'the window-context switch');
  assert(all(ui).some(e => e.attrs.id === 'chat-local-models'), 'the local models card is addressable (the models list mounts into it)');
  const claude = card(ui, 'Claude'); calls.length = 0;
  field(claude, 'chat-key-anthropic-api-key').value = 'sk-ant-fixture'; btn(claude, 'Guardar clave').fire('click'); await ui.settled();
  assert(calls.some(([c, p]) => c === 'agent_action' && p.action === 'abito_account_create' && p.accountId === 'key-anthropic'), 'the key still becomes a chat account');
  const fs = require('node:fs'), path = require('node:path');
  const entry = fs.readFileSync(path.join(__dirname, '../frontend/settings-app.js'), 'utf8');
  assert.match(entry, /chat\.querySelector\?\.\('#chat-local-models'\)/, 'the models list mounts by id, not by child index');
});

test('S3 Chat: NaN and OpenCode Go are cards with a key, state, model and Probar; saving creates their HTTPS chat account', async () => {
  const { ui, calls } = await mount({ present: { 'nan-api-key': true } });
  assert.equal(stateOf(card(ui, 'NaN')), '✓ lista'); assert.equal(stateOf(card(ui, 'OpenCode Go')), '✗ sin clave');
  for (const [title, id] of [['NaN', 'nan-api-key'], ['OpenCode Go', 'opencode-go-api-key']]) {
    const c = card(ui, title); assert(field(c, `chat-key-${id}`), id); assert(btn(c, 'Probar'), `${title}: Probar`); assert(all(c).some(e => e.tagName === 'select'), `${title}: model`);
  }
  const go = card(ui, 'OpenCode Go'); calls.length = 0;
  field(go, 'chat-key-opencode-go-api-key').value = 'fixture-secret-value'; btn(go, 'Guardar').fire('click'); await ui.settled();
  const created = calls.find(([c, p]) => c === 'agent_action' && p.action === 'abito_account_create' && p.accountId === 'key-opencodego');
  assert(created, 'OpenCode Go account'); assert.equal(created[1].config.baseUrl, 'https://opencode.ai/inference/go/openai/v1'); assert.equal(created[1].config.api, 'openai-completions');
  assert(!JSON.stringify(created[1]).includes('fixture-secret-value'), 'the key travels only in secret_action (single source)');
  assert(!all(ui).some(e => (e.attrs.value || '').includes('fixture-secret-value')), 'no secret left in the DOM');
  const nan = card(ui, 'NaN'); calls.length = 0;
  field(nan, 'chat-key-nan-api-key').value = 'fixture-secret-2'; btn(nan, 'Guardar').fire('click'); await ui.settled();
  assert.equal(calls.find(([c, p]) => c === 'agent_action' && p.action === 'abito_account_create' && p.accountId === 'key-nan')[1].config.baseUrl, 'https://api.nan.builders/v1');
});
