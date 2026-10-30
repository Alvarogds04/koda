'use strict';
/* #352 F034/F035/F036 — pure checks for frontend/integrations-view.js (the
   service-cards framework: closed registry, enable toggle, connection state,
   refresh/pause, open target). No DOM, no network, no accounts: FAKE data only.
   The open-target allowlist must satisfy the SAME rules the host's
   `open_chat_url` validator (`desktop::validated_web_url`) enforces, mirrored
   here on purpose: nothing the view could ever open may be refused by the host.
   Run: node apps/desktop-tauri/test-node/integrations-view-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const T = require(path.join(frontend, 'integrations-view.js'));

let passed = 0;
const async = [];
const test = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') async.push(r.then(() => { passed += 1; }));
    else passed += 1;
  } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};

// ---- registry ---------------------------------------------------------------
test('registry: exactly the 9 closed services, frozen, Spanish labels, in card order', () => {
  assert.deepEqual(T.SERVICES.map(s => s.id),
    ['github', 'deployments', 'email', 'payments', 'notion', 'n8n', 'calendar', 'slack', 'finance']);
  assert.deepEqual(T.SERVICES.map(s => s.name),
    ['GitHub', 'Despliegues', 'Correo', 'Pagos', 'Notion', 'n8n', 'Calendario', 'Slack', 'Finanzas']);
  assert.ok(Object.isFrozen(T.SERVICES));
  for (const s of T.SERVICES) assert.ok(Object.isFrozen(s), s.id);
});

test('registry is closed: unknown ids never resolve, no prototype tricks', () => {
  assert.equal(T.serviceById('github').id, 'github');
  assert.equal(T.serviceById('n8n').name, 'n8n');
  for (const bad of ['', 'GitHub', 'constructor', '__proto__', 'prototype', 'toString', null, undefined, 7]) {
    assert.equal(T.serviceById(bad), null, String(bad));
  }
});

// ---- connection states ------------------------------------------------------
test('connection states: closed 4-state vocabulary with Spanish labels', () => {
  assert.deepEqual(T.STATES, ['disconnected', 'connected', 'error', 'paused']);
  assert.equal(T.stateLabel('disconnected'), 'sin conectar');
  assert.equal(T.stateLabel('connected'), 'conectado');
  assert.equal(T.stateLabel('error'), 'error');
  assert.equal(T.stateLabel('paused'), 'en pausa');
  for (const bad of ['', 'ok', 'CONNECTED', null, undefined, 0]) assert.equal(T.stateLabel(bad), null, String(bad));
});

// ---- store ------------------------------------------------------------------
test('createStore: every service disabled and disconnected; the store is frozen', () => {
  const store = T.createStore();
  for (const s of T.SERVICES) {
    assert.equal(store.services[s.id].enabled, false, s.id);
    assert.equal(store.services[s.id].state, 'disconnected', s.id);
    assert.equal(store.services[s.id].refreshedAt, null, s.id);
  }
  assert.ok(Object.isFrozen(store));
  assert.ok(Object.isFrozen(store.services));
});

test('storeFromFrame: a valid frame builds the store; fake stays a flag, never silent', () => {
  const frame = { type: 'integrations', schema: T.SCHEMA, fake: true,
    services: [{ id: 'github', enabled: true, state: 'connected' }, { id: 'n8n', enabled: false, state: 'error' }] };
  const store = T.storeFromFrame(frame);
  assert.equal(store.services.github.enabled, true);
  assert.equal(store.services.github.state, 'connected');
  assert.equal(store.services.n8n.state, 'error');
  assert.equal(store.fake, true);
  assert.equal(T.storeFromFrame({ ...frame, fake: false }).fake, false);
});

test('storeFromFrame: malformed frames are refused whole, never half-built', () => {
  const ok = { type: 'integrations', schema: T.SCHEMA, fake: true, services: [] };
  for (const bad of [null, {}, [], 'x',
    { ...ok, type: 'other' }, { ...ok, schema: 'foreign/1' },
    { ...ok, fake: 1 }, { ...ok, services: 'x' }, { ...ok, services: null }]) {
    assert.equal(T.storeFromFrame(bad), null, JSON.stringify(bad));
  }
});

test('storeFromFrame: unknown ids and duplicates are dropped, off-enum states refuse, extra keys never pass', () => {
  const base = { type: 'integrations', schema: T.SCHEMA, fake: false };
  assert.equal(T.storeFromFrame({ ...base, services: [{ id: 'nope', enabled: true, state: 'connected' }] }), null,
    'a frame carrying ONLY unknown rows is not a frame we can trust');
  const mixed = T.storeFromFrame({ ...base, services: [
    { id: 'nope', enabled: true, state: 'connected' }, { id: 'github', enabled: true, state: 'connected' }] });
  assert.deepEqual(Object.keys(mixed.services).sort(), T.SERVICES.map(s => s.id).sort(),
    'the store only ever carries registry ids');
  assert.equal(mixed.services.github.state, 'connected');
  assert.equal(mixed.services.nope, undefined, 'unknown ids are dropped, never rendered');
  assert.equal(T.storeFromFrame({ ...base, services: [{ id: 'github', enabled: true, state: 'on' }] }), null, 'off-enum state');
  assert.equal(T.storeFromFrame({ ...base, services: [{ id: 'github', enabled: 'yes', state: 'connected' }] }), null, 'non-bool enabled');
  assert.equal(T.storeFromFrame({ ...base, services: [{ id: 'github', enabled: true, state: 'connected', url: 'https://x' }] }), null,
    'the frame never carries an open target: the allowlist lives only in the module');
  const dup = T.storeFromFrame({ ...base, services: [
    { id: 'github', enabled: true, state: 'connected' }, { id: 'github', enabled: false, state: 'error' }] });
  assert.equal(dup.services.github.state, 'connected', 'duplicate ids: first wins, nothing silently repaired');
});

// ---- enable toggle ----------------------------------------------------------
test('setEnabled: flips one service and touches nothing else; invalid input is refused with data unchanged', () => {
  const store = T.createStore();
  const next = T.setEnabled(store, 'github', true);
  assert.equal(next.services.github.enabled, true);
  assert.equal(next.services.n8n.enabled, false);
  assert.equal(store.services.github.enabled, false, 'the old store is never mutated');
  assert.equal(T.setEnabled(next, 'github', false).services.github.enabled, false);
  for (const bad of [['nope', true], ['github', 'yes'], ['github', 1], ['constructor', true], [null, true]]) {
    assert.equal(T.setEnabled(next, bad[0], bad[1]), null, JSON.stringify(bad));
  }
  assert.equal(next.services.github.enabled, true, 'rejected input leaves the store exactly as it was');
});

// ---- refresh ----------------------------------------------------------------
test('refresh: only an enabled service refreshes; the outcome is a closed state plus a timestamp', () => {
  const store = T.setEnabled(T.createStore(), 'github', true);
  const now = 1700000000000;
  const refreshed = T.refresh(store, 'github', 'connected', now);
  assert.equal(refreshed.services.github.state, 'connected');
  assert.equal(refreshed.services.github.refreshedAt, now);
  // refresh never flips the enable switch
  assert.equal(refreshed.services.github.enabled, true);
  // a disabled service never refreshes
  assert.equal(T.refresh(store, 'n8n', 'connected', now), null, 'disabled service');
  // unknown service, off-enum outcome, bad timestamp: refused
  assert.equal(T.refresh(store, 'nope', 'connected', now), null);
  assert.equal(T.refresh(store, 'github', 'maybe', now), null);
  assert.equal(T.refresh(store, 'github', 'connected', 'now'), null);
  assert.equal(refreshed.services.github.state, 'connected', 'rejected input leaves the store unchanged');
});

test('pause: only a connected service pauses and only a paused one resumes', () => {
  const base = T.setEnabled(T.createStore(), 'github', true);
  const connected = T.refresh(base, 'github', 'connected', 1);
  const paused = T.togglePause(connected, 'github');
  assert.equal(paused.services.github.state, 'paused');
  const resumed = T.togglePause(paused, 'github');
  assert.equal(resumed.services.github.state, 'connected');
  assert.equal(resumed.services.github.refreshedAt, 1, 'resuming keeps the last refresh timestamp');
  // cannot pause what is not connected
  for (const [id, why] of [['n8n', 'disabled'], ['nope', 'unknown']]) {
    assert.equal(T.togglePause(connected, id), null, why);
  }
  assert.equal(T.togglePause(base, 'github'), null, 'disconnected service cannot pause');
  const errored = T.refresh(base, 'github', 'error', 1);
  assert.equal(T.togglePause(errored, 'github'), null, 'an errored service cannot pause');
});

// ---- open target ------------------------------------------------------------
test('open target: the closed URL allowlist maps service -> URL (or null), and NOTHING else opens', () => {
  const allow = T.ALLOWLIST;
  assert.deepEqual(Object.keys(allow).sort(), ['calendar', 'deployments', 'email', 'github', 'n8n', 'notion', 'payments', 'slack'],
    'finance has no target; the allowlist is closed and exactly these 8');
  for (const id of Object.keys(allow)) {
    assert.equal(T.serviceById(id) !== null, true, `${id} is a real service`);
    assert.equal(typeof allow[id], 'string');
  }
  assert.equal(allow.finance, undefined);
  assert.equal(T.openTarget(null, 'github'), null, 'unknown id');
  assert.equal(T.openTarget(undefined, 'github'), null);
});

test('open target: every allowlisted URL satisfies the host open_chat_url validator (desktop::validated_web_url)', () => {
  // Mirror of the Rust rules: non-empty, <= 2000 chars, no whitespace/control,
  // parses as an absolute URL, http/https only, host present, no credentials.
  for (const [id, raw] of Object.entries(T.ALLOWLIST)) {
    assert.ok(raw.length > 0 && raw.length <= 2000, `${id}: length`);
    assert.doesNotMatch(raw, /[\s\u0000-\u001f\u007f-\u009f]/, `${id}: no whitespace or controls`);
    let url;
    try { url = new URL(raw); } catch { assert.fail(`${id}: not an absolute URL`); }
    assert.ok(['http:', 'https:'].includes(url.protocol), `${id}: scheme ${url.protocol}`);
    assert.ok(url.hostname.length > 0, `${id}: host present`);
    assert.equal(url.username, '', `${id}: no username`);
    assert.equal(url.password, '', `${id}: no password`);
  }
});

test('open target: only an enabled, connected service with an allowlisted target opens', () => {
  const store = T.storeFromFrame({ type: 'integrations', schema: T.SCHEMA, fake: true, services: [
    { id: 'github', enabled: true, state: 'connected' },
    { id: 'email', enabled: true, state: 'paused' },
    { id: 'payments', enabled: false, state: 'connected' },
    { id: 'notion', enabled: true, state: 'error' },
    { id: 'finance', enabled: true, state: 'connected' }] });
  assert.equal(T.openTarget(store, 'github'), T.ALLOWLIST.github);
  assert.equal(T.openTarget(store, 'email'), null, 'paused never opens');
  assert.equal(T.openTarget(store, 'payments'), null, 'disabled never opens');
  assert.equal(T.openTarget(store, 'notion'), null, 'errored never opens');
  assert.equal(T.openTarget(store, 'finance'), null, 'connected but no allowlisted target');
  assert.equal(T.openTarget(store, 'nope'), null, 'unknown service never opens');
});

// ---- view projection --------------------------------------------------------
test('view: registry order, Spanish labels, honest counters, fake is loud', () => {
  const store = T.storeFromFrame({ type: 'integrations', schema: T.SCHEMA, fake: true, services: [
    { id: 'github', enabled: true, state: 'connected' },
    { id: 'n8n', enabled: true, state: 'error' }] });
  const v = T.view(store, 1700000000000);
  assert.deepEqual(v.rows.map(r => r.id), T.SERVICES.map(s => s.id), 'registry order, all 9 rows');
  const gh = v.rows.find(r => r.id === 'github');
  assert.equal(gh.name, 'GitHub');
  assert.equal(gh.stateLabel, 'conectado');
  assert.equal(gh.enabled, true);
  assert.equal(gh.canOpen, true);
  assert.equal(v.rows.find(r => r.id === 'n8n').stateLabel, 'error');
  assert.equal(v.rows.find(r => r.id === 'calendar').stateLabel, 'sin conectar');
  assert.equal(v.enabledCount, 2);
  assert.equal(v.connectedCount, 1);
  assert.equal(v.fake, true, 'the banner reads this: datos de ejemplo');
});

test('view: invalid store yields no view, never a half-rendered frame', () => {
  assert.equal(T.view(null, 1), null);
  assert.equal(T.view({}, 1), null);
  assert.equal(T.view('x', 1), null);
  const store = T.storeFromFrame({ type: 'integrations', schema: T.SCHEMA, fake: true, services: [] });
  assert.equal(T.view(store, 'now'), null, 'a bad timestamp cannot render refresh ages');
});

// ---- module hygiene ---------------------------------------------------------
test('the module exposes a frozen API and never embeds markup or secrets', () => {
  assert.ok(Object.isFrozen(T));
  const src = fs.readFileSync(path.join(frontend, 'integrations-view.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML\s*=/, 'textContent only: no innerHTML writes');
  assert.doesNotMatch(src, /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i, 'no embedded credentials');
});

// ---- fake provider ----------------------------------------------------------
test('fake provider: FAKE data only, always marked, refresh outcomes are closed and deterministic', () => {
  const frame = T.fakeFrame();
  assert.equal(frame.type, 'integrations');
  assert.equal(frame.schema, T.SCHEMA);
  assert.equal(frame.fake, true, 'the frame is loud about being fake');
  for (const row of frame.services) {
    assert.ok(T.serviceById(row.id), row.id);
    assert.ok(T.STATES.includes(row.state), row.state);
    assert.equal(typeof row.enabled, 'boolean');
    assert.equal(Object.keys(row).length, 3, 'the frame never smuggles a URL or anything else');
  }
  const store = T.storeFromFrame(frame);
  assert.equal(store.fake, true);
  // the fake outcome cycles inside the closed vocabulary, deterministically
  assert.deepEqual([0, 1, 2, 3, 4].map(t => T.fakeOutcome(t)),
    ['connected', 'connected', 'error', 'connected', 'connected']);
  assert.equal(T.fakeOutcome(-1), null);
  assert.equal(T.fakeOutcome('x'), null);
  assert.equal(T.fakeOutcome(1.5), null);
  // and every outcome the provider hands out is a real closed state, never invented
  const enabled = T.setEnabled(store, 'n8n', true);
  for (let t = 0; t < 6; t += 1) {
    const next = T.refresh(enabled, 'n8n', T.fakeOutcome(t), 1000 + t);
    assert.ok(next && T.STATES.includes(next.services.n8n.state), String(T.fakeOutcome(t)));
  }
});

// ---- the fake marker is LOUD (never mistaken for real data) -------------------
test('fake marker: a fake view carries the visible «datos de ejemplo» banner in its pure projection', () => {
  const fake = T.view(T.storeFromFrame(T.fakeFrame()), 1700000000000);
  assert.equal(fake.fake, true);
  assert.equal(typeof fake.banner, 'string');
  assert.match(fake.banner, /datos de ejemplo/i);
  // and a REAL (non-fake) view never shows it
  const real = T.storeFromFrame({ type: 'integrations', schema: T.SCHEMA, fake: false, services: [] });
  const realView = T.view(real, 1700000000000);
  assert.equal(realView.fake, false);
  assert.equal(realView.banner, null);
});

test('render writes the banner as text, never markup; no window.open anywhere', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-view.js'), 'utf8');
  assert.match(src, /Datos de ejemplo/, 'the banner copy lives in the module, loud');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /window\.open/, 'open target never bypasses the host command');
});

// ---- renderer (DOM-guarded: pure Node skips, browser runs them) ---------------
test('render: builds the 9 cards in registry order, textContent only, buttons with closed actions', () => {
  if (typeof document === 'undefined') return; // pure Node run: the DOM path runs in the browser
  const host = document.createElement('div');
  const view = T.view(T.storeFromFrame(T.fakeFrame()), 1700000000000);
  T.render(host, view);
  assert.equal(host.hidden, false);
  const cards = [...host.querySelectorAll('[data-service-id]')];
  assert.deepEqual(cards.map(c => c.dataset.serviceId), T.SERVICES.map(s => s.id));
  // T7.2 design (R7): NO banner paragraph any more — the fake marker rides ON EVERY CARD as the
  // visible «demo» badge. Was: one .int-fake paragraph above the cards.
  assert.equal(host.querySelector('.int-fake'), null, 'the banner paragraph is gone');
  for (const card of cards) {
    const demo = card.querySelector('.int-demo');
    assert.ok(demo, 'every card carries the demo badge (R7)');
    assert.equal(demo.textContent, 'demo');
    assert.match(demo.getAttribute('title'), /Datos de ejemplo/);
  }
  for (const name of ['GitHub', 'Despliegues', 'Correo', 'Pagos', 'Notion', 'n8n', 'Calendario', 'Slack', 'Finanzas']) {
    assert.ok(cards.some(c => c.querySelector('.int-name').textContent === name), name);
  }
  for (const card of cards) {
    for (const b of card.querySelectorAll('button')) {
      assert.ok(['enable', 'refresh', 'pause', 'open'].includes(b.dataset.action), b.dataset.action);
      assert.equal(b.dataset.id, card.dataset.serviceId);
    }
  }
  const gh = cards.find(c => c.dataset.serviceId === 'github');
  assert.equal(gh.querySelector('.int-state').textContent, 'conectado');
  assert.equal(gh.querySelector('[data-action="open"]').textContent, 'Abrir');
  assert.equal(gh.querySelector('[data-action="pause"]').textContent, 'Pausar');
  const cal = cards.find(c => c.dataset.serviceId === 'calendar');
  assert.equal(cal.querySelector('.int-state').textContent, 'sin conectar');
  assert.equal(cal.querySelector('[data-action="open"]'), null, 'disconnected never offers Abrir');
  assert.equal(cal.querySelector('[data-action="refresh"]').disabled, true, 'disabled service cannot refresh');
});

test('render: an invalid view clears and hides the host; a real view never claims to be an example', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  T.render(host, T.view(T.storeFromFrame(T.fakeFrame()), 1700000000000));
  assert.ok(host.children.length > 0);
  T.render(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  T.render(host, T.view(T.storeFromFrame({ type: 'integrations', schema: T.SCHEMA, fake: false, services: [] }), 1700000000000));
  assert.equal(host.hidden, false);
  // T7.2: the old head (title + count line) is gone; the group heading in index.html names the
  // section. Was: .int-fake absent + .int-count '0 habilitados · 0 conectados'.
  assert.equal(host.querySelector('.int-fake'), null, 'a real view never claims to be an example');
  assert.equal(host.querySelector('.int-demo'), null, 'a real view draws no demo badge');
  assert.equal(host.querySelector('.int-head'), null, 'the count line is gone');
});

test('mount is wired: guarded on the container, trusted clicks only, open routes through open_chat_url', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-view.js'), 'utf8');
  assert.match(src, /getElementById\('integrations'\)/, 'mount contract: the #integrations container');
  assert.match(src, /if \(!host\) return/, 'inert until wired');
  assert.match(src, /e\.isTrusted !== true/, 'synthetic clicks never change anything');
  assert.match(src, /open_chat_url/, 'the open target uses the existing host command');
  assert.match(src, /fakeFrame\(\)/, 'mount seeds the FAKE provider, nothing real');
});

Promise.all(async).then(() => { console.log(`integrations-view-check: ${passed} checks ok`); process.exit(0); },
  (e) => { console.error(e); process.exit(1); });
