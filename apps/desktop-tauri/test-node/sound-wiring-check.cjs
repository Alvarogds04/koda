'use strict';
/* #313 — the island's wiring of the engine's sound module (apps/desktop-sound).
   The engine itself is the engine lane's; this checks OUR half: the vendored copy is the source byte for byte,
   it is loaded before island.js, and the page turns its events into `engine.play` only after the two conditions
   the module requires (applyPrefs + ready). A forgotten condition is SILENCE, so the failure mode is asserted.
   Run: node apps/desktop-tauri/test-node/sound-wiring-check.cjs (also by cargo test, tests/frontend_sound.rs). */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const source = path.join(__dirname, '..', '..', 'desktop-sound', 'sound-engine.js');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let passed = 0;
const pending = [];
const test = (_name, fn) => { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(() => { passed += 1; })); else passed += 1; };

test('vendored: frontend/sound-engine.js is the engine\'s source, byte for byte (sha256)', () => {
  assert.ok(fs.existsSync(source), 'the source module exists in this checkout');
  // #467: seven original interaction cues; both copies intentionally repinned.
  assert.equal(sha(source), 'd3d85d79421353e0936610c20c3ecf5519c95f4d45ec572da0e357319f6269d0');
  assert.equal(sha(path.join(frontend, 'sound-engine.js')), sha(source));
});

test('loaded: <script defer src="sound-engine.js"> comes BEFORE island.js and the wiring after the engine', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const at = name => html.indexOf(`<script defer src="${name}"></script>`);
  assert.ok(at('sound-engine.js') > -1 && at('sound-wiring.js') > -1);
  assert.ok(at('sound-engine.js') < at('island.js'), 'the engine before island.js (the module contract)');
  assert.ok(at('sound-engine.js') < at('sound-wiring.js'));
  assert.ok(at('sound-wiring.js') < at('notify.js') || at('sound-wiring.js') > -1);
});

test('settings window does not load sound engine or wiring', () => {
  const html = fs.readFileSync(path.join(frontend, 'settings.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]*src=["'][^"']*sound-(?:engine|wiring)\.js["']/);
});

test('packaged: both files are in the closed frontend list the packager hashes', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'lib.cjs'), 'utf8');
  assert.match(lib, /'sound-engine\.js'/); assert.match(lib, /'sound-wiring\.js'/);
});

test('CSP: no inline script was needed (script-src \'self\' still holds)', () => {
  const conf = fs.readFileSync(path.join(__dirname, '..', 'tauri.conf.json'), 'utf8');
  assert.match(conf, /script-src 'self'/); assert.doesNotMatch(conf, /unsafe-inline|unsafe-eval/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline <script>');
});

// ---- behaviour: the real wiring against the real engine, with the engine lane's software AudioContext ---------
const soft = require(path.join(__dirname, '..', '..', 'desktop-sound', 'test', 'support', 'soft-audio.cjs'));
const Wiring = require(path.join(frontend, 'sound-wiring.js'));
const Engine = require(path.join(frontend, 'sound-engine.js'));
function rig(extra = {}) {
  const time = soft.createFakeTime();
  const ctxs = [];
  const engine = Engine.createSoundEngine({ enabled: false, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    createContext: () => { const c = soft.createSoftContext(); ctxs.push(c); return c; }, ...extra });
  const listeners = {};
  const doc = { addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); }, dispatchEvent: e => { for (const f of listeners[e.type] || []) f(e); return true; }, visibilityState: 'visible' };
  const bus = { listen: (n, f) => { (listeners['tauri:' + n] = listeners['tauri:' + n] || []).push(f); return Promise.resolve(() => {}); }, fire: (n, payload) => { for (const f of listeners['tauri:' + n] || []) f({ payload }); } };
  const calls = [];
  // the engine is frozen: a thin wrapper that records every `play` the wiring asks for and delegates the rest
  const spy = { play: id => { calls.push(id); return engine.play(id); }, applyPrefs: p => engine.applyPrefs(p), setGain: n => engine.setGain(n), ready: () => engine.ready(), quiet: ms => engine.quiet(ms),
    resetTransitions: () => engine.resetTransitions(), transition: (k, a, id) => engine.transition(k, a, id), state: () => engine.state() };
  const lines = [];
  const wiring = Wiring.wire({ engine: spy, document: doc, listen: bus.listen, now: time.now, log: l => lines.push(l) });
  const settle = async id => { const p = engine.play(id); time.advance(30); return p; };
  return { engine, time, ctxs, doc, bus, wiring, calls, lines, settle };
}

