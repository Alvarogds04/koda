'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { engine, clock } = require('./character-harness.cjs');
const fs = require('node:fs');
const path = require('node:path');
const legacy = ['idle', 'listen', 'think', 'speak', 'reject', 'confirm', 'error'];
const added = ['working', 'searching', 'approval', 'question', 'finished', 'ratelimit', 'sleeping', 'dizzy'];
test('R7 adds eight states after the seven stable public names, without thinking alias', () => {
  const { api } = engine(); assert.equal(api.REVISION, 'R7');
  assert.deepEqual(Array.from(api.ORDER), [...legacy, ...added]);
  assert.equal(api.STATES.thinking, undefined);
});
for (const state of [...legacy, ...added]) test(`public setState/step/staticPose renders own clay and distinct ${state}`, () => {
  const { api, svg } = engine(); api.setManual(true); const inst = api.create(svg, { seed: 505 });
  inst.setState(state); const a = inst.step(120), b = inst.step(60);
  assert.equal(b.state, state); assert.notEqual(a.d, b.d); assert.equal(b.eyes.length, 2);
  assert.ok(b.pts.every(p => p.every(Number.isFinite))); inst.staticPose(state);
  const still = inst.sample(); assert.equal(still.state, state);
  inst.setState('not-a-state'); assert.equal(inst.state, state); // existing unknown-name behavior
  const stops = svg.children[0].children[0].children;
  assert.deepEqual(stops.map(e => e.attrs['stop-color']), ['#acdd96', '#8fcb78', '#78b562']);
  assert.equal(svg.children.length, 5, 'same defs/shadow/body/two eye groups, no appendages');
});
test('all R7 static states preserve identity and distinct eye/body poses under honored reduction', () => {
  const { api, svg } = engine(true); const inst = api.create(svg);
  const shapes = new Set();
  for (const state of api.ORDER) { inst.setState(state); const s = inst.sample(); shapes.add(s.d + JSON.stringify(s.eyes)); assert.equal(s.state, state); }
  assert.equal(shapes.size, 15); assert.equal(api.statusKind()[0], 'reduced');
});
test('existing pause, forced motion and hidden-page lifecycle keeps one shared frame loop', () => {
  const h = engine(true); h.api.create(h.svg); h.api.create(h.element()); assert.equal(h.pending(), 0);
  h.api.setForced(true); assert.equal(h.pending(), 1); h.frame(); h.frame(); assert.equal(h.api.frames, 2);
  h.api.setPaused(true); assert.equal(h.pending(), 0); h.frame(); assert.equal(h.api.frames, 2);
  h.api.setPaused(false); assert.equal(h.pending(), 1); h.hide(true); assert.equal(h.pending(), 0);
  h.hide(false); assert.equal(h.pending(), 1); h.api.setForced(false); assert.equal(h.pending(), 0);
});
function setup() {
  const api = require('../frontend/character-motion.js'); const h = engine(), time = clock();
  h.api.setManual(true); const clay = h.api.create(h.svg);
  let blocked = false;
  const c = api.create({ clay, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    blocked: () => blocked, validCard: card => card && card.valid === true,
    notification: snapshot => snapshot && snapshot.pending,
    choosePose: (chat, host) => chat === 'think' || chat === 'speak' ? chat : host || chat || 'idle' });
  return { c, clay, time, block(value) { blocked = value; c.motionChanged(); } };
}
test('public producer controller prioritizes typed live human requests, then legacy chat/host errors', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); c.chat('think'); assert.equal(clay.state, 'think');
  c.host('error'); assert.equal(clay.state, 'think'); c.chat(null); assert.equal(clay.state, 'error');
  c.question({ pending: { kind: 'question', expiresAt: 2000 } }); assert.equal(clay.state, 'question');
  c.snapshot({ card: { valid: true, state: 'pending', expires_at: '1970-01-01T00:00:03Z' }, notices: [] }); assert.equal(clay.state, 'approval');
  time.advance(3000); assert.equal(clay.state, 'error', 'local expiry releases attention without confirm/reject');
  for (const reason of ['Decisión enviada.', 'No se pudo confirmar la decisión.', 'Propuesta vencida.']) {
    c.snapshot({ card: { valid: true, state: 'inert', reason, expires_at: '1970-01-01T00:01:00Z' } }); assert.equal(clay.state, 'error');
  }
  c.host(null); c.chat('speak'); assert.equal(clay.state, 'speak'); c.destroy(); assert.equal(time.count(), 0);
});
test('finished means neutral new settled event only, deduped per session/id; no boot/churn/success', () => {
  const { c, clay, time } = setup(); const notice = (id, sessionId = 'one') => ({ id, sessionId, expiresAt: 60000 });
  c.snapshot({ notices: [notice('old')] }); assert.equal(clay.state, 'idle');
  c.snapshot({ notices: [notice('old'), notice('new')] }); assert.equal(clay.state, 'finished');
  time.advance(1800); assert.equal(clay.state, 'idle');
  c.snapshot({ notices: [notice('new'), notice('old')] }); assert.equal(clay.state, 'idle');
  c.snapshot({ notices: [notice('new', 'two')] }); assert.equal(clay.state, 'finished');
  c.chat('think'); time.advance(100); c.chat(null); assert.equal(clay.state, 'idle', 'suppressed decoration is not replayed');
  c.snapshot({ notices: [notice('late')], card: { valid: true, state: 'pending', expires_at: '1970-01-01T00:01:00Z' } });
  assert.equal(clay.state, 'approval'); c.snapshot({ notices: [notice('late')] }); assert.equal(clay.state, 'idle');
  c.destroy();
});
test('sleep follows 60 s genuine idle, activity/pending/queued draft interrupt; paused/reduced never stale-replays', () => {
  const { c, clay, time, block } = setup(); c.snapshot({ notices: [] }); time.advance(59999); assert.equal(clay.state, 'idle');
  time.advance(1); assert.equal(clay.state, 'sleeping'); c.activity(); assert.equal(clay.state, 'idle');
  c.busy(true); time.advance(70000); assert.equal(clay.state, 'idle'); c.busy(false);
  time.advance(59999); assert.equal(clay.state, 'idle'); time.advance(1); assert.equal(clay.state, 'sleeping');
  c.activity(); block(true); time.advance(70000); assert.equal(clay.state, 'idle'); block(false);
  time.advance(1000); assert.equal(clay.state, 'idle'); c.destroy(); assert.equal(time.count(), 0);
});
test('far-future live card keeps approval through capped deadline and injected scheduler teardown', () => {
  const time = clock(), h = engine(); h.api.setManual(true); const clay = h.api.create(h.svg); const delays = [];
  const c = require('../frontend/character-motion.js').create({ clay, now: time.now,
    setTimer(fn, ms) { delays.push(ms); return time.setTimer(fn, ms); }, clearTimer: time.clearTimer,
    validCard: card => card && card.state === 'pending', notification: () => null, choosePose: () => 'idle' });
  c.snapshot({ card: { state: 'pending', expires_at: '2099-01-01T00:00:00Z' }, notices: [] });
  assert.equal(clay.state, 'approval'); assert.deepEqual(delays, [2147483647]); assert.equal(time.count(), 1);
  time.advance(2147483647); assert.equal(clay.state, 'approval'); assert.deepEqual(delays, [2147483647, 2147483647]);
  c.destroy(); assert.equal(time.count(), 0); time.advance(2147483647); assert.equal(clay.state, 'approval');
});

