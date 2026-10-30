'use strict';
/* #266 — deterministic checks for the incoming-event reveal policy (Sileo-style
   animated reveal/expansion of a NEW question or completion notice).
   Pure gates only: no DOM, no IPC, no timers, fixed clocks. The reveal decision
   lives in notify-view.js (createRevealGate + revealAction); the wiring in
   notify.js / island.js is checked structurally at the end, the same way
   notify-view-check.cjs checks the announcement wiring.
   Run: node apps/desktop-tauri/test-node/notification-reveal-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const N = require(path.join(frontend, 'notify-view.js'));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

const NOW = 2_000_000_000_000; // fixed epoch ms: every case passes its own clock
const ID_A = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const ID_B = '7a1d2c3b-4e5f-4a6b-9c8d-1e2f3a4b5c6d';
const ID_C = '9e8d7c6b-5a4f-4d3c-8b2a-1f0e9d8c7b6a';
const qstate = (p, extra = {}) => ({ available: true, pending: p, deliveries: [], ready_connections: 1, notice: null, native_transition: 'idle', ...extra });
const pending = (id, extra = {}) => ({ id, kind: 'question', text: '¿Qué rama uso?', allow_free_text: false, expires_at: NOW + 60000,
  options: [{ index: 0, label: 'main', description: '' }, { index: 1, label: 'develop', description: '' }], ...extra });

// ---- the gate exists and starts from «no baseline yet» --------------------
test('gate: createRevealGate exists and answers with question/notice', () => {
  assert.equal(typeof N.createRevealGate, 'function', 'the reveal gate must live in notify-view.js');
  const g = N.createRevealGate();
  assert.equal(typeof g.question, 'function');
  assert.equal(typeof g.notice, 'function');
});

// ---- question: a NEW live question is an event; boot history is not -------
test('question: a cached pending at boot never reveals; the same id never reveals twice', () => {
  const g = N.createRevealGate();
  // boot replay of a pending that was already there: history, not an event
  assert.equal(g.question(qstate(pending(ID_A)), NOW), false, 'a boot-cached question must not reopen the island');
  assert.equal(g.question(qstate(pending(ID_A), { deliveries: [1, 2] }), NOW), false, 'a duplicate cached snapshot never re-reveals');
  assert.equal(g.question(qstate(pending(ID_A)), NOW), false, 'replays of the same id are the same event');
  // a genuinely new question reveals exactly once
  assert.equal(g.question(qstate(pending(ID_B)), NOW), true, 'a new question reveals');
  assert.equal(g.question(qstate(pending(ID_B), { ready_connections: 2 }), NOW), false, 'unrelated snapshot churn never re-reveals');
});

test('question: idle boot then a first live question reveals', () => {
  const g = N.createRevealGate();
  assert.equal(g.question(qstate(null), NOW), false, 'the first empty snapshot is only the baseline');
  assert.equal(g.question(qstate(null), NOW), false, 'still idle: nothing to fire');
  assert.equal(g.question(qstate(pending(ID_A)), NOW), true, 'the question that ARRIVES is an event');
});

test('question: expiry, malformed and gone-then-back are handled without re-reveals', () => {
  const g = N.createRevealGate();
  g.question(qstate(null), NOW);
  assert.equal(g.question(qstate(pending(ID_A, { expires_at: NOW })), NOW), false, 'an already-expired question never reveals');
  assert.equal(g.question(qstate({ id: 'not-a-uuid', kind: 'question', text: 'x', options: [{ index: 0, label: 'a', description: '' }], expires_at: NOW + 60000 }), NOW), false, 'a malformed question is no event');
  assert.equal(g.question(qstate(pending(ID_B)), NOW), true, 'a valid question after garbage still reveals');
  assert.equal(g.question(qstate(null), NOW), false, 'expiry/cancel (pending gone) reveals nothing');
  assert.equal(g.question(qstate(pending(ID_B)), NOW), true, 'the same id re-issued after it went away is a NEW event');
});

test('question: approval-kind and free-text-only questions are real events too', () => {
  const g = N.createRevealGate();
  g.question(qstate(null), NOW);
  assert.equal(g.question(qstate(pending(ID_A, { kind: 'approval', options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] })), NOW), true);
  g.question(qstate(null), NOW);
  assert.equal(g.question(qstate(pending(ID_B, { options: [], allow_free_text: true })), NOW), true);
});

// ---- notice: a NEW top notice is an event; boot/stale/dismiss are not ------
test('notice: boot history never reveals; dismiss-to-older-notice never re-reveals', () => {
  const g = N.createRevealGate();
  const nA = { id: ID_A, title: 'Pi terminó su turno', detail: 'listo', expiresAt: NOW + 60000 };
  const nB = { id: ID_B, title: 'Pi terminó su turno', detail: 'listo', expiresAt: NOW + 60000 };
  assert.equal(g.notice([nA, nB]), false, 'notices already there at boot are history');
  assert.equal(g.notice([nA, nB]), false, 'the same cached snapshot again is not an event');
  assert.equal(g.notice([nB]), false, 'dismissing the top one exposes an ALREADY SEEN notice: no reveal, no animation');
  const nC = { id: ID_C, title: 'Pi terminó su turno', detail: 'listo', expiresAt: NOW + 60000 };
  assert.equal(g.notice([nC, nB]), true, 'a notice that ARRIVES later reveals once');
  assert.equal(g.notice([nC, nB]), false, 'a duplicate delivery of the same arrival never re-reveals');
  assert.equal(g.notice([]), false, 'the notice expiring on its own reveals nothing');
});

test('notice: the first notice after an empty baseline is an event', () => {
  const g = N.createRevealGate();
  assert.equal(g.notice([]), false);
  assert.equal(g.notice([{ id: ID_C, title: 'Pi terminó su turno', expiresAt: NOW + 60000 }]), true);
});

test('notice: repeated deliveries of the CURRENT top never re-reveal, however long the page runs', () => {
  const g = N.createRevealGate();
  g.notice([]);
  const first = { id: ID_A, title: 'viejo', expiresAt: NOW + 60000 };
  assert.equal(g.notice([first]), true, 'first arrival reveals');
  for (let i = 0; i < 300; i++) assert.equal(g.notice([first]), false, `duplicate snapshot #${i} must never re-open or re-animate`);
  const later = { id: ID_B, title: 'nuevo', expiresAt: NOW + 60000 };
  assert.equal(g.notice([later, first]), true, 'the next real arrival still reveals after a long run');
  assert.equal(g.notice([later, first]), false);
});

test('R23: new questions take over expanded chat and panels, but not compact or hidden', () => {
  assert.equal(N.revealAction({ state: 'expanded', phase: 'expanded', view: 'chat', question: true }), 'leave-chat');
  for (const view of ['overview', 'notices', 'settings']) {
    assert.equal(N.revealAction({ state: 'expanded', phase: 'expanded', view, question: true }), 'show-question');
  }
  assert.equal(N.revealAction({ state: 'compact', phase: 'compact', view: 'chat', question: true }), 'expand');
  assert.equal(N.revealAction({ state: 'hidden', phase: 'expanded', view: 'chat', question: true }), 'expand');
  assert.equal(N.revealAction({ state: 'expanded', phase: 'expanded', view: 'chat' }), 'none', 'notices must not interrupt chat');
});

// ---- revealAction: the visible capsule decides whether an event acts -------
// #266 S2 Path B (parent-authorized): the existing host `expand` verb now
// reveals from Hidden too (desktop.rs matrix + main.rs show-without-focus).
test('action: resting compact AND hidden islands expand; visible/animating ones do not', () => {
  assert.equal(typeof N.revealAction, 'function', 'the reveal action policy must live in notify-view.js');
  assert.equal(N.revealAction({ state: 'compact', phase: 'compact' }), 'expand');
  assert.equal(N.revealAction({ state: 'hidden', phase: 'compact' }), 'expand', 'S2: a new event reveals the hidden island through the same host verb');
  assert.equal(N.revealAction({ state: 'hidden', phase: 'expanded' }), 'expand', 'hidden: the local phase attr may be stale from before the hide; the host owns normalization, never toggle-collapse');
  assert.equal(N.revealAction({ state: 'hidden', phase: 'collapsing' }), 'expand', 'hidden: a stale mid-shrink attr is not a human action on a hidden window');
  assert.equal(N.revealAction({ state: 'expanded', phase: 'expanded' }), 'none', 'already open: the event is on screen');
  assert.equal(N.revealAction({ state: 'compact', phase: 'expanding' }), 'none', 'a collapse/expand already in flight is never double-poked');
  assert.equal(N.revealAction({ state: 'compact', phase: 'expanded' }), 'none');
  assert.equal(N.revealAction({ state: 'compact', phase: 'collapsing' }), 'none', 'a human closing the island is respected mid-shrink');
  assert.equal(N.revealAction({}), 'none', 'fail closed without a visible compact phase');
  assert.equal(N.revealAction(null), 'none');
  assert.equal(N.revealAction({ phase: 'compact' }), 'expand', 'boot before the first host snapshot: the host verb decides, a no-op is harmless');
});

test('HU-006 S4/S5: a notice never grows a visible compact island; hidden still reveals, expanded unchanged', () => {
  assert.equal(N.revealAction({ state: 'compact', phase: 'compact', notice: true }), 'none', 'S4: compact stays compact; the pill shows the notice');
  assert.equal(N.revealAction({ phase: 'compact', notice: true }), 'none', 'S4: also before the first host snapshot');
  assert.equal(N.revealAction({ state: 'hidden', phase: 'compact', notice: true }), 'expand', 'hidden keeps its reveal policy');
  assert.equal(N.revealAction({ state: 'expanded', phase: 'expanded', view: 'chat', notice: true }), 'none', 'S5: expanded behaves as today');
  assert.equal(N.revealAction({ state: 'compact', phase: 'compact', notice: true, question: true }), 'expand', 'a question keeps its own policy');
  assert.equal(N.revealAction({ state: 'compact', phase: 'compact' }), 'expand', 'a non-notice reveal (desktop character) is unchanged');
});

test('gates while hidden: boot/cached/duplicate/expired never restore the hidden island', () => {
  // the gates are state-agnostic by design; the hidden reveal must fire ONLY on
  // new events. These are the same baselines asserted above, run against the
  // hidden boot story the parent must never see reopen.
  const g = N.createRevealGate();
  assert.equal(g.question(qstate(pending(ID_A)), NOW), false, 'boot with a cached pending while hidden: no event, no restore');
  assert.equal(g.question(qstate(pending(ID_A)), NOW), false, 'duplicate hidden snapshot: no restore');
  assert.equal(g.question(qstate(pending(ID_B, { expires_at: NOW - 1 })), NOW), false, 'expired question never restores');
  const gn = N.createRevealGate();
  assert.equal(gn.notice([{ id: ID_A, title: 'viejo', expiresAt: NOW + 60000 }]), false, 'boot-cached notice while hidden: no restore');
  assert.equal(gn.notice([{ id: ID_A, title: 'viejo', expiresAt: NOW + 60000 }]), false, 'duplicate cached notice snapshot: no repeated reopen');
  assert.equal(gn.notice([{ id: ID_C, title: 'nuevo', expiresAt: NOW + 60000 }, { id: ID_A, title: 'viejo', expiresAt: NOW + 60000 }]), true, 'the genuinely new completion notice IS the event');
});

// ---- wiring: the page consumes the gates (structural, like the asker check) --
test('wiring: notify.js passes a reveal flag through abito:question', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /createRevealGate\(\)/, 'notify.js owns one question reveal gate');
  assert.match(src, /reveal\s*[:=]/, 'the abito:question detail carries the reveal event');
  assert.match(src, /gate\.question\(|\.question\(snapshot/, 'the gate sees every applied snapshot');
});

test('wiring: island.js reveals a resting compact island through the host expand only', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(src, /createRevealGate\(\)/, 'island.js owns one notice reveal gate');
  assert.match(src, /revealAction\(/, 'the action decision is the pure policy, not ad-hoc ifs');
  assert.match(src, /desktop\.expand\(\)/, 'reveal goes through the host verb: Rust owns the native geometry and the spring follows');
  // the pre-existing no-focus contract comment must survive, and the reveal
  // path itself must contain no focus call of any kind
  assert.match(src, /no\n?\s*\/\/ set_focus|never takes focus by itself/, 'the file still declares the no-focus-by-itself contract');
  const revealFn = src.match(/function revealIsland\([^)]*\) \{[\s\S]*?\n  \}/);
  assert(revealFn, 'revealIsland must exist');
  assert.doesNotMatch(revealFn[0], /focus\(|set_focus/, 'the reveal path never focuses');
  assert.match(src, /detail\.reveal|reveal\b[^\n]*abito:question|abito:question[\s\S]{0,400}reveal/, 'the question event reaches the reveal path');
});

// ---- S2 #266: visible asker chip (display-only) ---------------------------
test('asker chip: index.html carries #question-asker inside #question-head', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const head = /<div id="question-head"[\s\S]*?<\/div>/.exec(html);
  assert(head, 'question-head must exist');
  assert.match(head[0], /<span id="question-asker" class="chip"/, 'the asker is a chip inside the head row');
});

test('asker chip: notify.js renders the SLUG-DERIVED askedBy via textContent only', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /\$\('question-asker'\)|question-asker/, 'notify.js knows the chip');
  assert.match(src, /asker[^\n]*textContent[^\n]*askedBy|textContent[^\n]*=\s*N\.askedBy/, 'the visible asker is N.askedBy(n), textContent-only');
  assert.doesNotMatch(src, /agent_label/, 'the raw host agent_label is never read by the renderer');
  assert.doesNotMatch(src, /innerHTML[^\n]*(asker|askedBy)/, 'the chip is never written with innerHTML');
  const vm = fs.readFileSync(path.join(frontend, 'notify-view.js'), 'utf8');
  assert.doesNotMatch(vm, /agent_label/, 'the view-model keeps ignoring the raw label (slug whitelist)');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(css, /#question-asker[^{]*\{|#question-expiry[^}]*#question-asker|#question-asker/, 'the chip is styled (flex:none row member)');
});

// WM focus-on-map correction: the reveal-from-Hidden show must reuse the
// EXISTING hotkeyhost give-back pattern (capture before show, deferred
// best-effort hand-back). Structural seam only: dynamic focus behavior is a
// live-WM runtime property this node check cannot observe (see task ledger).
test('main.rs reveal arm captures the keyboard owner BEFORE showing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.rs'), 'utf8');
  const arm = /if was_hidden && next == IslandState::Expanded[\s\S]*?\n                \} else \{/.exec(src);
  assert(arm, 'the hidden-reveal arm must exist in the Expand dispatch');
  const body = arm[0];
  const capture = body.indexOf('hotkey::x11::active_window');
  const firstShow = body.search(/win\.show\(\)|show_on_top\(&win\)/); // L56: show_on_top re-asserts always-on-top
  assert(capture !== -1, 'the arm reads the active window (no new focus architecture)');
  assert(firstShow !== -1 && capture < firstShow, 'the keyboard owner is captured BEFORE the show');
});

test('main.rs reveal arm hands focus back through the existing helpers only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.rs'), 'utf8');
  const arm = /if was_hidden && next == IslandState::Expanded[\s\S]*?\n                \} else \{/.exec(src);
  assert(arm, 'the hidden-reveal arm must exist');
  const body = arm[0];
  assert.match(body, /hotkey::focus_after_show\(focused, false\)/, 'the pure GiveBack rule is reused with deliberate=false');
  assert.match(body, /hotkey::FocusAction::GiveBack/, 'the existing FocusAction enum is reused');
  assert.match(body, /hotkey::x11::give_focus_back\(None, previous\)/, 'the existing best-effort hand-back is reused');
  assert.match(body, /from_millis\(250\)/, 'the same 250ms settle as the hotkeyhost pattern');
  assert.doesNotMatch(body, /set_focus/, 'the reveal never REQUESTS focus (showing ≠ taking the keyboard)');
  assert.match(body, /#\[cfg\(target_os = "linux"\)\]/, 'the X11-only guard is platform-gated as elsewhere');
});

console.log(`notification-reveal-check: ${passed} passed`);