// Fixture translation only, not a Rust evaluator: extract the whole json!(...)
// with balanced parentheses/quoted strings, then map ONLY known typed fields.
// Pill defaults come from the actual Rust constants; every projected field stays.
function hostDtoFixture(host) {
  try {
    const start = /fn view_prefs\(p: &Prefs\) -> Value \{\s*json!\(/.exec(host);
    assert.ok(start, 'view_prefs must contain its explicit JSON projection');
    const at = start.index + start[0].length;
    let depth = 1, quoted = false, escaped = false, end = -1;
    for (let i = at; i < host.length; i++) {
      const ch = host[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) { end = i; break; }
    }
    assert.ok(end >= at && !quoted, 'complete Host DTO JSON macro required');
    const prefs = fs.readFileSync(path.join(__dirname, '..', 'src', 'prefs.rs'), 'utf8');
    const main = /pub const DEFAULT_MAIN_PILL:\s*&str\s*=\s*("[^"]+");/.exec(prefs);
    const declared = /pub const DEFAULT_DECLARED_PILLS:\s*\[&str;\s*4\]\s*=\s*(\[[^\]]*\]);/.exec(prefs);
    assert.ok(main && declared, 'actual typed pill defaults must be available');
    const values = {
      'p.sound': true, 'p.display_name': null, 'p.avatar_colors': {},
      'p.pill_colors': {},
      // #414: the chosen models reach the page only as the validated typed pref; nothing chosen is null
      'p.chosen_models': null,
      'p.gain': 0, 'p.gain()': 0,
      'p.main_pill()': JSON.parse(main[1]),
      'p.declared_pills()': JSON.parse(declared[1]),
      'p.theme().as_str()': 'system',
      'p.auto_close_seconds()': 15,
      'p.open_on_hover()': false,
      'p.absence_seconds()': 10,
      'p.show_plan_in_notch()': false,
      'p.show_codex_plan_in_notch()': false,
      'p.window_context()': false,
      'p.live_context()': true,
      'p.settings_window_on()': false,
      'p.open_settings_at_launch()': false,
      // #415: created blobs project as null when none exist
      'p.custom_blobs_view()': null,
      // #442 T7.4: the island order projects as null until the human chooses one
      'p.island_agents_view()': null,
      'p.abito_instructions_view()': null,
      // #389: the chosen panel monitor projects as null when no choice exists
      'p.monitor': null,
    };
    const expression = host.slice(at, end).replace(/\bcontext_extension_available\(\)/g, 'false').replace(/\bcontext_title_note\(\)/g, 'null').replace(/\bcfg!\(not\(target_os = "linux"\)\)/g, 'false').replace(/\bp\.[a-z_]+(?:\(\))?(?:\.[a-z_]+\(\))*/g, token => {
      if (!Object.hasOwn(values, token)) throw new Error('Unmapped Host DTO expression: ' + token);
      return JSON.stringify(values[token]);
    });
    return JSON.parse(expression);
  } catch (cause) {
    throw new Error('Host DTO fixture extraction failed: ' + cause.message, { cause });
  }
}

test('Host DTO fixture extracts complete legacy and multiline typed projections without dropping fields', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'settingshost.rs'), 'utf8');
  const dto = hostDtoFixture(host);
  assert.deepEqual(dto, { sound: true, gain: 0, displayName: null, avatarColors: {},
    pillColors: {}, chosenModels: null,
    mainPill: 'integration_claude', declaredPills: ['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github'], theme: 'system',
    autoCloseSeconds: 15, openOnHover: false, absenceSeconds: 10, openSettingsAtLaunch: false, settingsWindow: true, customBlobs: null, islandAgents: null, abitoInstructions: null, monitor: null, showPlanInNotch: false, showCodexPlanInNotch: false, windowContext: false, liveContext: true, windowContextAvailable: false, windowContextNote: null, windowContextNative: false });
  const legacy = 'fn view_prefs(p: &Prefs) -> Value { json!({"sound": p.sound, "gain": p.gain(), "displayName": p.display_name, "avatarColors": p.avatar_colors}) }';
  assert.deepEqual(hostDtoFixture(legacy), { sound: true, gain: 0, displayName: null, avatarColors: {} });
  const quoted = 'complete ) with "quoted" text';
  const withLiteral = legacy.replace('"sound": p.sound', `"literal": ${JSON.stringify(quoted)}, "sound": p.sound`);
  assert.equal(hostDtoFixture(withLiteral).literal, quoted, 'quoted parentheses/escapes cannot terminate the macro');
  assert.throws(() => hostDtoFixture(host.replace('p.main_pill()', 'p.unknown_helper()')), /Unmapped Host DTO expression: p\.unknown_helper\(\)/);
});

