'use strict';
// #503 T3 · S23 · 23 Integraciones → Opción A: one card per service with its state (icon + word), Probar/Quitar when connected,
// Conectar when not (the key is asked in a panel that opens on demand), and a «¿Dónde? ↗» help that names where to get the key.
const assert = require('node:assert/strict');
const { test, all, text, dom, load } = require('./settings-designs-check.cjs');

async function mount({ present = {}, failNext = false } = {}) {
  dom();
  Element_patch();
  const { renderIntegrations } = await load('integrations.js');
  const V = require('../frontend/settings-view.js'), P = require('../frontend/pills.js'), C = require('../frontend/pill-catalog.js');
  const have = { ...present }, calls = [], prefs = { mainPill: 'integration_claude', declaredPills: [], pillColors: {} };
  let failOnce = failNext;
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'secret_action') {
      if (failOnce && p.action === 'present') { failOnce = false; throw new Error('keychain'); }
      if (p.action === 'set') have[p.key] = true; if (p.action === 'clear') have[p.key] = false;
      return { present: p.action === 'present' ? have[p.key] === true : p.action === 'set' };
    }
    if (p.action === 'toggle_declared_pill') prefs.declaredPills = P.toggle(P.normalize(prefs), p.id).declaredPills;
    return structuredClone(prefs);
  };
  const ui = await renderIntegrations({ invoke, V, P, C, listen: async () => () => {}, timers: { setTimeout: () => 1, clearTimeout() {} } });
  await ui.settled();
  return { ui, calls, have, V, failOnce: () => { failOnce = true; } };
}
function Element_patch() {
  const { Element } = require('./settings-accounts-check.cjs');
  Element.prototype.getBoundingClientRect = () => ({ left: 20, bottom: 30 });
  Element.prototype.querySelector = function () { return all(this).find(e => e.className.split(' ').includes('swatch')); };
  Element.prototype.remove = function () { document.body.removeChild(this); };
  document.removeEventListener = () => {};
  global.window = { innerWidth: 1100, addEventListener() {}, removeEventListener() {} };
}
const card = (ui, id) => all(ui).find(e => e.attrs.id === id);
const stateOf = c => text(all(c).find(e => e.className.split(' ').includes('card-state'))).replace(/\s+/g, ' ').trim();
// a control that is `hidden` is not there for the user: only visible buttons count
const btn = (scope, word) => all(scope).find(e => e.tagName === 'button' && !e.hidden && (e.textContent === word || e.attrs['aria-label'] === word));
const panel = c => all(c).find(e => e.className.split(' ').includes('int-connect'));
const FULL = { 'github-token': true, 'n8n-url': true, 'n8n-api-key': true, 'resend-api-key': true, 'resend-from': true };

test('S23 Integraciones: every service is a card with its state as icon + word, computed from ALL its keys', async () => {
  const { ui } = await mount({ present: FULL });
  assert.equal(stateOf(card(ui, 'integration_github')), '✓ conectado');
  assert.equal(stateOf(card(ui, 'integration_n8n')), '✓ conectado', 'url + key present');
  assert.equal(stateOf(card(ui, 'integration_stripe')), '✗ sin clave');
  assert.equal(stateOf(card(ui, 'integration_spotify')), '· no necesita clave');
  const half = await mount({ present: { 'n8n-url': true } }); assert.equal(stateOf(card(half.ui, 'integration_n8n')), '✗ sin clave', 'one of two keys is not connected');
  const bad = await mount({ failNext: true });
  assert.equal(stateOf(card(bad.ui, 'integration_stripe')), '· No disponible todavía', 'an unreadable keychain says so instead of «sin clave»');
  for (const c of all(ui).filter(e => e.className.split(' ').includes('int-card'))) assert(all(c).some(e => e.className === 'state-ico' && e.attrs['aria-hidden'] === 'true'), `${c.attrs.id}: decorative icon, the word carries the state`);
  assert.deepEqual(all(ui).find(e => e.attrs.id === 'integration-list').children.map(e => e.attrs.id),
    ['integration_stripe', 'integration_github', 'integration_vercel', 'integration_n8n', 'integration_resend', 'integration_notion', 'integration_calcom', 'integration_spotify', 'mail_smtp', 'mail_imap'], 'same services, same order');
});

test('S23 Integraciones: connected -> Probar + Quitar; not connected -> Conectar; the key panel is closed until asked', async () => {
  const { ui, calls } = await mount({ present: FULL });
  const gh = card(ui, 'integration_github'), stripe = card(ui, 'integration_stripe');
  assert(btn(gh, 'Probar') && btn(gh, 'Quitar')); assert(!btn(gh, 'Conectar'));
  assert(btn(stripe, 'Conectar')); assert(!btn(stripe, 'Probar') && !btn(stripe, 'Quitar'));
  assert.equal(panel(stripe).hidden, true, 'the key is asked on demand'); assert.equal(panel(gh).hidden, true);
  const connect = btn(stripe, 'Conectar'); assert.equal(connect.attrs['aria-expanded'], 'false');
  connect.fire('click', false); assert.equal(panel(stripe).hidden, true, 'synthetic click opens nothing');
  connect.fire('click'); assert.equal(panel(stripe).hidden, false); assert.equal(connect.attrs['aria-expanded'], 'true');
  assert(all(panel(stripe)).some(e => e.attrs.id === 'integration-key-stripe-api-key'), 'the key field lives in the panel');
  // the existing row contract is intact: label, masked input, Guardar, status dot
  const input = all(stripe).find(e => e.attrs.id === 'integration-key-stripe-api-key'); assert.equal(input.type, 'password');
  const row = all(stripe).find(e => e.children.includes(input)); assert.equal(row.children[0].tagName, 'label'); assert.equal(row.children[2].textContent, 'Guardar');
  calls.length = 0; input.value = 'sk_live_fixture'; row.children[2].fire('click'); await ui.settled();
  assert.deepEqual(calls, [['secret_action', { action: 'set', key: 'stripe-api-key', value: 'sk_live_fixture' }]]);
  assert.equal(input.value, ''); assert.equal(stateOf(stripe), '✓ conectado', 'the card follows the saved key'); assert.equal(panel(stripe).hidden, true, 'the panel closes once connected');
  assert(btn(stripe, 'Probar') && btn(stripe, 'Quitar') && !btn(stripe, 'Conectar'));
});

