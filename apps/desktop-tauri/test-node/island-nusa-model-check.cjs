'use strict';
/* HU-057 «isla Nusa»: pure view-model of the expanded notch (tabs, navigation, state veil, agent rows, clock). No DOM.
   Run: node test-node/island-nusa-model-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const N = require(path.join(__dirname, '..', 'frontend', 'island-nusa.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

test('Ver todas: moreAgents shows only when the real total exceeds the Agentes cap (or truncated)', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: `s-${i}` }));
  assert.equal(N.AGENT_ROWS, 3);
  for (const n of [0, 1, 2, 3]) assert.deepEqual(N.moreAgents({ state: 'ready', rows: rows(n), truncated: false, total: n }), { show: false, total: n, label: '' }, `${n} rows: no link`);
  assert.deepEqual(N.moreAgents({ rows: rows(4), truncated: false, total: 4 }), { show: true, total: 4, label: 'Ver todas (4)' });
  assert.deepEqual(N.moreAgents({ rows: rows(4) }), { show: true, total: 4, label: 'Ver todas (4)' }, 'no total -> rows.length');
  assert.deepEqual(N.moreAgents({ rows: rows(3), truncated: true, total: 40 }), { show: true, total: 40, label: 'Ver todas (40)' }, 'truncated: real total');
  assert.deepEqual(N.moreAgents({ rows: rows(3), truncated: true }), { show: true, total: 3, label: 'Ver todas (3)' }, 'truncated without total: rows.length');
  assert.equal(N.moreAgents({ rows: rows(5), total: 2 }).total, 5, 'total below rows.length is ignored');
  for (const bad of [NaN, Infinity, -1, 4.5, '9', null, {}]) assert.equal(N.moreAgents({ rows: rows(5), total: bad }).total, 5, `hostile total ${String(bad)}`);
  for (const v of [null, undefined, 'x', {}, { rows: 'x' }, { rows: [] }]) assert.equal(N.moreAgents(v).show, false);
  assert.equal(N.moreAgents({ rows: rows(2), truncated: 'yes' }).show, false, 'only a literal true counts');
});
test('S3: three tabs in order, and no Chat tab', () => {
  assert.deepEqual(N.TABS.map(t => t.id), ['inicio', 'agentes', 'avisos']);
  assert.deepEqual(N.TABS.map(t => t.title), ['Inicio', 'Agentes', 'Avisos']);
  assert.ok(!N.TABS.some(t => /chat/i.test(t.id + t.title)));
});
test('S2/S3: navigation clamps at both ends and the arrows exist only with a neighbour', () => {
  assert.equal(N.step(0, -1), 0); assert.equal(N.step(0, 1), 1); assert.equal(N.step(2, 1), 2); assert.equal(N.step(1, -1), 0);
  assert.deepEqual(N.arrows(0), { prev: false, next: true });
  assert.deepEqual(N.arrows(1), { prev: true, next: true });
  assert.deepEqual(N.arrows(2), { prev: true, next: false });
  assert.equal(N.step(NaN, 1), 1, 'garbage index starts from Inicio');
});
test('S3: wheel and arrow keys map to a step; other keys and typing do not', () => {
  assert.equal(N.wheelStep({ deltaY: 40, deltaX: 0 }), 1); assert.equal(N.wheelStep({ deltaY: -40, deltaX: 0 }), -1);
  assert.equal(N.wheelStep({ deltaY: 2, deltaX: 3 }), 0, 'tiny wheel noise is ignored');
  assert.equal(N.wheelStep({ deltaY: 0, deltaX: 60 }), 1);
  assert.equal(N.keyStep({ key: 'ArrowRight', isTrusted: true }), 1); assert.equal(N.keyStep({ key: 'ArrowLeft', isTrusted: true }), -1);
  assert.equal(N.keyStep({ key: 'ArrowRight', isTrusted: true }, { typing: true }), 0, 'never while typing in the field');
  assert.equal(N.keyStep({ key: 'ArrowRight', isTrusted: false }), 0);
  assert.equal(N.keyStep({ key: 'a', isTrusted: true }), 0);
  assert.equal(N.keyStep({ key: 'ArrowRight', isTrusted: true, ctrlKey: true }), 0);
});
test('S8: veil by state — amber waits, green finished, red error, blue works, none at rest; the human outranks', () => {
  assert.equal(N.veilState({}), 'idle');
  assert.equal(N.veilState({ working: true }), 'working');
  assert.equal(N.veilState({ working: true, finished: true }), 'finished');
  assert.equal(N.veilState({ working: true, finished: true, waiting: true }), 'waiting');
  assert.equal(N.veilState({ waiting: true, error: true }), 'error', 'a real failure outranks waiting');
  assert.deepEqual(['working', 'waiting', 'finished', 'error'].map(s => N.VEIL[s]), ['--veil-working', '--veil-waiting', '--veil-finished', '--veil-error']);
});
test('S5: agent rows carry name, state, colour and the live current action; no avatar field', () => {
  const rows = [
    { id: 's-00000001', kindLabel: 'Claude Code', cwd: 'api', state: 'running', color: 'orange', tools: { total: 9, steps: [{ index: 8, name: 'Read', state: 'done' }, { index: 9, name: 'Edit src/a.rs', state: 'running' }] } },
    { id: 's-00000002', kindLabel: 'Codex', cwd: 'sb-second-brain', state: 'sleeping', color: 'purple' },
  ];
  const v = N.agentRows(rows, { attributedId: null });
  assert.equal(v.length, 2);
  assert.deepEqual([v[0].name, v[0].state, v[0].color, v[0].live], ['api', 'working', 'orange', 'Edit src/a.rs']);
  assert.deepEqual(v[0].ticker, ['Read', 'Edit src/a.rs'], 'recent actions rise, the last one is the current');
  assert.deepEqual([v[1].name, v[1].state, v[1].live], ['Koda', 'idle', ''], 'the Koda folder keeps its display name; idle has no live line'); // Koda 0.1 T2
  for (const r of v) assert.ok(!('avatar' in r) && !('pose' in r) && !('mini' in r));
  assert.equal(N.agentRows(rows, { attributedId: 's-00000002' })[1].state, 'waiting');
  assert.deepEqual(N.agentRows(null), []);
});
test('S5: a ticker keeps at most three actions and bounds long text', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, name: 'x'.repeat(80), state: i === 5 ? 'running' : 'done' }));
  const [r] = N.agentRows([{ id: 's-00000003', kindLabel: 'Pi', cwd: 'w', state: 'running', tools: { total: 6, steps } }]);
  assert.equal(r.ticker.length, 3); assert.ok(Array.from(r.ticker[2]).length <= 48);
});
test('S2: clock text is a short Spanish date and a 24h time', () => {
  const c = N.clockText(new Date(2026, 9, 28, 16, 5));
  assert.deepEqual(c, { date: 'mié 28 oct', time: '16:05' });
  assert.deepEqual(N.clockText(new Date(NaN)), { date: '', time: '' });
});
test('S6: notices list is one line each with a bounded text; mark-all is offered only when there are notices', () => {
  const v = N.noticeLines([{ id: 'a', title: 'Pi terminó su turno', detail: 'x', severity: 'info', at: 0 }, { id: 'b', title: 'Atajo limitado (sin permiso)', severity: 'warning' }], 60000);
  assert.equal(v.lines.length, 2); assert.equal(v.markAll, true);
  assert.equal(v.lines[0].text, 'Pi terminó'); assert.equal(v.lines[1].tone, 'sun');
  assert.deepEqual(N.noticeLines([], 0), { lines: [], markAll: false });
});
test('S9: size setting S/M/L/Auto scales the notch, bigger on wide monitors, never beyond the work area', () => {
  assert.deepEqual(N.SIZES.map(s => s.id), ['s', 'm', 'l', 'auto']);
  assert.equal(N.sizeScale('m', 1920, 1920), 1); assert.equal(N.sizeScale('s', 1920, 1920), 0.85); assert.equal(N.sizeScale('l', 2560, 2560), 1.25);
  assert.equal(N.sizeScale('auto', 1366, 1366), 1); assert.equal(N.sizeScale('auto', 2560, 2560), 1.25); assert.equal(N.sizeScale('auto', 1920, 1920), 1.1);
  assert.equal(N.sizeScale('l', 800, 800), 800 / 752, 'bounded by the work area');
  assert.ok(N.sizeScale('l', 800, 800) < 1.25);
  assert.equal(N.sizeScale('zzz', 1920, 1920), 1, 'unknown setting falls back to M'); assert.equal(N.sizeScale('m', 0, 0), 1);
});
test('S12: the compact pill fits its content: width = padding + text + Koda, bounded', () => {
  // HU-057 (human, 28-oct): with nothing to show the pill shrinks to a small capsule the size of compact Koda, no text
  assert.equal(N.compactWidth(0), N.COMPACT.kodaOnly);
  assert.equal(N.COMPACT.kodaOnly, 8 + 24 + 8);
  assert.ok(N.COMPACT.kodaOnly < N.COMPACT.min + 1);
  assert.equal(N.compactWidth(1), N.COMPACT.min, 'any text keeps the readable minimum');
  assert.equal(N.compactWidth(100), 8 + 24 + 16 + 100 + 10, 'padLeft + Koda + gap (dot) + text + padRight');
  assert.ok(N.COMPACT.gap >= 8, 'Koda and the text keep at least 8px apart');
  assert.ok(N.COMPACT.max <= 440, 'bounded by the narrowest reported wide box');
  assert.equal(N.compactWidth(9999), N.COMPACT.max);
  assert.equal(N.COMPACT.h, 32); assert.equal(N.COMPACT.radius, 16);
});

const ROWS = [
  { id: 's-0000000a', kindLabel: 'Pi', cwd: 'sb-second-brain', state: 'running', tools: { total: 2, steps: [{ index: 1, name: 'Read a.rs', state: 'done' }, { index: 2, name: 'Edit b.rs', state: 'running' }] } },
  { id: 's-0000000b', kindLabel: 'Claude Code', cwd: 'api', state: 'sleeping' },
  { id: 's-0000000c', kindLabel: 'Codex', cwd: 'web', state: 'sleeping' },
];
test('S13: agent colours — Pi #2dffac, Claude #b04dff, Codex #f472b6; unknown falls back to a hex, never a name', () => {
  assert.equal(N.agentHex('Pi'), '#2dffac'); assert.equal(N.agentHex('Claude Code'), '#b04dff'); assert.equal(N.agentHex('Codex'), '#f472b6');
  assert.match(N.agentHex('Otro'), /^#[0-9a-f]{6}$/i);
  assert.equal(N.agentHex('Pi', '#112233'), '#112233', 'a human-chosen hex wins');
  assert.ok(N.agentRows(ROWS).every(r => /^#[0-9a-f]{6}$/i.test(r.hex)));
});
test('S13: veilColor — waiting stays sun, error red-11, the rest take the focused agent colour', () => {
  assert.equal(N.veilColor('waiting', '#b04dff'), 'var(--sun)'); assert.equal(N.veilColor('error', '#b04dff'), 'var(--red-11)');
  for (const s of ['working', 'idle', 'finished']) assert.equal(N.veilColor(s, '#b04dff'), '#b04dff', s);
  assert.equal(N.veilColor('working', null), 'var(--island-live)'); assert.equal(N.veilColor('finished', null), 'var(--go)');
  assert.equal(N.veilColor('working', 'red;x'), 'var(--island-live)', 'only a hex is ever painted');
});
test('S13/S4: focusView follows focusId, then a working row; the texts name the FOCUSED agent', () => {
  const a = N.focusView(ROWS, 's-0000000b', {});
  assert.deepEqual([a.agent, a.name, a.state, a.chip, a.color], ['Claude Code', 'api', 'idle', 'En reposo', '#b04dff']);
  assert.ok(a.line.startsWith('Claude Code'), a.line);
  const b = N.focusView(ROWS, null, {});
  assert.deepEqual([b.agent, b.state, b.chip, b.live], ['Pi', 'working', 'Trabaja', 'Edit b.rs']);
  assert.ok(b.line.includes('Pi') && b.line.includes('Koda') && !b.line.includes('Claude'));
  assert.equal(N.focusView(ROWS, 's-0000000c', { waiting: true }).chip, 'Te espera');
  assert.equal(N.focusView(ROWS, 's-0000000c', { finished: true }).chip, 'Terminó');
  assert.equal(N.focusView(ROWS, 's-0000000c', { finished: true }).veil, 'finished');
  assert.equal(N.focusView([], null, {}), null); assert.equal(N.focusView(null, null, {}), null);
});
test('S4: replyLine takes the last assistant reply, one ellipsised line; nothing when there is none', () => {
  assert.equal(N.replyLine({ turns: [{ reply: 'uno' }, { reply: 'dos\n\ny   tres' }] }, 20), 'dos y tres');
  assert.equal(N.replyLine({ turns: [{ reply: 'x'.repeat(200) }] }, 10), 'xxxxxxxxx…');
  assert.equal(N.replyLine({ turns: [{ reply: '' }] }), ''); assert.equal(N.replyLine(null), '');
  assert.equal(N.replyLine({ turns: [{ reply: 'a' }, { reply: '' }] }), 'a', 'skips a turn still without reply');
});
test('S4: sendCheck mirrors the chat draft rules (empty, 8000 scalars, control chars) and requestId is req-<24 hex>', () => {
  assert.equal(N.sendCheck('hola'), null); assert.ok(N.sendCheck('   ')); assert.ok(N.sendCheck(''));
  assert.equal(N.sendCheck('a'.repeat(8000)), null); assert.ok(N.sendCheck('a'.repeat(8001)));
  assert.equal(N.sendCheck('😀'.repeat(8000)), null, 'counted in scalars, not UTF-16 units');
  assert.ok(N.sendCheck('a\u0007b'));
  assert.match(N.requestId(new Uint8Array(12).fill(171)), /^req-(ab){12}$/);
});
test('S6: noticeLines keeps id/kind for the open action and ages from time or at', () => {
  const v = N.noticeLines([{ id: 'a', kind: 'finished', title: 'Pi terminó su turno', at: 0 }], 120000);
  assert.deepEqual([v.lines[0].id, v.lines[0].kind, v.lines[0].age], ['a', 'finished', 'hace 2 min']);
});
test('HU-063 T4: noticeAgentColor — finished takes the notice agent hex; waiting/error keep their role colour; unknown agent -> default', () => {
  assert.equal(N.noticeAgentColor({ agent: 'pi' }, 'finished'), '#2dffac');
  assert.equal(N.noticeAgentColor({ agent: 'claude-code' }, 'finished'), '#b04dff');
  assert.equal(N.noticeAgentColor({ agent: 'codex' }, 'finished'), '#f472b6');
  assert.equal(N.noticeAgentColor({ agent: 'Claude Code' }, 'finished'), '#b04dff', 'label form too');
  assert.equal(N.noticeAgentColor({ agent: 'otro' }, 'finished'), 'var(--go)');
  assert.equal(N.noticeAgentColor(null, 'finished'), 'var(--go)');
  assert.equal(N.noticeAgentColor({}, 'finished'), 'var(--go)');
  assert.equal(N.noticeAgentColor({ agent: 'pi' }, 'waiting'), 'var(--sun)');
  assert.equal(N.noticeAgentColor({ agent: 'codex' }, 'error'), 'var(--red-11)');
  assert.equal(N.noticeAgentColor({ agent: '__proto__' }, 'finished'), 'var(--go)');
});
console.log(`island-nusa-model-check: ${passed} passed`);

// ---- RDD corrections (HU-057, review-c4e601a12aa78a6a) ----
(async () => {
  const calls = [];
  const dismiss = id => { calls.push(id); return id === 'b' ? Promise.reject(new Error('refused')) : Promise.resolve({ notices: [] }); };
  const r = await N.dismissAll(dismiss, ['a', 'b', 'c']);
  assert.deepEqual(calls, ['a', 'b', 'c'], 'one failing dismiss never stops the rest');
  assert.deepEqual([r.done, r.failed], [2, 1]);
  assert.equal(N.dismissFeedback(r), '1 aviso no se pudo marcar como leído.');
  assert.equal(N.dismissFeedback({ done: 3, failed: 0 }), '');
  assert.equal(N.dismissFeedback({ done: 0, failed: 2 }), '2 avisos no se pudieron marcar como leídos.');
  assert.deepEqual(await N.dismissAll(null, ['a']), { done: 0, failed: 1, snapshot: null }, 'no facade: honest failure');
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'island-nusa-bodies.js'), 'utf8');
  assert.match(src, /home\.input\.addEventListener\('input', \(\) => \{[^}]*pendingId = null/, 'editing the text drops the retry id');
  assert.doesNotMatch(src, /abito:sessions-view[\s\S]{0,400}paintNotices\(/, 'session events never repaint Avisos');
  console.log('island-nusa-model-check (RDD): ok');
})().catch(e => { console.error(e); process.exit(1); });