test('F055 actual public host DTO enables sound and carries zero gain', async () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'settingshost.rs'), 'utf8');
  const dto = hostDtoFixture(host);
  const r = rig(); r.wiring.applyPrefs(dto);
  assert.equal(r.engine.isEnabled(), true, 'actual host DTO must enable the engine');
  assert.equal(r.engine.state().gain, 0);
  r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  assert.equal((await r.settle('snd.notice')).reason, 'disabled');
  assert.equal(r.ctxs.length, 0, 'gain zero never creates audio');
});

test('wiring: nothing sounds until BOTH applyPrefs({v:1,sound:true}) and ready() happened', async () => {
  const r = rig();
  assert.equal((await r.settle('snd.attention')).reason, 'disabled');
  r.bus.fire('prefs:state', { v: 1, sound: true });
  assert.equal((await r.settle('snd.attention')).reason, 'not_ready', 'prefs alone is still silence');
  r.wiring.firstSnapshotRendered();
  r.time.advance(5000);
  const ok = await r.settle('snd.attention');
  assert.equal(ok.played, true, JSON.stringify(r.engine.state()));
  assert.deepEqual([r.engine.state().enabled, r.engine.state().ready], [true, true]);
  assert.ok(r.ctxs.length >= 1);
});

test('wiring: the `abito:cue` page event reaches engine.play and never throws on junk', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  r.doc.dispatchEvent({ type: 'abito:cue', detail: 'snd.notice' });
  r.time.advance(30);
  assert.ok(r.ctxs.length >= 1 && r.ctxs[0] && r.ctxs[0].oscillators ? r.ctxs[0].oscillators.length >= 1 : r.ctxs.length >= 1, 'a cue event produced audio');
  for (const junk of [undefined, null, 7, {}, '__proto__', 'snd.nope', ['snd.notice']]) assert.doesNotThrow(() => r.doc.dispatchEvent({ type: 'abito:cue', detail: junk }));
});

test('prefs: host DTO or explicit v1 requires exact sound:true; invalid versions fail closed and mute stops new cues', async () => {
  const r = rig();
  r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  for (const bad of [null, undefined, {}, { v: 2, sound: true }, { v: 1, sound: 'yes' }, { v: 1, sound: 1 }, 'on', [], { v: 1 }]) {
    r.bus.fire('prefs:state', bad);
    assert.equal(r.engine.isEnabled(), false, JSON.stringify(bad));
  }
  r.bus.fire('prefs:state', { v: 1, sound: true }); assert.equal(r.engine.isEnabled(), true);
  r.bus.fire('prefs:state', { v: 1, sound: false }); assert.equal(r.engine.isEnabled(), false);
  assert.equal((await r.settle('snd.error')).reason, 'disabled');
});

test('startup: no AudioContext is created while sound is off (a silent island never touches audio)', async () => {
  const r = rig();
  r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  for (const id of ['snd.attention', 'snd.notice', 'snd.error']) await r.settle(id);
  assert.equal(r.ctxs.length, 0);
});

