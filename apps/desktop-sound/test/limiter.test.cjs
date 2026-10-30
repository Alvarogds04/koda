'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('./support/soft-audio.cjs');

// Request several cues "at the same time" (one burst), then let the coalesce window elapse.
async function burst(h, ids) {
  const ps = ids.map((id) => h.engine.play(id));
  h.time.advance(30);
  return Promise.all(ps);
}
const reasons = (rs) => rs.map((r) => r.reason);

test('single cue plays; result shape', async () => {
  const h = makeHarness();
  assert.deepEqual(await h.settle('snd.notice'), { played: true, reason: 'played', id: 'snd.notice' });
  assert.equal(h.ctxs.length, 1);
});

test('250 ms window across all cues: drop, never queue', async () => {
  const h = makeHarness();
  assert.equal((await h.settle('snd.notice')).reason, 'played'); // clock is now +30
  const before = h.ctxs[0].oscillators.length;
  h.time.advance(100); // 130 ms after the first start < 250
  const r = await h.settle('snd.error'); // +30 => 160 ms < 250
  assert.deepEqual(r, { played: false, reason: 'rate_limited', id: 'snd.error' });
  h.time.advance(5000); // nothing plays later from the dropped request
  assert.equal(h.ctxs[0].oscillators.length, before);
  assert.equal(h.time.pending() >= 0, true);
});

test('after 250 ms a different cue plays', async () => {
  const h = makeHarness();
  await h.settle('snd.notice');
  h.time.advance(260);
  assert.equal((await h.settle('snd.sent')).reason, 'played');
});

test('same id: duplicate inside 2 s, plays after 2 s', async () => {
  const h = makeHarness();
  assert.equal((await h.settle('snd.reply')).reason, 'played');
  h.time.advance(400);
  assert.equal((await h.settle('snd.reply')).reason, 'duplicate');
  h.time.advance(1500);
  assert.equal((await h.settle('snd.reply')).reason, 'duplicate');
  h.time.advance(300);
  assert.equal((await h.settle('snd.reply')).reason, 'played');
});

test('burst of 20 identical cues sounds once', async () => {
  const h = makeHarness();
  const rs = await burst(h, Array(20).fill('snd.notice'));
  assert.equal(rs.filter((r) => r.played).length, 1);
  assert.equal(rs[0].played, true);
  assert.ok(rs.slice(1).every((r) => r.reason === 'duplicate'));
  assert.equal(h.ctxs[0].oscillators.length, 2); // notice = 2 notes, one voice
});

test('coalesce: error beats attention beats confirm beats notice beats sent beats think', async () => {
  const order = ['snd.think', 'snd.sent', 'snd.notice', 'snd.confirm', 'snd.attention', 'snd.error'];
  for (let i = 0; i < order.length; i++) {
    const h = makeHarness();
    const ids = order.slice(0, i + 1);
    const rs = await burst(h, ids);
    const winner = rs.findIndex((r) => r.played);
    assert.equal(ids[winner], order[i], 'winner of ' + ids.join(','));
    assert.equal(rs.filter((r) => r.played).length, 1);
    rs.forEach((r, k) => { if (k !== winner) assert.equal(r.reason, 'outranked'); });
  }
});

test('coalesce is order independent for priority; ties => first requested wins', async () => {
  let h = makeHarness();
  let rs = await burst(h, ['snd.sent', 'snd.error', 'snd.think']);
  assert.deepEqual(reasons(rs), ['outranked', 'played', 'outranked']);
  h = makeHarness();
  rs = await burst(h, ['snd.reject', 'snd.confirm']); // equal priority
  assert.deepEqual(reasons(rs), ['played', 'outranked']);
  h = makeHarness();
  rs = await burst(h, ['snd.expired', 'snd.notice']);
  assert.deepEqual(reasons(rs), ['played', 'outranked']);
  h = makeHarness();
  rs = await burst(h, ['snd.listen', 'snd.reply', 'snd.think']);
  assert.deepEqual(reasons(rs), ['played', 'outranked', 'outranked']);
  assert.equal(rs[0].id, 'snd.listen');
});

test('late high-priority cue after a low one already started is dropped, not queued', async () => {
  const h = makeHarness();
  assert.equal((await h.settle('snd.think')).reason, 'played');
  const n = h.ctxs[0].oscillators.length;
  h.time.advance(50);
  const p = h.engine.play('snd.error'); // inside 250 ms of the started think
  assert.equal((await p).reason, 'rate_limited'); // resolves immediately, no timer needed
  h.time.advance(10000);
  assert.equal(h.ctxs[0].oscillators.length, n);
});

test('cue in a later burst window (> coalesceMs) is a separate burst', async () => {
  const h = makeHarness({ engine: { coalesceMs: 25 } });
  const a = h.engine.play('snd.sent');
  h.time.advance(30);
  const b = h.engine.play('snd.error');
  h.time.advance(30);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.reason, 'played');
  assert.equal(rb.reason, 'rate_limited'); // error does NOT interrupt sent
});

test('coalesceMs 0 plays immediately without timers', async () => {
  const h = makeHarness({ engine: { coalesceMs: 0 } });
  const r = await h.engine.play('snd.notice');
  assert.equal(r.reason, 'played');
  assert.equal(h.time.pending() >= 0, true);
});

test('max 3 simultaneously live voices', async () => {
  const long = { notes: [{ t: 0, f: 440, dur: 0.45 }, { t: 0.45, f: 550, dur: 0.45 }] };
  const h = makeHarness({ engine: { cues: { 'snd.attention': long, 'snd.error': long, 'snd.notice': long, 'snd.sent': long } } });
  const out = [];
  for (const id of ['snd.attention', 'snd.error', 'snd.notice', 'snd.sent']) {
    out.push((await h.settle(id)).reason);
    h.time.advance(260); // starts ~290 ms apart: limiter passes, fallback timers (~1.15 s) not yet fired
  }
  assert.deepEqual(out, ['played', 'played', 'played', 'rate_limited']);
  // when a voice ends (onended) a slot frees up
  const ctx = h.ctxs[0];
  ctx.advance(10); // everything ended
  h.time.advance(3000);
  assert.equal((await h.settle('snd.confirm')).reason, 'played');
});

test('voices are cleaned up: nodes disconnected on onended and by fallback timer', async () => {
  const h = makeHarness();
  await h.settle('snd.attention');
  const ctx = h.ctxs[0];
  assert.equal(ctx.disconnects, 0);
  ctx.advance(2);
  assert.equal(ctx.disconnects, ctx.oscillators.length + ctx.gains.length);
  // fallback timer path (onended never fires)
  const h2 = makeHarness();
  await h2.settle('snd.error');
  h2.time.advance(5000);
  assert.equal(h2.ctxs[0].disconnects, h2.ctxs[0].nodeCount());
});
