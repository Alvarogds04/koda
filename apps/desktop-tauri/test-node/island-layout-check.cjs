'use strict';
/* Expanded island layout «A + E» (human decision 21/10, validacion/ESQUEMA-isla-A-E.md): pure view-model. No DOM.
   A = three columns (status | centre | blobs); E = focus mode while something waits for the human.
   Run: node test-node/island-layout-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const L = require(path.join(frontend, 'island-layout.js'));
const T = require(path.join(frontend, 'sessions-ticker.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

const sess = (over = {}) => ({ id: 's-0123abcd', kindLabel: 'Pi', cwd: 'workspace', state: 'sleeping', stateLabel: 'inactiva', origin: null, ...over });
const frame = (rows, over = {}) => ({ type: 'sessions', schema: 'abito-sessions/view/1', sessions: rows, truncated: false, ...over });
const view = (rows, over) => T.sessionsView(frame(rows, over));
const raw = (over = {}) => ({ id: 's-0123abcd', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null, ...over });

// ---- the sessions view now carries what the columns count -----------------------------------------------------------------------
test('the sessions view keeps each row\'s raw state and the real total when the frame is truncated', () => {
  const v = view([raw(), raw({ id: 's-0123abce', state: 'running' })]);
  assert.deepEqual(v.rows.map(r => r.state), ['sleeping', 'running']);
  assert.equal(v.total, 2, 'not truncated: total = rows');
  const t = view([raw()], { truncated: true, total: 40 });
  assert.equal(t.total, 40);
  assert.equal(view([raw()], { truncated: true, total: 0 }).total, 1, 'a total below the rows received is nonsense: rows');
  assert.equal(view([raw()], { truncated: true, total: 99999 }).total, 1, 'above the daemon cap: rows');
  assert.equal(view([raw()], { truncated: true }).total, 1, 'truncated without a total: rows (and the label says «+»)');
});

// ---- widths ---------------------------------------------------------------------------------------------------------------------
test('columnWidths: status 108 | centre >= 330 | gap 8 | blobs, summing to the overview width; focus shrinks blobs to a mascot column', () => {
  const n = L.columnWidths(700, false);
  assert.deepEqual(n, { fits: true, focus: false, status: 108, centre: 410, gap: 8, blobs: 174, main: 518 });
  assert.equal(n.status + n.centre + n.gap + n.blobs, 700);
  const f = L.columnWidths(700, true);
  assert.deepEqual(f, { fits: true, focus: true, status: 108, centre: 520, gap: 8, blobs: 64, main: 628 });
  assert.equal(f.main + f.gap + f.blobs, 700, 'the focus card takes left + centre and leaves only the mascot column');
  assert.ok(f.centre >= n.centre, 'focus gives the content MORE room');
});
test('columnWidths: the minimums are honest; a width that cannot fit says so instead of squeezing the centre', () => {
  assert.equal(L.columnWidths(560, false).fits, false, '560: centre would be 294 < 330');
  assert.equal(L.columnWidths(612, false).fits, true);
  assert.ok(L.columnWidths(612, false).centre >= 330 && L.columnWidths(612, false).blobs >= 150);
  assert.equal(L.columnWidths(NaN, false).fits, false);
  assert.equal(L.columnWidths(-5, true).fits, false);
  assert.equal(L.columnWidths(500, true).fits, false, 'focus: 500 - 8 - 64 - 108 = 320 < 330');
  assert.equal(L.columnWidths(520, true).fits, true);
});

// ---- the counts: real sessions and the real queue, never rendered rows ---------------------------------------------------------
test('statusCounts: active = real sessions working; waiting = pending + queued (not rows rendered)', () => {
  const v = view([raw({ state: 'running' }), raw({ id: 's-0123abce', state: 'sleeping' }), raw({ id: 's-0123abcf', state: 'running' })]);
  const c = L.statusCounts({ view: v, pending: { id: 'x' }, queuedCount: 2 });
  assert.deepEqual([c.active, c.waiting, c.approx], [2, 3, false]);
  assert.deepEqual(c.lines, ['2 activas', '3 esperan']);
  assert.deepEqual(L.statusCounts({ view: v, pending: { id: 'x' }, queuedCount: 0 }).lines, ['2 activas', '1 espera']);
  assert.deepEqual(L.statusCounts({ view: view([raw({ state: 'running' })]), pending: null, queuedCount: 0 }).lines, ['1 activa']);
});
test('statusCounts: a running tool counts as active even when the process state says otherwise; truncated lists say «+»; nothing = reposo', () => {
  const tools = { total: 1, steps: [{ index: 1, name: 'bash', state: 'running' }] };
  const v = view([raw({ state: 'sleeping', tools })]);
  assert.equal(L.statusCounts({ view: v, pending: null, queuedCount: 0 }).active, 1);
  const t = view([raw({ state: 'running' })], { truncated: true, total: 30 });
  const c = L.statusCounts({ view: t, pending: null, queuedCount: 0 });
  assert.deepEqual([c.active, c.approx, c.lines], [1, true, ['1+ activa']], 'only the received rows are known: never claim an exact count');
  assert.deepEqual(L.statusCounts({ view: view([raw()]), pending: null, queuedCount: 0 }).lines, ['En reposo']);
  assert.deepEqual(L.statusCounts({ view: null, pending: null, queuedCount: 0 }).lines, ['En reposo']);
  assert.deepEqual(L.statusCounts({ view: { state: 'error' }, pending: null, queuedCount: 0 }).lines, ['En reposo'], 'an unavailable list claims nothing');
  for (const bad of [-1, 1.5, '2', NaN, 99, undefined]) assert.equal(L.statusCounts({ view: null, pending: { id: 'x' }, queuedCount: bad }).waiting, 1, `queued_count ${bad} is not a count`);
  assert.equal(L.statusCounts({ view: null, pending: null, queuedCount: 3 }).waiting, 0, 'nothing pending: a queue count alone is not shown');
});

// ---- attribution: the pending question belongs to a row only when it is unambiguous --------------------------------------------
test('attribute: agent class + project name pick ONE session; ambiguity attributes nothing (the count still says it)', () => {
  const rows = [sess({ id: 's-0000000a', kindLabel: 'Claude Code', cwd: 'api' }), sess({ id: 's-0000000b', kindLabel: 'Claude Code', cwd: 'web' }), sess({ id: 's-0000000c', kindLabel: 'Pi', cwd: 'api' })];
  const claudeApi = { agent: 'claude-code', project_name: 'api' };
  assert.equal(L.attribute(claudeApi, rows), 's-0000000a');
  assert.equal(L.attribute({ agent: 'claude-code', project_name: 'web' }, rows), 's-0000000b');
  assert.equal(L.attribute({ agent: 'claude-code' }, rows), null, 'two Claude sessions and no project: ambiguous');
  assert.equal(L.attribute({ agent: 'codex', project_name: 'api' }, rows), null, 'no such session');
  assert.equal(L.attribute({ agent: 'claude-code', project_name: 'nope' }, rows), null);
  assert.equal(L.attribute({ agent: 'pi' }, [rows[2]]), 's-0000000c', 'a single session of the class is unambiguous');
  assert.equal(L.attribute({ agent: 'claude-code', project_name: 'api' }, [rows[0], { ...rows[0], id: 's-0000000d' }]), null, 'two sessions with the same class AND project: ambiguous');
  assert.equal(L.attribute(null, rows), null);
  assert.equal(L.attribute({ agent: '../x' }, rows), null);
});

test('S4 (abito-avisos-ux): the Koda project folder «sb-second-brain» is shown as «Koda» in the blobs and the centre; others keep their name', () => {
  const rows = L.blobRows({ declared: [], sessions: [sess({ id: 's-00000001', cwd: 'sb-second-brain' }), sess({ id: 's-00000002', cwd: 'scratch' })], focusId: null, attributedId: null, badges: new Set() });
  assert.deepEqual(rows.map(r => r.name), ['Koda', 'scratch']);
  assert.ok(rows.every(r => !/sb-second-brain|\bSB\b/i.test(r.aria)), JSON.stringify(rows.map(r => r.aria)));
});
// ---- the right column ----------------------------------------------------------------------------------------------------------
const pill = (id, name, over = {}) => ({ id, name, kind: 'pill', color: 'blue', ...over });
test('blobRows: declared pills ALWAYS come first and are never pushed out; sessions follow; no cap of four', () => {
  const declared = [pill('abito', 'Abito', { kind: 'principal' }), pill('integration_github', 'GitHub', { kind: 'integration' })];
  const sessions = Array.from({ length: 9 }, (_, i) => sess({ id: `s-0000000${i}`, cwd: `p${i}`, state: i === 0 ? 'running' : 'sleeping' }));
  const rows = L.blobRows({ declared, sessions, focusId: null, attributedId: null, badges: new Set() });
  assert.equal(rows.length, 11, '2 declared + 9 sessions: nothing dropped');
  assert.deepEqual(rows.slice(0, 2).map(r => r.id), ['abito', 'integration_github']);
  assert.ok(rows.slice(2).every(r => r.kind === 'session'));
  assert.deepEqual(rows.slice(0, 2).map(r => r.kind), ['principal', 'integration']);
});
test('blobRows: every row has a name, a colour and ONE honest status dot: working / idle / needs you / news', () => {
  const declared = [pill('abito', 'Abito', { kind: 'principal' }), pill('integration_github', 'GitHub', { kind: 'integration' })];
  const sessions = [sess({ id: 's-0000000a', kindLabel: 'Claude Code', cwd: 'api', state: 'running' }), sess({ id: 's-0000000b', cwd: 'web' }), sess({ id: 's-0000000c', cwd: 'old', state: 'sleeping' })];
  const rows = L.blobRows({ declared, sessions, focusId: 's-0000000b', attributedId: 's-0000000c', badges: new Set(['integration_github']) });
  const by = id => rows.find(r => r.id === id);
  assert.equal(by('s-0000000a').status, 'working');
  assert.equal(by('s-0000000b').status, 'idle');
  assert.equal(by('s-0000000c').status, 'needs', 'the attributed pending question marks ITS row only');
  assert.equal(by('integration_github').status, 'news');
  assert.equal(by('abito').status, 'idle');
  assert.equal(by('s-0000000b').focused, true);
  assert.equal(by('s-0000000a').focused, false);
  assert.equal(by('s-0000000a').name, 'api');
  assert.equal(by('s-0000000a').aria, 'api · Claude Code · trabajando');
  assert.equal(by('s-0000000c').aria, 'old · Pi · te necesita');
  for (const r of rows) assert.ok(r.name && r.color && ['working', 'idle', 'needs', 'news'].includes(r.status), r.id);
});
test('blobRows: a long name is bounded for the column; a running tool means working; nothing malformed throws', () => {
  const tools = { total: 1, steps: [{ index: 1, name: 'bash', state: 'running' }] };
  const rows = L.blobRows({ declared: [], sessions: [sess({ cwd: 'un-nombre-de-proyecto-larguisimo', tools, state: 'sleeping' })], focusId: null, attributedId: null, badges: new Set() });
  assert.equal(rows[0].status, 'working');
  assert.ok(Array.from(rows[0].name).length <= 24 && rows[0].name.endsWith('…'), rows[0].name);
  assert.deepEqual(L.blobRows({}), []);
  assert.deepEqual(L.blobRows(null), []);
  assert.equal(L.blobRows({ declared: [null, { id: 5 }, pill('ok', 'Ok')], sessions: [null, 7] }).length, 1, 'junk rows are dropped, never repaired');
});
test('focusOverflow: up to four mascots show all of them; more shows three and «+N»', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}` }));
  assert.deepEqual(L.focusOverflow(rows.slice(0, 4)), { shown: rows.slice(0, 4), more: 0 });
  const o = L.focusOverflow(rows);
  assert.deepEqual([o.shown.length, o.more], [3, 3]);
  assert.deepEqual(L.focusOverflow([]), { shown: [], more: 0 });
  assert.deepEqual(L.focusOverflow(null), { shown: [], more: 0 });
});

// ---- the mode -------------------------------------------------------------------------------------------------------------------
test('layoutMode: focus ONLY while something waits for the human and its card is the one on screen; it ends with the question', () => {
  assert.equal(L.layoutMode({ question: 'pending' }), 'focus');
  assert.equal(L.layoutMode({ card: 'pending' }), 'focus');
  assert.equal(L.layoutMode({ question: 'pending', card: 'pending' }), 'focus');
  for (const q of ['', 'outcome', 'expired', undefined, null]) assert.equal(L.layoutMode({ question: q }), 'normal', String(q));
  assert.equal(L.layoutMode({}), 'normal');
  assert.equal(L.layoutMode(null), 'normal');
});

// ---- approvals (E): «!», the command in a mono box, «Rechazar N / Aprobar Y» ----------------------------------------------------
const opt = (i, label, description = '') => ({ index: i, key: String(i + 1), label, description });
const harness = (text, opts = [opt(0, 'Allow once'), opt(1, 'Deny')]) => ({ id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'question', agent: 'claude-code', text, options: opts, allowFreeText: false });
test('approvalView: a Claude/Codex permission (a question the harness words «asks permission») gets the approval look', () => {
  const v = L.approvalView(harness('Claude Code asks permission: Bash: rm -rf build/ && npm run build'), 'Claude Code');
  assert.equal(v.badge, '!');
  assert.equal(v.title, 'Ejecutar:');
  assert.equal(v.command, 'rm -rf build/ && npm run build');
  assert.equal(v.tool, 'Bash');
  assert.deepEqual(v.actions.map(a => [a.role, a.label, a.key, a.index]), [['reject', 'Rechazar', 'N', 1], ['approve', 'Aprobar', 'Y', 0]], 'reject on the left, approve primary on the right; indexes come from the labels');
  assert.equal(v.secretsHidden, false);
  assert.equal(L.approvalView(harness('Codex asks permission: Edit: src/a.js (secrets hidden)'), 'Codex').secretsHidden, true);
  const other = L.approvalView(harness('Claude Code asks permission: WebFetch: https://example.com'), 'Claude Code');
  assert.equal(other.title, 'Permiso:');
  assert.equal(other.command, 'https://example.com');
  assert.equal(other.tool, 'WebFetch');
});
test('approvalView is SAFE: only the exact known label pair maps to Aprobar/Rechazar; anything else stays a numbered list', () => {
  assert.equal(L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Deny'), opt(1, 'Decide in the terminal')]), 'Claude Code'), null, 'a lossy request offers no allow: no approve button');
  assert.equal(L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Allow'), opt(1, 'Deny')]), 'Claude Code'), null, 'unknown wording is not guessed');
  assert.equal(L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Allow once'), opt(1, 'Deny'), opt(2, 'More')]), 'Claude Code'), null);
  assert.equal(L.approvalView(harness('¿Querés café o té?', [opt(0, 'Café'), opt(1, 'Té')]), 'Pi'), null, 'an ordinary question is never an approval');
  assert.equal(L.approvalView({ ...harness('Claude Code asks permission: Bash: ls'), allowFreeText: true }, 'Claude Code'), null);
  assert.equal(L.approvalView(null, 'x'), null);
  // a swapped order still maps by LABEL, never by position
  const swapped = L.approvalView(harness('Claude Code asks permission: Bash: ls', [opt(0, 'Deny'), opt(1, 'Allow once')]), 'Claude Code');
  assert.deepEqual(swapped.actions.map(a => [a.role, a.index]), [['reject', 0], ['approve', 1]]);
});
// T4b: the actual Claude Code / Codex producer wording (apps/desktop-harness hook-common.cjs): «<Agente> pide permiso para <detalle>» with
// the exact pair «Aprobar una vez» / «Rechazar». The approve label keeps «una vez»; indexes come from the labels.
const es = (text, opts = [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar')]) => harness(text, opts);
const rows2 = v => v.actions.map(a => [a.role, a.label, a.key, a.index]);
test('T4b approvalView: the Spanish producer pair wears the approval look and keeps «Aprobar una vez»', () => {
  for (const agent of ['Claude Code', 'Codex']) {
    const v = L.approvalView(es(`${agent} pide permiso para Bash: rm -rf build/ && npm run build`), agent);
    assert.deepEqual([v.badge, v.title, v.tool, v.command, v.secretsHidden], ['!', 'Ejecutar:', 'Bash', 'rm -rf build/ && npm run build', false], agent);
    assert.deepEqual(rows2(v), [['reject', 'Rechazar', 'N', 1], ['approve', 'Aprobar una vez', 'Y', 0]], agent);
  }
  const sw = L.approvalView(es('Codex pide permiso para Bash: ls', [opt(0, 'Rechazar'), opt(1, 'Aprobar una vez')]), 'Codex');
  assert.deepEqual(rows2(sw), [['reject', 'Rechazar', 'N', 0], ['approve', 'Aprobar una vez', 'Y', 1]], 'swapped pair keeps the ORIGINAL indexes');
  const odd = L.approvalView(es('Codex pide permiso para Bash: ls', [opt(4, 'Aprobar una vez'), opt(9, 'Rechazar')]), 'Codex');
  assert.deepEqual(rows2(odd).map(r => r[3]), [9, 4], 'non-contiguous original indexes are preserved');
  const hid = L.approvalView(es('Codex pide permiso para Edit: src/a.js (secretos ocultos)'), 'Codex');
  assert.deepEqual([hid.secretsHidden, hid.title, hid.tool, hid.command], [true, 'Permiso:', 'Edit', 'src/a.js']);
  const mcp = L.approvalView(es('Claude Code pide permiso para herramienta MCP foo'), 'Claude Code');
  assert.deepEqual([mcp.tool, mcp.command, mcp.title], [null, 'herramienta MCP foo', 'Permiso:']);
  assert.equal(L.compactView({ rows: [], focusId: null, pending: { kind: 'question', agent: 'claude-code', text: 'Codex pide permiso para Bash: ls', options: [{ index: 0, label: 'Aprobar una vez' }, { index: 1, label: 'Rechazar' }] } }).badge, 'approval');
});
test('T4b approvalView: near matches, lossy, extra options, free text, forms and mixed wording stay NOT an approval', () => {
  const T0 = 'Claude Code pide permiso para Bash: ls';
  const no = (n, l) => assert.equal(L.approvalView(n, 'Claude Code'), null, l);
  no(es(T0, [opt(0, 'Aprobar'), opt(1, 'Rechazar')]), 'plain Aprobar on a harness question is unknown wording');
  no(es(T0, [opt(0, 'aprobar una vez'), opt(1, 'Rechazar')]), 'case differs');
  no(es(T0, [opt(0, 'Aprobar una vez'), opt(1, 'Rechazar'), opt(2, 'Más')]), 'three options');
  no(es(T0, [opt(0, 'Rechazar'), opt(1, 'Decidir en la terminal')]), 'lossy pair has no approve');
  no(es(T0, [opt(0, 'Aprobar una vez'), opt(1, 'Decidir en la terminal')]), 'no reject');
  no(es(T0, [opt(0, 'Aprobar una vez'), opt(1, 'Deny')]), 'mixed language labels');
  no(es(T0, [opt(0, 'Allow once'), opt(1, 'Rechazar')]), 'mixed language labels');
  no(es('Claude Code pide permiso para Bash: ls (detalles solo en la terminal; decidir en la terminal)'), 'lossy wording never gets an approve button');
  no(es('Claude Code quiere ejecutar Bash: ls'), 'unknown wording');
  no(es('Claude Code pide permiso: Bash: ls'), 'missing «para»');
  no(es('¿Claude Code pide permiso para Bash: ls?'), 'does not start with the agent');
  no(es(' pide permiso para Bash: ls'), 'no agent');
  no(es('Claude Code pide permiso para '), 'no detail');
  no({ ...es(T0), allowFreeText: true }, 'free text');
  no({ ...es(T0), kind: 'text' }, 'other kind');
  no({ ...es(T0), kind: 'multi' }, 'other kind');
  no({ ...es(T0), kind: undefined }, 'no kind');
  no(es(T0, [opt(0, 'Aprobar una vez'), opt(0, 'Aprobar una vez')]), 'same option twice');
  no(es(T0, [opt(0, 'Rechazar'), opt(1, 'Rechazar')]), 'no approve');
});
test('approvalView: Pi\'s kind=approval with the exact pair «Aprobar»/«Rechazar» follows the MD (Rechazar N | Aprobar Y, Aprobar primary, short title); other labels keep their own order', () => {
  const pi = (text, opts) => ({ id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'approval', agent: 'pi', text, options: opts, allowFreeText: false });
  const v = L.approvalView(pi('¿Me das permiso para ejecutar: rm -rf build/ && npm run build?', [opt(0, 'Aprobar'), opt(1, 'Rechazar')]), 'Pi');
  assert.equal(v.badge, '!'); assert.equal(v.title, 'Ejecutar:'); assert.equal(v.command, 'rm -rf build/ && npm run build');
  assert.deepEqual(v.actions.map(a => [a.role, a.label, a.key, a.index]), [['reject', 'Rechazar', 'N', 1], ['approve', 'Aprobar', 'Y', 0]], 'MD order and keys; the index is the option\'s own');
  const plain = L.approvalView(pi('¿Borrar la carpeta build?', [opt(0, 'Aprobar'), opt(1, 'Rechazar')]), 'Pi');
  assert.equal(plain.title, 'Permiso:'); assert.equal(plain.command, '¿Borrar la carpeta build?');
  // any other wording is NOT guessed: its own labels, its own order, numeric keys
  const other = L.approvalView(pi('¿Borrar la carpeta build?', [opt(0, 'Borrar'), opt(1, 'Mantener')]), 'Pi');
  assert.equal(other.title, 'Permiso:');
  assert.deepEqual(other.actions.map(a => [a.role, a.label, a.key, a.index]), [['option', 'Borrar', '1', 0], ['option', 'Mantener', '2', 1]]);
});
test('approvalKey: Y approves and N rejects only for a known pair, trusted, unmodified, not typing, not repeating', () => {
  const v = L.approvalView(harness('Claude Code asks permission: Bash: ls'), 'Claude Code');
  const key = (k, extra = {}) => ({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, ...extra });
  assert.equal(L.approvalKey(key('y'), v, { typing: false }), 0);
  assert.equal(L.approvalKey(key('Y'), v, { typing: false }), 0);
  assert.equal(L.approvalKey(key('n'), v, { typing: false }), 1);
  assert.equal(L.approvalKey(key('y', { isTrusted: false }), v, { typing: false }), -1);
  assert.equal(L.approvalKey(key('y', { ctrlKey: true }), v, { typing: false }), -1);
  assert.equal(L.approvalKey(key('y', { repeat: true }), v, { typing: false }), -1);
  assert.equal(L.approvalKey(key('y'), v, { typing: true }), -1);
  assert.equal(L.approvalKey(key('x'), v, { typing: false }), -1);
  const pi = L.approvalView({ id: 'a', kind: 'approval', agent: 'pi', text: 't', options: [opt(0, 'Borrar'), opt(1, 'Mantener')], allowFreeText: false }, 'Pi');
  assert.equal(L.approvalKey(key('y'), pi, { typing: false }), -1, 'Y/N never guess which of Pi\'s own labels approves');
  assert.equal(L.approvalKey(key('y'), null, { typing: false }), -1);
});


// ---- G: the state badge is attached to the mascot, wherever the mascot is (human audit: «el ? queda ~90 px arriba/izquierda») ---------
test('badgePosition: top-left of the mascot (centre - 20, - 21 like Coucou), following it in every view and size', () => {
  assert.deepEqual(L.badgePosition({ left: 68, top: 70, size: 66 }), { left: 68 + 33 - 20 - 8, top: 70 + 33 - 21 - 8 }, 'overview: centre (101,103) -> badge centre (81,82)');
  const chat = L.badgePosition({ left: 52, top: 164, size: 46 });
  assert.deepEqual(chat, { left: 52 + 23 - 28, top: 164 + 23 - 29 }, 'chat: the mascot moved to the composer, the badge came with it');
  assert.ok(chat.top > 100, 'and it is NOT left up near the header where the overview mascot was');
  assert.deepEqual(L.badgePosition({ left: 0, top: 0, size: 0 }), { left: -28, top: -29 });
  for (const bad of [null, undefined, {}, { left: NaN, top: 1, size: 1 }, { left: 1, top: 1 }]) assert.equal(L.badgePosition(bad), null, JSON.stringify(bad));
});
test('wiring: island.js places the badge from the mascot\'s OWN rendered box (the same left/top/size it just wrote), not a fixed offset', () => {
  const fs = require('node:fs');
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  const badge = isl.slice(isl.indexOf("const badge = $('clay-badge')"), isl.indexOf("if (capsule.dataset.edge !== edge)"));
  assert.match(badge, /AbitoIslandLayout\.badgePosition\(/);
  assert.match(badge, /left: clayLeft, top: clayTop, size: csv/);
  assert.doesNotMatch(badge, /ov\.clayX - 28|ov\.cy - 29/, 'the fixed offsets that detached the badge in the chat are gone');
});


// ---- CSS: the three columns and focus mode, measured on the real style sheets --------------------------------------------------
const fs = require('node:fs');
const css = (fs.readFileSync(path.join(frontend, 'style.css'), 'utf8') + '\n' + fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].replace(/\s+/g, ' ').trim();
    if (group !== sel && !group.split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace('!important', '').trim(); }
  }
  return out;
}
const px = v => parseFloat(v);
test('CSS: the columns add up to the 700px overview — status 108 | centre | 8 gap | blobs — with the blobs column scrolling inside its card', () => {
  const left = decls('.card-left'), blobs = decls('#blobs'), list = decls('#pill-choices');
  assert.equal(px(left.width) + px(blobs.width) + 8, 700, 'the columns still sum to the overview width');
  assert.equal(px(left.width), 518, "left + centre = status 108 + centre 410");
  assert.equal(px(blobs.width), 174);
  assert.equal(blobs.left, 'calc(50% + 176px)', 'island centre - 350 (overview left) + 526 (main card 518 + 8px gap)');
  assert.equal(px(blobs.top), 42); assert.equal(px(blobs.height), 132);
  assert.equal(list['overflow-y'], 'auto', 'the blobs scroll, nothing is capped or pushed out');
  assert.equal(list.display, 'flex');
  assert.equal(list['flex-direction'], 'column');
  const row = decls('.pill-choice');
  assert.equal(px(row.height), 22, 'rows are 22px: 3 fully visible even with the 28px notices band over the top of the card (screen gate: only ~1.5 were)');
  assert.equal(row.width, '100%', 'one blob per row, full width of the column');
});
test('CSS: focus mode — 620px card, 12px gutter and 68px mascot column (names hidden, dots kept)', () => {
  const left = decls('#capsule[data-layout="focus"] #question'), blobs = decls('#capsule[data-layout="focus"] #blobs');
  assert.equal(px(left.width), 620, 'leave the requested 12px gutter and 68px blobs inside 700px');
  assert.equal(px(blobs.width), 68);
  assert.equal(blobs.left, 'calc(50% + 282px)', 'island centre - 350 + 620 + 12');
  assert.equal(px(left.width) + 12 + px(blobs.width), 700);
  assert.equal(decls('#capsule[data-layout="focus"] .pill-choice span:not(.ico)').display, 'none', 'only mascots in focus mode');
  assert.notEqual(decls('#capsule[data-layout="focus"] .blob-dot').display, 'none', 'but the status dots stay');
});
test('CSS: the status dot has one honest colour per state (working / idle / needs you / news)', () => {
  for (const [st, token] of [['working', '--go'], ['needs', '--sun'], ['news', '--island-live']]) assert.match(decls(`.blob-dot[data-status="${st}"]`).background || '', new RegExp(token), st);
  assert.ok(decls('.blob-dot[data-status="idle"]').background, 'idle is drawn too (an empty ring)');
});
test('CSS: the left column is Abito\'s mascot and its status; the status text never overlaps the centre', () => {
  const st = decls('.col-status');
  assert.equal(px(st.width), 96);
  assert.equal(st.position, 'absolute');
  assert.ok(px(st.left) + px(st.width) <= 108, 'inside the 108px status column');
});

// ---- wiring: the approval look on the question card (E) ------------------------------------------------------------------------
test('wiring: notify.js renders approvalView (badge, mono box, Rechazar/Aprobar) and sends the OPTION INDEX through the same choose() path; Y/N use approvalKey', () => {
  const src = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(src, /AbitoIslandLayout/);
  assert.match(src, /\.approvalView\(/);
  assert.match(src, /\.approvalKey\(/);
  assert.match(src, /q-approval/);
  assert.match(src, /choose\(event, act\.index\)/, 'the click goes through the existing trusted answer path with the option index');
  assert.doesNotMatch(src, /approval[^\n]*action\('allow'|action\(\{ action: 'allow'/, 'no new IPC verb: an approval is an ordinary answer');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="question-approval"/);
  assert.match(css, /#question-approval \.q-cmd \{[^}]*font: 400 12px var\(--mono\)/, 'the command in a mono well');
  assert.match(css, /#question\[data-look="approval"\]/);
  assert.equal(decls('.q-approval-btn.q-approve::after').background, 'var(--ink)', 'Aprobar is the primary (white) pill');
  assert.equal(decls('.q-approval-btn.q-approve').color, 'var(--island, #0b0c0e)', 'the island colour on the ink pill: readable in BOTH themes (the first build hardcoded dark ink)');
});

// ---- the notices band must not cover the blobs list; calm gives the room back ---------------------------------------------------
test('CSS: the blobs card leaves the 28px notices band free (32px with air); a calm strip and focus mode give that room back', () => {
  assert.equal(px(decls('#capsule[data-notices-calm="false"]:not([data-layout="focus"]) #blobs')['padding-top']), 32, 'the 28px band + 4px of air owns the top of the card');
  assert.equal(px(decls('#capsule[data-notices-calm="true"] #blobs')['padding-top']), 0, 'calm: nothing to say, the rows start at the top');
  assert.equal(px(decls('#capsule[data-layout="focus"] #blobs')['padding-top']), 0, 'focus mode hides the band behind the question card');
});

// ---- H: every agent has its own mascot colour (human audit: «4 puntos azules idénticos») --------------------------------------
test('agentColor: a stable colour per agent class, the human\'s own pill colour wins, unknown falls back to blue', () => {
  assert.deepEqual(['Pi', 'Claude Code', 'Codex', 'Gemini', 'OpenCode'].map(k => T.agentColor(k, {})), ['green', 'orange', 'purple', 'mint', 'blue']);
  assert.equal(T.agentColor('Claude Code', { pillColors: { integration_claude: 'purple' } }), 'purple', 'the human\'s choice wins');
  assert.equal(T.agentColor('Claude Code', { pillColors: { integration_claude: 'not-a-colour' } }), 'orange', 'a junk preference never reaches the DOM');
  assert.equal(T.agentColor('Mystery', {}), 'blue');
  assert.equal(T.agentColor(undefined, null), 'blue');
  const rows = T.sessionRows(T.sessionsView({ type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [
    { id: 's-0000000a', kind: 'claude-code', cwd: 'a', state: 'running', origin: null }, { id: 's-0000000b', kind: 'codex', cwd: 'b', state: 'running', origin: null }] }), {});
  assert.deepEqual(rows.map(r => r.color), ['orange', 'purple'], 'two agents are two colours');
});
test('wiring: the focus-mode blobs column shows «+N» for the overflow and the footer\'s «Ver todas» opens the full list', () => {
  const pv = fs.readFileSync(path.join(frontend, 'pills-view.js'), 'utf8');
  assert.match(pv, /focusOverflow\(/);
  assert.match(pv, /blobs-more/);
  assert.match(css, /#capsule\[data-layout="focus"\] \.pill-choice\[data-overflow="true"\] \{[^}]*display: none/);
});

// ---- E: the centre shows the FOCUSED session with its real state and real tool steps only ---------------------------------------
const row = (over = {}) => ({ id: 's-0000000a', kindLabel: 'Claude Code', cwd: 'api', state: 'sleeping', stateLabel: 'inactiva', origin: null, ...over });
test('pickFocus: the one selected in the blobs column, else the most recently active; never another session by accident', () => {
  const a = row({ id: 's-0000000a', cwd: 'a' }), b = row({ id: 's-0000000b', cwd: 'b', state: 'running' }), c = row({ id: 's-0000000c', cwd: 'c' });
  assert.equal(L.pickFocus([a, b, c], 's-0000000c', null), 's-0000000c', 'the human\'s selection wins');
  assert.equal(L.pickFocus([a, b, c], null, null), 's-0000000b', 'default: a working session beats idle ones');
  assert.equal(L.pickFocus([a, c], null, null), 's-0000000a', 'all idle: the first the daemon lists (it sorts most recent first)');
  assert.equal(L.pickFocus([a, b, c], 's-9999999z', null), 's-0000000b', 'a selection that no longer exists is dropped, not shown');
  assert.equal(L.pickFocus([], 's-0000000a', null), null);
  assert.equal(L.pickFocus(null, null, null), null);
  const withTools = row({ id: 's-0000000d', cwd: 'd', tools: { total: 1, steps: [{ index: 1, name: 'bash', state: 'running' }] } });
  assert.equal(L.pickFocus([a, withTools], null, null), 's-0000000d', 'a running tool counts as working');
  assert.equal(L.pickFocus([a, b], null, 's-0000000a'), 's-0000000a', 'the attributed pending question\'s session is the default focus when none is selected');
});
test('centreView: name, agent, REAL state word and real tool steps; no steps -> no step lines (no placeholder, no «…»)', () => {
  const idle = L.centreView(row());
  assert.deepEqual([idle.name, idle.agent, idle.state, idle.stateWord, idle.steps], ['api', 'Claude Code', 'idle', 'En reposo', []]);
  assert.equal(idle.aria, 'api · Claude Code · en reposo');
  const working = L.centreView(row({ state: 'running' }));
  assert.deepEqual([working.state, working.stateWord], ['working', 'Trabajando']);
  const tools = { total: 4, steps: [{ index: 2, name: 'read', state: 'done' }, { index: 3, name: 'grep', state: 'done' }, { index: 4, name: 'bash', state: 'running' }] };
  const t = L.centreView(row({ state: 'sleeping', tools }));
  assert.equal(t.state, 'working', 'a running tool overrides the process state');
  assert.deepEqual(t.steps.map(x => [x.name, x.state]), [['grep', 'done'], ['bash', 'running']], 'the last 2 steps: that is what fits the 94px centre next to the state line and the footer row');
  assert.equal(t.count, '4/4');
  assert.deepEqual(t.steps.map(x => x.current), [false, true], 'the running step is the current one');
  const done = L.centreView(row({ tools: { total: 2, steps: [{ index: 1, name: 'read', state: 'done' }, { index: 2, name: 'bash', state: 'done' }] } }));
  assert.equal(done.steps.at(-1).current, true, 'when nothing runs the last step is the current one');
  const err = L.centreView(row({ tools: { total: 1, steps: [{ index: 1, name: 'bash', state: 'error' }] } }));
  assert.equal(err.state, 'error'); assert.equal(err.stateWord, 'Con error');
  assert.equal(L.centreView(null), null);
  assert.equal(L.centreView({}), null);
});
test('centreView: a session waiting for the human says so ONLY when the pending question is attributed to it', () => {
  assert.equal(L.centreView(row(), { attributedId: 's-0000000a' }).state, 'waiting');
  assert.equal(L.centreView(row(), { attributedId: 's-0000000a' }).stateWord, 'Te espera');
  assert.equal(L.centreView(row(), { attributedId: 's-0000000b' }).state, 'idle', 'someone else\'s question is not this session\'s state');
  assert.equal(L.centreView(row({ state: 'running' }), { attributedId: 's-0000000a' }).state, 'waiting', 'waiting beats working');
});
test('centreView: steps are bounded to what fits (last 2) and a long name is cut for the column', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, name: `tool${i}`, state: 'done' }));
  assert.equal(L.centreView(row({ tools: { total: 6, steps } })).steps.length, 2);
  assert.equal(L.centreView(row({ tools: { total: 6, steps } })).steps[1].name, 'tool5');
  const long = L.centreView(row({ cwd: 'un-proyecto-con-un-nombre-larguisimo-de-verdad' }));
  assert.ok(Array.from(long.name).length <= 32 && long.name.endsWith('…'), long.name);
});

// ---- I: the empty state in the centre, with a CTA ------------------------------------------------------------------------------
test('emptyView: nothing running -> «Todo tranquilo» + «Preguntar a Koda»; failures and unknown states are NOT empty', () => {
  const e = L.emptyView({ view: T.sessionsView({ type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [] }), pending: null, finished: false });
  assert.deepEqual(e, { title: 'Todo tranquilo', sub: 'Arrastrá un archivo o preguntá.', cta: { label: 'Preguntar a Koda', action: 'new-chat' } }); // Koda 0.1 T2
  assert.deepEqual(L.emptyView({ view: null, pending: null, finished: false }).cta.action, 'new-chat', 'no list yet and nothing pending: still a calm empty centre');
  assert.equal(L.emptyView({ view: { state: 'error' }, pending: null, finished: false }), null, 'a failed list is not "everything is calm": the engine row owns that');
  assert.equal(L.emptyView({ view: T.sessionsView({ type: 'sessions', schema: 'abito-sessions/view/1', truncated: false, sessions: [{ id: 's-0000000a', kind: 'pi', cwd: 'x', state: 'sleeping', origin: null }] }), pending: null, finished: false }), null, 'a session exists: the centre shows it');
  assert.equal(L.emptyView({ view: null, pending: { id: 'x' }, finished: false }), null, 'something waits: focus mode owns the centre');
  assert.equal(L.emptyView({ view: null, pending: null, finished: true }), null, 'a finished result owns the centre');
});

// ---- D: «Pi terminó» in the centre, full width, the result untruncated -------------------------------------------------------------
test('finishedLayout: the result wraps (never one truncated line) and asks the island for the height it needs, capped like a question', () => {
  const short = L.finishedLayout(40);
  assert.deepEqual(short, { cardH: 108, islandH: 160, scroll: false }, 'a short result fits the normal overview card');
  const mid = L.finishedLayout(150);
  assert.deepEqual([mid.cardH, mid.islandH, mid.scroll], [150, 202, false]);
  const huge = L.finishedLayout(900);
  assert.deepEqual([huge.cardH, huge.islandH, huge.scroll], [280, 332, true], 'capped at the same 332 as a question, then scrolls inside');
  const granted = L.finishedLayout(900, 600);
  assert.deepEqual([granted.cardH, granted.islandH, granted.scroll], [548, 600, true], 'a window the host grew allows more');
  for (const bad of [NaN, -3, undefined]) assert.deepEqual(L.finishedLayout(bad), { cardH: 108, islandH: 160, scroll: false }, String(bad));
});
test('wiring D/E/I: the centre is fed by island-layout.js; CSS lets the finished message wrap; a blob click selects it for the centre', () => {
  const lay = fs.readFileSync(path.join(frontend, 'island-layout.js'), 'utf8');
  for (const id of ['col-centre', 'centre-state', 'centre-steps', 'centre-empty']) assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), new RegExp(`id="${id}"`), id);
  assert.match(lay, /pickFocus\(/); assert.match(lay, /centreView\(/); assert.match(lay, /emptyView\(/);
  assert.match(lay, /abito:sessions-view/, 'the centre follows the ticker\'s focus event: a blob click, the compact bar\'s mini mascot and the «principal» preference all end there');
  const pv = fs.readFileSync(path.join(frontend, 'pills-view.js'), 'utf8');
  assert.match(pv, /abito:session-select/, 'the blob click already dispatches the selection the centre listens to');
  assert.equal(decls('#notice-card #notice-card-message')['white-space'], 'nowrap', 'S10: the finished message is ONE line in the band (full text in the tooltip)');
  assert.equal(decls('#notice-card #notice-card-message')['text-overflow'], 'ellipsis');
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(isl, /FINISHED_BAND_H = 36/, 'S10: the island is 36px taller while the band shows');
  assert.match(isl, /abito:centre-new/, 'the CTA opens a new conversation through the existing «+»');
});

test('no duplicates: the centre column replaces the old who-row text and the Coucou ticker; only the «Ver todas» link stays of the who-row', () => {
  for (const sel of ['.who .name', '.who .tool', '.who .count', '.who .who-dot']) assert.equal(decls(sel).display, 'none', `${sel}: the centre already says it`);
  assert.equal(decls('.card-left > .ticker').display, 'none', 'the centre draws the real steps (3 lines) itself');
  const who = decls('.card-left > .who');
  assert.equal(who.bottom, '6px', 'the link sits at the bottom of the centre, away from the state line');
  assert.equal(who.top, 'auto');
  assert.ok(decls('.who .see-all'), 'the link keeps its own rule');
});

// ---- ONE source of truth for «which session is focused»: the ticker's focus (it also drives the ↗ jump and the terminal shortcut) -------
test('pickFocus: the ticker\'s focus wins over a stale selection; the centre can never name a different session than the ↗ jump targets', () => {
  const a = row({ id: 's-0000000a', cwd: 'workspace' }), b = row({ id: 's-0000000b', cwd: 'proyecto-beta', state: 'running' });
  // the human clicked the mini mascot (compact bar) or changed «principal»: the TICKER now focuses `a`, while the layout remembers an older click on `b`
  assert.equal(L.pickFocus([a, b], 's-0000000b', null, 's-0000000a'), 's-0000000a', 'the ticker\'s focusId decides');
  assert.equal(L.pickFocus([a, b], null, null, 's-0000000b'), 's-0000000b');
  assert.equal(L.pickFocus([a, b], null, null, 's-9999999z'), 's-0000000b', 'a focus the list no longer has is dropped: default rules');
  assert.equal(L.pickFocus([a, b], 's-0000000a', null, null), 's-0000000a', 'without a ticker focus the layout selection still applies (unit use)');
});
test('wiring: the centre is painted from the ticker\'s focusId (sessions-view event), and a blob click only asks the ticker to focus — it never keeps a private selection', () => {
  const lay = fs.readFileSync(path.join(frontend, 'island-layout.js'), 'utf8');
  assert.match(lay, /L\.pickFocus\(rows, selectedId, attributedId, focusId\)/);
  assert.doesNotMatch(lay, /abito:session-select', e => \{ selectedId = e\.detail/, 'no private selection set from the click: the ticker answers with abito:sessions-view');
  const tk = fs.readFileSync(path.join(frontend, 'sessions-ticker.js'), 'utf8');
  assert.match(tk, /abito:session-select', event => \{ if \(canFocus\(\)\) selectSession/, 'the blob click reaches the ticker\'s own focus');
});

// ---- the blobs list shows WHOLE rows only: a 4th row peeking 3px under the 3rd looked like a cut row without a label (real preview) -----
test('rowsViewport: the list is sized to a whole number of rows (>= 3) plus its own 1px padding, the rest of the card is padding, never a sliver', () => {
  const V = L.rowsViewport;
  assert.deepEqual(V(72), { rows: 3, height: 72, rest: 0 }, '3 rows of 22 + 2 gaps of 2 + 2px of list padding = 72 exactly');
  assert.deepEqual(V(78), { rows: 3, height: 72, rest: 6 }, '6px left: NOT enough for a 4th row, so it becomes padding (it used to be a visible sliver)');
  assert.deepEqual(V(96), { rows: 4, height: 96, rest: 0 }, '4 rows = 4x22 + 3x2 + 2px of padding');
  assert.deepEqual(V(106), { rows: 4, height: 96, rest: 10 }, 'calm strip: the whole card height, 4 whole rows, the remainder is padding');
  assert.deepEqual(V(40), { rows: 3, height: 72, rest: 0 }, 'a card too short still gets the 3-row minimum');
  for (const bad of [NaN, -5, undefined, null]) assert.deepEqual(V(bad), { rows: 3, height: 72, rest: 0 }, String(bad));
  assert.deepEqual(L.ROW, { h: 22, gap: 2, min: 3, pad: 1 });
});
test('wiring: the mount applies rowsViewport to #pill-choices on every layout/notices change', () => {
  const lay = fs.readFileSync(path.join(frontend, 'island-layout.js'), 'utf8');
  assert.match(lay, /L\.rowsViewport\(/);
  assert.match(lay, /maxHeight = /);
  assert.match(lay, /data-notices-calm|noticesCalm|attributeFilter: \[[^\]]*'data-notices-calm'/);
});

test('CSS: the «Recibida» / «Enviada» outcome card keeps the A layout width (438), so the blobs column (x446..) never overlaps its corner', () => {
  assert.equal(px(decls('#capsule[data-question="outcome"]:not([data-card]) #question').width), 438);
  assert.equal(px(decls('#capsule[data-question="expired"]:not([data-card]) #question').width), 438, 'an expired card is layout A too (not pending, so the blobs are the normal column and must stay free)');
});
test('CSS: a questionnaire/multi-select row shows its SELECTION without hover: filled background, a visible mark and a heavier label', () => {
  const on = decls('.q-option[data-selected="true"]::after');
  assert.ok(on.background && on.background !== 'var(--btn-bg)', 'the selected row has its own fill');
  assert.equal(Object.keys(decls('.q-option[data-selected="true"]::before')).length, 0, 'NO ::before on a row: it is one more grid cell and broke the label letter by letter (v5-06)');
  assert.ok(decls('.q-option[data-selected="true"] .q-dot').background || decls('.q-option[data-selected="true"] .q-box').background, 'the mark is the existing .q-dot / .q-box element, which is already a grid cell');
  assert.equal(decls('.q-option[data-selected="true"] .q-label')['font-weight'], '700');
  const notify = fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8');
  assert.match(notify, /dataset\.selected = r\.checked \? 'true' : 'false'/, 'notify.js writes the state on every row');
  assert.match(notify, /aria-checked/, 'and exposes it to assistive tech');
});

// ---- v5-04: tooltips. WebKitGTK may not paint `title` tooltips in this undecorated, transparent, focus:false X11 window; the island draws its own ----
test('tipFor: the text a hovered element shows — its own title, only when it differs from what is visible, bounded and clean', () => {
  const tip = L.tipFor;
  assert.equal(tip({ title: 'tokens_plugin#2 feat(telemetry): add local Pi sessions', visibleText: 'tokens_plugin#2 feat(telemetry): add local Pi…' }), 'tokens_plugin#2 feat(telemetry): add local Pi sessions');
  assert.equal(tip({ title: 'Abrir', visibleText: 'Abrir' }), '', 'a title equal to the visible text adds nothing');
  assert.equal(tip({ title: '', visibleText: 'x' }), '');
  assert.equal(tip({ title: 'a\u0000b\u202ec', visibleText: '' }), 'a b c', 'control and bidi characters are flattened');
  assert.ok(Array.from(tip({ title: 'x'.repeat(500), visibleText: '' })).length <= 160 && tip({ title: 'x'.repeat(500), visibleText: '' }).endsWith('…'));
  assert.equal(tip(null), ''); assert.equal(tip({ title: 7 }), '');
});
test('tipPlacement: below the pointer, kept inside the island, flipped above near the bottom edge', () => {
  const P = L.tipPlacement;
  assert.deepEqual(P({ x: 100, y: 60, w: 120, h: 18 }, { w: 672, h: 160 }), { left: 100, top: 78 });
  assert.deepEqual(P({ x: 640, y: 60, w: 120, h: 18 }, { w: 672, h: 160 }), { left: 548, top: 78 }, 'never past the right edge');
  assert.deepEqual(P({ x: 100, y: 150, w: 120, h: 18 }, { w: 672, h: 160 }), { left: 100, top: 124 }, 'near the bottom: above the pointer');
  assert.deepEqual(P({ x: -20, y: 10, w: 50, h: 18 }, { w: 672, h: 160 }), { left: 4, top: 28 }, 'never past the left edge');
});
test('wiring: ONE delegated tooltip in the island — shows on hover AND keyboard focus after a short delay, hides on leave/blur/Escape, role=tooltip, never steals clicks', () => {
  const lay = fs.readFileSync(path.join(frontend, 'island-layout.js'), 'utf8');
  assert.match(lay, /L\.tipFor\(/); assert.match(lay, /L\.tipPlacement\(/);
  assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), /id="island-tip" role="tooltip"/); assert.match(lay, /pointerover/); assert.match(lay, /focusin/); assert.match(lay, /Escape/);
  assert.equal(decls('#island-tip')['pointer-events'], 'none');
  assert.ok(decls('#island-tip')['z-index']);
  assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), /id="island-tip"/);
});

// ======== T1 · S1 (01 oculta A) + S2 (02 compacta A) ========================================================================
test('S1 edgeStripView: ONE strip whose colour is the most urgent state (reposo gris / pregunta cian / permiso ámbar / listo verde) and never colour alone', () => {
  assert.deepEqual(L.edgeStripView({}), { state: 'rest', pulse: false, aria: 'Koda, en reposo' });
  assert.deepEqual(L.edgeStripView({ pending: 'question' }), { state: 'question', pulse: true, aria: 'Koda: una pregunta espera' });
  assert.deepEqual(L.edgeStripView({ pending: 'approval' }), { state: 'approval', pulse: true, aria: 'Koda: un permiso espera' });
  assert.deepEqual(L.edgeStripView({ finished: true }), { state: 'finished', pulse: true, aria: 'Koda: algo terminó' });
  assert.equal(L.edgeStripView({ pending: 'question', finished: true }).state, 'question', 'pending beats finished');
  assert.equal(L.edgeStripView({ pending: 'approval', finished: true }).state, 'approval');
  assert.equal(L.edgeStripView({ pending: 'question', queued: 2 }).aria, 'Koda: 3 preguntas esperan', 'the aria says how many wait (the colour cannot)');
  assert.equal(L.edgeStripView(null).state, 'rest');
  assert.deepEqual(L.EDGE_STRIP, { w: 160, h: 3, zone: 8 });
});
test('S2 compactView: up to 3 coloured minis + «+N», the activity line from REAL data, the status badge, and the width it needs', () => {
  const rows = [row({ id: 's-0000000a', kindLabel: 'Pi', cwd: 'workspace', state: 'running', tools: { total: 2, steps: [{ index: 1, name: 'read', state: 'done' }, { index: 2, name: 'bash', state: 'running' }] }, color: 'green' }),
    row({ id: 's-0000000b', kindLabel: 'Claude Code', cwd: 'api', color: 'orange' }), row({ id: 's-0000000c', kindLabel: 'Codex', cwd: 'web', color: 'purple' }),
    row({ id: 's-0000000d', kindLabel: 'Gemini', cwd: 'docs', color: 'mint' }), row({ id: 's-0000000e', kindLabel: 'OpenCode', cwd: 'x', color: 'blue' })];
  const c = L.compactView({ rows, focusId: 's-0000000a', pending: null });
  assert.deepEqual(c.minis.map(m => [m.id, m.color]), [['s-0000000a', 'green'], ['s-0000000b', 'orange'], ['s-0000000c', 'purple']]);
  assert.equal(c.more, 2, '5 sessions: 3 minis + «+2»');
  assert.equal(c.activity, 'workspace · bash…', 'the real running tool of the focused session, never an invented verb');
  assert.equal(c.badge, 'working');
  assert.equal(c.width, 440);
  const idle = L.compactView({ rows: rows.slice(1, 2), focusId: 's-0000000b', pending: null });
  assert.deepEqual([idle.activity, idle.badge, idle.more, idle.minis.length], ['api', '', 0, 1], 'idle: the session name only, no «…» and no badge');
  const none = L.compactView({ rows: [], focusId: null, pending: null });
  assert.deepEqual([none.minis, none.more, none.activity, none.badge, none.width], [[], 0, '', '', 288], 'nothing running: the plain 288 pill');
  assert.equal(L.compactView({ rows, focusId: null, pending: { kind: 'question', agent: 'pi', text: '¿Qué editor?' } }).badge, 'question');
  const ask = L.compactView({ rows, focusId: null, pending: { kind: 'question', agent: 'pi', text: '¿Qué editor preferís?\nvim o emacs' } });
  assert.deepEqual([ask.width, ask.activity, ask.reply, ask.minis.length, ask.more], [560, '¿Qué editor preferís?', true, 0, 0], 'S3: a question widens the pill, shows its first line + «Responder», drops the minis');
  const perm = L.compactView({ rows: [], focusId: null, pending: { kind: 'question', agent: 'claude-code', text: 'Claude Code asks permission: Bash: rm -rf build/', options: [{ index: 0, label: 'Allow once' }, { index: 1, label: 'Deny' }] } });
  assert.equal(perm.badge, 'approval'); assert.match(perm.activity, /^Ejecutar: rm -rf build/);
  assert.equal(L.compactView({ rows, focusId: null, pending: null }).reply, false);
  assert.equal(L.compactView(null).width, 288);
});
test('HU-006 S4 compactView: a notice shows inside the compact pill without widening it; a waiting question still wins', () => {
  const done = L.compactView({ rows: [], focusId: null, pending: null, notice: { kind: 'settled', title: 'Terminó: tests verdes' } });
  assert.deepEqual([done.activity, done.badge, done.width, done.reply], ['Terminó: tests verdes', 'finished', 288, false]);
  const busy = [row({ id: 's-0000000a', kindLabel: 'Pi', cwd: 'workspace', state: 'running' })];
  const withRows = L.compactView({ rows: busy, focusId: 's-0000000a', pending: null, notice: { kind: 'attention', title: 'Codex te pide permiso' } });
  assert.deepEqual([withRows.activity, withRows.badge, withRows.width], ['Codex te pide permiso', 'attention', 440], 'same width as without the notice');
  const ask = L.compactView({ rows: busy, focusId: null, pending: { kind: 'question', agent: 'pi', text: '¿Seguro?' }, notice: { kind: 'settled', title: 'x' } });
  assert.deepEqual([ask.badge, ask.activity], ['question', '¿Seguro?']);
  const long = L.compactView({ rows: [], pending: null, notice: { kind: 'settled', title: 'x'.repeat(200) } });
  assert.ok(long.activity.length <= 44, 'bounded');
  for (const bad of [{ kind: 'evil', title: 'x' }, { kind: 'settled', title: 7 }, { kind: 'settled', title: '' }, 'text']) {
    const v = L.compactView({ rows: [], pending: null, notice: bad });
    assert.deepEqual([v.activity, v.badge], ['', ''], JSON.stringify(bad));
  }
  const css = fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  for (const kind of ['finished', 'attention']) assert.match(css, new RegExp(`#compact-badge\\[data-kind="${kind}"\\]::before`), kind);
});
test('S1/S2 wiring + CSS: the strip element, the 8px activation zone (24px hidden offset), the mini row and the activity line exist', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  for (const id of ['edge-strip', 'compact-activity', 'compact-badge']) assert.match(html, new RegExp(`id="${id}"`), id);
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(isl, /24 \* conceal\.target/, 'hidden = 24px up: 8px of activation zone stay under the pointer');
  assert.doesNotMatch(isl, /28 \* conceal/, 'the old 4px slice is gone');
  assert.match(isl, /abito:compact-view/);
  assert.match(isl, /compactW/);
  assert.equal(decls('#edge-strip').width, '160px'); assert.equal(decls('#edge-strip').height, '3px');
  assert.equal(decls('#capsule[data-edge-hidden="true"] #island').background, 'transparent', 'only the coloured thread is seen, not the black slice');
  for (const st of ['rest', 'question', 'approval', 'finished']) assert.ok(decls(`#edge-strip[data-state="${st}"]`).background, st);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[^}]*#edge-strip\[data-pulse="true"\]/, 'the slow pulse exists only when motion is allowed');
  assert.equal(decls('#mini-grid')['flex-direction'], 'row', 'a row of minis, not a 2x2 grid');
  assert.equal(decls('#capsule[data-phase="compact"] #mini-grid[data-count]:not([data-count="0"])').display, 'flex');
  assert.ok(decls('.mini-more'));
  assert.equal(decls('.compact-activity')['text-overflow'], 'ellipsis');
});

console.log(`island-layout-check: ${passed} checks ok`);