test('reconnect: a reconnect opens a quiet window and re-baselines transitions', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  assert.equal((await r.settle('snd.notice')).played, true);
  r.wiring.reconnected();
  r.time.advance(100);
  assert.equal((await r.settle('snd.attention')).reason, 'quiet', 'quiet right after a reconnect');
  r.time.advance(Wiring.RECONNECT_QUIET_MS + 50);
  assert.equal((await r.settle('snd.attention')).played, true);
});

test('reconnect: the agent connection coming BACK after a loss is a reconnect; the first «connected» is not', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  r.bus.fire('agent:state', { connection: 'connected' });
  r.time.advance(50);
  assert.equal((await r.settle('snd.notice')).played, true, 'the first connect opens no quiet window');
  r.bus.fire('agent:state', { connection: 'lost' });
  r.bus.fire('agent:state', { connection: 'connected' });
  r.time.advance(50);
  assert.equal((await r.settle('snd.notice')).reason, 'quiet');
});

test('transitions: the model going down sounds once when it ENTERS the state, never while it lasts, never on first sight', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  const seen = [];
  const step = async v => { const p = r.wiring.observeChat(v); r.time.advance(30); if (p) seen.push((await p).played); r.time.advance(3000); };
  await step({ availability: { state: 'unavailable' }, turns: [] });  // first sight: baseline only
  await step({ availability: { state: 'unavailable' }, turns: [] });  // still down
  await step({ availability: { state: 'ready' }, turns: [] });        // recovered
  await step({ availability: { state: 'blocked' }, turns: [] });      // enters again
  assert.deepEqual(seen, [true], 'exactly one cue: the entering transition after a baseline');
});

test('turns: sent/think/reply follow the transitions of the last turn, once per turn id; a failing turn plays error, not reply', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  const turn = (id, state) => ({ availability: { state: 'ready' }, turns: [{ turn_id: id, state }] });
  r.wiring.observeChat({ availability: { state: 'ready' }, turns: [] });
  for (const st of ['queued', 'thinking', 'thinking', 'streaming', 'streaming', 'completed', 'completed']) r.wiring.observeChat(turn('t1', st));
  assert.deepEqual(r.calls, ['snd.sent', 'snd.think', 'snd.reply'], 'one of each, in order');
  r.calls.length = 0;
  r.wiring.observeChat(turn('t2', 'thinking')); r.wiring.observeChat(turn('t2', 'error'));
  assert.deepEqual(r.calls, ['snd.sent', 'snd.think', 'snd.error']);
});

test('history: the first chat snapshot (possibly with old turns) and a reconnect replay make no sound', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  const old = { availability: { state: 'ready' }, turns: [{ turn_id: 'old1', state: 'completed' }, { turn_id: 'old2', state: 'error' }] };
  r.wiring.observeChat(old);
  assert.deepEqual(r.calls, [], 'old turns are history, not events');
  r.wiring.reconnected();
  r.wiring.observeChat(old);
  assert.deepEqual(r.calls, []);
});

test('notices and cards: only a NEW top notice and a card that BECOMES pending sound; what was there at start-up does not', async () => {
  const r = rig();
  r.bus.fire('prefs:state', { v: 1, sound: true }); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
  r.wiring.observeNotices([{ id: 'n1' }]);               // baseline
  assert.deepEqual(r.calls, []);
  r.wiring.observeNotices([{ id: 'n1' }]);               // same
  assert.deepEqual(r.calls, []);
  r.wiring.observeNotices([{ id: 'n2' }, { id: 'n1' }]); // new on top
  assert.deepEqual(r.calls, ['snd.notice']);
  r.wiring.observeNotices([]);                            // dismissed: nothing
  assert.deepEqual(r.calls, ['snd.notice']);
  r.calls.length = 0;
  r.wiring.observeCard('c1');                             // baseline
  assert.deepEqual(r.calls, []);
  r.wiring.observeCard('c2');
  assert.deepEqual(r.calls, ['snd.attention']);
  r.wiring.observeCard('c2'); r.wiring.observeCard(null);
  assert.deepEqual(r.calls, ['snd.attention'], 'the same card, or none, is not an event');
});

