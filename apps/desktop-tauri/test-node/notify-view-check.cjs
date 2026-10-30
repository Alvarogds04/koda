'use strict';
/* N6 — pure checks for frontend/notify-view.js (notifications with 1..N reply
   options; Pi questions QP/1 are one case). No DOM, no network, no audio.
   Contracts: docs/pi-question-roundtrip.md §2.4-§2.7, docs/desktop-visual-language.md
   §1.1/§2.2/§3, docs/desktop-sound-catalog.md §2-§3.
   Run: node apps/desktop-tauri/test-node/notify-view-check.cjs (also by cargo test). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const N = require(path.join(frontend, 'notify-view.js'));
let passed = 0;
const pendingTests = [];
const test = (name, fn) => { const r = fn(); if (r && typeof r.then === 'function') pendingTests.push(r.then(() => { passed += 1; })); else passed += 1; };

const ID = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const pending = (extra = {}) => ({ id: ID, kind: 'question', text: '¿Qué rama uso?', allow_free_text: false, expires_at: 2000000,
  options: [{ index: 0, label: 'main', description: '' }, { index: 1, label: 'develop', description: 'rama de integración' }], ...extra });
const snap = (p = null, extra = {}) => ({ available: true, pending: p, deliveries: [], ready_connections: 1, notice: null, native_transition: 'idle', ...extra });

// ---- model ---------------------------------------------------------------
test('model: a notification has 1..N reply options with 1-based keys; agent-agnostic with Pi as the only producer today', () => {
  const n = N.fromPending(pending());
  assert.equal(n.id, ID); assert.equal(n.kind, 'question'); assert.equal(n.agent, 'pi');
  assert.deepEqual(n.options.map(o => [o.index, o.key, o.label]), [[0, '1', 'main'], [1, '2', 'develop']]);
  assert.equal(n.options[1].description, 'rama de integración');
  assert.equal(n.allowFreeText, false); assert.equal(n.expiresAt, 2000000);
  // the generic model accepts 1 option (an acknowledgement) up to the wire cap, without inventing a producer
  assert.equal(N.fromPending(pending({ options: [{ index: 0, label: 'Entendido', description: '' }] })).options.length, 1);
  assert.equal(N.MAX_OPTIONS, 4);
  assert.equal(N.fromPending(pending({ options: Array.from({ length: 6 }, (_, i) => ({ index: i, label: `o${i}`, description: '' })) })).options.length, 4, 'never more than the QP/1 cap');
  assert.equal(N.fromPending(null), null);
  assert.equal(N.fromPending({}), null);
  assert.equal(N.fromPending(pending({ id: 'not-a-uuid' })), null, 'a malformed id never renders');
  const text = N.fromPending(pending({ options: [], allow_free_text: true }));
  assert.equal(text.options.length, 0); assert.equal(text.allowFreeText, true);
  assert.equal(N.fromPending(pending({ options: [], allow_free_text: false })), null, 'neither options nor free text is no notification');
});

test('approval kind: exactly two options, never free text (a Pi-session answer, NOT an Abito proposal approval)', () => {
  const ok = N.fromPending(pending({ kind: 'approval', options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] }));
  assert.equal(ok.kind, 'approval'); assert.equal(ok.approvesProposal, false);
  assert.equal(N.fromPending(pending({ kind: 'approval', options: [{ index: 0, label: 'Sí', description: '' }] })), null);
  assert.equal(N.fromPending(pending({ kind: 'approval', allow_free_text: true, options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] })), null);
});

// ---- keyboard ---------------------------------------------------------------
test('keyboard 1..N: a bare digit picks that option; modifiers, IME, repeats, typing and non-trusted events never do', () => {
  const n = N.fromPending(pending());
  const key = (k, extra = {}) => ({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, repeat: false, ...extra });
  assert.equal(N.optionForKey(n, key('1'), { typing: false }), 0);
  assert.equal(N.optionForKey(n, key('2'), { typing: false }), 1);
  assert.equal(N.optionForKey(n, key('3'), { typing: false }), -1, 'beyond N');
  assert.equal(N.optionForKey(n, key('0'), { typing: false }), -1);
  assert.equal(N.optionForKey(n, key('a'), { typing: false }), -1);
  assert.equal(N.optionForKey(n, key('1'), { typing: true }), -1, 'digits belong to the text field while typing');
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(N.optionForKey(n, key('1', { [mod]: true }), { typing: false }), -1, mod);
  assert.equal(N.optionForKey(n, key('1', { isTrusted: false }), { typing: false }), -1, 'synthetic events never answer');
  assert.equal(N.optionForKey(n, key('1', { isComposing: true }), { typing: false }), -1);
  assert.equal(N.optionForKey(n, key('1', { repeat: true }), { typing: false }), -1);
  assert.equal(N.optionForKey(null, key('1'), { typing: false }), -1);
  // Enter never submits an option on its own (nothing is preselected)
  assert.equal(N.optionForKey(n, key('Enter'), { typing: false }), -1);
});

test('S4 (abito-avisos-ux): «Agente · proyecto» shows the Koda project as «Koda», never «sb-second-brain»', () => {
  assert.equal(N.projectLabel('sb-second-brain'), 'Koda'); // Koda 0.1 T2
  assert.equal(N.projectLabel('SB-Second-Brain'), 'Koda');
  assert.equal(N.projectLabel('scratch'), 'scratch');
  assert.equal(N.askerLine({ agent: 'codex', projectName: 'sb-second-brain' }), 'Codex · Koda');
});
test('trusted gate: only event.isTrusted === true reaches the host', () => {
  assert.equal(N.trusted({ isTrusted: true }), true);
  for (const bad of [{ isTrusted: false }, {}, null, undefined, { isTrusted: 'true' }, { isTrusted: 1 }]) assert.equal(N.trusted(bad), false);
});

// ---- expiry -------------------------------------------------------------------
test('expiry: short relative word, «Vencida» at/after the deadline, honest on junk', () => {
  const T = 1000000;
  assert.equal(N.expiryWord(T + 4 * 60000, T), '4 min');
  assert.equal(N.expiryWord(T + 30000, T), '<1 min');
  assert.equal(N.expiryWord(T + 90 * 60000, T), '2 h');
  assert.equal(N.expiryWord(T, T), 'Vencida');
  assert.equal(N.expiryWord(T - 1, T), 'Vencida');
  assert.equal(N.expiryWord('x', T), '');
  assert.equal(N.expired(T, T), true); assert.equal(N.expired(T + 1, T), false);
  assert.equal(N.fraction(T + 150000, T, 300000), 0.5);
  assert.equal(N.fraction(T + 600000, T, 300000), 1); assert.equal(N.fraction(T - 5, T, 300000), 0);
});

// ---- outcomes -----------------------------------------------------------------
test('outcomes: every host outcome has icon+word; «Enviada» is NEUTRAL (live plane, never go/check); only a producer ack is lime', () => {
  const all = ['busy', 'expired', 'disconnected', 'cancelled', 'sent', 'answered', 'human_cancelled', 'rejected', 'ack_lost', 'outcome_unknown'];
  for (const o of all) { const v = N.outcomeView(o); assert.ok(v && v.word && v.icon && v.tone && v.aria, o); }
  const sent = N.outcomeView('sent');
  assert.deepEqual([sent.word, sent.icon, sent.tone], ['Enviada', 'plane', 'live']);
  assert.notEqual(sent.tone, 'go'); assert.notEqual(sent.icon, 'check');
  for (const o of ['ack_lost', 'outcome_unknown']) { const v = N.outcomeView(o); assert.equal(v.word, 'Sin confirmar'); assert.equal(v.tone, 'red'); assert.equal(v.icon, 'triangle'); assert.equal(v.persistent, true); }
  assert.equal(N.outcomeView('rejected').persistent, true);
  assert.equal(N.outcomeView('answered').tone, 'go');
  assert.equal(N.outcomeView('answered').word, 'Recibida');
  for (const o of all.filter(x => x !== 'answered')) assert.notEqual(N.outcomeView(o).tone, 'go', `${o} must not look like success`);
  assert.equal(N.outcomeView('expired').word, 'Vencida');
  assert.equal(N.outcomeView('disconnected').word, 'Sin conexión', 'F4: Claude/Codex questions disconnect too: never «Sin Pi»');
  for (const o of all) assert.doesNotMatch(`${N.outcomeView(o).word} ${N.outcomeView(o).aria}`, /\bPi\b/, `F4: ${o} names no agent it cannot know`);
  assert.equal(N.outcomeView('human_cancelled').word, 'Omitida');
  assert.equal(N.outcomeView('nope'), null); assert.equal(N.outcomeView(null), null);
});

// ---- sound cues (pure; no audio exists) ------------------------------------------
test('sound cues follow the catalog: attention on a NEW pending question, expired once; «Enviada»/«Sin confirmar» NEVER sound', () => {
  const none = snap(null);
  assert.equal(N.soundFor(none, snap(pending())), 'snd.attention');
  assert.equal(N.soundFor(snap(pending()), snap(pending())), null, 'same question: no repeat');
  assert.equal(N.soundFor(snap(pending({ id: ID })), snap(pending({ id: '4a2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2c' }))), 'snd.attention', 'a different question is new');
  assert.equal(N.soundFor(null, snap(pending())), null, 'nothing sounds at start-up (no previous snapshot)');
  assert.equal(N.soundFor(snap(pending()), snap(null, { notice: 'expired' })), 'snd.expired');
  assert.equal(N.soundFor(snap(null, { notice: 'expired' }), snap(null, { notice: 'expired' })), null, 'a persisting condition sounds once');
  for (const silent of ['sent', 'ack_lost', 'outcome_unknown', 'answered', 'human_cancelled', 'rejected', 'busy', 'disconnected', 'cancelled']) {
    assert.equal(N.soundFor(snap(pending()), snap(null, { notice: silent, deliveries: [{ id: ID, expires_at: 1, state: 'sent' }] })), null, `${silent} is silent`);
  }
  assert.equal(N.soundFor(snap(null, { notice: 'sent' }), snap(null, { notice: 'ack_lost' })), null);
  // the cue is only an id: playing it is a separate switch, ON by default and the human can turn it off
  assert.equal(N.SOUND_ENABLED_DEFAULT, true);
});

test('rate limit: at most one cue per 250 ms and the same cue once per 2 s; bursts are dropped, not queued', () => {
  const rl = N.createCueLimiter();
  assert.equal(rl.allow('snd.attention', 1000), true);
  assert.equal(rl.allow('snd.expired', 1100), false, '<250ms');
  assert.equal(rl.allow('snd.expired', 1300), true);
  assert.equal(rl.allow('snd.attention', 2500), false, 'same cue <2s');
  assert.equal(rl.allow('snd.attention', 3400), true);
  assert.equal(rl.allow(null, 9999), false);
});

// ---- view phases ------------------------------------------------------------------
test('phase: pending → sending (in flight) → sent (host delivery) → final outcome; nothing infers success', () => {
  assert.equal(N.phase(snap(pending()), { inFlight: false, now: 1 }).kind, 'pending');
  assert.equal(N.phase(snap(pending()), { inFlight: true, now: 1 }).kind, 'sending');
  const afterSend = snap(null, { deliveries: [{ id: ID, expires_at: 5, state: 'sent' }], notice: 'sent' });
  assert.equal(N.phase(afterSend, {}).kind, 'outcome'); assert.equal(N.phase(afterSend, {}).outcome.word, 'Enviada');
  assert.equal(N.phase(snap(null, { notice: 'answered' }), {}).outcome.word, 'Recibida');
  assert.equal(N.phase(snap(null), {}).kind, 'none');
  assert.equal(N.phase(null, {}).kind, 'none');
  assert.equal(N.phase({ available: false }, {}).kind, 'none');
  // pending always beats a stale notice
  assert.equal(N.phase(snap(pending(), { notice: 'ack_lost' }), { now: 1 }).kind, 'pending');
  // a local-clock expiry is shown as «Vencida» and the controls are dead
  const expired = N.phase(snap(pending({ expires_at: 1000 })), { now: 2000 });
  assert.equal(expired.kind, 'expired'); assert.equal(expired.controlsEnabled, false);
  assert.equal(N.phase(snap(pending()), { inFlight: true, now: 1 }).controlsEnabled, false, 'controls lock while a send is in flight');
  assert.equal(N.phase(snap(pending()), { now: 1 }).controlsEnabled, true);
  // the native barrier (a window transition in flight) disables answering without hiding the question
  assert.equal(N.phase(snap(pending(), { native_transition: 'native_transition_busy' }), { now: 1 }).controlsEnabled, false);
  assert.equal(N.phase(snap(pending(), { native_transition: 'native_transition_degraded' }), { now: 1 }).controlsEnabled, false);
});

// ---- free text ----------------------------------------------------------------------
test('free text: UTF-8 byte count, host budget is authoritative, empty/whitespace never sends, the word is one of the contract words', () => {
  assert.equal(N.utf8Bytes('abc'), 3); assert.equal(N.utf8Bytes('ñ'), 2); assert.equal(N.utf8Bytes('🙂'), 4);
  assert.equal(N.textWord({ allowed: true }, 'hola'), '');
  assert.equal(N.textWord({ allowed: false, reason: 'frame_too_large' }, 'x'), 'Muy largo');
  assert.equal(N.textWord({ allowed: false, reason: 'invalid_answer' }, 'x'), 'No válido');
  assert.equal(N.canSendText({ allowed: true }, 'hola'), true);
  assert.equal(N.canSendText({ allowed: true }, '   '), false);
  assert.equal(N.canSendText({ allowed: true }, ''), false);
  assert.equal(N.canSendText({ allowed: false, reason: 'frame_too_large' }, 'x'), false);
  assert.equal(N.canSendText(null, 'hola'), false, 'no budget answer yet: the host must say yes first');
});

// ---- markup / wiring contract -----------------------------------------------------------
test('markup: icon-only controls are named, «Omitir» keeps its WORD, options keep their LABEL (decisions are never icon-only)', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<script defer src="notify-view\.js"><\/script>/);
  assert.match(html, /<script defer src="notify\.js"><\/script>/);
  assert.match(html, /id="question"[^>]*aria-label="Pi pregunta"/);
  assert.match(html, /id="question-skip"[^>]*>[\s\S]*?<span class="btn-word">Omitir<\/span>/);
  assert.match(html, /id="question-send"[^>]*aria-label="[^"]{3,}"/);
  assert.match(html, /id="question-text"[^>]*maxlength="/);
  assert.match(html, /placeholder="Escribí…"/);
});
test('wiring: only trusted events call question_action; no timer, rule or model output ever answers', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /N\.trusted\(event\)/);
  assert.match(src, /question_action/);
  // every answering call sits behind the trusted gate: no `answer` action outside a handler that checks it
  const calls = [...src.matchAll(/action:\s*'(answer|text|decline)'/g)];
  assert.ok(calls.length >= 3);
  assert.doesNotMatch(src, /setTimeout\([^)]*(answer|decline|send)/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'question text is never persisted');
  assert.doesNotMatch(src, /innerHTML\s*=\s*[^;]*(q\.|pending|text|label|description)/, 'plain text only');
  assert.doesNotMatch(src, /new Audio|AudioContext|\.play\(/, 'silence: no audio exists yet');
});

test('R6 shrinks like with a card while a notification is on screen (never covers the options)', () => {
  const island = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(island, /questionShown \? \{ \.\.\.OVERVIEW_CARD, cy: [^}]*\} : cardShown \? OVERVIEW_CARD : OVERVIEW/, 'both a card and a question use the small character; the question centres lower in its 200px island (S10)');
  assert.match(island, /'abito:question'/);
  const notify = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(notify, /show: !!capsule\.dataset\.question/);
});

test('layout: head row carries expiry + text + Omitir; Omitir exists only while something is pending', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const head = /<div id="question-head">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(head.indexOf('question-expiry') < head.indexOf('question-body') && head.indexOf('question-body') < head.indexOf('question-skip'));
  assert.match(fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8'), /skipEl\.hidden = !n;/);
});

test('snd.expired: a SECOND expiry fires even when the old «expired» notice is retained; an unrelated update never re-fires', () => {
  assert.equal(N.soundFor(snap(pending(), { notice: 'expired' }), snap(null, { notice: 'expired' })), 'snd.expired');
  assert.equal(N.soundFor(snap(null, { notice: 'expired' }), snap(null, { notice: 'expired' })), null);
});

test('onScreen: expanded questions are answerable in every view, with no covering card', () => {
  assert.equal(N.onScreen({ phase: 'expanded', view: 'overview', card: undefined }), true);
  assert.equal(N.onScreen({ phase: 'expanded', view: 'chat' }), true);
  for (const d of [{ phase: 'compact', view: 'overview' }, { phase: 'expanding', view: 'overview' },
    { phase: 'expanded', view: 'overview', card: 'pending' }, {}, null]) assert.equal(N.onScreen(d), false, JSON.stringify(d));
});

// ---- BEHAVIOUR: run the real notify.js against a tiny fake DOM --------------------------------
function harness(dataset) {
  const vm = require('node:vm');
  const calls = [];
  const listeners = {};
  const node = (id) => {
    const n = { id, dataset: {}, style: {}, offsetHeight: 148, scrollHeight: 20, hidden: false, inert: true, disabled: false, value: '', textContent: '', title: '', children: [],
      listeners: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null; }, append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      querySelectorAll() { return []; }, requestSubmit() {}, blur() {}, focus() {}, innerHTML: '' };
    Object.defineProperty(n, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = v; if (v === '') this.children = []; } });
    return n;
  };
  const ids = ['question', 'capsule', 'question-body', 'question-options', 'question-freeform', 'question-text', 'question-word', 'question-send',
    'question-skip', 'question-live', 'question-expiry', 'question-state', 'question-expiry-word', 'question-state-icon', 'question-state-word',
    'question-step', 'question-step-header', 'question-summary', 'question-nav', 'question-prev', 'question-primary', 'question-queue',
    'question-approval', 'question-approval-title', 'question-approval-cmd', 'question-approval-note', 'question-approval-actions'];
  const nodes = Object.fromEntries(ids.map(id => [id, node(id)]));
  Object.assign(nodes.capsule.dataset, dataset);
  const doc = { getElementById: id => nodes[id] || null, createElement: tag => node(tag), addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent() {}, activeElement: { tagName: 'OL' } };
  const win = { AbitoNotify: N, AbitoIcons: { svg: () => '' }, __TAURI__: { core: { invoke: (name, args) => { calls.push(args.payload); return Promise.resolve(args.payload.action === 'view' ? view : {}); } } } };
  const view = snap(pending({ expires_at: Date.now() + 120000 }));
  const ctx = vm.createContext({ window: win, document: doc, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: f => f(), MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, Date });
  vm.runInContext(fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8'), ctx);
  return { calls, nodes, key: (k, extra) => { for (const f of listeners.keydown || []) f({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, preventDefault() {}, stopPropagation() {}, ...extra }); } };
}
const settle = () => new Promise(r => setImmediate(r));

test('BEHAVIOUR: a real digit answers ONLY while the notification is on screen (chat open / compact / card covering / mid-transition → never)', async () => {
  const cases = [
    [{ phase: 'expanded', view: 'overview' }, true],
    [{ phase: 'expanded', view: 'chat' }, true],
    [{ phase: 'compact', view: 'overview' }, false],
    [{ phase: 'expanding', view: 'overview' }, false],
    [{ phase: 'expanded', view: 'overview', card: 'pending' }, false],
  ];
  const results = [];
  for (const [dataset, expected] of cases) {
    const h = harness(dataset);
    await settle(); await settle();
    h.nodes.question.inert = !expected ? h.nodes.question.inert : h.nodes.question.inert; // the guard must NOT rely on inert alone
    h.nodes.question.inert = false; // worst case: inert says «live»
    h.key('1');
    await settle();
    const answered = h.calls.some(c => c.action === 'answer');
    results.push([JSON.stringify(dataset), answered]);
    assert.equal(answered, expected, `${JSON.stringify(dataset)} -> answered=${answered}`);
  }
  // typing / modifiers / untrusted never answer even when visible
  for (const extra of [{ isTrusted: false }, { ctrlKey: true }, { repeat: true }]) {
    const h = harness({ phase: 'expanded', view: 'overview' }); await settle(); await settle(); h.nodes.question.inert = false;
    h.key('1', extra); await settle();
    assert.equal(h.calls.some(c => c.action === 'answer'), false, JSON.stringify(extra));
  }
});

test('BEHAVIOUR: the visible-only rule is checked on EVERY answering path (source)', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  for (const fn of ['function choose', 'function decline', 'function submitText']) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 400);
    assert.match(body, /onScreen\(\)/, fn);
  }
  assert.match(src, /root\.inert \|\| !onScreen\(\)/);
});

// ---- P1: who is asking ---------------------------------------------------
test('agent: no field = Pi; a valid slug names the asker; a bad one never reaches the screen', () => {
  assert.equal(N.fromPending(pending()).agent, 'pi');
  assert.equal(N.askedBy(N.fromPending(pending())), 'Pi pregunta');
  const cc = N.fromPending(pending({ agent: 'claude-code', agent_label: 'Claude Code' }));
  assert.equal(cc.agent, 'claude-code');
  assert.equal(N.askedBy(cc), 'Claude Code pregunta');
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'codex', agent_label: 'Codex' }))), 'Codex pregunta');
  // the label is never trusted blindly: derived from the slug when missing or off
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'opencode' }))), 'OpenCode pregunta');
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'gemini-cli' }))), 'Gemini Cli pregunta');
  for (const bad of ['Claude Code', '', '<b>x</b>', 'a'.repeat(33), 7, null, {}, '../x', 'x\ny']) {
    const n = N.fromPending(pending({ agent: bad, agent_label: '<img src=x>' }));
    assert.equal(n.agent, 'pi', `a bad agent falls back to the safe default: ${JSON.stringify(bad)}`);
    assert.equal(N.askedBy(n), 'Pi pregunta');
  }
  // a hostile label next to a good slug is ignored (the label comes from the slug)
  assert.equal(N.askedBy(N.fromPending(pending({ agent: 'codex', agent_label: '<script>x</script>' }))), 'Codex pregunta');
});

test('agent: the screen reader and title use the asker, written with textContent only', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /N\.askedBy\(n\)|askedBy\(n\)/, 'the live-region announcement names the asker');
  assert.doesNotMatch(src, /say\(`Pi pregunta/, 'no hardcoded Pi in the announcement');
  // innerHTML is only for our own static icons: never for the asker or the question text
  assert.doesNotMatch(src, /innerHTML[^\n]*(askedBy|agent|\.text\b)/);
});

// ---- T2: outcome EDGES for the Sileo toast (S3-S5): events at transitions only, never the retained notice ---------------------------
test('T2 outcomeEvent: a pending question that is gone with expired/cancelled/disconnected is ONE event carrying the asker', () => {
  for (const o of ['expired', 'cancelled', 'disconnected']) {
    assert.deepEqual(N.outcomeEvent(snap(pending({ agent: 'claude-code' })), snap(null, { notice: o })), { outcome: o, agent: 'claude-code' }, o);
    assert.equal(N.outcomeEvent(snap(null, { notice: o }), snap(null, { notice: o })), null, `${o}: a retained notice is not a second event`);
    assert.equal(N.outcomeEvent(snap(null), snap(null, { notice: o })), null, `${o}: nothing was pending before: no event`);
  }
});
test('T2 outcomeEvent: busy fires on the change to busy only; sent/answered/human_cancelled/rejected/ack_lost are never events', () => {
  assert.deepEqual(N.outcomeEvent(snap(pending()), snap(pending(), { notice: 'busy' })), { outcome: 'busy', agent: 'pi' });
  assert.equal(N.outcomeEvent(snap(pending(), { notice: 'busy' }), snap(pending(), { notice: 'busy' })), null, 'unrelated snapshot while busy is retained');
  for (const o of ['sent', 'answered', 'human_cancelled', 'rejected', 'ack_lost', 'outcome_unknown']) {
    assert.equal(N.outcomeEvent(snap(pending()), snap(null, { notice: o })), null, o);
  }
  assert.equal(N.outcomeEvent(snap(pending()), snap(pending())), null, 'a plain pending snapshot');
  assert.equal(N.outcomeEvent(snap(pending()), snap(pending(), { notice: 'expired' })), null, 'still pending: it did not expire');
  assert.equal(N.outcomeEvent(null, snap(null, { notice: 'expired' })), null, 'no history at start-up');
  assert.equal(N.outcomeEvent(snap(pending()), null), null);
});
test('T2 shared code pinned: soundFor and phase keep their question/expiry semantics', () => {
  assert.equal(N.soundFor(snap(pending()), snap(null, { notice: 'expired' })), 'snd.expired');
  assert.equal(N.soundFor(snap(pending()), snap(null, { notice: 'cancelled' })), null);
  assert.equal(N.phase(snap(null, { notice: 'busy' }), { now: 1 }).outcome.word, 'Ocupada');
  assert.equal(N.phase(snap(pending()), { now: 1 }).kind, 'pending');
});

Promise.all(pendingTests).then(() => console.log(`notify-view-check: ${passed} passed`), e => { console.error(e); process.exit(1); });

// ---- S3: «Agente · proyecto» and «1 de N» ---------------------------------
test('S3 askerLine: agent and project name, the project only when it is a well-formed name', () => {
  assert.equal(N.askerLine(N.fromPending(pending({ agent: 'codex', project_name: 'proyecto-beta' }))), 'Codex · proyecto-beta');
  assert.equal(N.askerLine(N.fromPending(pending({ agent: 'claude-code', project_name: 'workspace' }))), 'Claude Code · workspace');
  assert.equal(N.askerLine(N.fromPending(pending({ agent: 'codex' }))), 'Codex', 'no project name: just the agent');
  for (const bad of ['', ' x', 'x ', 'a/b', '<img src=x>', 'x'.repeat(65), 7, null, {}, 'x\ny']) {
    assert.equal(N.askerLine(N.fromPending(pending({ agent: 'codex', project_name: bad }))), 'Codex', `bad project: ${JSON.stringify(bad)}`);
  }
});
test('S3 queueLabel: «1 de N» only while others wait behind the shown question', () => {
  const snap = (queued_count, extra = {}) => ({ pending: pending(), queued_count, ...extra });
  assert.equal(N.queueLabel(snap(0)), '');
  assert.equal(N.queueLabel(snap(1)), '1 de 2');
  assert.equal(N.queueLabel(snap(7)), '1 de 8');
  for (const bad of [undefined, null, -1, 1.5, '3', NaN, 99]) assert.equal(N.queueLabel(snap(bad)), '', JSON.stringify(bad));
  assert.equal(N.queueLabel(null), '');
  assert.equal(N.queueLabel({ pending: null, queued_count: 3 }), '', 'nothing shown, nothing to count');
});
test('S3 wiring: the island paints the asker line and the queue label with textContent', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /askerName\.textContent = N\.askerLine\(n\)/);
  assert.match(src, /queueEl\.textContent = N\.queueLabel\(snapshot\)/);
  assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), /id="question-queue"/);
});

// ---- «Enviada» race: a delivered answer must end as «Recibida» ----------------------------------------------------
// Pi acks in <1 ms, so the pushed `question:state` (notice «answered») can land BEFORE the invoke of the send resolves with the
// view computed right after the write (notice «sent»). Applying that older reply used to roll the island back to «Enviada».
test('race: a reply to a send is applied only when no pushed state arrived while it was in flight', () => {
  assert.equal(N.replyIsCurrent(3, 3), true, 'nothing pushed meanwhile: the reply is the newest state');
  assert.equal(N.replyIsCurrent(3, 4), false, 'a push arrived while the invoke was in flight: the reply is older');
  assert.equal(N.replyIsCurrent(0, 0), true);
  for (const bad of [undefined, null, NaN, '3']) assert.equal(N.replyIsCurrent(bad, 3), false, String(bad));
});
test('race: a terminal outcome never regresses to «sent» (answered/human_cancelled/rejected/ack_lost/outcome_unknown stay)', () => {
  for (const terminal of ['answered', 'human_cancelled', 'rejected', 'ack_lost', 'outcome_unknown', 'cancelled', 'expired', 'disconnected']) {
    assert.equal(N.regressesToSent({ pending: null, notice: terminal }, { pending: null, notice: 'sent' }), true, terminal);
  }
  assert.equal(N.regressesToSent({ pending: null, notice: 'sent' }, { pending: null, notice: 'sent' }), false);
  assert.equal(N.regressesToSent({ pending: null, notice: null }, { pending: null, notice: 'sent' }), false);
  assert.equal(N.regressesToSent({ pending: null, notice: 'answered' }, { pending: null, notice: 'answered' }), false);
  assert.equal(N.regressesToSent(null, { pending: null, notice: 'sent' }), false);
  // a NEW question in between is a different send: never blocked
  assert.equal(N.regressesToSent({ pending: { id: 'x' }, notice: null }, { pending: null, notice: 'sent' }), false);
  assert.equal(N.regressesToSent({ pending: null, notice: 'answered' }, { pending: { id: 'y' }, notice: null }), false);
});
test('race wiring: notify.js counts pushed states, ignores stale replies and never lets apply() regress a terminal outcome', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /let pushSeq = 0;/);
  assert.match(src, /listen\('question:state', event => \{ pushSeq \+= 1; apply\(event && event\.payload\); \}\)/);
  assert.match(src, /N\.replyIsCurrent\(sent, pushSeq\)/);
  assert.match(src, /N\.regressesToSent\(snapshot, next\)/);
  for (const fn of ['choose', 'decline', 'submitText']) {
    const body = src.slice(src.indexOf(`function ${fn}(`));
    assert.match(body.slice(0, 900), /const sent = pushSeq;/, fn);
  }
});

// ---- auto-size: the question card grows with its content, the island with it (human: «abito se ajusta al tamaño») -----------
test('questionLayout: min 148, grows with the content, capped so the island fits the fixed window, then scrolls inside the card', () => {
  const L = N.questionLayout;
  assert.deepEqual(L(60), { cardH: 148, islandH: 200, scroll: false }, 'short: the Coucou question card, unchanged');
  assert.deepEqual(L(148), { cardH: 148, islandH: 200, scroll: false });
  assert.deepEqual(L(200.2), { cardH: 201, islandH: 253, scroll: false }, 'rounds up, never clips by a fraction');
  assert.deepEqual(L(280), { cardH: 280, islandH: 332, scroll: false }, 'exactly the cap');
  assert.deepEqual(L(900), { cardH: 280, islandH: 332, scroll: true }, 'beyond the cap: capped and scrolling');
  assert.equal(N.QUESTION_MAX_ISLAND_H, 332);
  assert.ok(N.QUESTION_MAX_ISLAND_H <= 340, 'never taller than the native window (geometry::ISLAND_WINDOW)');
  for (const bad of [NaN, -5, undefined, null, Infinity, '200']) assert.deepEqual(L(bad), { cardH: 148, islandH: 200, scroll: false }, String(bad));
});
test('textareaHeight: the free-text field grows with its text up to a cap, then scrolls', () => {
  const H = N.textareaHeight;
  assert.deepEqual(H(20), { height: 44, scroll: false }, 'one line: the 44px field');
  assert.deepEqual(H(90), { height: 90, scroll: false });
  assert.deepEqual(H(120), { height: 120, scroll: false });
  assert.deepEqual(H(400), { height: 120, scroll: true });
  for (const bad of [NaN, -1, undefined, null]) assert.deepEqual(H(bad), { height: 44, scroll: false }, String(bad));
});
test('auto-size wiring: notify.js measures, sets the card height and tells the island; the island follows; the CSS never clips', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /N\.questionLayout\(/);
  assert.match(src, /N\.textareaHeight\(/);
  assert.match(src, /CustomEvent\('abito:question-size'/);
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(isl, /addEventListener\('abito:question-size'/);
  assert.match(isl, /questionH/);
  assert.doesNotMatch(isl, /\? QUESTION_H : OVERVIEW\.h/, 'the fixed 200 is only the default now');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8') + fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  assert.match(css, /#question-body \{[^}]*max-height: none/);
  assert.match(css, /\.q-label \{[^}]*white-space: normal/);
  assert.match(css, /#question-text \{[^}]*overflow-y: hidden/);
});

// ---- the island is told EVERY time the card appears or disappears (a stale «question shown» kept it tall with the badge) ----------------
test('render announces every change of data-question (outcome timer and local expiry included), once per change', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /function announceShown\(\)/);
  assert.match(src, /if \(show === shownSent\) return;/, 'no event storm: one per change');
  assert.match(src, /capsule\.dataset\.question = [^\n]*\n[\s\S]{0,700}announceShown\(\);/, 'announced right where data-question is written');
  assert.match(src, /reveal: false/, 'a state change is never a reveal event');
});

// ---- the window grows on demand (cap decided by Rust: 70% of the work area) ---------------------------------------------
test('questionLayout takes the island cap the host granted; the default stays the fixed window', () => {
  assert.deepEqual(N.questionLayout(900, 600), { cardH: 548, islandH: 600, scroll: true }, 'capped at the granted height, scrolls inside');
  assert.deepEqual(N.questionLayout(400, 600), { cardH: 400, islandH: 452, scroll: false }, 'fits: the island grows with the card, no scroll');
  assert.deepEqual(N.questionLayout(900), { cardH: 280, islandH: 332, scroll: true }, 'no cap given: the fixed window as before');
  assert.deepEqual(N.questionLayout(900, 100), { cardH: 148, islandH: 200, scroll: true }, 'a nonsense cap never goes below the minimum card');
  for (const bad of [NaN, undefined, null, 'x', -1]) assert.equal(N.questionLayout(900, bad).islandH, 332, String(bad));
});
test('windowHeightFor: the native window needs the island plus a margin; a closed question gives the fixed window back', () => {
  assert.equal(N.windowHeightFor(332), 340);
  assert.equal(N.windowHeightFor(600), 608);
  assert.equal(N.windowHeightFor(0), 340, 'closed: the fixed window (Rust clamps up to it anyway)');
  for (const bad of [NaN, undefined, -3, Infinity]) assert.equal(N.windowHeightFor(bad), 340, String(bad));
});

// ---- structured questions: multiSelect, questionnaire, free_text_max (contract fix/seguridad-app 5a57a4d) -----------------------
const opt = (i, label, description = '') => ({ index: i, label, description });
const pend = (over = {}) => ({ id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'question', text: 'Configurar el proyecto', agent: 'claude-code', agent_label: 'Claude Code',
  options: [], allow_free_text: false, expires_at: Date.now() + 120000, free_text_max: 4000, ...over });
const multiP = (over = {}) => pend({ text: '¿Qué extras?', multi_select: true, options: [opt(0, 'ESLint'), opt(1, 'Tailwind'), opt(2, 'Vitest')], ...over });
const formP = (over = {}) => pend({ form: [
  { header: 'Framework', text: '¿Cuál framework?', options: [opt(0, 'React'), opt(1, 'Vue')], multi_select: false, allow_free_text: false },
  { header: 'Extras', text: '¿Qué extras?', options: [opt(0, 'ESLint'), opt(1, 'Tailwind'), opt(2, 'Vitest')], multi_select: true, allow_free_text: true },
  { header: 'Nombre', text: '¿Cómo se llama?', options: [opt(0, 'app'), opt(1, 'web')], multi_select: false, allow_free_text: true },
], ...over });

test('structured fromPending: multi_select and free_text_max are read, a nonsense max falls back to 2000', () => {
  const m = N.fromPending(multiP());
  assert.deepEqual([m.multiSelect, m.freeTextMax, m.form], [true, 4000, null]);
  assert.equal(N.fromPending(multiP({ free_text_max: undefined })).freeTextMax, 2000);
  for (const bad of [0, -1, 5000, '4000', 1.5, null, NaN]) assert.equal(N.fromPending(multiP({ free_text_max: bad })).freeTextMax, 2000, String(bad));
  assert.equal(N.fromPending(multiP({ multi_select: undefined })).multiSelect, false);
  assert.equal(N.fromPending(multiP({ multi_select: 'true' })).multiSelect, false, 'only a real true');
  assert.equal(N.fromPending(multiP({ kind: 'approval' })), null, 'an approval is never multi-select');
});
test('structured fromPending: a questionnaire has 1..4 items of 2..4 options, empty top-level options, header <= 32', () => {
  const f = N.fromPending(formP());
  assert.equal(f.form.length, 3);
  assert.deepEqual(f.options, []);
  assert.deepEqual(f.form[1], { header: 'Extras', text: '¿Qué extras?', multiSelect: true, allowFreeText: true,
    options: [{ index: 0, key: '1', label: 'ESLint', description: '' }, { index: 1, key: '2', label: 'Tailwind', description: '' }, { index: 2, key: '3', label: 'Vitest', description: '' }] });
  const item = formP().form[0];
  assert.equal(N.fromPending(formP({ form: [] })), null, 'empty form');
  assert.equal(N.fromPending(formP({ form: [item, item, item, item, item] })), null, 'more than 4');
  assert.equal(N.fromPending(formP({ form: [{ ...item, options: [opt(0, 'solo')] }] })), null, 'needs 2..4 options');
  assert.equal(N.fromPending(formP({ form: [{ ...item, header: 'x'.repeat(33) }] })), null, 'header > 32');
  assert.equal(N.fromPending(formP({ form: [{ ...item, text: '' }] })), null, 'empty question text');
  assert.equal(N.fromPending(formP({ options: [opt(0, 'a'), opt(1, 'b')] })), null, 'top-level options must be empty with a form');
  assert.equal(N.fromPending(formP({ kind: 'approval' })), null);
  assert.equal(N.fromPending(formP({ form: 'x' })), null);
  assert.equal(N.fromPending(formP({ form: [{ ...item, options: [opt(0, ''), opt(1, 'b')] }] })), null, 'empty label');
});

const itemMulti = { multiSelect: true, allowFreeText: true, options: [{ index: 0, label: 'a' }, { index: 1, label: 'b' }, { index: 2, label: 'c' }] };
const itemSingle = { multiSelect: false, allowFreeText: true, options: [{ index: 0, label: 'a' }, { index: 1, label: 'b' }] };
const D = (picked = [], text = '', other = false) => ({ picked, text, other });
test('drafts: multi toggles a sorted set; single replaces (and un-picks); «Otra cosa» and single picks exclude each other', () => {
  assert.deepEqual(N.newDraft(), D());
  let d = N.newDraft();
  d = N.toggleOption(itemMulti, d, 2); d = N.toggleOption(itemMulti, d, 0);
  assert.deepEqual(d.picked, [0, 2]);
  d = N.toggleOption(itemMulti, d, 2);
  assert.deepEqual(d.picked, [0]);
  assert.deepEqual(N.toggleOption(itemMulti, N.newDraft(), 9).picked, [], 'an index the question does not have is ignored');
  let s = N.toggleOption(itemSingle, N.newDraft(), 1); s = N.toggleOption(itemSingle, s, 0);
  assert.deepEqual(s.picked, [0], 'single select replaces');
  assert.deepEqual(N.toggleOption(itemSingle, s, 0).picked, [], 'clicking the pick again clears it');
  const typed = N.setDraftText(itemSingle, s, 'otra cosa');
  assert.deepEqual(typed, D([], 'otra cosa', true), 'typing a free answer opens «Otra cosa» and clears the single pick');
  assert.deepEqual(N.toggleOption(itemSingle, typed, 1), D([1]), 'picking an option closes «Otra cosa» and drops the typed answer');
  const keep = N.setDraftText(itemMulti, N.toggleOption(itemMulti, N.newDraft(), 1), 'nota');
  assert.deepEqual(keep, D([1], 'nota', true), 'multi keeps picks AND text');
  assert.deepEqual(N.toggleOption(itemMulti, keep, 0), D([0, 1], 'nota', true), 'toggling an option keeps «Otra cosa» open');
  assert.deepEqual(N.toggleOption(itemMulti, N.newDraft(), 1), D([1]), 'immutable: the old draft is untouched');
});
test('«Otra cosa…»: opening reveals the field, closing (Esc / un-ticking) discards what was typed; single select drops its pick when opened', () => {
  const open = N.toggleOther(itemSingle, D([1]));
  assert.deepEqual(open, D([], '', true), 'single: «Otra cosa» replaces the pick');
  assert.deepEqual(N.toggleOther(itemMulti, D([1], 'x', true)), D([1]), 'closing clears the text but keeps the multi picks');
  assert.deepEqual(N.toggleOther(itemMulti, D([1])), D([1], '', true), 'multi: opening keeps the picks');
  assert.deepEqual(N.toggleOther({ ...itemSingle, allowFreeText: false }, D()), D(), 'a question without free text has no «Otra cosa»');
  assert.deepEqual(N.setDraftText({ ...itemSingle, allowFreeText: false }, D(), 'x'), D(), 'and refuses text');
});
test('optionRows: a vertical numbered list, label with its description, and «N. Otra cosa…» LAST only when free text is allowed', () => {
  const item = { multiSelect: false, allowFreeText: true, options: [{ index: 0, key: '1', label: 'Café', description: 'con leche' }, { index: 1, key: '2', label: 'Té', description: '' }] };
  const v = N.optionRows(item, D([1]));
  assert.deepEqual(v.rows.map(r => [r.kind, r.number, r.label, r.description, r.checked]), [
    ['option', 1, 'Café', 'con leche', false], ['option', 2, 'Té', '', true], ['other', 3, 'Otra cosa…', '', false]]);
  assert.equal(v.showText, false);
  assert.equal(N.optionRows(item, D([], 'hola', true)).showText, true, 'selecting «Otra cosa» reveals the growing textarea');
  assert.equal(N.optionRows(item, D([], 'hola', true)).rows[2].checked, true);
  const none = N.optionRows({ ...item, allowFreeText: false }, D());
  assert.deepEqual(none.rows.map(r => r.kind), ['option', 'option'], 'no «Otra cosa» without free text');
  assert.equal(none.showText, false);
  const multi = N.optionRows({ ...item, multiSelect: true }, D([0]));
  assert.ok(multi.rows.every(r => r.control === 'checkbox'), 'multi-select rows carry a checkbox at the left');
  assert.ok(v.rows.every(r => r.control === 'row'), 'single-select rows are plain rows');
  assert.equal(N.optionRows({ ...item, allowFreeText: false, options: [] }, D()).rows.length, 0);
});
test('textFits: characters (not bytes) up to the granted max, no control characters, blank is not an answer', () => {
  assert.equal(N.textFits('hola', 2000), true);
  assert.equal(N.textFits('🙂'.repeat(2000), 2000), true, '2000 characters even if 8000 bytes');
  assert.equal(N.textFits('a'.repeat(2001), 2000), false);
  assert.equal(N.textFits('a'.repeat(4000), 4000), true);
  assert.equal(N.textFits('a\u0000b', 2000), false);
  assert.equal(N.textFits('línea\nsegunda\tcon tab', 2000), true, 'newline and tab are fine');
  assert.equal(N.textFits('   ', 2000), false);
  assert.equal(N.textFits('', 2000), false);
  assert.equal(N.textFits(5, 2000), false);
});
test('draftAnswered / itemPayload: the exact shapes the closed IPC takes; text counts only while «Otra cosa» is open', () => {
  assert.equal(N.draftAnswered(itemMulti, N.newDraft(), 2000), false);
  assert.deepEqual(N.itemPayload(itemMulti, D([2, 0]), 2000), { indexes: [0, 2] });
  assert.deepEqual(N.itemPayload(itemMulti, D([1], 'nota', true), 2000), { indexes: [1], text: 'nota' });
  assert.deepEqual(N.itemPayload(itemMulti, D([], 'solo texto', true), 2000), { indexes: [], text: 'solo texto' });
  assert.equal(N.itemPayload(itemMulti, D([], 'huérfano', false), 2000), null, 'text while «Otra cosa» is closed is not an answer');
  assert.equal(N.itemPayload(itemMulti, D([], '  ', true), 2000), null);
  assert.deepEqual(N.itemPayload(itemSingle, D([1]), 2000), { index: 1 });
  assert.deepEqual(N.itemPayload(itemSingle, D([], 'otra', true), 2000), { text: 'otra' });
  assert.equal(N.itemPayload({ ...itemSingle, allowFreeText: false }, D([], 'otra', true), 2000), null, 'text where the question does not take text');
  assert.equal(N.itemPayload({ ...itemMulti, allowFreeText: false }, D([1], 'nota', true), 2000), null);
  assert.equal(N.itemPayload(itemMulti, D([1], 'a'.repeat(2001), true), 2000), null, 'over free_text_max');
});
test('multi-select: «Hecho» needs >= 1 option or text; the payload is answer_many {id, indexes, text?}', () => {
  const n = N.fromPending(multiP({ allow_free_text: true }));
  assert.deepEqual(N.multiView(n, N.newDraft()), { label: 'Hecho', canDone: false, reason: 'Marcá al menos una' });
  assert.equal(N.multiView(n, D([1])).canDone, true);
  assert.equal(N.multiView(n, D([0, 2])).label, 'Hecho (2)', 'S7: the primary counts the marked options');
  assert.equal(N.multiView(n, D([1])).reason, '');
  assert.equal(N.multiView(n, D([], 'algo', true)).canDone, true);
  assert.equal(N.multiView(n, D([], '  ', true)).canDone, false);
  assert.deepEqual(N.manyPayload(n, D([2, 1])), { action: 'answer_many', id: n.id, indexes: [1, 2] });
  assert.deepEqual(N.manyPayload(n, D([1], 'nota', true)), { action: 'answer_many', id: n.id, indexes: [1], text: 'nota' });
  assert.equal(N.manyPayload(n, N.newDraft()), null);
  const noText = N.fromPending(multiP());
  assert.equal(N.manyPayload(noText, D([1], 'nota', true)), null, 'a question without free text refuses text');
  assert.equal(N.manyPayload(N.fromPending(formP()), D([0])), null, 'not for a form');
});
test('plain single question: the rows come from the question itself; a row answers at once, «Otra cosa…» only opens the field', () => {
  const n = N.fromPending(pend({ options: [opt(0, 'Café'), opt(1, 'Té')], allow_free_text: true }));
  const v = N.optionRows(N.singleItem(n), D());
  assert.deepEqual(v.rows.map(r => r.label), ['Café', 'Té', 'Otra cosa…']);
  const closed = N.fromPending(pend({ options: [opt(0, 'Café'), opt(1, 'Té')] }));
  assert.deepEqual(N.optionRows(N.singleItem(closed), D()).rows.map(r => r.label), ['Café', 'Té']);
  assert.deepEqual(N.singleItem(n), { header: '', text: n.text, options: n.options, multiSelect: false, allowFreeText: true });
});

test('questionnaire: one question per step, «i de N», Siguiente gated by the current answer, summary, Enviar', () => {
  const n = N.fromPending(formP());
  let st = N.formStart(n);
  let v = N.formView(n, st);
  assert.deepEqual([v.mode, v.step, v.total, v.label, v.header, v.text], ['step', 0, 3, '1 de 3', 'Framework', '¿Cuál framework?']);
  assert.deepEqual([v.canPrev, v.canNext, v.primary], [false, false, { kind: 'next', label: 'Siguiente', enabled: false }]);
  assert.deepEqual(N.formReduce(n, st, { type: 'next' }), st, 'cannot advance an unanswered step');
  st = N.formReduce(n, st, { type: 'toggle', index: 1 });
  v = N.formView(n, st);
  assert.equal(v.primary.enabled, true);
  st = N.formReduce(n, st, { type: 'next' });
  v = N.formView(n, st);
  assert.deepEqual([v.step, v.label, v.header, v.canPrev], [1, '2 de 3', 'Extras', true]);
  st = N.formReduce(n, st, { type: 'toggle', index: 0 }); st = N.formReduce(n, st, { type: 'toggle', index: 2 });
  st = N.formReduce(n, st, { type: 'other' });
  st = N.formReduce(n, st, { type: 'text', text: 'y prettier' });
  // each step keeps its draft: go back and forth
  st = N.formReduce(n, st, { type: 'prev' });
  assert.deepEqual(N.formView(n, st).draft, D([1]), 'step 1 kept its pick');
  st = N.formReduce(n, st, { type: 'next' });
  assert.deepEqual(N.formView(n, st).draft, D([0, 2], 'y prettier', true), 'step 2 kept its draft');
  st = N.formReduce(n, st, { type: 'next' });
  st = N.formReduce(n, st, { type: 'other' });
  st = N.formReduce(n, st, { type: 'text', text: 'mi-app' });
  v = N.formView(n, st);
  assert.deepEqual([v.step, v.primary.label], [2, 'Siguiente'], 'the last question still says Siguiente: the summary comes next');
  st = N.formReduce(n, st, { type: 'next' });
  v = N.formView(n, st);
  assert.deepEqual([v.mode, v.label, v.primary, v.canPrev], ['review', 'Resumen', { kind: 'send', label: 'Enviar', enabled: true }, true]);
  assert.deepEqual(v.summary, [
    { header: 'Framework', text: '¿Cuál framework?', answer: 'Vue' },
    { header: 'Extras', text: '¿Qué extras?', answer: 'ESLint, Vitest · «y prettier»' },
    { header: 'Nombre', text: '¿Cómo se llama?', answer: '«mi-app»' },
  ]);
  assert.deepEqual(N.formPayload(n, st), { action: 'answer_form', id: n.id, answers: [{ index: 1 }, { indexes: [0, 2], text: 'y prettier' }, { text: 'mi-app' }] });
});
test('questionnaire: Esc / back steps back (summary -> last step -> ... -> first, where it does nothing); nothing is sent until Enviar', () => {
  const n = N.fromPending(formP());
  let st = N.formStart(n);
  assert.deepEqual(N.formReduce(n, st, { type: 'back' }), st, 'at the first step Esc leaves the state alone');
  st = N.formReduce(n, st, { type: 'toggle', index: 0 }); st = N.formReduce(n, st, { type: 'next' });
  st = N.formReduce(n, st, { type: 'toggle', index: 1 }); st = N.formReduce(n, st, { type: 'next' });
  st = N.formReduce(n, st, { type: 'toggle', index: 0 }); st = N.formReduce(n, st, { type: 'next' });
  assert.equal(N.formView(n, st).mode, 'review');
  st = N.formReduce(n, st, { type: 'back' });
  assert.deepEqual([N.formView(n, st).mode, N.formView(n, st).step], ['step', 2]);
  st = N.formReduce(n, st, { type: 'back' });
  assert.equal(N.formView(n, st).step, 1);
  assert.equal(N.formReduce(n, st, { type: 'next' }) !== st, true);
  assert.equal(N.formPayload(n, N.formStart(n)), null, 'an unfinished questionnaire has no payload (all-or-nothing)');
  const partial = N.formReduce(n, N.formReduce(n, N.formStart(n), { type: 'toggle', index: 0 }), { type: 'next' });
  assert.equal(N.formPayload(n, partial), null);
});
test('questionnaire: events that do not apply are ignored; the state is immutable; one-item forms work', () => {
  const n = N.fromPending(formP());
  const st = N.formStart(n);
  const frozen = JSON.stringify(st);
  N.formReduce(n, st, { type: 'toggle', index: 0 });
  assert.equal(JSON.stringify(st), frozen);
  assert.deepEqual(N.formReduce(n, st, { type: 'bogus' }), st);
  assert.deepEqual(N.formReduce(n, st, null), st);
  assert.deepEqual(N.formReduce(n, st, { type: 'prev' }), st);
  const one = N.fromPending(formP({ form: [formP().form[0]] }));
  let o = N.formReduce(one, N.formStart(one), { type: 'toggle', index: 0 });
  o = N.formReduce(one, o, { type: 'next' });
  assert.deepEqual(N.formPayload(one, o), { action: 'answer_form', id: one.id, answers: [{ index: 0 }] });
  assert.equal(N.formView(n, { ...st, review: true }).mode, 'review', 'a review state renders as the summary');
});

test('keyboard: digits pick (the LAST digit is «Otra cosa…»), arrows move, Enter goes next/sends, Esc goes back; never while composing, repeating or synthetic', () => {
  const key = (k, extra = {}) => ({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, shiftKey: false, ...extra });
  const ctx = (over = {}) => ({ typing: false, optionCount: 3, hasOther: true, review: false, canPrev: true, otherOpen: false, primary: { kind: 'next', enabled: true }, ...over });
  assert.deepEqual(N.keyIntent(key('2'), ctx()), { type: 'toggle', index: 1 });
  assert.deepEqual(N.keyIntent(key('4'), ctx()), { type: 'other' }, 'the digit after the options is «Otra cosa…»');
  assert.equal(N.keyIntent(key('4'), ctx({ hasOther: false })), null, 'no «Otra cosa…» row: no such digit');
  assert.equal(N.keyIntent(key('5'), ctx()), null, 'beyond the rows');
  assert.equal(N.keyIntent(key('2'), ctx({ typing: true })), null, 'digits are text while typing');
  assert.equal(N.keyIntent(key('2'), ctx({ review: true })), null, 'no options on the summary');
  assert.deepEqual(N.keyIntent(key('ArrowDown'), ctx()), { type: 'move', delta: 1 });
  assert.deepEqual(N.keyIntent(key('ArrowUp'), ctx()), { type: 'move', delta: -1 });
  assert.equal(N.keyIntent(key('ArrowDown'), ctx({ typing: true })), null, 'arrows move the caret while typing');
  assert.deepEqual(N.keyIntent(key('Enter'), ctx()), { type: 'next' });
  assert.deepEqual(N.keyIntent(key('Enter'), ctx({ review: true, primary: { kind: 'send', enabled: true } })), { type: 'send' });
  assert.deepEqual(N.keyIntent(key('Enter'), ctx({ primary: { kind: 'done', enabled: true } })), { type: 'done' });
  assert.equal(N.keyIntent(key('Enter'), ctx({ primary: { kind: 'next', enabled: false } })), null, 'a disabled primary does nothing');
  assert.equal(N.keyIntent(key('Enter', { shiftKey: true }), ctx({ typing: true })), null, 'Shift+Enter is a newline');
  assert.deepEqual(N.keyIntent(key('Enter'), ctx({ typing: true })), { type: 'next' }, 'Enter in the textarea advances');
  assert.deepEqual(N.keyIntent(key('Escape'), ctx({ typing: true, otherOpen: true })), { type: 'other' }, 'Esc in the field closes «Otra cosa…» first');
  assert.deepEqual(N.keyIntent(key('Escape'), ctx()), { type: 'back' });
  assert.equal(N.keyIntent(key('Escape'), ctx({ canPrev: false })), null, 'nothing to go back to');
  assert.equal(N.keyIntent(key('Enter', { isTrusted: false }), ctx()), null);
  assert.equal(N.keyIntent(key('Enter', { isComposing: true }), ctx()), null);
  assert.equal(N.keyIntent(key('Enter', { repeat: true }), ctx()), null);
  assert.equal(N.keyIntent(key('Enter', { ctrlKey: true }), ctx()), null);
  assert.equal(N.keyIntent(key(' '), ctx()), null, 'Space belongs to the focused row/checkbox');
});

test('structured wiring: the closed IPC verbs, the card controls, the textarea max and the toast count', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  for (const id of ['question-step', 'question-step-header', 'question-summary', 'question-nav', 'question-prev', 'question-primary']) assert.match(html, new RegExp(`id="${id}"`), id);
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /N\.manyPayload\(/); assert.match(src, /N\.formPayload\(/);
  assert.match(src, /N\.formReduce\(/); assert.match(src, /N\.keyIntent\(/);
  assert.match(src, /textEl\.maxLength = /);
  assert.match(src, /N\.optionRows\(/); assert.match(src, /role', 'checkbox'|role = 'checkbox'/);
  assert.match(src, /q-other/); assert.match(src, /ArrowDown|'move'/);
  assert.match(src, /N\.replyIsCurrent\(sent, pushSeq\)/, 'the structured sends use the same stale-reply guard');
  assert.doesNotMatch(src, /innerHTML[^\n]*(label|description|header|\.text)/, 'plain text only');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8') + fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  assert.match(css, /#question-nav \{/); assert.match(css, /\.q-box/); assert.match(css, /#question-nav button:focus-visible/);
  assert.match(css, /#question-options \{[^}]*flex-direction: column/, 'the options are a vertical list');
  assert.match(css, /\.q-option \{[^}]*width: 100%/, 'each row is full width');
  assert.doesNotMatch(css, /#question-options \{[^}]*flex-wrap: wrap/, 'no horizontal chips');
  const toast = require(path.join(frontend, 'question-toast.js'));
  const v = toast.toastView({ available: true, pending: formP(), queued_count: 0 }, { now: Date.now() });
  assert.equal(v.title, 'Claude Code pregunta (3 preguntas)');
  assert.equal(toast.toastView({ available: true, pending: multiP(), queued_count: 0 }, { now: Date.now() }).title, 'Claude Code pregunta');
  assert.equal(toast.toastView({ available: true, pending: formP({ form: [formP().form[0]] }), queued_count: 0 }, { now: Date.now() }).title, 'Claude Code pregunta (1 pregunta)');
});

// ---- after a question closes the island returns to its overview height and the window to 340 (human: «más grande de lo que debería») ----
test('sizeSync: every way a question can end gives the height back; a shown question asks for exactly its layout', () => {
  const S = N.sizeSync;
  // open question: the island follows its card, the window follows the island
  assert.deepEqual(S({ question: 'pending', islandH: 252 }), { islandH: 252, windowH: 340 }, 'a card that fits the fixed window keeps it at 340');
  assert.deepEqual(S({ question: 'pending', islandH: 600 }), { islandH: 600, windowH: 608 }, 'a taller card asks the window for island + 8');
  assert.deepEqual(S({ question: 'expired', islandH: 252 }), { islandH: 252, windowH: 340 }, 'an expired card is still on screen');
  // every close path: answered, declined, cancelled, terminal won, expired -> the question flag leaves 'pending'
  for (const question of ['', 'outcome', undefined, null]) {
    assert.deepEqual(S({ question, islandH: 252 }), { islandH: 0, windowH: 340 }, String(question));
  }
  assert.deepEqual(S({ question: 'pending', islandH: 0 }), { islandH: 0, windowH: 340 }, 'no measured layout yet: nothing to grow');
  for (const bad of [NaN, -3, undefined]) assert.deepEqual(S({ question: 'pending', islandH: bad }), { islandH: 0, windowH: 340 }, String(bad));
});
test('shrink contract: islandH 0 always reaches the island (even when no size was ever published) and the window ask is made once per change', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  const fit = src.slice(src.indexOf('function fitCard()'), src.indexOf('function growText()'));
  assert.match(fit, /N\.sizeSync\(/, 'one rule decides both sizes');
  assert.doesNotMatch(fit, /if \(sizedKey\) \{ sizedKey = ''; root\.style\.height/, 'the reset no longer depends on a size having been published before');
  assert.match(fit, /publishSize\(closed\.islandH\)/, 'closing always tells the island, even if no size was ever published');
  assert.match(src, /function publishSize[\s\S]*abito:question-size/);
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  const handler = isl.slice(isl.indexOf("addEventListener('abito:question-size'"), isl.indexOf("addEventListener('abito:question'"));
  assert.match(handler, /questionH = next/);
  assert.match(handler, /h >= QUESTION_H \? h : QUESTION_H/, '0 (closed) falls back to the default overview-question height');
  // the island also drops the question height when the question flag itself goes away
  const onQ = isl.slice(isl.indexOf("addEventListener('abito:question', event"), isl.indexOf("addEventListener('abito:question', event") + 700);
  assert.match(onQ, /if \(!show\) questionH = QUESTION_H/, 'closing the question resets the island height regardless of the size event');
});
test('closing paths: notify.js re-fits on every state change, outcome timer expiry and local expiry', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /outcomeTimer = setTimeout\(\(\) => render\(\)/, 'the outcome timer re-renders (and so re-fits)');
  assert.match(src, /setInterval\(\(\) => render\(\), 5000\)/, 'local expiry re-renders');
  assert.match(src, /fitCard\(\);\n  \}/, 'render ends in fitCard');
});

// ---- L5 (human): a click on the blobs column during «Recibida» dismisses the outcome early and applies the selection ----------------------
test('outcomeDismissible: only a SHOWING outcome (a word on screen, no pending question) can be dismissed by a blob click; nothing else is touched', () => {
  const D = N.outcomeDismissible;
  assert.equal(D({ question: 'outcome' }), true);
  for (const q of ['pending', 'expired', '', undefined, null]) assert.equal(D({ question: q }), false, `a ${String(q)} question is never dismissed by a blob click`);
  assert.equal(D(null), false);
  assert.equal(D({}), false);
});
test('L5 wiring: notify.js dismisses the outcome on the island\'s request, pills-view asks for it and then applies the selection', () => {
  const nv = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(nv, /abito:outcome-dismiss/, 'notify.js listens for the dismissal request');
  assert.match(nv, /outcomeUntil = 0;[\s\S]{0,200}render\(\)/, 'it ends the outcome now (the same state the timer reaches) and repaints');
  const pv = fs.readFileSync(path.join(frontend, 'pills-view.js'), 'utf8');
  assert.match(pv, /N\.outcomeDismissible|AbitoNotify\.outcomeDismissible/, 'pills-view decides with the shared rule');
  assert.match(pv, /abito:outcome-dismiss/);
  assert.match(pv, /const clickable = \(\) =>/, 'the click gate is one function: on screen OR a dismissible outcome');
});