test('the live island wires host/question snapshots and inactivity to the public controller without native drag changes', () => {
  const island = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(island, /AbitoCharacter\.create/); assert.match(island, /character\.snapshot\(snapshot\)/);
  assert.match(island, /characterListen\('question:state'/); assert.match(island, /character\.question/);
  assert.match(island, /character\.activity/); assert.match(island, /O\.choosePose\(chatPose, hostPose\)/);
});

// ---- T2: emotional reactions (F058), hover love, yawn ----
const emotes = ['love', 'surprised', 'proud', 'wink', 'yawn', 'happy', 'annoyed'];
function twin() { const h = engine(); h.api.setManual(true); return { h, a: h.api.create(h.svg, { seed: 505 }), b: h.api.create(h.element(), { seed: 505 }) }; }
test('public API lists the seven emotes', () => { assert.deepEqual(Array.from(engine().api.EMOTES), emotes); });
for (const name of emotes) test(`emote ${name}: finite overlay changes the pose, then leaves the state untouched`, () => {
  const { a, b } = twin(); assert.equal(a.triggerEmote(name), true);
  assert.equal(a.sample().reaction.name, name);
  assert.equal(a.triggerEmote('happy'), false, 'one reaction at a time, never queued');
  a.step(40); b.step(40);
  const mid = a.sample(), ctl = b.sample();
  assert.notEqual(JSON.stringify([mid.d, mid.eyes]), JSON.stringify([ctl.d, ctl.eyes]), 'visible change mid reaction');
  assert.equal(mid.state, 'idle');
  a.step(150); b.step(150);
  assert.equal(a.sample().reaction, null); assert.equal(a.sample().state, 'idle');
  assert.equal(a.sample().d, b.sample().d, 'back to the exact base pose, no residue');
});
test('unknown emote is refused; an urgent state change cancels a running emote immediately', () => {
  const { a } = twin(); assert.equal(a.triggerEmote('nope'), false); assert.equal(a.sample().reaction, null);
  a.triggerEmote('love'); a.step(10); a.setState('error'); assert.equal(a.sample().reaction, null);
});
test('love and proud add only small Abito-green motes; no heart or extra appendage', () => {
  const { h, a } = twin(); a.triggerEmote('love'); a.step(60);
  const group = h.svg.children.find(c => c.attrs && 'data-abito-motes' in c.attrs);
  assert.ok(group); assert.equal(group.children.length, 4);
  assert.ok(group.children.every(c => c.attrs.r === '2.4' && c.attrs.fill === '#acdd96'));
  assert.ok(group.children.some(c => Number(c.attrs.opacity) > 0));
  a.step(120); assert.ok(group.children.every(c => Number(c.attrs.opacity) === 0));
});
test('honored reduced motion, pause and hidden page refuse or cancel emotes with no stale replay', () => {
  const r = engine(true); const ri = r.api.create(r.svg); assert.equal(ri.triggerEmote('love'), false); assert.equal(ri.sample().reaction, null);
  const { h, a } = twin(); a.triggerEmote('wink'); h.api.setPaused(true); assert.equal(a.sample().reaction, null);
  assert.equal(a.triggerEmote('wink'), false); h.api.setPaused(false); assert.equal(a.sample().reaction, null);
  a.triggerEmote('wink'); h.hide(true); assert.equal(a.sample().reaction, null); assert.equal(a.triggerEmote('wink'), false);
  h.hide(false); assert.equal(a.sample().reaction, null);
});
test('hover love: 1900 ms continuous dwell, 6 s cooldown, leave cancels, never over attention or when pressed/busy', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); clay.step(130); // launch greeting (T4) has finished
  c.hover(true); time.advance(1899); assert.equal(clay.sample().reaction, null);
  time.advance(1); assert.equal(clay.sample().reaction.name, 'love');
  c.hover(false); assert.equal(clay.sample().reaction, null, 'leave cancels');
  c.hover(true); time.advance(5999); assert.equal(clay.sample().reaction, null, 'cooldown from last love');
  time.advance(1); assert.equal(clay.sample().reaction.name, 'love'); c.hover(false);
  time.advance(7000); c.hover(true); time.advance(1000); c.hover(false); time.advance(5000); assert.notEqual((clay.sample().reaction || {}).name, 'love', 'short dwell never fires love'); clay.step(130);
  c.chat('think'); c.hover(true); time.advance(3000); assert.equal(clay.sample().reaction, null, 'active turn is never decorated'); c.hover(false); c.chat(null);
  c.busy(true); c.hover(true); time.advance(3000); assert.equal(clay.sample().reaction, null, 'drag/composer busy'); c.hover(false); c.busy(false);
  c.destroy(); assert.equal(time.count(), 0);
});
test('yawn once at 58 s idle, before the 60 s sleep; activity re-arms; urgent state cancels it', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); clay.step(130);
  time.advance(57999); assert.equal(clay.sample().reaction, null);
  time.advance(1); assert.equal(clay.sample().reaction.name, 'yawn');
  time.advance(2000); assert.equal(clay.state, 'sleeping'); assert.equal(clay.sample().reaction, null);
  c.activity(); time.advance(57999); assert.equal(clay.sample().reaction, null); time.advance(1); assert.equal(clay.sample().reaction.name, 'yawn');
  c.chat('think'); assert.equal(clay.sample().reaction, null); c.destroy();
});
test('island wires pointer hover to the controller', () => {
  const island = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(island, /character\.hover\(/);
});

// ---- T3: shake -> dizzy (F059), frontend detector only ----
function shake(c, time, xs, step = 50) { for (const x of xs) { time.advance(step); c.dragMove(x); } }
const zig = [0, 30, 0, 30, 0, 30]; // legs of 30 px: reversals at 0, 30, 0
test('fast back-and-forth drag makes dizzy for 3300 ms, then returns to idle', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] });
  c.dragStart(0); shake(c, time, zig); assert.equal(clay.state, 'dizzy');
  c.dragEnd(); assert.equal(clay.state, 'dizzy', 'release does not cancel the wobble');
  const fired = 250; // third reversal of zig at 50 ms/step
  time.advance(fired + 3300 - 1 - time.now()); assert.equal(clay.state, 'dizzy'); time.advance(1); assert.equal(clay.state, 'idle');
  c.destroy(); assert.equal(time.count(), 0);
});
test('slow drags, short legs, one-way drags and plain clicks never trigger dizzy', () => {
  for (const [xs, step] of [[zig, 400], [[0, 10, 0, 10, 0, 10, 0], 50], [[0, 30, 60, 90, 120, 150], 50], [[], 50]]) {
    const { c, clay, time } = setup(); c.snapshot({ notices: [] }); c.dragStart(0); shake(c, time, xs, step);
    assert.notEqual(clay.state, 'dizzy'); c.dragEnd(); c.destroy();
  }
});
test('detector fires once per press and re-arms on the next press', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] });
  c.dragStart(0); shake(c, time, zig); assert.equal(clay.state, 'dizzy'); time.advance(3300); assert.equal(clay.state, 'idle');
  shake(c, time, zig); assert.equal(clay.state, 'idle', 'same press cannot fire again'); c.dragEnd();
  c.dragStart(0); shake(c, time, zig); assert.equal(clay.state, 'dizzy'); c.destroy();
});
test('pending request, active turn, busy composer and blocked motion suppress dizzy; urgent facts cancel it', () => {
  for (const arm of [c => c.chat('think'), c => c.question({ pending: { kind: 'question', expiresAt: 999999 } }), c => c.busy(true)]) {
    const { c, clay, time } = setup(); c.snapshot({ notices: [] }); arm(c); const before = clay.state;
    c.dragStart(0); shake(c, time, zig); assert.equal(clay.state, before); assert.notEqual(clay.state, 'dizzy'); c.destroy();
  }
  const b = setup(); b.c.snapshot({ notices: [] }); b.block(true); b.c.dragStart(0); shake(b.c, b.time, zig); assert.equal(b.clay.state, 'idle'); b.c.destroy();
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); c.dragStart(0); shake(c, time, zig); assert.equal(clay.state, 'dizzy');
  c.chat('speak'); assert.equal(clay.state, 'speak'); c.chat(null); assert.equal(clay.state, 'idle', 'no stale dizzy replay'); c.destroy();
});
test('cancelled pointer resets the detector; dragging holds off sleep', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); c.dragStart(0); shake(c, time, [0, 30, 0, 30]); c.dragEnd();
  c.dragStart(0); shake(c, time, [30, 0]); assert.notEqual(clay.state, 'dizzy');
  time.advance(70000); assert.equal(clay.state, 'idle', 'pressed drag counts as activity'); c.dragEnd(); c.destroy();
});
test('island feeds pointer screen x to the detector and leaves native drag IPC arguments unchanged', () => {
  const island = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(island, /character\.dragStart\(e\.screenX\)/); assert.match(island, /character\.dragMove\(e\.screenX\)/); assert.match(island, /character\.dragEnd\(\)/);
  assert.match(island, /send\('drag_move', \{ x: e\.clientX, y: e\.clientY \}\)/);
  assert.match(island, /send\('drag_release', \{ x: pt\.x, y: pt\.y, cancelled \}\)/);
  assert.match(island, /send\('drag_press', \{ x: e\.clientX, y: e\.clientY \}\)/);
});