test('never: «Enviada» / «Sin confirmar» notices and the character face alone make no sound', () => {
  const src = fs.readFileSync(path.join(frontend, 'sound-wiring.js'), 'utf8');
  assert.doesNotMatch(src, /ack_lost|outcome_unknown|'sent'\b.*notice|abito:pose/, 'the wiring never listens to the pose or the silent notices');
});

test('diagnostics: a cue dropped for a WIRING reason (disabled/not_ready) logs engine.state() ONCE, bounded and secret-free', async () => {
  const r = rig();
  r.doc.dispatchEvent({ type: 'abito:cue', detail: 'snd.attention' });
  r.time.advance(30);
  await new Promise(res => setTimeout(res, 5));
  r.doc.dispatchEvent({ type: 'abito:cue', detail: 'snd.notice' });
  r.time.advance(3000);
  await new Promise(res => setTimeout(res, 5));
  assert.equal(r.lines.length, 1, 'once');
  assert.match(r.lines[0], /disabled/); assert.match(r.lines[0], /"ready":false/);
  assert.ok(!/token|secret|password/i.test(r.lines[0]));
});

test('questions: notify.js hands the cue to the engine ALWAYS (the engine and the human\'s preference are the gate, not a constant)', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("abito:cue"));
  assert.ok(line, 'notify.js still emits the page event');
  assert.doesNotMatch(line, /SOUND_ENABLED_DEFAULT/, 'a constant that is always false would mute attention/expired forever');
  assert.match(line, /limiter\.allow/, 'the 250ms/2s limiter still guards it');
});

test('hooks: island.js and chat.js call the wiring through a null-safe lookup, so a missing engine breaks nothing', () => {
  for (const f of ['island.js', 'chat.js']) {
    const src = fs.readFileSync(path.join(frontend, f), 'utf8');
    assert.match(src, /AbitoSoundWiringInstance/, f);
    assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), /AbitoSoundWiringInstance\.\w+\(/, `${f}: never dereference without a check`);
  }
  const island = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(island, /soundCue\('firstSnapshotRendered'\)/, 'ready() is signalled after the first snapshot');
});

test('custom sounds: startup, exact IPC, validation, failures, removal and reload ordering', async () => {
  const calls = [], listeners = {}, overrides = new Map();
  let names = ['notice', 'notice', '../bad', '__proto__', 'unknown', 'error'];
  let bad = false, failList = false, decodeFail = false, readFail = false;
  const buffer = { duration: 0.2, getChannelData() {} };
  const engine = { setSample: (id, b) => overrides.set(id, b), clearSamples: () => overrides.clear() };
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (args.payload.action === 'list') { if (failList) throw Error('host'); return { names }; }
    if (readFail) throw Error('read');
    return { name: 'untrusted', mime: 'ignored', data: args.payload.name === 'error' || bad ? '!!!!' : 'AQID' };
  };
  let decodes = 0;
  const wiring = Wiring.wire({ engine, invoke, listen: (n, f) => { listeners[n] = f; },
    getAudioContext: () => ({ decodeAudioData: async bytes => {
      decodes++; assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]);
      if (decodeFail) throw Error('decode'); return buffer;
    } }), decodeBase64: s => Buffer.from(s, 'base64').toString('binary') });
  await wiring.samplesLoaded();
  assert.deepEqual(calls, [['sound_action', { payload: { action: 'list' } }],
    ['sound_action', { payload: { action: 'read', name: 'notice' } }],
    ['sound_action', { payload: { action: 'read', name: 'error' } }]]);
  assert.equal(overrides.get('snd.notice'), buffer); assert.equal(overrides.size, 1);
  names = []; calls.length = 0; listeners['sounds:changed']({}); await wiring.samplesLoaded();
  assert.deepEqual(calls, [['sound_action', { payload: { action: 'list' } }]]);
  assert.equal(overrides.size, 0);
  names = ['notice']; bad = true; listeners['sounds:changed']({}); await wiring.samplesLoaded();
  assert.equal(overrides.size, 0); assert.equal(decodes, 1);
  bad = false; decodeFail = true; listeners['sounds:changed']({}); await wiring.samplesLoaded();
  assert.equal(overrides.size, 0); assert.equal(decodes, 2);
  decodeFail = false; readFail = true; listeners['sounds:changed']({}); await wiring.samplesLoaded();
  assert.equal(overrides.size, 0);
  readFail = false; failList = true; listeners['sounds:changed']({}); await wiring.samplesLoaded();
  assert.equal(overrides.size, 0);
  failList = false; calls.length = 0;
  listeners['sounds:changed']({}); listeners['sounds:changed']({}); await wiring.samplesLoaded();
  assert.equal(calls.filter(c => c[1].payload.action === 'list').length, 2);
  assert.equal(calls.filter(c => c[1].payload.action === 'read').length, 2);
});

