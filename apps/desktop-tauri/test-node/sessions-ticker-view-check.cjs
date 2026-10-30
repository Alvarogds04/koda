'use strict';
/* #360 — pure checks for frontend/sessions-ticker.js (the live agent sessions
   ticker: pure view-model + browser-only mount; Node exercises the pure API). No DOM, no network, no IPC. The view is a CLOSED projection
   of the daemon's `sessions` frame: kind/state labels and plain text rows in
   Spanish (rioplatense voseo), ready to render with textContent only.
   Run: node apps/desktop-tauri/test-node/sessions-ticker-view-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require(path.join(__dirname, '..', 'frontend', 'sessions-ticker.js'));

let passed = 0; const async = [];
function test(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') async.push(r.then(() => { passed += 1; })); else passed += 1; }
  catch (e) { console.error(`FAIL ${name}`); throw e; }
}

const row = (over = {}) => ({ id: 's-0123abcd', kind: 'pi', cwd: 'mi-proyecto', state: 'sleeping', origin: 'herdr', ...over });
const frame = (over = {}) => ({ type: 'sessions', schema: 'abito-sessions/view/1', sessions: [row()], truncated: false, ...over });

// ---- model -------------------------------------------------------------------
test('the frame maps to a ready view with closed labels', () => {
  const v = T.sessionsView(frame());
  assert.equal(v.state, 'ready');
  assert.equal(v.truncated, false);
  assert.deepEqual(v.rows, [{ id: 's-0123abcd', kindLabel: 'Pi', cwd: 'mi-proyecto', stateLabel: 'inactiva', state: 'sleeping', origin: 'herdr', text: 'Pi · mi-proyecto · inactiva · en herdr' }]);
});

test('the closed vocabularies: kinds and states label in Spanish; unknown rows never render', () => {
  const kinds = frame({ sessions: [
    row({ kind: 'pi' }), row({ kind: 'claude-code' }), row({ kind: 'codex' }), row({ kind: 'opencode' }), row({ kind: 'gemini' }),
  ] });
  assert.deepEqual(T.sessionsView(kinds).rows.map(r => r.kindLabel), ['Pi', 'Claude Code', 'Codex', 'OpenCode', 'Gemini']);
  // an off-table kind is dropped, never invented a label for
  assert.equal(T.sessionsView(frame({ sessions: [row({ kind: 'bash' })] })).rows.length, 0);
  const states = frame({ sessions: [
    row({ state: 'running' }), row({ state: 'sleeping' }), row({ state: 'stopped' }), row({ state: 'zombie' }), row({ state: 'unknown' }),
  ] });
  assert.deepEqual(T.sessionsView(states).rows.map(r => r.stateLabel), ['ejecutando', 'inactiva', 'detenida', 'zombi', 'desconocida']);
});

test('a malformed frame is refused; malformed rows are dropped, never half-rendered', () => {
  assert.equal(T.sessionsView(null), null);
  assert.equal(T.sessionsView({ type: 'error', code: 'failed' }), null);
  assert.equal(T.sessionsView({ type: 'sessions', schema: 'other', sessions: [], truncated: false }), null, 'a foreign schema is not ours');
  assert.equal(T.sessionsView(frame({ sessions: 'x' })), null);
  assert.equal(T.sessionsView(frame({ truncated: 'yes' })), null);
  // one bad row never hides the good ones: vocabulary rows are dropped per row,
  // and a text cell that arrives dirty is sanitized to the honest «—»
  const mixed = T.sessionsView(frame({ sessions: [row({ id: 7 }), row(), row({ state: 'dancing' }), row({ cwd: '/full/path' })] }));
  assert.equal(mixed.rows.length, 2, 'the two rows with a known id/kind/state survive');
  assert.deepEqual(mixed.rows.map(r => r.text), ['Pi · mi-proyecto · inactiva · en herdr', 'Pi · — · inactiva · en herdr']);
  // a frame with only bad rows is a valid, EMPTY view: render() then hides it
  assert.equal(T.sessionsView(frame({ sessions: [row({ id: 'nope' })] })).rows.length, 0);
});

test('row text: segments join with ·; unknown cwd shows —; a null origin omits the segment', () => {
  assert.equal(T.sessionsView(frame({ sessions: [row({ cwd: null })] })).rows[0].text, 'Pi · — · inactiva · en herdr');
  assert.equal(T.sessionsView(frame({ sessions: [row({ origin: null })] })).rows[0].text, 'Pi · mi-proyecto · inactiva');
  assert.equal(T.sessionsView(frame({ sessions: [row({ cwd: null, origin: null })] })).rows[0].text, 'Pi · — · inactiva');
});

test('caps: at most 64 rows render; truncation carries the bounded-list copy', () => {
  const many = frame({ sessions: Array.from({ length: 70 }, (_, i) => row({ id: `s-${String(i).padStart(8, '0')}` })), truncated: true });
  const v = T.sessionsView(many);
  assert.equal(v.rows.length, 64);
  assert.equal(v.truncated, true);
  assert.match(T.boundedText(v), /más/i);
  assert.equal(T.boundedText(T.sessionsView(frame())), null);
});

test('error copy: one honest Spanish line for an unavailable view', () => {
  assert.match(T.errorText(), /no disponibles/);
});

test('render is DOM-guarded: no rows clears and hides; rows are textContent-only', () => {
  if (typeof document === 'undefined') return; // pure Node run: the DOM path runs under cargo test / browser
  const host = document.createElement('div');
  T.render(host, T.sessionsView(frame()));
  assert.equal(host.children.length, 1);
  assert.equal(host.firstChild.textContent, 'Pi · mi-proyecto · inactiva · en herdr');
  assert.equal(host.style.display, '', 'visible with rows');
  T.render(host, { state: 'ready', rows: [], truncated: false });
  assert.equal(host.children.length, 0);
  assert.equal(host.style.display, 'none', 'zero layout space without sessions');
});

// ---- the feed of Coucou's Ticker (S10) ------------------------------------------
test('feed: process discovery and idle state changes never impersonate tool steps', () => {
  const m = T.newMemory();
  const v1 = T.sessionsView(frame());
  let r = T.feed(m, v1);
  assert.equal(r.active, true, 'the who-row (session name) is still shown');
  assert.equal(r.ticker, false, 'no tool steps: NO ticker row and NO placeholder text (human: «si no es nada quitalo»)');
  assert.equal(r.task, null);
  assert.deepEqual(r.who, { name: 'mi-proyecto', tool: 'Pi', count: '' }, 'no invented n/m without tool events');
  r = T.feed(m, v1);
  assert.deepEqual([r.ticker, r.task], [false, null], 'unchanged list: still nothing to draw');
  const v2 = T.sessionsView(frame({ sessions: [row(), row({ id: 's-0123abce', kind: 'codex', cwd: 'otro', state: 'running', origin: null })] }));
  r = T.feed(m, v2);
  assert.deepEqual([r.ticker, r.task], [false, null]);
  r = T.feed(m, T.sessionsView(frame({ sessions: [row({ state: 'running' })] })));
  assert.deepEqual([r.ticker, r.task], [false, null], 'a running process without tool events is not a tool step');
  assert.ok(!JSON.stringify(r).includes('Sin pasos'), 'the placeholder text is gone');
});

test('feed: no sessions hides the ticker and forgets the history; an error is shown once; bounded lists say so once', () => {
  const m = T.newMemory();
  T.feed(m, T.sessionsView(frame()));
  const none = T.feed(m, T.sessionsView(frame({ sessions: [] })));
  assert.deepEqual([none.active, none.task], [false, null]);
  assert.deepEqual([m.log.length, m.seq], [0, 0]);
  const e1 = T.feed(m, { state: 'error' }), e2 = T.feed(m, { state: 'error' });
  assert.equal(e1.active, true);
  assert.deepEqual(e2.task.steps, ['Sesiones no disponibles'], 'one line, not one per poll');
  const b = T.newMemory();
  T.feed(b, T.sessionsView(frame({ truncated: true })));
  const again = T.feed(b, T.sessionsView(frame({ truncated: true })));
  assert.equal(again.task.steps.filter(x => x === T.boundedText({ state: 'ready', truncated: true })).length, 1);
});

test('feed: recovery changes the ticker index so the unavailable line cannot stick', () => {
  const m = T.newMemory();
  const unavailable = T.feed(m, { state: 'error' });
  assert.deepEqual([unavailable.ticker, unavailable.task.steps], [true, ['Sesiones no disponibles']], 'a real failure keeps its line');
  const recovered = T.feed(m, T.sessionsView(frame()));
  assert.deepEqual([recovered.ticker, recovered.task], [false, null], 'recovered: the line goes away, nothing replaces it');
  const unavailableAgain = T.feed(m, { state: 'error' });
  assert.ok(unavailableAgain.task.stepSeq > unavailable.task.stepSeq, 'the second failure advances the ticker index so it shows again');
  assert.equal(unavailableAgain.who, null);
});

test('feed: repeated process metadata updates do not accumulate history', () => {
  const m = T.newMemory();
  let r;
  for (let i = 0; i < 25; i++) r = T.feed(m, T.sessionsView(frame({ sessions: [row({ cwd: `p${i}` })] })));
  assert.deepEqual([r.ticker, r.task, m.log.length], [false, null, 0], 'no history accumulates, and nothing is drawn');
  assert.equal(r.who.name, 'p24');
  assert.equal(r.who.count, '');
});

test('wiring: the mount feeds Coucou\'s Ticker through a dynamic import of the vendored module', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'frontend', 'sessions-ticker.js'), 'utf8');
  assert.match(src, /import\('\.\/vendor\/coucou\/views\/ticker\.js'\)/);
  assert.doesNotMatch(src, /position:fixed/);
});

test('poll opens the lazy connection and treats an unanswered scan as pending, not unavailable', async () => {
  const calls = [];
  let sessions = null;
  const invoke = async (command, { payload }) => {
    assert.equal(command, 'agent_action');
    calls.push(payload.action);
    if (payload.action === 'sessions_list') assert.equal(calls.at(-2), 'view');
    return { connection: 'connected', sessions };
  };
  const pending = await T.requestSessions(invoke);
  assert.equal(pending.state, 'pending');
  assert.equal(T.feed(T.newMemory(), pending).active, false);
  sessions = { rows: [row()], truncated: false };
  assert.equal((await T.requestSessions(invoke)).rows[0].cwd, 'mi-proyecto');
  sessions = { rows: [], truncated: false };
  assert.equal(T.feed(T.newMemory(), await T.requestSessions(invoke)).active, false);
  assert.deepEqual(await T.requestSessions(async () => ({ connection: 'disconnected', sessions: null })), { state: 'error' });
});

// ---- tiny harness result (functions defined above) -----------------------------
test('real tool history drives n/m; missing and malformed streams remain honest', () => {
  const tools = { total: 2, steps: [{ index: 1, name: 'read', state: 'done' }, { index: 2, name: 'bash', state: 'running' }] };
  const v = T.sessionsView(frame({ sessions: [row(), row({ id: 's-abcdef01', tools })] }));
  const m = T.newMemory();
  const r = T.feed(m, v);
  assert.deepEqual(r.task.steps, ['read', 'bash']);
  assert.equal(r.task.stepSeq, 1);
  assert.equal(r.who.count, '2/2');
  const external = T.focus(m, v, 's-0123abcd');
  assert.equal(external.who.count, '');
  assert.deepEqual([external.ticker, external.task], [false, null]);
  assert.equal(T.focus(m, v, 'not-a-session'), null);
  const malformed = T.sessionsView(frame({ sessions: [row({ tools: { total: 2, steps: [] } })] }));
  const bad = T.feed(T.newMemory(), malformed);
  assert.deepEqual([bad.ticker, bad.task], [false, null], 'malformed tool data is dropped, never shown as steps');
});

test('feed: a real notice (error, bounded list) is STILL (finalLine set -> no shimmer); a live tool stream keeps shimmering', () => {
  const m = T.newMemory();
  assert.equal(T.feed(m, { state: 'error' }).task.finalLine, 'Sesiones no disponibles');
  const b = T.newMemory();
  const bounded = T.feed(b, T.sessionsView(frame({ truncated: true })));
  assert.deepEqual([bounded.ticker, bounded.task.steps], [true, ['Hay más sesiones']], 'the bounded notice is real information');
  assert.equal(bounded.task.finalLine, bounded.task.steps.at(-1));
});

test('every ticker notice fits the 322px card in full (<= 26 chars at 13px/500 over ~190px) and is a plain Spanish sentence', () => {
  const texts = [T.errorText(), T.boundedText({ state: 'ready', truncated: true })];
  for (const t of texts) assert.ok(t.length <= 26, `${t} (${t.length})`);
  assert.equal(T.boundedText({ state: 'ready', truncated: true }), 'Hay más sesiones');
  assert.equal(T.errorText(), 'Sesiones no disponibles');
});

test('the mounted ticker hides its row when there is nothing to draw, and the card detail has no placeholder either', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'sessions-ticker.js'), 'utf8');
  const pills = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pills-view.js'), 'utf8');
  assert.match(src, /ticker\.el\.title = /);
  assert.match(src, /ticker\.el\.hidden = !\(active && showTicker\)/, 'the row is hidden unless the feed has something to draw');
  assert.match(src, /if \(!showTicker\) ticker\.sync\(null\)/, 'and its content is cleared, never a stale step');
  assert.doesNotMatch(src + pills, /Sin pasos de herramientas|Pasos de herramientas no disponibles/, 'no placeholder anywhere');
  assert.match(pills, /detail\.textContent = 'Sesión enfocada\. El destino del chat no cambió\.'/, 'one honest line for a focused session, with or without tools');
});

// ---- «Ver todas» (part 1 of the human's two-part decision) --------------------------
const two = () => T.sessionsView(frame({ sessions: [row(), row({ id: 's-0123abce', kind: 'claude-code', cwd: 'otro', state: 'running', origin: null })] }));
test('moreView: «Ver todas» (no number: the frame has no total) only when there is more than the card shows', () => {
  assert.deepEqual(T.moreView(two()), { label: 'Todas', aria: 'Ver todas las sesiones' });
  assert.deepEqual(T.moreView(T.sessionsView(frame({ truncated: true }))), { label: 'Todas', aria: 'Ver todas las sesiones' });
  assert.equal(T.moreView(T.sessionsView(frame())), null, 'one session: nothing more to see');
  assert.equal(T.moreView(T.sessionsView(frame({ sessions: [] }))), null);
  assert.equal(T.moreView({ state: 'error' }), null);
  assert.equal(T.moreView(null), null);
  assert.doesNotMatch(T.moreView(two()).label, /\d/);
});

test('listView: one row per received session (agent, cwd, state), the focused one marked, truncation said plainly, no invented count', () => {
  const v = T.listView(two(), null, 's-0123abcd');
  assert.equal(v.title, 'Sesiones');
  assert.equal(v.rows.length, 2);
  const [a, b] = v.rows;
  assert.deepEqual([a.id, a.agent, a.cwd, a.state, a.focused], ['s-0123abcd', 'Pi', 'mi-proyecto', 'inactiva', true]);
  assert.deepEqual([b.agent, b.cwd, b.state, b.focused], ['Claude Code', 'otro', 'ejecutando', false]);
  assert.match(a.aria, /Enfocar mi-proyecto: Pi, inactiva/);
  assert.equal(v.note, null);
  assert.equal(T.listView(T.sessionsView(frame({ truncated: true })), null, null).note, 'La lista está acotada: puede haber más sesiones.');
  assert.equal(T.listView({ state: 'error' }, null, null), null);
  assert.equal(T.listView(T.sessionsView(frame({ sessions: [] })), null, null), null);
});

test('listView: the single pending question is shown ONCE at the top by agent class, never pinned to a guessed row', () => {
  const pending = { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'question', text: 'x', agent: 'claude-code', agent_label: 'Claude Code' };
  const v = T.listView(two(), pending, null);
  assert.deepEqual(v.pending, { text: 'Pregunta pendiente de Claude Code' });
  assert.ok(v.rows.every(r => !('question' in r) && !/pregunta/i.test(r.aria)), 'no per-row badge');
  assert.equal(T.listView(two(), null, null).pending, null);
  assert.equal(T.listView(two(), { id: 'nope' }, null).pending, null, 'malformed pending is ignored');
  assert.equal(T.listView(two(), { ...pending, agent: '../x', agent_label: 'evil\u0000' }, null).pending.text, 'Pregunta pendiente de Pi', 'unsafe asker falls back to the safe default');
});

test('the Ver todas overlay is wired: link in the who-row, dialog with Volver, Esc/arrows handled, Enfocar through selectSession, no jump handler change', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'sessions-ticker.js'), 'utf8');
  assert.match(src, /V\.moreView\(view\)/);
  assert.match(src, /V\.listView\(lastView, pendingQuestion, memory\.focus\?\.id/);
  assert.match(src, /role', 'dialog'/);
  assert.match(src, /event\.key === 'Escape'/);
  assert.match(src, /ArrowDown/);
  assert.match(src, /selectSession\(/);
  assert.match(src, /listen\('question:state'/);
  assert.match(src, /event\.isTrusted === true/);
});

Promise.all(async).then(() => { console.log(`sessions-ticker-view-check: ${passed} checks ok`); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