test('S23 Integraciones: Probar re-reads local state only and says the service was not contacted; Quitar clears every key of that service', async () => {
  const { ui, calls, have } = await mount({ present: FULL });
  const n8n = card(ui, 'integration_n8n'); calls.length = 0;
  btn(n8n, 'Probar').fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  btn(n8n, 'Probar').fire('click'); await ui.settled();
  assert.deepEqual(calls, [['secret_action', { action: 'present', key: 'n8n-url' }], ['secret_action', { action: 'present', key: 'n8n-api-key' }]], 'only closed READ commands');
  assert(text(n8n).includes('Claves guardadas. No se contactó al servicio.'));
  calls.length = 0; btn(n8n, 'Quitar').fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  btn(n8n, 'Quitar').fire('click'); await ui.settled();
  assert.deepEqual(calls, [['secret_action', { action: 'clear', key: 'n8n-url' }], ['secret_action', { action: 'clear', key: 'n8n-api-key' }]]);
  assert.equal(have['n8n-url'], false); assert.equal(have['n8n-api-key'], false); assert.equal(stateOf(n8n), '✗ sin clave');
  assert(btn(n8n, 'Conectar') && !btn(n8n, 'Quitar'));
  assert.equal(stateOf(card(ui, 'integration_github')), '✓ conectado', 'another service is untouched');
  // a failing keychain read during the test is reported, never a green tick
  const failing = await mount({ present: FULL }); failing.failOnce(); const gh = card(failing.ui, 'integration_github');
  btn(gh, 'Probar').fire('click'); await failing.ui.settled();
  assert(text(gh).includes('No se pudo comprobar.')); assert(!text(gh).includes('Claves guardadas.'));
});

test('S23 Integraciones: «¿Dónde? ↗» names where to get the key, as text, with no navigation and no new command', async () => {
  const { ui, calls } = await mount();
  for (const [id, site] of [['integration_stripe', 'dashboard.stripe.com/apikeys'], ['integration_github', 'github.com/settings/tokens'], ['integration_vercel', 'vercel.com/account/tokens'],
    ['integration_resend', 'resend.com/api-keys'], ['integration_notion', 'notion.so/profile/integrations'], ['integration_calcom', 'app.cal.com/settings/developer/api-keys']]) {
    const c = card(ui, id), help = btn(c, '¿Dónde? ↗'), where = all(c).find(e => e.className.split(' ').includes('int-where'));
    assert(help, `${id}: help button`); assert.equal(where.hidden, true); assert.equal(help.attrs['aria-expanded'], 'false');
    help.fire('click', false); assert.equal(where.hidden, true);
    calls.length = 0; help.fire('click'); assert.equal(where.hidden, false); assert(text(where).includes(site), `${id}: ${site}`); assert.deepEqual(calls, [], 'it opens no URL and asks the host nothing');
    help.fire('click'); assert.equal(where.hidden, true);
  }
  assert(!btn(card(ui, 'integration_spotify'), '¿Dónde? ↗'), 'nothing to look up for Spotify');
});

test('S23 Integraciones: every pre-existing control survives: pill switch, colour dot, every key id, masking, trusted gates', async () => {
  const { ui, calls } = await mount({ present: FULL });
  for (const id of ['stripe', 'github', 'vercel', 'n8n', 'resend', 'notion', 'calcom', 'spotify']) {
    const c = card(ui, `integration_${id}`);
    assert(all(c).some(e => e.attrs.id === `declare-integration_${id}`), `${id}: pill switch`); assert(all(c).some(e => e.className.includes('color-dot')), `${id}: colour dot`);
  }
  for (const key of ['stripe-api-key', 'github-token', 'vercel-token', 'n8n-url', 'n8n-api-key', 'resend-api-key', 'resend-from', 'notion-api-key', 'calcom-api-key', 'smtp-host', 'smtp-user', 'smtp-password', 'smtp-from', 'imap-host', 'imap-user', 'imap-password']) {
    const input = all(ui).find(e => e.attrs.id === `integration-key-${key}`); assert(input, key); assert.equal(input.type, 'password', `${key} stays masked`);
  }
  calls.length = 0; const sw = all(ui).find(e => e.attrs.id === 'declare-integration_stripe');
  sw.fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  sw.fire('click'); await ui.settled(); assert.deepEqual(calls, [['prefs_action', { action: 'toggle_declared_pill', id: 'integration_stripe' }]]);
  assert(all(ui).some(e => e.attrs.id === 'mail_smtp') && all(ui).some(e => e.attrs.id === 'mail_imap'), 'the mail accounts are cards too');
  assert.equal(stateOf(card(ui, 'mail_smtp')), '✗ sin clave');
});