test('custom sounds: reject empty, malformed, non-string and oversized base64 without decoding', async () => {
  for (const data of ['', null, 42, [], 'A', 'A===', 'AA=A', 'AQID\n', 'A'.repeat(4 * Math.ceil(2097152 / 3) + 4)]) {
    let decodes = 0, installed = 0;
    const w = Wiring.wire({ engine: { clearSamples() {}, setSample() { installed++; } },
      invoke: async (_cmd, { payload }) => payload.action === 'list' ? { names: ['notice'] } : { data },
      getAudioContext: () => ({ decodeAudioData: async () => { decodes++; } }),
      decodeBase64: s => Buffer.from(s, 'base64').toString('binary') });
    await w.samplesLoaded(); assert.equal(decodes, 0); assert.equal(installed, 0);
  }
});

test('custom sounds: boot shares the decoding/playback context and never plays while off', async () => {
  let contexts = 0, engine;
  const sources = [], events = {};
  const c = soft.createSoftContext();
  c.decodeAudioData = async () => ({ duration: 0.1, getChannelData() {} });
  c.createBufferSource = () => {
    const s = { connect() {}, disconnect() {}, start() {}, stop() {} }; sources.push(s); return s;
  };
  const win = { document: { addEventListener() {} },
    AbitoSound: { createSoundEngine: options => (engine = Engine.createSoundEngine({ ...options, coalesceMs: 0 })) },
    AudioContext: function () { contexts++; return c; }, atob: s => Buffer.from(s, 'base64').toString('binary'),
    __TAURI__: { event: { listen: (n, f) => { events[n] = f; } }, core: { invoke: async (cmd, { payload }) => {
      if (cmd === 'prefs_action') return { sound: false };
      return payload.action === 'list' ? { names: ['notice'] } : { data: 'AQID' };
    } } } };
  const w = Wiring.boot(win); await w.samplesLoaded(); w.firstSnapshotRendered();
  assert.equal((await engine.play('snd.notice')).reason, 'disabled');
  assert.equal(sources.length, 0); assert.equal(contexts, 1);
  w.applyPrefs({ sound: true }); assert.equal((await engine.play('snd.notice')).played, true);
  assert.equal(sources.length, 1); assert.equal(contexts, 1); assert.equal(c.oscillators.length, 0);
  engine.close();
});

test('custom sounds: no invoke or audio capability means no sample listener or IPC', async () => {
  for (const options of [{}, { invoke: () => { throw Error('must not invoke'); } }]) {
    const events = [];
    const w = Wiring.wire({ engine: {}, listen: n => events.push(n), ...options });
    await w.samplesLoaded();
    assert.ok(!events.includes('sounds:changed'));
  }
});

