'use strict';
// #486: the desktop character's life cycle (Coucou DesktopMochiController) against fake ports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../frontend/character-desktop-logic.js');

function setup({ alert = false, flyOutOk = true } = {}) {
  const log = [], later = [];
  const st = { alert };
  const c = L.create({
    flyOut: async anywhere => { log.push(['flyOut', anywhere]); return flyOutOk; },
    flyHome: async forget => { log.push(['flyHome', forget]); return true; },
    setAway: away => log.push(['away', away]),
    emote: e => log.push(['emote', e]),
    alertActive: () => st.alert,
    revealIsland: () => log.push(['reveal']),
    later: (fn, ms) => later.push({ fn, ms }),
  });
  return { c, log, later, st };
}
const names = log => log.map(e => e[0] + (e[1] === undefined ? '' : ':' + e[1]));

test('constants are Coucou\'s', () => {
  assert.equal(L.RETRACT_DELAY_MS, 450); assert.equal(L.RETURN_DELAY_MS, 600);
  assert.equal(L.DRAG_THRESHOLD, 3); assert.equal(L.SLEEP_TIMEOUT, 120); assert.equal(L.BODY_RADIUS_FRACTION, 0.24);
});

test('off by default: nothing flies out at launch until the human sent it to the desktop', async () => {
  const { c, log } = setup();
  assert.equal(c.enabled, false);
  await c.launchFlyIfNeeded();
  assert.deepEqual(log, []);
  assert.equal(c.phase, 'home');
});

test('a character that lived on the desktop flies back out at launch', async () => {
  const { c, log } = setup();
  c.enabled = true;
  await c.launchFlyIfNeeded();
  assert.deepEqual(names(log), ['away:true', 'flyOut:false']);
  assert.equal(c.phase, 'onDesktop');
});

test('a spot on a display that is gone leaves it home and off', async () => {
  const { c, log } = setup({ flyOutOk: false });
  c.enabled = true;
  await c.launchFlyIfNeeded();
  assert.equal(c.phase, 'home'); assert.equal(c.enabled, false);
  assert.deepEqual(names(log), ['away:true', 'flyOut:false', 'away:false']);
});

test('an alert waiting at launch keeps it in the island until answered', async () => {
  const { c, log, later, st } = setup({ alert: true });
  c.enabled = true;
  await c.launchFlyIfNeeded();
  assert.equal(c.phase, 'atNotchForAlert'); assert.deepEqual(log, []);
  st.alert = false; c.updateAlert(false); // edge only counts after a true
  c.updateAlert(true); c.updateAlert(false);
  assert.equal(c.phase, 'home'); assert.equal(later[0].ms, L.RETURN_DELAY_MS);
});

test('installed after a drag out of the island', () => {
  const { c, log } = setup();
  c.installed();
  assert.equal(c.enabled, true); assert.equal(c.phase, 'onDesktop');
  assert.deepEqual(names(log), ['away:true', 'emote:happy']);
});

test('an alert on the desktop: surprised, flies home (keeps the spot), reveals the island, and flies out again once answered', async () => {
  const { c, log, later, st } = setup();
  c.installed(); log.length = 0;
  st.alert = true; c.updateAlert(true);
  assert.equal(c.phase, 'retracting'); assert.deepEqual(names(log), ['emote:surprised']);
  assert.equal(later[0].ms, L.RETRACT_DELAY_MS);
  await later[0].fn(); await Promise.resolve();
  assert.equal(c.phase, 'atNotchForAlert');
  assert.deepEqual(names(log), ['emote:surprised', 'flyHome:false', 'away:false', 'reveal']);
  st.alert = false; c.updateAlert(false);
  assert.equal(c.phase, 'home');
  assert.equal(later[1].ms, L.RETURN_DELAY_MS);
  await later[1].fn();
  assert.equal(c.phase, 'onDesktop');
});

test('answered before it took off: it never left its spot', async () => {
  const { c, later, st } = setup();
  c.installed();
  st.alert = true; c.updateAlert(true);
  st.alert = false; c.updateAlert(false);
  assert.equal(c.phase, 'alertResolvedDuringRetract');
  await later[0].fn();
  assert.equal(c.phase, 'onDesktop');
});

test('home for good (double click / dropped on the island) forgets the spot', async () => {
  const { c, log } = setup();
  c.installed(); log.length = 0;
  await c.flyHome();
  assert.equal(c.phase, 'home'); assert.equal(c.enabled, false);
  assert.deepEqual(names(log), ['flyHome:true', 'away:false']);
  await c.flyHome(); // already home: nothing
  assert.equal(log.length, 2);
});

test('the shortcut: out from the island (anywhere), home from the desktop, nothing in between', async () => {
  const { c, log } = setup();
  await c.flyOutOrHome();
  assert.deepEqual(names(log), ['away:true', 'flyOut:true']);
  assert.equal(c.phase, 'onDesktop');
  log.length = 0;
  await c.flyOutOrHome();
  assert.deepEqual(names(log), ['flyHome:true', 'away:false']);
  c.phase = 'flyingOut'; log.length = 0;
  await c.flyOutOrHome();
  assert.deepEqual(log, []);
});

test('a finished task makes the desktop character jump, only on the desktop', () => {
  const { c, log } = setup();
  c.updateState('working'); c.updateState('finished');
  assert.deepEqual(log, []);
  c.installed(); log.length = 0;
  c.updateState('working'); c.updateState('finished');
  assert.deepEqual(names(log), ['emote:happy']);
});

test('pure helpers: body hit, sleep, gaze, drag top-left', () => {
  assert.equal(L.isOverBody({ x: 60, y: 60 }), true);
  assert.equal(L.isOverBody({ x: 0, y: 0 }), false);
  assert.equal(L.shouldSleep(121, 150), true); assert.equal(L.shouldSleep(120, 150), false); assert.equal(L.shouldSleep(500, 149), false);
  const g = L.gaze({ x: 0, y: 0 }, { x: 260, y: -200 });
  assert.ok(Math.abs(g.lookX - Math.tanh(1)) < 1e-9 && Math.abs(g.lookY - Math.tanh(1)) < 1e-9);
  assert.equal(L.alertActive({ card: { state: 'pending' } }), true);
  assert.equal(L.alertActive({ card: { state: 'done' }, pending: null }), false);
  assert.equal(L.alertActive({ pending: { id: 'x' } }), true);
  assert.equal(L.alertActive(null), false);
});
