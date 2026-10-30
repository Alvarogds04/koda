'use strict';
// #347 T1 (S3-S4): the launch greeting is retried on later snapshots until it actually
// plays once, never repeats afterwards, and hover love / shake dizzy keep their calm gate.
// Public controller against a fake clay with an injected fake clock: every refusal and every
// later calm snapshot is deterministic, and no timer can hide a deferred greeting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clock } = require('./character-harness.cjs');

function fakeClay({ refuseGreet = false } = {}) {
  const clay = {
    state: 'idle', reaction: null, emotes: [], states: [], greetCalls: 0,
    setState(next) { clay.state = next; clay.states.push(next); },
    // Same contract as clay-engine greet(): one reaction at a time, refused while the engine
    // is static (reduced motion / paused / hidden). There is no force path.
    greet() {
      clay.greetCalls++;
      if (refuseGreet || clay.reaction || clay.state !== 'idle') return false;
      clay.reaction = 'greeting';
      return true;
    },
    triggerEmote(name) {
      clay.emotes.push(name);
      if (clay.reaction || clay.state !== 'idle') return false;
      clay.reaction = name;
      return true;
    },
    cancelReaction() { clay.reaction = null; },
    finish() { clay.reaction = null; }, // the 2 s timeline ended
  };
  return clay;
}

function setup(options) {
  const api = require('../frontend/character-motion.js');
  const time = clock(), clay = fakeClay(options);
  const c = api.create({ clay, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    blocked: () => false, validCard: card => card && card.valid === true,
    notification: snapshot => snapshot && snapshot.pending,
    choosePose: (chat, host) => chat === 'think' || chat === 'speak' ? chat : host || chat || 'idle' });
  return { c, clay, time };
}

test('S4: a launch greeting refused while not calm plays on a later calm snapshot, never on a timer', () => {
  const { c, clay, time } = setup();
  c.chat('think');                      // an active turn when the first snapshot arrives
  c.snapshot({ notices: [] });
  assert.equal(clay.reaction, null, 'the refusal is never forced to play');
  c.chat(null);                         // calm again, but no snapshot arrives
  time.advance(5000);
  assert.equal(clay.reaction, null, 'the retry happens on snapshots, never on a timer');
  c.snapshot({ notices: [] });          // later calm snapshot: it actually plays now
  assert.equal(clay.reaction, 'greeting');
  c.destroy();
  assert.equal(time.count(), 0, 'no timer left behind');
});

test('S4: once the launch greeting has played it never repeats, however often snapshots and churn return', () => {
  const { c, clay, time } = setup();
  c.chat('think');
  c.snapshot({ notices: [] });          // first attempt refused while not calm
  assert.equal(clay.reaction, null);
  c.chat(null);
  c.snapshot({ notices: [] });          // plays here
  assert.equal(clay.reaction, 'greeting');
  clay.finish();                        // the 2 s timeline ends
  c.snapshot({ notices: [] });
  c.chat('think'); c.chat(null);        // later urgent churn
  c.snapshot({ notices: [] });
  time.advance(5000);
  c.snapshot({ notices: [] });
  assert.equal(clay.reaction, null, 'exactly once per page session');
  c.destroy();
  assert.equal(time.count(), 0);
});

test('S4: hover love and shake dizzy keep their calm gate while the launch greeting is still pending', () => {
  const { c, clay, time } = setup();
  c.chat('think');
  c.snapshot({ notices: [] });          // launch greeting still pending (refused)
  assert.equal(clay.reaction, null);
  c.hover(true); time.advance(3000);    // dwell far past the 1900 ms love threshold
  assert.equal(clay.reaction, null, 'hover love stays gated while not calm');
  c.hover(false);
  c.dragStart(0);
  for (const x of [0, 30, 0, 30, 0, 30]) { time.advance(50); c.dragMove(x); } // three 30 px reversals
  assert.notEqual(clay.state, 'dizzy', 'shake dizzy stays gated while not calm');
  assert.ok(!clay.emotes.includes('love'), 'the love emote is never even requested');
  assert.equal(clay.reaction, null, 'still no forced launch greeting either');
  c.dragEnd(); c.destroy();
  assert.equal(time.count(), 0);
});

test('S4: an engine that refuses (reduced motion, paused, hidden) is retried but never forced to play', () => {
  const { c, clay, time } = setup({ refuseGreet: true });
  c.snapshot({ notices: [] });
  c.snapshot({ notices: [] });
  time.advance(5000);
  c.snapshot({ notices: [] });
  assert.equal(clay.reaction, null, 'refusals stay refusals');
  assert.ok(clay.greetCalls >= 3, 'every later snapshot retries the attempt instead of giving up');
  c.destroy();
  assert.equal(time.count(), 0);
});