test('custom samples: every reference stem has its own playable Abito cue and override', async () => {
  const names = ['peek','open','close','hover','blip','slap','annoyed','dizzy','greet','work','finish','error','approval','question','approve','gulp','tick','send','love','pop','proud','wink','yawn','attach','think','search','rate','sleep','greeting'];
  for (const name of names) {
    const r = rig(); r.wiring.applyPrefs({sound:true}); r.wiring.firstSnapshotRendered(); r.time.advance(5000);
    const played = await r.settle('snd.' + name);
    assert.equal(played.played, true, name + ': ' + played.reason);
  }
  const reads = [], installed = [];
  const w = Wiring.wire({ engine: { clearSamples() {}, setSample: id => installed.push(id) },
    invoke: async (_cmd, { payload }) => {
      if (payload.action === 'list') return { names: [...names, '../open', 'unknown'] };
      reads.push(payload.name); return { data: 'AQID' };
    }, getAudioContext: () => ({ decodeAudioData: async () => ({}) }),
    decodeBase64: s => Buffer.from(s, 'base64').toString('binary') });
  await w.samplesLoaded(); assert.deepEqual([...reads].sort(), [...names].sort()); assert.deepEqual([...installed].sort(), names.map(n => 'snd.' + n).sort());
  w.dispose();
});

test('dispose handles late-resolving Tauri unlisteners without leaving callbacks active', async () => {
  const resolves = [], callbacks = []; let off = 0, played = 0;
  const w = Wiring.wire({ engine: { play() { played++; } },
    listen: (_n, f) => { callbacks.push(f); return new Promise(resolve => resolves.push(resolve)); } });
  w.dispose(); for (const resolve of resolves) resolve(() => { off++; }); await Promise.resolve();
  for (const fn of callbacks) fn({ payload: { state: 'expanded' } });
  assert.equal(off, resolves.length); assert.equal(played, 0);
});