// ---- T4: launch greeting and hover replay (F063) ----
test('engine greet(): 2 s body-only timeline, not an emote, moves the body and blinks, then leaves no residue', () => {
  const { h, a, b } = twin(); assert.ok(!Array.from(h.api.EMOTES).includes('greeting'));
  assert.equal(a.greet(), true); assert.equal(a.sample().reaction.name, 'greeting'); assert.equal(a.greet(), false);
  assert.equal(a.triggerEmote('love'), false, 'never stacks with an emote');
  let moved = false, lidClosed = false;
  for (let i = 0; i < 120; i++) { a.step(1); b.step(1); const x = a.sample(), y = b.sample();
    if (x.d !== y.d) moved = true; if (x.eyes.some((e, k) => e.upper > y.eyes[k].upper + .5)) lidClosed = true; }
  assert.ok(moved && lidClosed, 'rises/sways and blinks');
  a.step(2); b.step(2); assert.equal(a.sample().reaction, null); assert.equal(a.sample().d, b.sample().d);
  assert.equal(h.svg.children.length, 5, 'no particles/appendages for greeting');
});
test('launch greeting: retried on later snapshots until it plays once; refused while urgent or unavailable, never deferred', () => {
  let s = setup(); s.c.snapshot({ available: false }); assert.equal(s.clay.sample().reaction, null);
  s.c.snapshot({ notices: [] }); assert.equal(s.clay.sample().reaction.name, 'greeting');
  s.clay.step(130); s.c.snapshot({ notices: [] }); assert.equal(s.clay.sample().reaction, null, 'once per page session'); s.c.destroy();
  s = setup(); s.c.chat('think'); s.c.snapshot({ notices: [] }); assert.equal(s.clay.sample().reaction, null);
  s.c.chat(null); s.time.advance(5000); assert.equal(s.clay.sample().reaction, null, 'not deferred'); s.c.destroy();
  s = setup(); s.c.snapshot({ card: { valid: true, state: 'pending', expires_at: '1970-01-01T00:01:00Z' }, notices: [] });
  assert.equal(s.clay.state, 'approval'); assert.equal(s.clay.sample().reaction, null); s.c.destroy();
});
test('hover replay: on entry to a calm idle character after 6 s cooldown; not while busy; love waits, never stacks', () => {
  const { c, clay, time } = setup(); c.snapshot({ notices: [] }); clay.step(130);
  c.hover(true); assert.equal(clay.sample().reaction, null, 'inside cooldown of the launch greeting'); c.hover(false);
  time.advance(6000); c.hover(true); assert.equal(clay.sample().reaction.name, 'greeting');
  time.advance(1900); assert.equal(clay.sample().reaction.name, 'greeting', 'love does not interrupt or stack');
  clay.step(130); time.advance(200); assert.equal(clay.sample().reaction.name, 'love', 'love begins after the greeting if the pointer remains');
  c.hover(false); clay.step(130);
  time.advance(6000); c.busy(true); c.hover(true); assert.equal(clay.sample().reaction, null); c.hover(false); c.busy(false);
  c.chat('speak'); c.hover(true); assert.equal(clay.sample().reaction, null); c.hover(false); c.chat(null);
  c.destroy(); assert.equal(time.count(), 0);
});
test('greeting is cancelled by an urgent state or a drag and never replayed afterwards', () => {
  let s = setup(); s.c.snapshot({ notices: [] }); s.c.chat('think'); assert.equal(s.clay.sample().reaction, null);
  s.c.chat(null); assert.equal(s.clay.sample().reaction, null); s.c.destroy();
  s = setup(); s.c.snapshot({ notices: [] }); s.c.dragStart(0); assert.equal(s.clay.sample().reaction, null); s.c.dragEnd(); s.c.destroy();
});
test('honored reduced motion: no greeting at launch or on hover', () => {
  const h = engine(true), time = clock(), clay = h.api.create(h.svg);
  const c = require('../frontend/character-motion.js').create({ clay, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    validCard: () => false, notification: () => null, choosePose: () => 'idle' });
  c.snapshot({ notices: [] }); time.advance(7000); c.hover(true); assert.equal(clay.sample().reaction, null); c.destroy();
});
test('SN2: a harness permission worded as kind question (the card shows it as approval) makes Abito react as approval', () => {
  const api = require('../frontend/character-motion.js'); const h = engine(), time = clock();
  h.api.setManual(true); const clay = h.api.create(h.svg);
  const c = api.create({ clay, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, validCard: () => false,
    notification: snapshot => snapshot && snapshot.pending, choosePose: () => 'idle',
    isApproval: n => n.text.includes('pide permiso') });
  c.snapshot({ notices: [] });
  c.question({ pending: { kind: 'question', text: 'Codex pide permiso para Bash: ls', expiresAt: 2000 } });
  assert.equal(clay.state, 'approval', 'the same permission the card shows as approval');
  c.question({ pending: { kind: 'question', text: '¿Cuál preferís?', expiresAt: 2000 } });
  assert.equal(clay.state, 'question', 'an ordinary question keeps the question pose');
  c.question({ pending: { kind: 'approval', text: 'x', expiresAt: 2000 } }); assert.equal(clay.state, 'approval', 'Pi kind=approval unchanged');
  time.advance(3000); assert.equal(clay.state, 'idle', 'expiry still releases the attention'); c.destroy();
});
test('S5 rest(true): the empty island puts the calm character to sleep at once; any real producer, reduced motion or rest(false) wakes it', () => {
  const { c, clay, block } = setup(); c.snapshot({ notices: [] });
  assert.equal(clay.state, 'idle'); c.rest(true); assert.equal(clay.state, 'sleeping');
  c.chat('think'); assert.equal(clay.state, 'think'); c.chat(null); assert.equal(clay.state, 'sleeping');
  block(true); assert.equal(clay.state, 'idle', 'reduced/hidden motion: no sleeping pose animation'); block(false); assert.equal(clay.state, 'sleeping');
  c.rest(false); assert.equal(clay.state, 'idle'); c.destroy();
});
