'use strict';
// #336 T1a: exercise the shipped policy/scheduler API, not a duplicate model.
// No DOM/Tauri wiring exists yet. isTrusted:true fixtures simulate handler inputs;
// they are NOT browser-generated gestures or native focus/admission evidence.
const assert = require('node:assert/strict');
const I = require('../frontend/island-interaction.js');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const prefs = (autoCloseSeconds = 15, openOnHover = false) => ({ autoCloseSeconds, openOnHover });
const overview = extra => ({
  state: 'expanded', view: 'overview', settled: true, nativeReady: true,
  question: false, approval: false, request: false, decision: false, card: false,
  dragging: false, editing: false, composing: false, draft: false,
  settings: false, models: false, ...extra,
});
const mouse = extra => ({ isTrusted: true, pointerType: 'mouse', buttons: 0, ...extra });
const click = extra => ({ isTrusted: true, type: 'click', button: 0, ...extra });
const key = extra => ({ isTrusted: true, type: 'keydown', key: 'Enter', repeat: false, ...extra });
// #419: a minimal stand-in for the decoration element (no real DOM in Node).
const fakeElement = () => {
  const written = [];
  return { hidden: false, style: { setProperty: (name, value) => written.push([name, value]) }, written };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(effects = {}) {
  let time = 0, raw = 0, nextId = 0;
  const jobs = new Map(), calls = [], counts = [];
  const controller = I.createController({
    now: () => raw,
    schedule(fn, delay) {
      assert.ok(Number.isFinite(delay) && delay > 0 && delay <= 120000, `bounded delay ${delay}`);
      assert.equal(jobs.size, 0, 'exactly one owned timer');
      const id = ++nextId; jobs.set(id, { fn, at: time + delay }); return id;
    },
    cancel: id => jobs.delete(id),
    open() { calls.push('open'); return effects.open ? effects.open() : Promise.resolve(); },
    autoClose() { calls.push('autoClose'); return effects.autoClose ? effects.autoClose() : Promise.resolve(); },
    onCountdown(value) { counts.push(value); if (effects.onCountdown) effects.onCountdown(value, controller); },
  });
  function advance(ms) {
    const target = time + ms;
    let budget = 1000;
    while (true) {
      const entry = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > target) break;
      assert.ok(--budget > 0, 'no runaway scheduler');
      time = raw = entry[1].at; jobs.delete(entry[0]); entry[1].fn();
    }
    time = raw = target;
  }
  return { controller, calls, counts, jobs, advance, raw: n => { raw = n; } };
}
(async () => {
  await test('A04a Coucou: hover opens immediately with no enter timer, then grants 600ms on leave', async () => {
    const f = fixture(); f.controller.setPreferences(prefs(15, true));
    f.controller.update(overview({ state: 'compact' }));
    assert.equal(f.controller.enter(mouse()), true);
    assert.deepEqual(f.calls, ['open'], 'mouseEntered immediately requests home');
    assert.equal(f.jobs.size, 0, 'no enter dwell timer');
    assert.equal(f.controller.snapshot().hoverOnly, true);
    await flush(); f.controller.update(overview()); f.controller.leave(mouse());
    f.advance(599); assert.deepEqual(f.calls, ['open']);
    f.advance(1); assert.deepEqual(f.calls, ['open', 'autoClose']);
  });
  await test('A04a pin: trusted toggle suppresses deadlines, unpin starts a full countdown', () => {
    const f = fixture(); f.controller.update(overview()); f.advance(1000);
    assert.equal(f.controller.togglePin(click()), true);
    assert.equal(f.controller.snapshot().pinned, true);
    assert.equal(f.controller.snapshot().countdown, null);
    f.advance(120000); assert.deepEqual(f.calls, []);
    assert.equal(f.controller.togglePin(click({ isTrusted: false })), false);
    assert.equal(f.controller.snapshot().pinned, true);
    assert.equal(f.controller.togglePin(click()), true);
    f.advance(14999); assert.deepEqual(f.calls, []); f.advance(1);
    assert.deepEqual(f.calls, ['autoClose']);
  });
  await test('A04a pin cannot release a protected card; collapse clears only the manual pin', () => {
    const f = fixture(); f.controller.update(overview()); f.controller.togglePin(click());
    for (const field of ['question', 'approval', 'request', 'decision', 'card']) {
      f.controller.update(overview({ [field]: true }));
      assert.equal(f.controller.togglePin(click()), false);
      assert.equal(f.controller.snapshot().pinned, true);
      f.advance(120000); assert.deepEqual(f.calls, []);
    }
    f.controller.update(overview({ state: 'compact', question: true }));
    assert.equal(f.controller.snapshot().pinned, false);
    f.advance(120000); assert.deepEqual(f.calls, []);
  });
  await test('A04a pending approval/question pins a hover-open island through the leave grace', async () => {
    for (const field of ['approval', 'question', 'card', 'request']) {
      const f = fixture(); f.controller.setPreferences(prefs(15, true));
      f.controller.update(overview({state:'compact'})); f.controller.enter(mouse()); await flush();
      f.controller.update(overview()); f.controller.leave(mouse()); f.advance(599);
      f.controller.update(overview({[field]:true})); f.advance(120000);
      assert.deepEqual(f.calls, ['open'], field + ' cannot be auto-closed');
      assert.equal(f.controller.snapshot().countdown, null);
    }
  });
  await test('S4 defaults, inclusive integer bounds and exact preference shape', () => {
    assert.deepEqual(I.DEFAULTS, prefs()); assert.ok(Object.isFrozen(I.DEFAULTS));
    for (const n of [0, 5, 15, 120]) assert.equal(I.validPreferences(prefs(n)), true);
    for (const n of [1, 2, 3, 4, 121, 5.5, NaN, Infinity, '15', null]) assert.equal(I.validPreferences(prefs(n)), false);
    for (const bad of [null, [], {}, { autoCloseSeconds: 15 }, { ...prefs(), extra: 1 }, prefs(15, 1)])
      assert.equal(I.validPreferences(bad), false);
  });
  await test('#438 «Nunca» (0): a pinned/clicked-open island never schedules a close nor publishes a countdown', async () => {
    const f = fixture(); f.controller.setPreferences(prefs(0)); f.controller.update(overview());
    f.advance(600000); assert.deepEqual(f.calls, []); assert.equal(f.jobs.size, 0);
    assert.ok(f.counts.every(v => v === null), 'no countdown values ever published');
    assert.equal(f.controller.snapshot().deadline, null);
    // engagement, snapshot churn and re-eligibility never resurrect a deadline
    f.controller.engage(click()); f.advance(600000); assert.deepEqual(f.calls, []);
    for (const revision of [2, 3, 4]) f.controller.update(overview({ revision }));
    f.advance(600000);
    assert.deepEqual(f.calls, []); assert.equal(f.jobs.size, 0);
    assert.ok(f.counts.every(v => v === null), 'no countdown values ever published');
    assert.equal(I.countdown(15000, 6000, 0), null, '«Nunca» never produces a countdown object');
  });
  await test('#438 «Nunca» (0): the hover-open grace still closes, with no countdown bar', async () => {
    const f = fixture(); f.controller.setPreferences(prefs(0, true));
    f.controller.update(overview({ state: 'compact' }));
    assert.equal(f.controller.enter(mouse()), true); await flush();
    f.controller.update(overview()); f.controller.leave(mouse());
    f.advance(599); assert.deepEqual(f.calls, ['open']);
    assert.ok(f.counts.every(v => v === null), 'the grace publishes no countdown');
    f.advance(1); assert.deepEqual(f.calls, ['open', 'autoClose']);
    // engagement converts the grace into a permanent pin: never closes again
    f.controller.update(overview({ state: 'compact' }));
    assert.equal(f.controller.enter(mouse()), true); await flush(); f.controller.update(overview());
    f.controller.engage(click()); f.controller.leave(mouse()); f.advance(600000);
    assert.deepEqual(f.calls, ['open', 'autoClose', 'open']); assert.equal(f.jobs.size, 0);
    assert.ok(f.counts.every(v => v === null), 'no countdown values ever published');
  });
  await test('S3 eligibility is overview-only and fails closed for every unknown guard', () => {
    assert.equal(I.eligible(overview()), true);
    for (const field of ['question', 'approval', 'request', 'decision', 'card', 'dragging', 'editing', 'composing', 'draft', 'settings', 'models']) {
      for (const value of [true, undefined, null, 0]) assert.equal(I.eligible(overview({ [field]: value })), false, field);
    }
    for (const facts of [null, {}, overview({ state: 'compact' }), overview({ state: 'hidden' }),
      overview({ view: 'chat' }), overview({ view: 'settings' }), overview({ view: 'models' }),
      overview({ settled: false }), overview({ nativeReady: false })]) assert.equal(I.eligible(facts), false);
  });
  await test('S4 15s default and 5/120 second boundaries request close once', async () => {
    for (const seconds of [5, 15, 120]) {
      const f = fixture(); f.controller.setPreferences(prefs(seconds)); f.controller.update(overview());
      f.advance(seconds * 1000 - 1); assert.deepEqual(f.calls, []);
      f.advance(1); assert.deepEqual(f.calls, ['autoClose']); await flush();
      assert.equal(f.jobs.size, 0); f.controller.update(overview()); f.advance(120000);
      assert.deepEqual(f.calls, ['autoClose'], 'snapshot churn cannot retry a spent deadline');
    }
  });
  await test('S5 hover defaults off; synthetic, touch, pressed and unsettled inputs never open', async () => {
    for (const [settings, event, facts] of [
      [prefs(), mouse(), overview({ state: 'compact' })],
      [prefs(15, true), mouse({ isTrusted: false }), overview({ state: 'compact' })],
      [prefs(15, true), mouse({ pointerType: 'touch' }), overview({ state: 'compact' })],
      [prefs(15, true), mouse({ buttons: 1 }), overview({ state: 'compact' })],
      [prefs(15, true), mouse(), overview({ state: 'hidden' })],
      [prefs(15, true), mouse(), overview({ state: 'compact', settled: false })],
      [prefs(15, true), mouse(), overview({ state: 'compact', question: true })],
    ]) {
      const f = fixture(); f.controller.setPreferences(settings); f.controller.update(facts);
      assert.equal(f.controller.enter(event), false); await flush();
      assert.deepEqual(f.calls, []); assert.equal(f.jobs.size, 0);
    }
  });
  await test('S5 hover requests open without guessing native state, then leaves at 600ms', async () => {
    const f = fixture(); f.controller.setPreferences(prefs(15, true));
    f.controller.update(overview({ state: 'compact' }));
    assert.equal(f.controller.enter(mouse()), true); assert.deepEqual(f.calls, ['open']);
    assert.equal(f.controller.snapshot().eligible, false, 'request does not predict native expanded state');
    assert.equal(f.controller.enter(mouse()), false); await flush();
    f.controller.update(overview()); f.controller.leave(mouse());
    assert.equal(f.controller.snapshot().hoverOnly, true);
    f.advance(599); assert.deepEqual(f.calls, ['open']);
    f.advance(1); assert.deepEqual(f.calls, ['open', 'autoClose']);
  });
  await test('S5 entry cancels; re-entry cancels hover countdown and leave starts afresh', async () => {
    const f = fixture(); f.controller.setPreferences(prefs(15, true)); f.controller.update(overview({ state: 'compact' }));
    f.controller.enter(mouse()); await flush(); f.controller.update(overview()); f.controller.leave(mouse());
    f.advance(599); f.controller.enter(mouse()); assert.equal(f.jobs.size, 0);
    f.advance(10000); assert.deepEqual(f.calls, ['open']);
    f.controller.leave(mouse()); f.advance(600); assert.deepEqual(f.calls, ['open', 'autoClose']);
  });
  await test('S5 trusted click/keyboard engagement selects normal delay, not permanent pin', async () => {
    for (const event of [click(), key()]) {
      const f = fixture(); f.controller.setPreferences(prefs(5, true)); f.controller.update(overview({ state: 'compact' }));
      f.controller.enter(mouse()); await flush(); f.controller.update(overview());
      assert.equal(f.controller.engage(event), true, 'first hover engagement is observable to native adapter');
      assert.equal(f.controller.engage(event), false, 'later input does not consume another native click');
      f.controller.leave(mouse()); f.advance(4999); assert.deepEqual(f.calls, ['open']);
      f.advance(1); assert.deepEqual(f.calls, ['open', 'autoClose']);
    }
  });
  await test('S5 invalid/synthetic engagement cannot convert the hover grace', async () => {
    for (const event of [click({ isTrusted: false }), click({ button: 2 }), key({ repeat: true }),
      key({ isComposing: true }), key({ keyCode: 229 }), key({ key: 'Shift' }), { isTrusted: true }]) {
      const f = fixture(); f.controller.setPreferences(prefs(15, true)); f.controller.update(overview({ state: 'compact' }));
      f.controller.enter(mouse()); await flush(); f.controller.update(overview());
      assert.equal(f.controller.engage(event), false); f.controller.leave(mouse());
      f.advance(600); assert.deepEqual(f.calls, ['open', 'autoClose']);
    }
  });
  await test('S4 engagement/activity outside restarts normal countdown; churn does not', () => {
    const f = fixture(); f.controller.update(overview()); f.advance(4000);
    f.controller.update(overview({ revision: 100 })); assert.equal(f.controller.snapshot().deadline, 15000);
    f.controller.engage(key()); assert.equal(f.controller.snapshot().deadline, 19000);
    f.advance(14999); assert.deepEqual(f.calls, []); f.advance(1); assert.deepEqual(f.calls, ['autoClose']);
  });
  await test('S3 every blocker cancels, removal outside starts full delay', () => {
    for (const change of [{ view: 'chat' }, { state: 'hidden' }, { settled: false }, { nativeReady: false },
      ...['question', 'approval', 'request', 'decision', 'card', 'dragging', 'editing', 'composing', 'draft', 'settings', 'models'].map(k => ({ [k]: true }))]) {
      const f = fixture(); f.controller.update(overview()); f.advance(14999); f.controller.update(overview(change));
      assert.equal(f.jobs.size, 0); f.advance(30000); assert.deepEqual(f.calls, []);
      f.controller.update(overview()); f.advance(14999); assert.deepEqual(f.calls, []);
      f.advance(1); assert.deepEqual(f.calls, ['autoClose']);
    }
  });
  await test('S4 settings edits reset normal countdown but preserve hover600', async () => {
    const f = fixture(); f.controller.update(overview()); f.advance(1000); f.controller.setPreferences(prefs(5));
    assert.equal(f.controller.snapshot().deadline, 6000); f.advance(4999); assert.deepEqual(f.calls, []);
    f.advance(1); assert.deepEqual(f.calls, ['autoClose']);
    const h = fixture(); h.controller.setPreferences(prefs(15, true)); h.controller.update(overview({ state: 'compact' }));
    h.controller.enter(mouse()); await flush(); h.controller.update(overview()); h.controller.leave(mouse()); h.advance(300);
    h.controller.setPreferences(prefs(120, true)); assert.equal(h.controller.snapshot().deadline, 600);
    h.advance(300); assert.deepEqual(h.calls, ['open', 'autoClose']);
  });
  await test('S4 invalid config is refused without any observable scheduler/effect/config mutation', () => {
    const f = fixture(); f.controller.update(overview()); f.advance(1000);
    for (const value of [prefs(4), prefs(121), prefs(5.5), prefs('15'), prefs(15, 'true'), { ...prefs(), extra: true }]) {
      const before = f.controller.snapshot(), jobs = [...f.jobs], counts = [...f.counts];
      assert.throws(() => f.controller.setPreferences(value), { name: 'TypeError', message: 'Invalid island interaction preferences.' });
      assert.deepEqual(f.controller.snapshot(), before); assert.deepEqual([...f.jobs], jobs);
      assert.deepEqual(f.counts, counts); assert.deepEqual(f.calls, []);
    }
  });
  await test('S4 countdown final min(10s,0.6delay), clamped output and invalid clocks', () => {
    assert.equal(I.countdown(15000, 0, 15).visible, false);
    assert.deepEqual(I.countdown(15000, 6000, 15), { remainingMs: 9000, seconds: 9, fraction: 1, visible: true });
    assert.equal(I.countdown(120000, 110000, 120).visible, true);
    assert.equal(I.countdown(5000, 2000, 5).visible, true);
    assert.deepEqual(I.countdown(15000, 16000, 15), { remainingMs: 0, seconds: 0, fraction: 0, visible: false });
    assert.equal(I.countdown(Infinity, 1, 15), null); assert.equal(I.countdown(2, NaN, 15), null);
    let raw = 100; const now = I.createClock(() => raw);
    assert.equal(now(), 100); raw = 50; assert.equal(now(), 100);
    for (raw of [NaN, Infinity, -100, '200']) assert.equal(now(), 100);
    raw = 200; assert.equal(now(), 200);
  });
  await test('S4 future clock schedules relative bounded delays, without real VM timers', () => {
    const f = fixture(); f.raw(Date.parse('2999-12-31T23:59:59Z')); f.controller.update(overview());
    assert.equal(f.jobs.size, 1); const job = [...f.jobs.values()][0];
    assert.ok(job.at <= 15000, 'absolute deadline must not become timer delay');
    assert.equal(f.controller.snapshot().deadline, Date.parse('2999-12-31T23:59:59Z') + 15000);
    f.controller.stop(); assert.equal(f.jobs.size, 0);
  });
  await test('S3 a refused autoClose is retried on a BACKOFF (never on snapshot churn), so one transient refusal cannot disable the close forever', async () => {
    for (const effect of [() => Promise.reject(new Error('native pending refusal')), () => { throw new Error('sync refusal'); }]) {
      const f = fixture({ autoClose: effect }); f.controller.update(overview()); f.advance(15000); await flush();
      assert.deepEqual(f.calls, ['autoClose']);
      // stale snapshots in between must not trigger anything: only the clock does
      for (let i = 0; i < 20; i++) f.controller.update(overview());
      assert.deepEqual(f.calls, ['autoClose'], 'churn never retries');
      f.advance(14999); await flush(); assert.deepEqual(f.calls, ['autoClose'], 'not before one full period');
      f.advance(1); await flush(); assert.deepEqual(f.calls, ['autoClose', 'autoClose'], 'one period later it asks again');
      // exponential backoff: 15 s, 30 s, 60 s, ... capped at 120 s; never a tight loop
      f.advance(29999); await flush(); assert.equal(f.calls.length, 2);
      f.advance(1); await flush(); assert.equal(f.calls.length, 3);
      f.advance(600000); await flush();
      assert.ok(f.calls.length <= 3 + 6, `bounded attempts, got ${f.calls.length}`);
    }
  });
  await test('S3 a refusal that recovers: the next attempt closes and the backoff is forgotten for the next expansion', async () => {
    let refuse = true;
    const f = fixture({ autoClose: () => (refuse ? Promise.reject(new Error('busy')) : Promise.resolve()) });
    f.controller.update(overview()); f.advance(15000); await flush(); assert.equal(f.calls.length, 1);
    refuse = false; f.advance(15000); await flush(); assert.equal(f.calls.length, 2, 'accepted this time');
    f.controller.update(overview({ state: 'compact' })); f.controller.update(overview());
    refuse = true; f.advance(15000); await flush(); f.advance(15000); await flush();
    assert.equal(f.calls.length, 4, 'a new expansion starts again at one period, not at the old backoff');
  });
  await test('S3 a user action (click/key) while a retry is pending restarts the normal period', async () => {
    const f = fixture({ autoClose: () => Promise.reject(new Error('busy')) });
    f.controller.update(overview()); f.advance(15000); await flush();
    f.advance(5000); f.controller.engage(click()); f.advance(14999); await flush(); assert.equal(f.calls.length, 1);
    f.advance(1); await flush(); assert.equal(f.calls.length, 2);
  });
  await test('diagnose: the controller says WHY it is not closing (blocker name, hover, armed countdown), for the live preview to show', () => {
    const f = fixture();
    assert.equal(f.controller.snapshot().why, 'sin-hechos', 'before any fact');
    f.controller.update(overview({ view: 'chat' })); assert.equal(f.controller.snapshot().why, 'vista:chat');
    f.controller.update(overview({ editing: true })); assert.equal(f.controller.snapshot().why, 'editing');
    f.controller.update(overview({ question: true })); assert.equal(f.controller.snapshot().why, 'question');
    f.controller.update(overview({ state: 'compact' })); assert.equal(f.controller.snapshot().why, 'estado:compact');
    f.controller.update(overview()); assert.match(f.controller.snapshot().why, /^armado:1[45]s$/);
    f.advance(5000); assert.match(f.controller.snapshot().why, /^armado:(9|10)s$/);
    f.controller.enter(mouse()); assert.equal(f.controller.snapshot().why, 'puntero-dentro');
    f.controller.leave(mouse()); f.controller.togglePin(click()); assert.equal(f.controller.snapshot().why, 'fijada');
    f.controller.togglePin(click());
    f.controller.setPreferences(prefs(0, false)); assert.equal(f.controller.snapshot().why, 'nunca');
    f.controller.stop(); assert.equal(f.controller.snapshot().why, 'detenido');
  });
  await test('diagnose: a spent close says so (the live symptom «never closes» becomes visible)', async () => {
    const f = fixture({ autoClose: () => Promise.reject(new Error('busy')) });
    f.controller.update(overview()); f.advance(15000); await flush();
    assert.match(f.controller.snapshot().why, /^rechazado:reintento \d+s$/);
  });
  await test('S3 close/reset and stop clear timers and ignore late open/close promises', async () => {
    for (const kind of ['open', 'autoClose']) {
      let resolve;
      const f = fixture({ [kind]: () => new Promise(r => { resolve = r; }) });
      if (kind === 'open') {
        f.controller.setPreferences(prefs(15, true)); f.controller.update(overview({ state: 'compact' })); f.controller.enter(mouse());
      } else { f.controller.update(overview()); f.advance(15000); }
      f.controller.stop(); const stopped = f.controller.snapshot(); resolve(); await flush();
      f.controller.update(overview()); f.controller.enter(mouse()); f.controller.leave(mouse()); f.controller.engage(key());
      f.controller.setPreferences(prefs(5, true)); f.controller.reset();
      assert.deepEqual(f.controller.snapshot(), stopped); assert.equal(f.jobs.size, 0); assert.deepEqual(f.calls, [kind]);
    }
    const f = fixture(); f.controller.update(overview()); f.controller.reset(); assert.equal(f.jobs.size, 0);
    f.controller.update(overview({ state: 'compact' })); f.controller.update(overview());
    assert.equal(f.controller.snapshot().hoverOnly, false); assert.equal(f.jobs.size, 1);
  });
  await test('S3 teardown during countdown publication cannot resurrect a timer', () => {
    const f = fixture({ onCountdown(value, controller) { if (value) controller.stop(); } });
    f.controller.update(overview());
    assert.equal(f.controller.snapshot().stopped, true); assert.equal(f.jobs.size, 0);
    f.advance(120000); assert.deepEqual(f.calls, []);
  });
  await test('S3 cancelled timer delivery cannot overwrite the current owned timer', () => {
    const f = fixture(); f.controller.update(overview());
    const stale = [...f.jobs.values()][0].fn;
    f.controller.setPreferences(prefs(5)); const jobs = [...f.jobs];
    stale(); assert.deepEqual([...f.jobs], jobs);
    f.advance(5000); assert.deepEqual(f.calls, ['autoClose']);
  });
  await test('#419 countdown view: element required, hides without a visible published value', () => {
    for (const bad of [null, undefined, 'el', 7, {}, { hidden: true }])
      assert.throws(() => I.createCountdownView(bad), { name: 'TypeError', message: 'Countdown view element required.' });
    const el = fakeElement();
    const view = I.createCountdownView(el);
    assert.ok(Object.isFrozen(view)); assert.equal(typeof view.update, 'function');
    for (const value of [null, undefined, {}, { visible: false, fraction: 1 }, { visible: true, fraction: NaN },
      { visible: true, fraction: Infinity }, { visible: true }, '0.5']) {
      el.hidden = false; view.update(value);
      assert.equal(el.hidden, true, JSON.stringify(value)); assert.deepEqual(el.written, [], JSON.stringify(value));
    }
  });
  await test('#419 countdown view shows the final window and sets the clamped fraction token', () => {
    const el = fakeElement();
    const view = I.createCountdownView(el);
    view.update({ remainingMs: 4000, seconds: 4, fraction: 0.4, visible: true });
    assert.equal(el.hidden, false);
    assert.deepEqual(el.written, [['--island-countdown-fraction', '0.4']]);
    view.update({ remainingMs: 10000, seconds: 10, fraction: 1.5, visible: true });
    assert.deepEqual(el.written.at(-1), ['--island-countdown-fraction', '1']);
    view.update({ remainingMs: 1, seconds: 1, fraction: -0.5, visible: true });
    assert.deepEqual(el.written.at(-1), ['--island-countdown-fraction', '0']);
    view.update(null);
    assert.equal(el.hidden, true);
  });
  await test('#419 published countdown values render through the view without touching the scheduler', () => {
    const el = fakeElement();
    const view = I.createCountdownView(el);
    const f = fixture({ onCountdown: value => view.update(value) });
    f.controller.setPreferences(prefs(5)); f.controller.update(overview());
    f.advance(1500);
    assert.equal(el.hidden, true, 'silent before the final window');
    f.advance(1500); // remaining 2000 <= window min(10000, 5*600)=3000
    assert.equal(el.hidden, false);
    assert.ok(el.written.length > 0 && el.written.every(([n]) => n === '--island-countdown-fraction'));
    f.controller.enter(mouse()); // pointer entry cancels the deadline
    assert.equal(el.hidden, true, 'cancelled deadline hides the bar');
    assert.equal(f.jobs.size, 0);
  });
  process.stdout.write(`island-interaction: ${passed} checks passed\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