// Deterministic adapter fixture: real engine + disposable fake DOM/Tauri subscriptions.
function interactionRig({ clay = true, hovered = false, sound = true } = {}) {
  const time = soft.createFakeTime(), listeners = new Map(), observers = [], results = [], ctxs = [];
  const engine = Engine.createSoundEngine({ enabled: sound, now: time.now, setTimer: time.setTimer,
    clearTimer: time.clearTimer, createContext: () => { const c = soft.createSoftContext(); ctxs.push(c); return c; } });
  engine.ready();
  const on = (n, f) => { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(f); return () => listeners.get(n).delete(f); };
  const fire = (n, e) => { for (const f of listeners.get(n) || []) f(e); };
  const el = { style: { getPropertyValue: () => hovered ? '1.06' : '1' } };
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe(target, opts) { assert.equal(target, el); assert.deepEqual(opts, { attributes: true, attributeFilter: ['style'] }); this.active = true; }
    disconnect() { this.active = false; }
  }
  const doc = { getElementById: id => { assert.equal(id, 'clay'); return clay ? el : null; },
    addEventListener: on, removeEventListener: (n, f) => listeners.get(n)?.delete(f), visibilityState: 'visible' };
  const w = Wiring.wire({ engine: { ...engine, play: id => { const p = engine.play(id); results.push(p); return p; } },
    document: doc, listen: (n, f) => Promise.resolve(on(n, f)), MutationObserver: Observer,
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  return { time, engine, ctxs, observers, doc, w, results, fire,
    state: state => fire('desktop:state', { payload: { state } }),
    hover: value => { hovered = value; for (const o of observers) if (o.active) o.fn([]); },
    verdicts: async () => { time.advance(30); const rs = await Promise.all(results.splice(0)); return rs; } };
}

test('desktop:state full transition matrix, baseline, repeats and malformed payloads', async () => {
  const expected = { 'compact:expanded': 'open', 'expanded:compact': 'close', 'expanded:hidden': 'close',
    'hidden:compact': 'peek', 'hidden:expanded': 'peek' };
  for (const from of ['compact', 'expanded', 'hidden']) for (const to of ['compact', 'expanded', 'hidden']) {
    const r = interactionRig(); r.state(from); assert.deepEqual(await r.verdicts(), []);
    for (const payload of [null, [], {}, { state: 'expanding' }, { state: 1 }, { view: 'expanded' }]) r.fire('desktop:state', { payload });
    r.state(to); const rs = await r.verdicts(), id = expected[from + ':' + to];
    assert.deepEqual(rs.map(v => [v.id, v.reason]), id ? [['snd.' + id, 'played']] : []);
    r.state(to); assert.deepEqual(await r.verdicts(), []); r.w.dispose(); r.engine.close();
  }
});

test('desktop and DOM cues respect off, gain, quiet reconnect and resume; peek loses to notice', async () => {
  const off = interactionRig({ sound: false }); off.state('compact'); off.state('expanded');
  off.hover(true); off.time.advance(1900);
  off.fire('abito:cue', { detail: 'snd.pop' }); off.fire('abito:cue', { detail: 'snd.tick' });
  assert.ok((await off.verdicts()).every(v => v.reason === 'disabled')); assert.equal(off.ctxs.length, 0);
  const r = interactionRig(); r.w.applyPrefs({ sound: true, gain: 0.05 });
  assert.equal(r.engine.state().gain, 0.05);
  r.state('hidden'); r.state('expanded'); r.fire('abito:cue', { detail: 'snd.notice' });
  assert.deepEqual((await r.verdicts()).map(v => v.reason), ['outranked', 'played']);
  assert.equal(r.ctxs[0].gains[0].gain.events.find(e => e.type === 'lin').v, 0.05 * Engine.CUES['snd.notice'].level);
  for (const reset of [() => r.w.reconnected(), () => r.fire('visibilitychange', {})]) {
    reset(); r.state('hidden'); assert.deepEqual(await r.verdicts(), []);
    r.state('compact'); assert.equal((await r.verdicts())[0].reason, 'quiet');
    r.hover(false); r.hover(true); r.time.advance(1900);
    assert.ok((await r.verdicts()).every(v => v.reason === 'quiet'));
    r.time.advance(3100); assert.deepEqual(await r.verdicts(), []);
  }
  off.w.dispose(); r.w.dispose(); off.engine.close(); r.engine.close();
});

test('hover edges, love dwell/cooldown, rapid reentry and cancellation use injected timers', async () => {
  const r = interactionRig(); r.hover(true); r.hover(true);
  assert.deepEqual((await r.verdicts()).map(v => v.id), ['snd.hover']);
  r.time.advance(1869); assert.deepEqual(r.results, []); r.time.advance(1);
  assert.deepEqual((await r.verdicts()).map(v => [v.id, v.reason]), [['snd.love', 'played']]);
  r.time.advance(10000); assert.deepEqual(await r.verdicts(), [], 'one love per entry');
  r.hover(false); r.hover(true); await r.verdicts(); r.time.advance(1900);
  assert.equal((await r.verdicts())[0].id, 'snd.love');
  r.hover(false); r.hover(true); r.hover(false); r.hover(true);
  assert.ok((await r.verdicts()).every(v => !v.played), 'engine suppresses quick hover reentries');
  r.time.advance(1900); assert.deepEqual(await r.verdicts(), [], 'love cooldown suppresses repeat');
  r.time.advance(6000); r.hover(false); r.hover(true); await r.verdicts();
  r.time.advance(1800); r.hover(false); r.time.advance(500); assert.deepEqual(await r.verdicts(), []);
  r.w.dispose(); r.engine.close();
});

test('hover baseline is silent, missing clay is inert, dispose removes observers/timers/subscriptions', async () => {
  const missing = interactionRig({ clay: false }); assert.equal(missing.observers.length, 0); assert.equal(missing.time.pending(), 0);
  const initial = interactionRig({ hovered: true }); initial.time.advance(3000); assert.deepEqual(await initial.verdicts(), []);
  const r = interactionRig(); r.hover(true); await r.verdicts(); r.engine.close();
  await Promise.resolve(); r.w.dispose(); r.w.dispose(); assert.equal(r.time.pending(), 0);
  assert.equal(r.observers[0].active, false);
  r.hover(false); r.hover(true); r.state('compact'); r.state('expanded'); r.fire('abito:cue', { detail: 'snd.pop' });
  r.time.advance(10000); assert.deepEqual(await r.verdicts(), []);
  missing.w.dispose(); initial.w.dispose(); initial.engine.close();
});

Promise.all(pending).then(() => console.log(`sound-wiring-check: ${passed} passed`), e => { console.error(e); process.exit(1); });
