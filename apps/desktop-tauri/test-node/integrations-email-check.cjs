'use strict';
/* #355 F040 — pure checks for frontend/integrations-email.js (the Correo card:
   an activity pulse plus a summary of counts and the latest senders). FAKE data
   only: no network, no accounts, no tokens. Every view carries the loud
   «datos de ejemplo» marker.
   Run: node apps/desktop-tauri/test-node/integrations-email-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const E = require(path.join(frontend, 'integrations-email.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};

const frame = (over) => ({ ...E.fakeFrame(0), ...over });

test('fake frame: closed shape, 24 pulse buckets, marked fake', () => {
  const f = E.fakeFrame(0);
  assert.equal(f.type, 'email-activity');
  assert.equal(f.schema, E.SCHEMA);
  assert.equal(f.fake, true);
  assert.equal(f.pulse.length, E.MAX_BUCKETS);
  assert.ok(f.senders.length > 0 && f.senders.length <= E.MAX_SENDERS);
  assert.ok(E.storeFromFrame(f), 'the fake frame is accepted by its own validator');
});

test('fake frame is deterministic and the tick rotates the pulse', () => {
  assert.deepEqual(E.fakeFrame(3), E.fakeFrame(3));
  assert.notDeepEqual(E.fakeFrame(0).pulse, E.fakeFrame(1).pulse);
  for (const bad of [-1, 1.5, '1', null, undefined, NaN]) assert.equal(E.fakeFrame(bad), null, String(bad));
});

test('storeFromFrame: malformed frames are refused whole', () => {
  const ok = E.fakeFrame(0);
  const cases = [null, {}, [], 'x', 7,
    { ...ok, type: 'other' }, { ...ok, schema: 'foreign/1' }, { ...ok, fake: 1 },
    { ...ok, pulse: ok.pulse.slice(1) }, { ...ok, pulse: [...ok.pulse, 1] },
    { ...ok, pulse: ok.pulse.map(() => -1) }, { ...ok, pulse: ok.pulse.map(() => 1.5) },
    { ...ok, pulse: ok.pulse.map(() => E.MAX_COUNT + 1) },
    { ...ok, counts: { unread: -1, received: 2, sent: 1 } },
    { ...ok, counts: { unread: 1, received: 2 } },
    { ...ok, counts: { unread: 1, received: 2, sent: 1, extra: 1 } },
    { ...ok, senders: Array.from({ length: E.MAX_SENDERS + 1 }, () => ok.senders[0]) },
    { ...ok, senders: [{ name: '', minutesAgo: 1 }] },
    { ...ok, senders: [{ name: 'x'.repeat(E.MAX_NAME + 1), minutesAgo: 1 }] },
    { ...ok, senders: [{ name: 'Ana', minutesAgo: -1 }] },
    { ...ok, senders: [{ name: 'Ana', minutesAgo: 1, url: 'https://x' }] },
    { ...ok, token: 'secret' }];
  for (const bad of cases) assert.equal(E.storeFromFrame(bad), null, JSON.stringify(bad).slice(0, 80));
});

test('store is frozen and rejected input never half-builds', () => {
  const s = E.storeFromFrame(E.fakeFrame(0));
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.pulse) && Object.isFrozen(s.counts) && Object.isFrozen(s.senders));
  assert.equal(E.storeFromFrame(frame({ counts: null })), null);
});

test('view: fake marker is loud, real data never claims to be an example', () => {
  const v = E.view(E.storeFromFrame(E.fakeFrame(0)));
  assert.equal(v.fake, true);
  assert.match(v.banner, /datos de ejemplo/i);
  const real = E.view(E.storeFromFrame({ ...E.fakeFrame(0), fake: false }));
  assert.equal(real.fake, false);
  assert.equal(real.banner, null);
  assert.equal(E.view(null), null);
  assert.equal(E.view({}), null);
});

test('view: pulse levels are bounded 0..4 and follow the counts; peak and total are honest', () => {
  const pulse = Array.from({ length: E.MAX_BUCKETS }, (_, i) => (i === 5 ? 8 : 0));
  const v = E.view(E.storeFromFrame(frame({ pulse })));
  assert.equal(v.pulse.length, E.MAX_BUCKETS);
  assert.equal(v.pulse[5].level, 4);
  assert.equal(v.pulse[0].level, 0);
  assert.equal(v.peak, 8);
  assert.equal(v.total, 8);
  const flat = E.view(E.storeFromFrame(frame({ pulse: pulse.map(() => 0) })));
  assert.ok(flat.pulse.every(b => b.level === 0), 'a silent day shows no activity');
  for (const b of E.view(E.storeFromFrame(E.fakeFrame(2))).pulse) assert.ok(b.level >= 0 && b.level <= 4);
});

test('view: counts and latest senders are Spanish text, bounded', () => {
  const v = E.view(E.storeFromFrame(E.fakeFrame(0)));
  assert.deepEqual(v.counts.map(c => c.id), ['unread', 'received', 'sent']);
  assert.deepEqual(v.counts.map(c => c.label), ['sin leer', 'recibidos', 'enviados']);
  assert.ok(v.senders.length <= E.MAX_SENDERS);
  for (const s of v.senders) { assert.equal(typeof s.name, 'string'); assert.match(s.ago, /^hace /); }
});

test('agoLabel: minutes, hours, days; junk yields null', () => {
  assert.equal(E.agoLabel(0), 'ahora');
  assert.equal(E.agoLabel(5), 'hace 5 min');
  assert.equal(E.agoLabel(120), 'hace 2 h');
  assert.equal(E.agoLabel(60 * 48), 'hace 2 d');
  for (const bad of [-1, 1.5, NaN, '3', null]) assert.equal(E.agoLabel(bad), null, String(bad));
});

test('render: textContent only, no markup sinks, no network, no window.open', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-email.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /window\.open|fetch\(|XMLHttpRequest|WebSocket|localStorage/);
  assert.match(src, /Datos de ejemplo/);
  assert.match(src, /getElementById\('integrations-email'\)/, 'mount contract: inert until the container exists');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/, 'no raw colours in the module');
});

test('render (DOM-guarded): pulse bars, summary, banner; invalid view hides the host', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  E.render(host, E.view(E.storeFromFrame(E.fakeFrame(0))));
  assert.equal(host.hidden, false);
  assert.ok(host.querySelector('.em-fake').textContent.includes('datos de ejemplo'));
  assert.equal(host.querySelectorAll('.em-bar').length, E.MAX_BUCKETS);
  E.render(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

console.log(`integrations-email-check: ${passed} checks ok`);
