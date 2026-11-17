'use strict';
/* K2-07 «Koda suena al avisar» — the page end to end, no browser: the REAL island.js and notify.js controllers run on a small fake
   DOM inside one page (shared document, window, Tauri bus) with the REAL sound wiring booted the way the page boots it
   (sound-wiring.js boot(window)) and the REAL engine (sound-engine.js) synthesizing into the engine lane's software AudioContext.
   Nothing here plays real audio: a cue «played» means the engine scheduled it into that context; the human listens (LISTEN.md).
   S1: a question:state with a NEW question plays snd.question, a NEW permission snd.approval (Pi's kind=approval and a harness
       permission the island shows with the approval look), the island's permission card snd.approval and a finished turn (a new
       notice of kind settled) snd.finish — on the transition only: never the first snapshot, a reconnect replay or a dismiss.
   S2: prefs:state {sound:false} → nothing plays and no AudioContext exists; sound back on → it plays.
   S3: a user file question.* / approval.* / finish.* replaces that notice's cue for a real event; missing/undecodable → Koda's cue.
   Run: node apps/desktop-tauri/test-node/sound-notices-check.cjs (also picked up by run-node-checks.cjs, every *-check.cjs). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..', 'frontend');
const soft = require(path.join(__dirname, '..', '..', 'desktop-sound', 'test', 'support', 'soft-audio.cjs'));
const Engine = require(path.join(frontend, 'sound-engine.js'));
const Wiring = require(path.join(frontend, 'sound-wiring.js'));
const N = require(path.join(frontend, 'notify-view.js'));
const L = require(path.join(frontend, 'island-layout.js'));
const O = require(path.join(frontend, 'overview-view.js'));
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');

const Q1 = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a01', Q2 = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a02', Q3 = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a03';
const T0 = 2_000_000_000_000;
const question = id => ({ id, kind: 'question', agent: 'codex', project_name: 'koda', text: '¿Qué rama uso?', allow_free_text: false, expires_at: T0 + 600000,
  options: ['main', 'develop', 'release'].map((label, index) => ({ index, label, description: '' })) });
// Pi's own permission (kind=approval, exactly two options)
const piApproval = id => ({ id, kind: 'approval', agent: 'pi', text: '¿Me das permiso para ejecutar: git push?', allow_free_text: false, expires_at: T0 + 600000,
  options: [{ index: 0, label: 'Aprobar', description: '' }, { index: 1, label: 'Rechazar', description: '' }] });
// a Claude Code / Codex hook permission: kind=question worded «<Agente> pide permiso para …» with the exact pair (island-layout approvalView)
const hookPermission = id => ({ id, kind: 'question', agent: 'codex', project_name: 'koda', text: 'Codex pide permiso para Bash: cargo test', allow_free_text: false,
  expires_at: T0 + 600000, options: [{ index: 0, label: 'Aprobar una vez', description: '' }, { index: 1, label: 'Rechazar', description: '' }] });
const qstate = (pending, extra = {}) => ({ available: true, native_transition: 'idle', pending, queued: [], queued_count: 0, deliveries: [], notice: null, ready_connections: 1, ...extra });
const settled = id => ({ id, sessionId: 's1', at: T0, expiresAt: T0 + 600000, title: 'Pi terminó su turno', detail: '', emotion: 'idle', severity: 'info', kind: 'settled', agent: 'pi' });
const attention = id => ({ id, sessionId: 's2', at: T0, expiresAt: T0 + 600000, title: 'Codex te pide permiso en su terminal', detail: '', emotion: 'sun', severity: 'warning', kind: 'attention', agent: 'codex' });
const card = (operation, expiresAt = '2099-01-01T00:00:00Z') => ({ state: 'pending', reason: null, operation, expires_at: expiresAt });
const dstate = (extra = {}) => ({ state: 'expanded', view: 'overview', revision: 1, notices: [], card: null, ...extra });

// ---- one fake page: a DOM rich enough for island.js and notify.js ----------------------------------------------------------------
function page({ sound = true, files = {}, undecodable = [] } = {}) {
  const clock = { t: T0 };
  const doc = { activeElement: null };
  class El {
    constructor(tag, id) {
      Object.assign(this, { tagName: String(tag).toUpperCase(), nodeName: String(tag), id: id || '', className: '', dataset: {}, attrs: {}, children: [], parentNode: null,
        handlers: {}, hidden: false, inert: false, disabled: false, value: '', title: '', maxLength: 0, offsetHeight: 0, offsetWidth: 0, scrollHeight: 20, _t: '', isContentEditable: false });
      this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    get textContent() { return this._t + this.children.map(c => c.textContent || '').join(''); }
    set textContent(v) { this._t = v == null ? '' : String(v); this.children = []; }
    append(...kids) { for (const k of kids) { if (k && typeof k === 'object') { k.parentNode = this; this.children.push(k); } } }
    appendChild(k) { this.append(k); return k; }
    prepend(...kids) { this.append(...kids); }
    before(k) { if (k && k.id) nodes.set(k.id, k); }
    after() {}
    remove() {}
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    insertBefore(k) { this.append(k); return k; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
    addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }
    removeEventListener() {}
    contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll(sel) {
      if (sel !== 'button') return [];
      const all = [], walk = e => { for (const c of e.children) { all.push(c); walk(c); } };
      walk(this); return all.filter(e => e.tagName === 'BUTTON');
    }
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    getAnimations() { return []; }
    animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    requestSubmit() {}
    scrollIntoView() {}
    cloneNode() { return new El(this.tagName); }
  }
  const TAGS = { 'question-text': 'textarea', 'question-send': 'button', 'question-skip': 'button', 'question-prev': 'button', 'question-primary': 'button',
    'question-freeform': 'form', allow: 'button', deny: 'button', 'card-fold': 'button' };
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new El(TAGS[id] || 'div', id)); return nodes.get(id); };
  for (const id of ['question-head', 'question-body', 'question-options', 'question-freeform', 'question-text', 'question-state', 'question-approval',
    'question-approval-actions', 'question-live']) get(id).parentNode = get('question');
  Object.assign(get('capsule').dataset, { phase: 'expanded', view: 'overview' });
  const listeners = {};
  Object.assign(doc, {
    body: new El('body'), documentElement: new El('html'), readyState: 'complete', visibilityState: 'visible', hidden: false,
    getElementById: get, querySelector: () => null, querySelectorAll: () => [], createElement: tag => new El(tag), createElementNS: (_ns, tag) => new El(tag),
    createTextNode: data => ({ nodeType: 3, textContent: String(data) }), importNode: n => n,
    addEventListener(k, fn) { (listeners[k] ||= []).push(fn); }, removeEventListener(k, fn) { listeners[k] = (listeners[k] || []).filter(f => f !== fn); },
    dispatchEvent(e) { for (const fn of [...(listeners[e.type] || [])]) fn(e); return true; },
  });
  doc.activeElement = doc.body;

  // ---- one Tauri bus and host for the whole page ----
  const bus = {};
  const listen = (name, fn) => { (bus[name] ||= []).push(fn); return Promise.resolve(() => {}); };
  const fire = (name, payload) => { for (const fn of [...(bus[name] || [])]) fn({ payload }); };
  const reads = [];
  let qInitial = qstate(null);
  const invoke = async (cmd, args) => {
    const p = (args && args.payload) || {};
    if (cmd === 'question_action') return p.action === 'view' ? qInitial : qInitial;
    if (cmd === 'prefs_action') return { sound, gain: 0.12 };
    if (cmd === 'sound_action') {
      if (p.action === 'list') return { names: Object.keys(files) };
      reads.push(p.name);
      if (!Object.prototype.hasOwnProperty.call(files, p.name)) throw new Error('not_found');
      return { name: p.name, mime: 'audio/wav', data: files[p.name] };
    }
    return {};
  };

  // ---- the audio the engine produces (software context, counted) ----
  const contexts = [], played = [];
  function AudioContext() {
    const c = soft.createSoftContext();
    c.sources = [];
    c.createBufferSource = () => {
      const s = { buffer: null, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null };
      c.sources.push(s); return s;
    };
    c.decodeAudioData = async bytes => {
      const text = Buffer.from(new Uint8Array(bytes)).toString('latin1');
      if (undecodable.some(stem => text === `undecodable:${stem}`)) throw new Error('EncodingError');
      return { duration: 0.2, getChannelData() { return new Float32Array(1); }, label: text };
    };
    contexts.push(c);
    return c;
  }
  const win = {
    document: doc, AudioContext, atob: s => Buffer.from(s, 'base64').toString('binary'),
    AbitoOverview: O, AbitoNotify: N, AbitoIslandLayout: L, AbitoIcons: { svg: () => '', ring: () => '' },
    // the real engine, with the test clock so the 250 ms / 2 s gates and the reconnect quiet window are deterministic
    AbitoSound: { createSoundEngine: options => {
      const engine = Engine.createSoundEngine({ ...options, now: () => clock.t, coalesceMs: 0 });
      return { ...engine, play: id => { const r = engine.play(id); played.push(r); return r; } };
    } },
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    __TAURI__: { core: { invoke }, event: { listen } },
  };
  const stateHandlers = [];
  const resolved = value => ({ then(fn) { if (fn) fn(value); return { catch() {} }; } });
  let desktopInitial = dstate();
  win.desktop = { onState(fn) { stateHandlers.push(fn); }, snapshot() { return Promise.resolve(desktopInitial); }, // async, like the real facade
    click() { return resolved(null); }, dismiss() { return resolved(null); }, expand() { return resolved(null); }, close() { return resolved(null); },
    allow() { return resolved(null); }, deny() { return resolved(null); }, choose() { return resolved(null); } };
  win.AbitoCharacter = require(path.join(frontend, 'character-motion.js'));
  const h = require('./character-harness.cjs').engine();
  const clay = h.api.create(h.svg);
  const AbitoClay = { create: () => clay, get forced() { return h.api.forced; }, setForced: value => h.api.setForced(value), onChange: fn => h.api.onChange(fn) };
  const globals = { window: win, document: doc, AbitoClay, Date: { now: () => clock.t, parse: s => Date.parse(s) }, performance: { now: () => clock.t },
    DOMParser: class { parseFromString() { const n = new El('svg'); n.nodeName = 'svg'; return { documentElement: n }; } },
    matchMedia: win.matchMedia, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Promise, console };
  return {
    clock, contexts, played, reads, fire, get,
    set questionInitial(s) { qInitial = s; }, set desktopInitial(s) { desktopInitial = s; },
    // the page's own load order (index.html): sound-engine.js + sound-wiring.js (boot) … island.js … notify.js
    async load() {
      this.wiring = Wiring.boot(win);
      vm.runInNewContext(read('island.js'), { ...globals });
      vm.runInNewContext(read('notify.js'), { ...globals });
      await this.settle();
    },
    async settle() { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); await this.wiring.samplesLoaded(); },
    desktop: async s => { for (const fn of stateHandlers) fn(s); await new Promise(r => setImmediate(r)); },
    question: async s => { fire('question:state', s); for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); },
    // every engine verdict since the last call, as [id, reason]
    verdicts: async () => (await Promise.all(played.splice(0))).map(v => [v.id, v.reason]),
    later: ms => { clock.t += ms; },
  };
}
const playedIds = vs => vs.filter(([, reason]) => reason === 'played').map(([id]) => id);
const b64 = text => Buffer.from(text, 'latin1').toString('base64');

const checks = [];
const test = (name, fn) => checks.push([name, fn]);

test('S1 question:state → abito:cue → engine: a NEW question plays snd.question, synthesized with its own notes', async () => {
  const p = page(); await p.load(); p.later(5000);
  assert.deepEqual(await p.verdicts(), [], 'the first snapshot is history');
  await p.question(qstate(question(Q1)));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'played']]);
  const osc = p.contexts[0].oscillators;
  assert.equal(osc[0].frequency.events[0].v, Engine.CUES['snd.question'].notes[0].f, 'the audio scheduled is the question cue, not attention');
  p.later(3000); await p.question(qstate(question(Q1)));
  assert.deepEqual(await p.verdicts(), [], 'the same question again is not an event');
});

test('S1 a NEW permission plays snd.approval: Pi\'s kind=approval and a hook permission shown with the approval look', async () => {
  const p = page(); await p.load(); p.later(5000);
  await p.question(qstate(piApproval(Q1)));
  assert.deepEqual(await p.verdicts(), [['snd.approval', 'played']]);
  p.later(3000); await p.question(qstate(null, { notice: 'answered' }));
  p.later(3000); await p.question(qstate(hookPermission(Q2)));
  assert.deepEqual(await p.verdicts(), [['snd.approval', 'played']], 'a harness permission is a permission, not a question');
  assert.equal(p.get('question').dataset.look, 'approval', 'the cue agrees with what the island shows');
  p.later(3000); await p.question(qstate(question(Q3)));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'played']], 'an ordinary question after it keeps snd.question');
  const freqs = p.contexts[0].oscillators.map(o => o.frequency.events[0].v);
  assert.deepEqual(freqs, [Engine.CUES['snd.approval'].notes[0].f, Engine.CUES['snd.approval'].notes[0].f, Engine.CUES['snd.question'].notes[0].f]);
});

test('S1 no sound on the first snapshot, a reconnect replay or a dismiss of a question', async () => {
  const p = page(); p.questionInitial = qstate(question(Q1)); await p.load(); p.later(5000);
  assert.deepEqual(await p.verdicts(), [], 'a question already pending at start-up is history');
  await p.question(qstate(question(Q1)));
  assert.deepEqual(await p.verdicts(), [], 'the same question pushed again is not an event');
  await p.question(qstate(null, { notice: 'human_cancelled' }));
  assert.deepEqual(playedIds(await p.verdicts()), [], 'dismissing it («Omitir») is silent');
  // the engine connection drops and comes back: a reconnect opens the quiet window, a replayed question does not sound
  p.fire('agent:state', { connection: 'connected' }); p.fire('agent:state', { connection: 'lost' }); p.fire('agent:state', { connection: 'connected' });
  p.later(100); await p.question(qstate(question(Q2)));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'quiet']], 'a replay right after a reconnect stays quiet');
});

test('S1 the island: a finished turn (notice kind settled) plays snd.finish, the permission card snd.approval, others keep snd.notice', async () => {
  const p = page(); p.desktopInitial = dstate({ notices: [settled('n-old')] }); await p.load(); p.later(5000);
  assert.deepEqual(await p.verdicts(), [], 'notices already there at start-up are history');
  await p.desktop(dstate({ revision: 2, notices: [settled('n-old'), settled('n-1')] }));
  assert.deepEqual(await p.verdicts(), [['snd.finish', 'played']], 'a finished turn, even behind an older notice (host order is oldest first)');
  assert.equal(p.contexts[0].oscillators[0].frequency.events[0].v, Engine.CUES['snd.finish'].notes[0].f);
  p.later(3000); await p.desktop(dstate({ revision: 3, notices: [attention('a-1'), settled('n-old'), settled('n-1')] }));
  assert.deepEqual(await p.verdicts(), [['snd.notice', 'played']], 'an agent asking in its own terminal keeps snd.notice');
  p.later(3000); await p.desktop(dstate({ revision: 4, notices: [settled('n-old'), settled('n-1')] }));
  await p.desktop(dstate({ revision: 5, notices: [settled('n-1')] }));
  await p.desktop(dstate({ revision: 6, notices: [] }));
  assert.deepEqual(await p.verdicts(), [], 'dismissing notices is silent');
  p.later(3000); await p.desktop(dstate({ revision: 7, card: card('git push --force') }));
  assert.deepEqual(await p.verdicts(), [['snd.approval', 'played']], 'the permission card arriving');
  p.later(3000); await p.desktop(dstate({ revision: 8, state: 'compact', card: { ...card('git push --force'), state: 'inert', reason: 'Abrí la tarjeta para decidir.' } }));
  await p.desktop(dstate({ revision: 9, card: card('git push --force') }));
  assert.deepEqual(playedIds(await p.verdicts()), [], 'folding and reopening the same card is not a new permission');
  await p.desktop(dstate({ revision: 10, card: null }));
  assert.deepEqual(playedIds(await p.verdicts()), [], 'the card leaving is silent');
});

test('S1 the island: a reconnect replays the notices as history', async () => {
  const p = page(); await p.load(); p.later(5000);
  p.fire('agent:state', { connection: 'connected' }); p.fire('agent:state', { connection: 'lost' }); p.fire('agent:state', { connection: 'connected' });
  await p.desktop(dstate({ revision: 2, notices: [settled('n-1'), settled('n-2')] }));
  p.later(5000); await p.desktop(dstate({ revision: 3, notices: [settled('n-1'), settled('n-2')] }));
  assert.deepEqual(await p.verdicts(), [], 'the first list after a reconnect is a baseline, the same list again is nothing');
  await p.desktop(dstate({ revision: 4, notices: [settled('n-1'), settled('n-2'), settled('n-3')] }));
  assert.deepEqual(await p.verdicts(), [['snd.finish', 'played']]);
});

test('S2 sound off in Ajustes: a new question, permission and finished turn play nothing and no AudioContext exists; on again → plays', async () => {
  const p = page({ files: { question: b64('own:question') } }); await p.load(); p.later(5000);
  p.fire('prefs:state', { sound: false, gain: 0.12 }); await p.settle();
  const before = p.contexts.length; // booted with sound on: the shared context may already exist to decode the file
  const scheduled = () => p.contexts.reduce((n, c) => n + c.oscillators.length + c.sources.length, 0);
  await p.question(qstate(question(Q1)));
  p.later(3000); await p.question(qstate(piApproval(Q2)));
  p.later(3000); await p.desktop(dstate({ revision: 2, notices: [settled('n-1')] }));
  p.later(3000); await p.desktop(dstate({ revision: 3, notices: [settled('n-1'), settled('n-2')] }));
  p.later(3000); await p.desktop(dstate({ revision: 4, card: card('rm -rf build') }));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'disabled'], ['snd.approval', 'disabled'], ['snd.finish', 'disabled'], ['snd.finish', 'disabled'], ['snd.approval', 'disabled']]);
  assert.equal(p.contexts.length, before, 'no AudioContext is created while the sound is off');
  assert.equal(scheduled(), 0, 'no node was ever scheduled');
  const reads = p.reads.length;
  p.fire('sounds:changed', {}); await p.settle();
  assert.equal(p.reads.length, reads, '«Recargar sonidos» while off reads no file');
  p.fire('prefs:state', { sound: true, gain: 0.12 }); await p.settle();
  p.later(3000); await p.question(qstate(question(Q3)));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'played']], 'sound back on: it plays');
  assert.equal(p.contexts.at(-1).sources.at(-1).buffer.label, 'own:question', 'and the user\'s file is back');
  p.later(3000); await p.desktop(dstate({ revision: 5, notices: [settled('n-1'), settled('n-2'), settled('n-3')] }));
  assert.deepEqual(await p.verdicts(), [['snd.finish', 'played']]);
});

test('S2 the stored preference at start-up is respected: prefs_action view {sound:false} → silence, no AudioContext, no file read', async () => {
  const p = page({ sound: false, files: { finish: b64('own:finish') } }); await p.load(); p.later(5000);
  await p.question(qstate(question(Q1)));
  p.later(3000); await p.desktop(dstate({ revision: 2, notices: [settled('n-1')] }));
  p.later(3000); await p.desktop(dstate({ revision: 3, notices: [settled('n-1'), settled('n-2')] }));
  assert.deepEqual(playedIds(await p.verdicts()), []);
  assert.equal(p.contexts.length, 0, 'no audio context created');
  assert.deepEqual(p.reads, [], 'the user\'s files are not read while the sound is off');
  p.fire('prefs:state', { sound: true, gain: 0.12 }); await p.settle();
  assert.deepEqual(p.reads, ['finish']);
  p.later(3000); await p.desktop(dstate({ revision: 4, notices: [settled('n-1'), settled('n-2'), settled('n-3')] }));
  assert.deepEqual(await p.verdicts(), [['snd.finish', 'played']]);
  assert.equal(p.contexts.length, 1);
  assert.equal(p.contexts[0].sources[0].buffer.label, 'own:finish');
});

test('S3 the user\'s question.*, approval.* and finish.* replace those notices\' sounds for real events (boot with sample → event → sample)', async () => {
  const p = page({ files: { question: b64('own:question'), approval: b64('own:approval'), finish: b64('own:finish') } }); await p.load(); p.later(5000);
  assert.deepEqual([...p.reads].sort(), ['approval', 'finish', 'question'], 'the three files were read at start-up');
  await p.question(qstate(question(Q1)));
  p.later(3000); await p.question(qstate(piApproval(Q2)));
  p.later(3000); await p.desktop(dstate({ revision: 2, notices: [settled('n-1')] }));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'played'], ['snd.approval', 'played'], ['snd.finish', 'played']]);
  const c = p.contexts[0];
  assert.deepEqual(c.sources.map(s => s.buffer.label), ['own:question', 'own:approval', 'own:finish'], 'each notice played the user\'s own file');
  assert.equal(c.oscillators.length, 0, 'no synthesized cue played instead');
});

test('S3 a missing or undecodable file falls back to Koda\'s own cue', async () => {
  const p = page({ files: { question: b64('undecodable:question') }, undecodable: ['question'] }); await p.load(); p.later(5000);
  await p.question(qstate(question(Q1)));
  p.later(3000); await p.desktop(dstate({ revision: 2, notices: [settled('n-1')] }));
  assert.deepEqual(await p.verdicts(), [['snd.question', 'played'], ['snd.finish', 'played']]);
  const c = p.contexts[0];
  assert.equal(c.sources.length, 0, 'no sample: the undecodable question file and the missing finish file');
  assert.deepEqual(c.oscillators.map(o => o.frequency.events[0].v), [Engine.CUES['snd.question'].notes[0].f, Engine.CUES['snd.finish'].notes[0].f]);
  // the file goes away and «Recargar sonidos» (sounds:changed) is pressed: the cue goes back to Koda's
  const q = page({ files: { finish: b64('own:finish') } }); await q.load(); q.later(5000);
  q.fire('sounds:changed', {}); await q.settle();
  await q.desktop(dstate({ revision: 2, notices: [settled('n-1')] }));
  assert.deepEqual(await q.verdicts(), [['snd.finish', 'played']]);
  assert.deepEqual(q.contexts[0].sources.map(s => s.buffer.label), ['own:finish']);
});

test('docs: the user guide docs/sounds.md names the folder per OS, the names that play, formats, the limit and «Recargar sonidos»', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'sounds.md'), 'utf8');
  for (const must of ['question', 'approval', 'finish', '2 MiB', 'Recargar sonidos', 'com.abitog.Koda', 'Library/Application Support', '.config', 'AppData',
    '.wav', '.mp3', '.ogg', '.m4a', '.flac']) {
    assert.ok(guide.includes(must), `docs/sounds.md names ${must}`);
  }
});

test('docs: the settings tip names files that actually play (question / approval / finish)', () => {
  const es = read('vendor/coucou/hub/i18n-es.ts'), general = read('vendor/coucou/hub/general.ts');
  const tip = /t\("(Drop a file named[^"]*)"\)/.exec(general);
  assert.ok(tip, 'the tip is still in General');
  const names = [...tip[1].matchAll(/\b([a-z]+)\.(wav|mp3|ogg|m4a)\b/g)].map(m => m[1]);
  assert.ok(names.length >= 2, tip[1]);
  for (const n of names) assert.ok(['question', 'approval', 'finish'].includes(n), `${n} must be a notice that plays (K2-07)`);
  assert.ok(es.includes(tip[1]), 'the tip keeps its Spanish translation');
});

(async () => {
  let passed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; } catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
  }
  console.log(`sound-notices-check: ${passed} passed, ${checks.length - passed} failed`);
})();
