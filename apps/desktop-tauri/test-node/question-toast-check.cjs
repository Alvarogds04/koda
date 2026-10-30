'use strict';
/* Sileo-style question toast — pure view model (no DOM). Run: node test-node/question-toast-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const T = require(path.join(frontend, 'question-toast.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const ID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const NOW = 1_000_000;
const pending = (over = {}) => ({ id: ID, kind: 'question', text: '¿Querés café o té?', agent: 'pi', agent_label: 'Pi', allow_free_text: false,
  options: [{ index: 0, label: 'Café', description: '' }, { index: 1, label: 'Té', description: '' }], expires_at: NOW + 60000, ...over });
const snap = (over = {}) => ({ available: true, pending: pending(), queued: [], queued_count: 0, notice: null, ...over });

test('a new pending question becomes a toast «<Agente> pregunta» with the first line of the text', () => {
  const v = T.toastView(snap(), { now: NOW });
  assert.deepEqual([v.id, v.kind, v.title, v.body, v.queue], [ID, 'question', 'Pi pregunta', '¿Querés café o té?', null]);
  assert.equal(v.tone, 'action');
  assert.match(v.aria, /Pi pregunta: ¿Querés café o té\?/);
  assert.match(v.aria, /Abrir/);
});

test('permission requests read as a permission and use the warning tone', () => {
  const v = T.toastView(snap({ pending: pending({ kind: 'approval', agent: 'claude-code', text: 'Bash: rm -rf node_modules', options: [{ index: 0, label: 'Permitir', description: '' }, { index: 1, label: 'Denegar', description: '' }] }) }), { now: NOW });
  assert.deepEqual([v.kind, v.title, v.tone], ['approval', 'Claude Code pide permiso', 'warning']);
});

test('only the first non-empty line, control characters flattened, bounded with an ellipsis', () => {
  assert.equal(T.toastView(snap({ pending: pending({ text: '\n\n  Primera línea\nsegunda' }) }), { now: NOW }).body, 'Primera línea');
  assert.equal(T.toastView(snap({ pending: pending({ text: 'a\u0000b\u202ec' }) }), { now: NOW }).body, 'a b c');
  const long = T.toastView(snap({ pending: pending({ text: 'x'.repeat(500) }) }), { now: NOW }).body;
  assert.ok(long.length <= 120 && long.endsWith('…'), long.length);
});

test('hidden when there is nothing to show: no pending, expired, or the island already shows the question', () => {
  assert.equal(T.toastView(snap({ pending: null }), { now: NOW }), null);
  assert.equal(T.toastView(null, { now: NOW }), null);
  assert.equal(T.toastView({ available: false }, { now: NOW }), null);
  assert.equal(T.toastView(snap({ pending: pending({ expires_at: NOW - 1 }) }), { now: NOW }), null, 'expired');
  assert.equal(T.toastView(snap(), { now: NOW, onScreen: true }), null, 'the card is on screen: no duplicate');
  assert.equal(T.toastView(snap({ pending: pending({ text: '' }) }), { now: NOW }), null, 'malformed pending is not a toast');
  assert.equal(T.toastView(snap({ notice: 'answered', pending: null }), { now: NOW }), null, 'answered/cancelled outcomes hide it');
});

test('the human can dismiss one toast (Esc) without answering; a different question shows again', () => {
  assert.equal(T.toastView(snap(), { now: NOW, dismissedId: ID }), null);
  assert.ok(T.toastView(snap(), { now: NOW, dismissedId: '11111111-1111-4111-8111-111111111111' }));
});

test('designed for the queue: «1 de N» when the snapshot carries queued_count', () => {
  assert.equal(T.toastView(snap({ queued_count: 2 }), { now: NOW }).queue, '1 de 3');
  assert.equal(T.toastView(snap({ queued_count: 0 }), { now: NOW }).queue, null);
  assert.equal(T.toastView(snap({ queued_count: -4 }), { now: NOW }).queue, null);
  assert.equal(T.toastView(snap({ queued_count: 'x' }), { now: NOW }).queue, null);
  assert.match(T.toastView(snap({ queued_count: 1 }), { now: NOW }).aria, /1 de 2/);
});

test('opening needs a trusted click and returns only the live id; a synthetic event opens nothing', () => {
  const v = T.toastView(snap(), { now: NOW });
  assert.deepEqual(T.openRequest({ isTrusted: true }, v), { id: ID });
  assert.equal(T.openRequest({ isTrusted: false }, v), null);
  assert.equal(T.openRequest(null, v), null);
  assert.equal(T.openRequest({ isTrusted: true }, null), null);
});

test('the toast never carries an answer: the view has no option list, no send, no decision', () => {
  const v = T.toastView(snap(), { now: NOW });
  for (const key of Object.keys(v)) assert.doesNotMatch(key, /option|answer|decision|send/i, key);
});

test('input region: the island shape grows to include the toast (the host region is a single rectangle)', () => {
  assert.deepEqual(T.shapeWithToast([288, 32], false), [288, 32]);
  const [w, h] = T.shapeWithToast([288, 32], true);
  assert.equal(w, 350);
  assert.equal(h, 32 + T.TOAST.gap + T.TOAST.hMax);
  assert.deepEqual(T.shapeWithToast([720, 184], true), [720, 184 + T.TOAST.gap + T.TOAST.hMax]);
});

test('reveal policy: a new question shows the toast; it no longer expands the island by itself', () => {
  assert.equal(T.revealByToast({ phase: 'compact' }), true);
  assert.equal(T.revealByToast({ phase: 'expanded' }), false, 'expanded: the card itself is the signal');
});

test('Sileo port is vanilla: spring linear() easing, 350x40 pill, gooey filter, no React/npm, reduced motion respected', () => {
  const css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.match(css, /--sileo-spring-easing:\s*linear\(/);
  assert.match(css, /width:\s*350px/);
  assert.match(css, /height:\s*40px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /html\[data-motion="reduce"\]/);
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(js, /feGaussianBlur/);
  assert.match(js, /feColorMatrix/);
  assert.doesNotMatch(js, /require\((['"])react|from ['"]react|import\(/);
  assert.match(js, /textContent/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(js, /event\.isTrusted|isTrusted/);
  assert.match(js, /Escape/);
});

test('wiring: shipped in the page and the package, positioned under the island, opens the island on a trusted click, reports its shape', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="question-toast\.css">/);
  assert.match(html, /<script defer src="question-toast\.js"><\/script>/);
  assert.ok(html.indexOf('notify-view.js') < html.indexOf('question-toast.js'), 'the pure notify view loads first');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'lib.cjs'), 'utf8');
  assert.match(lib, /'question-toast\.css'/); assert.match(lib, /'question-toast\.js'/);
  const toast = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(toast, /getBoundingClientRect/);
  const isl = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(isl, /addEventListener\('abito:question-open'/);
  assert.match(isl, /window\.desktop\.expand\(\)/);
  assert.match(isl, /addEventListener\('abito:question-toast'/);
  assert.match(isl, /shapeWithToast/);
  assert.match(isl, /revealByToast/);
});

// ---- Sileo motion, ported (hiaaryan/sileo sileo.tsx + constants.ts): the pill MORPHS OUT of the island's bottom edge ------------------
test('spring: motion\'s spring(duration 0.6, bounce 0.25) = damping ratio 0.75, omega 2*pi/0.6; starts at 0, overshoots a little, settles at 1', () => {
  assert.deepEqual(T.SPRING, { duration: 0.6, bounce: 0.25 });
  assert.equal(T.springAt(0), 0);
  assert.equal(T.springAt(-1), 0);
  const samples = Array.from({ length: 200 }, (_, i) => T.springAt(i * 0.01));
  const peak = Math.max(...samples);
  assert.ok(peak > 1.01 && peak < 1.12, `a small overshoot (Sileo bounce), got ${peak}`);
  assert.ok(T.springAt(0.2) > 0.4 && T.springAt(0.2) < 1, 'most of the travel in the first third');
  assert.ok(Math.abs(T.springAt(2) - 1) < 1e-3, 'settled');
  assert.equal(T.springAt(10), 1, 'at rest it is exactly the target');
  assert.ok(Math.abs(T.springAt(0.3, { duration: 0.6, bounce: 0 }) - T.springAt(0.3, { duration: 0.6, bounce: 0 })) === 0 && T.springAt(0.3, { duration: 0.6, bounce: 0 }) <= 1, 'no bounce: never past the target');
  for (const bad of [NaN, Infinity, 'x', undefined]) assert.equal(T.springAt(bad), 0, String(bad));
});
test('morphFrame: at progress 0 the pill IS the island\'s bottom edge (same width, no gap); at 1 it is the content-wide pill centred under it', () => {
  const island = { w: 288, r: 14 };
  const a = T.morphFrame({ progress: 0, island, pillW: 150, open: false });
  assert.equal(a.neck.width, 288 - 2 * 14, 'the neck is the island\'s flat bottom edge (corner radii excluded)');
  assert.equal(a.pill.width, a.neck.width, 'starts exactly as wide as the edge it comes out of: the gooey filter joins them with no gap');
  assert.equal(a.pill.y + a.pill.height, 0, 'and its bottom is the island\'s bottom edge');
  const z = T.morphFrame({ progress: 1, island, pillW: 150, open: false });
  assert.deepEqual([z.pill.width, z.pill.height, z.pill.y], [150, T.TOAST.h, 0]);
  assert.equal(z.pill.x, (T.TOAST.w - 150) / 2, 'centred like the island');
  assert.ok(z.neck.y + z.neck.height <= 0.0001, 'the neck stays inside the island: it never draws below its bottom edge');
  assert.equal(z.body.height, 0, 'collapsed: no body');
  const over = T.morphFrame({ progress: 1.04, island, pillW: 150, open: false });
  assert.ok(over.pill.width < 150, 'the spring overshoot is allowed: it travels past the target in its own direction (260 -> 150 -> a bit under)');
  const wide = T.morphFrame({ progress: 1.04, island: { w: 100, r: 14 }, pillW: 150, open: false });
  assert.ok(wide.pill.width > 150, 'and past it upwards when the island is narrower than the pill');
});
test('morphFrame: expanding opens the 350px body below the pill; the neck always follows the CURRENT island width', () => {
  const open = T.morphFrame({ progress: 1, island: { w: 640, r: 14 }, pillW: 150, open: true });
  assert.equal(open.body.height, T.TOAST.hMax - T.TOAST.h);
  assert.equal(open.body.width, T.TOAST.w);
  assert.equal(open.neck.width, 640 - 28, 'a wider island, a wider neck');
  assert.equal(open.neck.x, (T.TOAST.w - (640 - 28)) / 2, 'centred on the toast axis (negative x is fine: the SVG overflows)');
  const half = T.morphFrame({ progress: 0.5, island: { w: 640, r: 14 }, pillW: 150, open: true });
  assert.ok(half.pill.width < 612 && half.pill.width > 150, 'the pill is still travelling');
  assert.ok(T.morphFrame({ progress: 1, island: { w: 640, r: 14 }, pillW: 10, open: false }).pill.width >= T.TOAST.h, 'never narrower than its height');
  assert.ok(T.morphFrame({ progress: 1, island: { w: 640, r: 14 }, pillW: 9999, open: false }).pill.width <= T.TOAST.w, 'never wider than the toast');
});
test('reduced motion: the toast does not travel — it appears in place and only fades', () => {
  const r = T.morphFrame({ progress: 0, island: { w: 288, r: 14 }, pillW: 150, open: false, reduce: true });
  assert.deepEqual([r.pill.width, r.pill.height], [150, T.TOAST.h], 'the final geometry straight away');
  assert.deepEqual(T.motionPlan(true), { mode: 'fade', springs: false });
  assert.deepEqual(T.motionPlan(false), { mode: 'morph', springs: true });
});
test('flush under the island: no gap, centred on it, and it moves with the island (offset follows the island\'s own bottom edge)', () => {
  assert.equal(T.TOAST.gap, 0, 'touching the island\'s bottom edge');
  assert.deepEqual(T.toastTop({ top: 0, height: 160 }), 160);
  assert.deepEqual(T.toastTop({ top: 2, height: 32 }), 34);
  assert.equal(T.toastTop({ top: -26, height: 32 }), 6, 'an island concealed to the edge pulls the toast up with it');
  for (const bad of [null, undefined, {}, { top: NaN, height: 5 }]) assert.equal(T.toastTop(bad), 0, JSON.stringify(bad));
  assert.deepEqual(T.shapeWithToast([288, 32], true), [350, 32 + T.TOAST.hMax], 'the input region has no dead band between island and toast');
});
test('wiring: the toast follows the island with a ResizeObserver (every frame of its spring), reads its radius, and starts from its edge', () => {
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(js, /new ResizeObserver\(/);
  assert.match(js, /observe\(island\)/);
  assert.match(js, /T\.toastTop\(/);
  assert.match(js, /T\.morphFrame\(/);
  assert.match(js, /T\.springAt\(/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /T\.motionPlan\(/);
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)|dataset\.motion === 'reduce'/);
  assert.doesNotMatch(js, /follow = requestAnimationFrame\(step\)|performance\.now\(\) \+ 900/, 'no fixed 900 ms tracking window that stops following the island');
  const css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.doesNotMatch(css, /top: 48px/, 'no hardcoded position: it is the island\'s edge');
  assert.match(css, /\.q-toast-neck/);
});

// ---- T2: finished + terminal outcomes as informational Sileo toasts (S3-S5) ------------------------------------------------------
const N = require(path.join(frontend, 'notify-view.js'));
const settled = (over = {}) => ({ id: '5c1f8f0e-3b52-4f7e-8d0a-0a9b7c6d5e4f', kind: 'settled', title: 'Terminó la revisión', agent: 'codex', projectName: 'abito', ...over });
test('T2 finished: «<Agente> terminó» is informational — no success claim, not actionable, no open request', () => {
  const v = T.finishedToast(settled());
  assert.deepEqual([v.kind, v.title, v.body, v.actionable, v.tone], ['finished', 'Codex terminó', 'Terminó la revisión', false, 'neutral']);
  assert.match(v.aria, /resultado no está confirmado/);
  assert.doesNotMatch(JSON.stringify(v), /éxito|exitos|correct|listo|ok\b/i);
  assert.equal(T.openRequest({ isTrusted: true }, v), null, 'a trusted click on a non-actionable toast opens nothing');
  assert.equal(v.ms, T.TOAST.transientMs);
  assert.ok(T.TOAST.transientMs < T.TOAST.ms, 'informational toasts are shorter than the 8 s action toast');
});
test('T2 finished: no agent -> generic wording (never a made-up «Pi»); other kinds and malformed notices are not finished toasts', () => {
  assert.equal(T.finishedToast(settled({ agent: undefined })).title, 'Una tarea terminó');
  assert.equal(T.finishedToast(settled({ agent: 'Bad Slug!' })).title, 'Una tarea terminó');
  for (const bad of [null, {}, settled({ id: '' }), settled({ kind: 'attention' }), settled({ kind: 'transport' }), settled({ title: '', projectName: '' })]) assert.equal(T.finishedToast(bad), null, JSON.stringify(bad));
  assert.equal(T.finishedToast(settled({ title: 'a\u202eb\nsecond' })).body, 'a b', 'control chars flattened, first line only');
});
test('F6 attention: a Codex «te pide permiso» notice becomes a Sileo pill that only points to the terminal (SN1)', () => {
  const a = { id: '7d3c2b1a-0f9e-4d8c-b7a6-5f4e3d2c1b0a', kind: 'attention', title: 'Codex te pide permiso', detail: 'Bash: npm install · Respondé en la terminal', agent: 'codex', projectName: 'abito' };
  const v = T.attentionToast(a);
  assert.deepEqual([v.kind, v.title, v.body, v.actionable, v.tone], ['attention', 'Codex te pide permiso', 'Bash: npm install · Respondé en la terminal', false, 'warning']);
  assert.equal(T.openRequest({ isTrusted: true }, v), null, 'never an answer surface: the terminal decides');
  assert.equal(T.abitoPose(v), 'approval', 'Abito reacts as a permission request');
  assert.equal(T.attentionToast({ ...a, detail: '' }).body, 'Respondé en la terminal');
  for (const bad of [null, {}, { ...a, kind: 'settled' }, { ...a, id: '' }, { ...a, title: '' }]) assert.equal(T.attentionToast(bad), null, JSON.stringify(bad));
});
test('T2 outcomes: expired/cancelled/disconnected/busy map to non-actionable toasts; sent/answered/human_cancelled/rejected never do', () => {
  for (const [o, title] of [['expired', 'Pregunta vencida'], ['cancelled', 'Pregunta cancelada'], ['disconnected', 'Conexión cortada'], ['busy', 'Pregunta rechazada']]) {
    const v = T.outcomeToast({ outcome: o, agent: 'claude-code' }, 1);
    assert.deepEqual([v.kind, v.title, v.actionable], [o, title, false], o);
    assert.equal(T.openRequest({ isTrusted: true }, v), null, o);
    assert.notEqual(v.id, T.outcomeToast({ outcome: o, agent: 'claude-code' }, 2).id, 'each event is distinct');
  }
  assert.match(T.outcomeToast({ outcome: 'expired', agent: 'claude-code' }, 1).body, /Claude Code/);
  assert.match(T.outcomeToast({ outcome: 'busy', agent: null }, 1).body, /ya había una abierta/);
  assert.equal(T.outcomeToast({ outcome: 'expired', agent: null }, 1).body, 'La pregunta venció sin respuesta');
  assert.equal(T.outcomeToast({ outcome: 'cancelled', agent: null }, 1).body, 'El agente retiró la pregunta');
  for (const o of ['sent', 'answered', 'human_cancelled', 'rejected', 'ack_lost', 'outcome_unknown', 'nope', undefined]) assert.equal(T.outcomeToast({ outcome: o, agent: 'pi' }, 1), null, String(o));
  assert.equal(T.outcomeToast(null, 1), null);
});
test('T2 shared code: question and permission toasts keep their title, tone, queue and trusted open (pinned)', () => {
  const q = T.toastView(snap({ queued_count: 1 }), { now: NOW });
  assert.deepEqual([q.title, q.tone, q.queue, q.actionable, q.ms], ['Pi pregunta', 'action', '1 de 2', true, T.TOAST.ms]);
  assert.deepEqual(T.openRequest({ isTrusted: true }, q), { id: ID });
  assert.equal(T.toastView(snap({ pending: pending({ kind: 'approval', options: [{ index: 0, label: 'Permitir', description: '' }, { index: 1, label: 'Denegar', description: '' }] }) }), { now: NOW }).tone, 'warning');
  assert.equal(T.openRequest({ isTrusted: false }, q), null);
});
test('T2 wiring: the same renderer shows transients; they never outrank a pending toast, keep the timers, and honour dismiss', () => {
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8');
  assert.match(js, /abito:notice-arrival/);
  assert.match(js, /N\.outcomeEvent\(prev, next\)/);
  assert.match(js, /pendingToast \|\| /, 'pending first');
  assert.match(js, /dismissedId !== transientView\.id/);
  assert.match(js, /view\.ms/, 'the countdown follows the view lifetime');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
  const css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.match(css, /data-state="neutral"/);
  assert.match(css, /data-actionable="false"/);
});

// ---- mounted regression: the real notify-view.js + question-toast.js in a vm sandbox with a fake DOM and a controlled clock ------
// (no browser). Asserts only what the user sees: toast hidden/visible, its title, and the shown events the host sizes its input region by.
const vm = require('node:vm');
function boot(initial, opts = {}) {
  let now = NOW, seq = 1; const timers = new Map(), docEvents = {}, dispatched = [], tauri = {};
  const el = tag => { const ls = {}; const e = { tag, children: [], style: { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; } }, dataset: {}, hidden: false, textContent: '', scrollWidth: 120, offsetWidth: 10, ownerDocument: null,
    appendChild(n) { e.children.push(n); return n; }, remove() {},
    setAttribute(k, v) { (e.attrs ||= {})[k] = String(v); }, getAttribute: k => (e.attrs || {})[k], append(...n) { e.children.push(...n.filter(Boolean)); }, replaceChildren(...n) { e.children = n; },
    addEventListener(n, f) { (ls[n] ||= []).push(f); }, getBoundingClientRect: () => ({ top: 0, height: 40, width: 288 }), fire(n, ev) { (ls[n] || []).forEach(f => f(ev)); } }; return e; };
  const set = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) }); return id; };
  const advance = ms => { const end = now + ms; for (let g = 0; g < 20000; g++) { const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); } now = end; };
  const capsule = el('div'), island = el('div');
  // human (26-oct): Sileo toasts only while Abito is HIDDEN at the edge; the mounted cases default to that (opts.visible = island shown)
  capsule.dataset.edgeHidden = opts.visible ? 'false' : 'true';
  let doc0 = null; const mkEl = tag => { const e = el(tag); e.ownerDocument = doc0; return e; };
  const document = { documentElement: { dataset: {} }, getElementById: id => (id === 'capsule' ? capsule : id === 'island' ? island : null), createElement: mkEl, createElementNS: (_n, t) => mkEl(t), importNode: n => n,
    addEventListener(n, f) { (docEvents[n] ||= []).push(f); }, dispatchEvent(ev) { dispatched.push(ev); (docEvents[ev.type] || []).forEach(f => f(ev)); return true; } };
  doc0 = document;
  const sb = { document, performance: { now: () => now }, Date: { now: () => now }, setTimeout: set, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = seq++; const tick = () => { if (!timers.has(id)) return; fn(); timers.set(id, { fn: tick, at: now + ms }); }; timers.set(id, { fn: tick, at: now + ms }); return id; },
    requestAnimationFrame: fn => set(() => fn(now), 16), cancelAnimationFrame: id => timers.delete(id), addEventListener() {},
    matchMedia: () => ({ matches: !!opts.reduced, addEventListener() {} }), getComputedStyle: () => ({ borderBottomLeftRadius: '14px' }),
    DOMParser: class { parseFromString() { return { documentElement: { nodeName: 'svg' } }; } }, CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} }, console, Math, Number, String, Object, Array, JSON, RegExp, Set, Map, Promise, Error, Boolean, Symbol, parseInt, parseFloat, isNaN, isFinite,
    __TAURI__: { core: { invoke: opts.invoke || (async () => initial) }, event: { listen: async (n, f) => { (tauri[n] ||= []).push(f); return () => {}; } } } };
  sb.window = sb.self = sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  for (const f of [...(opts.abito ? ['clay-engine.js', 'character-motion.js'] : []), 'notify-view.js', 'island-layout.js', 'question-toast.js']) { if (f === 'question-toast.js') sb.AbitoIcons = { svg: n => `<svg data-icon="${n}"></svg>` }; vm.runInContext(fs.readFileSync(path.join(frontend, f), 'utf8'), ctx, { filename: f }); }
  const toast = capsule.children.find(c => c.tag === 'button');
  return { toast, capsule, advance, ctx, badge: () => toast.children[1].children[0], abitoFrames: () => vm.runInContext('AbitoClay.frames', ctx), title: () => (toast.hidden ? null : toast.children[1].children[1].textContent), emit: s => (tauri['question:state'] || []).forEach(f => f({ payload: s })),
    arrive: n => (docEvents['abito:notice-arrival'] || []).forEach(f => f({ detail: n })), key: k => toast.fire('keydown', { key: k, preventDefault() {}, stopPropagation() {} }),
    shown: () => dispatched.filter(e => e.type === 'abito:question-toast').map(e => e.detail.shown), docEvents,
    actions: capsule.children.find(c => c.id === 'question-toast-actions'), doc: document, island, ls: undefined };
}
const settledArrival = (over = {}) => ({ id: '5c1f8f0e-3b52-4f7e-8d0a-0a9b7c6d5e4f', kind: 'settled', title: 'Terminó la revisión', agent: 'codex', projectName: 'abito', ...over });
const SNAP_NOW = () => snap({ pending: pending({ expires_at: NOW + 600000 }) });
const none = n => snap({ pending: null, notice: n });
const mounted = [];
const mtest = (name, fn) => mounted.push([name, fn]);

mtest('M1 info event while the pending toast is showing is dropped: answering later reveals nothing stale', async () => {
  const r = boot(SNAP_NOW()); await Promise.resolve(); await Promise.resolve();
  assert.equal(r.title(), 'Pi pregunta');
  r.arrive(settledArrival());
  assert.equal(r.title(), 'Pi pregunta', 'pending keeps priority');
  r.advance(3000); r.emit(none('sent')); r.advance(400);
  assert.equal(r.toast.hidden, true, `a dropped «terminó» must not appear after the answer; saw ${r.title()}`);
});
mtest('M2 a pending toast replacing an informational toast discards it for good', async () => {
  const r = boot(none(null)); await Promise.resolve(); await Promise.resolve();
  r.arrive(settledArrival()); assert.equal(r.title(), 'Codex terminó');
  r.emit(SNAP_NOW()); assert.equal(r.title(), 'Pi pregunta');
  r.advance(2000); r.emit(none('answered')); r.advance(400);
  assert.equal(r.toast.hidden, true, `the superseded «terminó» must not come back; saw ${r.title()}`);
});
mtest('M3 (human 26-oct) Abito visible: no Sileo toast at all — the card/island shows it; informational events are dropped, not queued', async () => {
  const r = boot(SNAP_NOW(), { visible: true }); await Promise.resolve(); await Promise.resolve();
  r.capsule.dataset.phase = 'expanded'; r.emit(SNAP_NOW()); r.advance(400);
  assert.equal(r.toast.hidden, true, 'the card is on screen: no pending toast');
  r.arrive(settledArrival()); r.advance(50);
  assert.equal(r.toast.hidden, true, 'island visible: no «terminó» toast');
  r.emit(none('expired')); r.advance(50);
  assert.equal(r.toast.hidden, true, 'island visible: no outcome toast');
  r.capsule.dataset.edgeHidden = 'true'; r.emit(none('expired')); r.advance(400);
  assert.equal(r.toast.hidden, true, 'hiding later does not replay a dropped event');
});
mtest('M3b (human 26-oct) compact island visible (no question on its pill): an informational event shows NO toast', async () => {
  const r = boot(none(null), { visible: true }); await Promise.resolve(); await Promise.resolve();
  r.capsule.dataset.phase = 'compact'; r.arrive(settledArrival()); r.advance(50);
  assert.equal(r.toast.hidden, true);
});
mtest('M3c (human 26-oct) a pending question while Abito is visible as a compact pill without its ask: still no toast', async () => {
  const r = boot(SNAP_NOW(), { visible: true }); await Promise.resolve(); await Promise.resolve();
  r.capsule.dataset.phase = 'compact'; r.emit(SNAP_NOW()); r.advance(400);
  assert.equal(r.toast.hidden, true);
  r.capsule.dataset.edgeHidden = 'true'; r.emit(SNAP_NOW()); r.advance(400);
  assert.equal(r.toast.hidden, false, 'hidden: the pending question toast appears');
});
mtest('M4 pending toast dismissed with Esc (not visible): info event shows', async () => {
  const r = boot(SNAP_NOW()); await Promise.resolve(); await Promise.resolve();
  r.key('Escape'); r.advance(400); assert.equal(r.toast.hidden, true);
  r.arrive(settledArrival()); assert.equal(r.title(), 'Codex terminó');
});
mtest('M5 ordinary info toast alone lives 5.2 s and an outcome edge is shown; a busy edge under a showing pending toast is dropped', async () => {
  const r = boot(none(null)); await Promise.resolve(); await Promise.resolve();
  r.arrive(settledArrival()); r.advance(5100); assert.equal(r.title(), 'Codex terminó'); r.advance(100 + 400); assert.equal(r.toast.hidden, true);
  r.emit(snap({ pending: pending({ expires_at: NOW + 600000 }), notice: 'busy' })); assert.equal(r.title(), 'Pi pregunta');
  r.emit(none('answered')); r.advance(400); assert.equal(r.toast.hidden, true, 'busy was dropped, not queued');
  r.emit(SNAP_NOW()); r.emit(none('expired')); assert.equal(r.title(), 'Pregunta vencida');
});
mtest('M6 pending question and permission toasts stay up past 8 s, actionable, and keep the host region signal', async () => {
  for (const over of [{}, { kind: 'approval', text: 'Bash: ls' }]) {
    const r = boot(snap({ pending: pending({ expires_at: NOW + 600000, ...over }) })); await Promise.resolve(); await Promise.resolve();
    r.advance(9000); assert.equal(r.toast.hidden, false);
    assert.equal(r.toast.dataset.actionable, 'true'); assert.equal(r.toast.dataset.expanded, 'false', 'the body folds after 8 s, the pill stays');
    r.toast.fire('click', { isTrusted: true });
    assert.equal(r.shown().at(-1), true);
    r.emit(none('answered')); r.advance(400); assert.equal(r.toast.hidden, true); assert.equal(r.shown().at(-1), false);
  }
});

// ---- T3: the REAL Abito (clay-engine + character-motion) on the left of the toast, with a state-appropriate pose --------------------
// Observable effects only: what sits in the badge, the pose it shows, whether the shared clay loop keeps rendering.
const abitoBoot = (initial, opts = {}) => boot(initial, { abito: true, ...opts });
const ready = async () => { await Promise.resolve(); await Promise.resolve(); };
const hasAbito = r => !!r.badge().children.find(c => c.tag === 'svg' && c.children.some(n => n.attrs && Object.hasOwn(n.attrs, 'data-abito-body')));
const appr = { kind: 'approval', text: 'Bash: ls', options: [{ index: 0, label: 'Permitir', description: '' }, { index: 1, label: 'Denegar', description: '' }] };
mtest('T3-1 the badge on the LEFT of the header is the actual Abito character (clay-engine SVG), not a generic icon', async () => {
  const r = abitoBoot(SNAP_NOW()); await ready();
  assert.equal(r.toast.children[1].children[0], r.badge(), 'the badge is the first (left-most) header item');
  assert.equal(hasAbito(r), true, 'engine body path is inside the badge');
  assert.equal(r.badge().children.some(c => c.attrs && c.attrs['data-icon']), false);
  assert.equal(r.badge().getAttribute('aria-hidden'), 'true', 'decorative: the toast button keeps its own aria-label');
  assert.match(r.toast.getAttribute('aria-label'), /Pi pregunta/);
});
mtest('T3-2 pose follows the real state: question / permission / finished / expired / cancelled / disconnected / busy; never a success pose', async () => {
  const seen = {};
  let r = abitoBoot(SNAP_NOW()); await ready(); seen.question = r.badge().dataset.pose;
  r = abitoBoot(snap({ pending: pending({ expires_at: NOW + 600000, ...appr }) })); await ready(); seen.approval = r.badge().dataset.pose;
  r = abitoBoot(none(null)); await ready(); r.arrive(settledArrival()); seen.finished = r.badge().dataset.pose;
  for (const o of ['expired', 'cancelled', 'disconnected']) { r = abitoBoot(none(null)); await ready(); r.emit(SNAP_NOW()); r.emit(none(o)); seen[o] = r.badge().dataset.pose; }
  r = abitoBoot(snap({ pending: null, notice: null })); await ready(); r.emit(snap({ pending: null, notice: 'busy' })); seen.busy = r.badge().dataset.pose;
  assert.deepEqual(seen, { question: 'question', approval: 'approval', finished: 'finished', expired: 'sleeping', cancelled: 'idle', disconnected: 'error', busy: 'reject' });
  for (const pose of Object.values(seen)) assert.ok(!['confirm', 'happy', 'proud', 'love', 'speak'].includes(pose), `${pose} would read as success/celebration`);
});
mtest('T3-3 the character is really animated: shared clay frames advance and the SVG contour changes while the toast shows', async () => {
  const r = abitoBoot(SNAP_NOW()); await ready();
  const body = () => r.badge().children[0].children.find(n => n.attrs && Object.hasOwn(n.attrs, 'data-abito-body'));
  r.advance(100); const d0 = body().attrs.d, f0 = r.abitoFrames();
  r.advance(600);
  assert.ok(r.abitoFrames() > f0, 'frames are scheduled while the toast is visible');
  assert.notEqual(body().attrs.d, d0, 'contour moved');
});
mtest('T3-4 hidden/disposed toast stops rendering: no engine frames, no leftover character, and a new toast gets a fresh one', async () => {
  const r = abitoBoot(SNAP_NOW()); await ready(); r.advance(300);
  r.emit(none('answered')); r.advance(400);
  assert.equal(r.toast.hidden, true); assert.equal(hasAbito(r), false, 'character removed with the toast');
  const f = r.abitoFrames(); r.advance(2000);
  assert.equal(r.abitoFrames(), f, 'the shared clay loop is idle once nothing visible needs it');
  r.emit(SNAP_NOW()); r.advance(100);
  assert.equal(hasAbito(r), true); assert.equal(r.badge().children.length, 1, 'exactly one character'); assert.ok(r.abitoFrames() > f);
  r.key('Escape'); r.advance(400);
  const g = r.abitoFrames(); r.advance(1000); assert.equal(r.abitoFrames(), g, 'Esc-dismissed toast also stops rendering');
});
mtest('T3-5 a pending question replacing «terminó» swaps the pose on the same single character', async () => {
  const r = abitoBoot(none(null)); await ready(); r.arrive(settledArrival());
  assert.equal(r.badge().dataset.pose, 'finished');
  r.emit(SNAP_NOW()); r.advance(50);
  assert.equal(r.badge().dataset.pose, 'question'); assert.equal(r.badge().children.length, 1);
});
mtest('T3-6 reduced motion: Abito shows its static pose, no frames are scheduled; toast behaviour unchanged', async () => {
  const r = abitoBoot(SNAP_NOW(), { reduced: true }); await ready(); r.advance(2000);
  assert.equal(hasAbito(r), true); assert.equal(r.badge().dataset.pose, 'question');
  assert.equal(r.abitoFrames(), 0, 'no animation frames under reduced motion');
  assert.equal(r.toast.dataset.actionable, 'true'); assert.equal(r.toast.hidden, false);
});
mtest('F6 an attention arrival shows the pill with the producer text; a pending question still outranks it', async () => {
  const r = boot(none(null)); await Promise.resolve(); await Promise.resolve();
  r.arrive({ id: '7d3c2b1a-0f9e-4d8c-b7a6-5f4e3d2c1b0a', kind: 'attention', title: 'Codex te pide permiso', detail: 'Bash: ls · Respondé en la terminal', agent: 'codex' });
  assert.equal(r.title(), 'Codex te pide permiso'); assert.equal(r.toast.dataset.actionable, 'false');
  r.emit(SNAP_NOW()); assert.equal(r.title(), 'Pi pregunta', 'an answerable question keeps priority');
});
mtest('T3-7 no Abito engine available: the generic icon is the fallback and the toast still works', async () => {
  const r = boot(SNAP_NOW()); await ready();
  assert.equal(r.badge().children.length, 1); assert.equal(r.badge().children[0].nodeName || 'svg', 'svg');
  assert.equal(r.toast.hidden, false); assert.equal(r.title(), 'Pi pregunta');
});


// ---- HU-063 T3: the toast's Aprobar/Rechazar buttons (risk item 2). Same host path as the card; every guarantee has a negative test. ----
const PERM = (over = {}) => pending({ kind: 'approval', text: 'Permiso para ejecutar: ls', options: [{ index: 0, label: 'Aprobar', description: '' }, { index: 1, label: 'Rechazar', description: '' }], expires_at: NOW + 600000, ...over });
const PSNAP = (over = {}) => snap({ pending: PERM(), ...over });
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
async function decideBoot(initial, opts = {}) {
  const calls = []; let behave = opts.behave || (() => Promise.resolve({}));
  const r = boot(initial, { ...opts, invoke: (cmd, arg) => { if (arg && arg.payload && arg.payload.action === 'view') return Promise.resolve(initial); calls.push({ cmd, arg }); return behave(); } });
  await Promise.resolve(); await Promise.resolve();
  r.calls = calls; r.setBehave = f => { behave = f; };
  r.advance(800); // the body unfolds by itself shortly after arriving; the buttons arm after 500 ms
  const [reject, approve] = r.actions.children;
  r.reject = reject; r.approve = approve;
  r.click = (b, trusted = true) => b.fire('click', { isTrusted: trusted, preventDefault() {}, stopPropagation() {} });
  return r;
}
const T3 = (n, fn) => mtest(`HU-063 T3 ${n}`, fn);
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

T3('buttons exist only for the actionable permission; plain question has none and keeps open-the-island', async () => {
  const r = await decideBoot(PSNAP());
  assert.equal(r.toast.dataset.expanded, 'true'); assert.equal(r.actions.hidden, false);
  assert.equal(r.actions.attrs.role, 'group'); assert.equal(r.actions.attrs['aria-label'], 'Decidir el permiso');
  assert.deepEqual([r.reject.textContent, r.approve.textContent, r.reject.type, r.approve.type], ['Rechazar', 'Aprobar', 'button', 'button']);
  const q = await decideBoot(SNAP_NOW());
  assert.equal(q.actions.hidden, true, 'plain question: no buttons');
  const opened = []; q.docEvents['abito:question-open'] = [e => opened.push(e.detail)];
  q.toast.fire('click', { isTrusted: true }); assert.equal(JSON.stringify(opened), JSON.stringify([{ id: ID }]));
  const lossy = await decideBoot(PSNAP({ pending: pending({ kind: 'question', text: 'Claude Code pide permiso para Bash: ls (detalles solo en la terminal; decidir en la terminal)', options: [{ index: 0, label: 'Aprobar una vez' }, { index: 1, label: 'Rechazar' }], expires_at: NOW + 600000 }) }));
  assert.equal(lossy.actions.hidden, true, 'lossy: no buttons');
  const hook = await decideBoot(PSNAP({ pending: pending({ kind: 'question', text: 'Claude Code pide permiso para Bash: ls', options: [{ index: 0, label: 'Aprobar una vez' }, { index: 1, label: 'Rechazar' }], expires_at: NOW + 600000 }) }));
  assert.equal(hook.actions.hidden, false); assert.equal(hook.approve.textContent, 'Aprobar una vez');
  const hidden = await decideBoot(none(null)); assert.equal(hidden.actions.hidden, true);
});
T3('exact payloads: Aprobar = answer{id,index}, Rechazar = answer{id,index} (same as the card), by label not position', async () => {
  const r = await decideBoot(PSNAP({ pending: PERM({ options: [{ index: 4, label: 'Rechazar', description: '' }, { index: 9, label: 'Aprobar', description: '' }] }) }));
  r.click(r.approve); await flush();
  assert.equal(JSON.stringify(r.calls), JSON.stringify([{ cmd: 'question_action', arg: { payload: { action: 'answer', id: ID, index: 9 } } }]));
  const d = await decideBoot(PSNAP()); d.click(d.reject); await flush();
  assert.equal(JSON.stringify(d.calls), JSON.stringify([{ cmd: 'question_action', arg: { payload: { action: 'answer', id: ID, index: 1 } } }]));
});
T3('a synthetic (untrusted) click sends nothing', async () => {
  const r = await decideBoot(PSNAP());
  r.click(r.approve, false); r.click(r.reject, false); r.approve.fire('click', {}); r.approve.fire('click', { isTrusted: 'true' });
  await flush(); assert.equal(r.calls.length, 0); assert.equal(r.approve.disabled, false);
});
T3('inert when the snapshot changed id, expired, left idle, or the card took over: nothing is sent', async () => {
  let r = await decideBoot(PSNAP()); r.emit(PSNAP({ pending: PERM({ id: OTHER_ID }) })); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'id changed');
  r = await decideBoot(PSNAP()); r.emit(PSNAP({ pending: PERM({ expires_at: NOW - 1 }) })); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'expired');
  r = await decideBoot(PSNAP()); r.advance(700000); r.click(r.reject); await flush(); assert.equal(r.calls.length, 0, 'expired by the clock');
  r = await decideBoot(PSNAP()); r.emit(PSNAP({ native_transition: 'collapsing' })); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'native transition');
  r = await decideBoot(PSNAP()); r.emit(PSNAP({ pending: PERM({ options: [{ index: 0, label: 'Permitir' }, { index: 1, label: 'Denegar' }] }) })); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'options changed');
  r = await decideBoot(PSNAP()); r.capsule.dataset.phase = 'expanded'; r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'the card is on screen');
  r = await decideBoot(PSNAP()); r.emit(none('answered')); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'no longer pending');
  r = await decideBoot(PSNAP()); r.emit(PSNAP({ native_transition: 'idle' })); r.click(r.approve); await flush(); assert.equal(r.calls.length, 1, 'idle still works');
});
T3('a request that replaces the shown one disarms the buttons for 500 ms: a click aimed at the old one cannot land on the new one', async () => {
  const r = await decideBoot(PSNAP()); r.emit(PSNAP({ pending: PERM({ id: OTHER_ID }) }));
  assert.equal(r.approve.disabled, true); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0);
  r.advance(700); assert.equal(r.approve.disabled, false); r.click(r.approve); await flush();
  assert.equal(r.calls[0].arg.payload.id, OTHER_ID);
});
T3('double click sends once; both buttons disabled while in flight', async () => {
  const r = await decideBoot(PSNAP(), { behave: () => new Promise(() => {}) });
  r.click(r.approve); assert.equal(r.approve.disabled, true); assert.equal(r.reject.disabled, true);
  r.click(r.approve); r.click(r.reject); await flush();
  assert.equal(r.calls.length, 1);
});
T3('a host rejection re-enables, shows «No se pudo enviar.», never claims approval', async () => {
  const r = await decideBoot(PSNAP(), { behave: () => Promise.reject(new Error('boom')) });
  r.click(r.approve); await flush();
  assert.equal(r.approve.disabled, false); assert.equal(r.reject.disabled, false);
  const body = r.toast.children[2].children[0].textContent;
  assert.equal(body, 'No se pudo enviar.'); assert.doesNotMatch(body, /Aprobad/i);
  r.setBehave(() => Promise.resolve({})); r.click(r.reject); await flush(); assert.equal(r.calls.length, 2, 'retry is possible after a failure');
});
T3('success: the toast paints nothing itself; the next state push drives it', async () => {
  const r = await decideBoot(PSNAP());
  r.click(r.approve); await flush();
  assert.notEqual(r.toast.children[2].children[0].textContent, 'No se pudo enviar.');
  assert.doesNotMatch(r.toast.children[2].children[0].textContent, /Aprobad/i);
  r.emit(none('answered')); r.advance(400); assert.equal(r.toast.hidden, true); assert.equal(r.actions.hidden, true);
});
T3('Escape, hover, focus, blur and timeouts send nothing; the group hides when folded or dismissed', async () => {
  const r = await decideBoot(PSNAP());
  r.toast.fire('pointerenter', {}); r.toast.fire('focus', {}); r.toast.fire('blur', {}); r.toast.fire('pointerleave', {});
  r.actions.fire('pointerenter', {}); r.actions.fire('focusin', {}); r.actions.fire('focusout', {}); r.actions.fire('pointerleave', {});
  r.toast.fire('keydown', { key: 'y', preventDefault() {}, stopPropagation() {} }); r.toast.fire('keydown', { key: 'n', preventDefault() {}, stopPropagation() {} });
  r.advance(60000);
  assert.equal(r.calls.length, 0);
  assert.equal(r.actions.hidden, true, 'folded by the timeout: group hidden');
  const e = await decideBoot(PSNAP()); e.actions.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} }); e.advance(400);
  assert.equal(e.calls.length, 0); assert.equal(e.toast.hidden, true); assert.equal(e.actions.hidden, true);
});
T3('R1 long / multi-line / hidden-char request: NO Aprobar/Rechazar, only «Ver todo» which opens the island and answers nothing', async () => {
  for (const text of ['Permiso para ejecutar: ' + 'a'.repeat(200), 'ls\nrm -rf ~', 'ls \u202erm']) {
    const r = await decideBoot(PSNAP({ pending: PERM({ text }) }));
    assert.equal(r.actions.hidden, false); assert.equal(r.toast.dataset.decide, 'false'); assert.equal(r.toast.dataset.fullview, 'true');
    assert.equal(r.reject.hidden, true); assert.equal(r.approve.hidden, true);
    const viewAll = r.actions.children[2]; assert.equal(viewAll.textContent, 'Ver todo'); assert.equal(viewAll.hidden, false);
    r.click(r.reject); r.click(r.approve); await flush(); assert.equal(r.calls.length, 0, 'hidden decision buttons are inert');
    const opened = []; r.docEvents['abito:question-open'] = [e => opened.push(e.detail)];
    r.click(viewAll); await flush();
    assert.equal(JSON.stringify(opened), JSON.stringify([{ id: ID }]), 'one open event');
    assert.equal(r.calls.length, 0, 'nothing reaches question_action');
    r.click(viewAll, false); viewAll.fire('click', {}); assert.equal(opened.length, 1, 'synthetic click does nothing');
    assert.equal(r.calls.length, 0);
  }
});
T3('R1 a short one-line request keeps the buttons and has no «Ver todo»; replacing it with a long one swaps them', async () => {
  const r = await decideBoot(PSNAP());
  assert.equal(r.actions.children[2].hidden, true); assert.equal(r.approve.hidden, false); assert.equal(r.toast.dataset.fullview, 'false');
  r.emit(PSNAP({ pending: PERM({ text: 'x'.repeat(130) }) }));
  assert.equal(r.approve.hidden, true); assert.equal(r.actions.children[2].hidden, false);
  r.click(r.approve); await flush(); assert.equal(r.calls.length, 0);
});
T3('R1 a plain question never shows «Ver todo» (the toast click already opens it)', async () => {
  const q = await decideBoot(SNAP_NOW()); assert.equal(q.actions.hidden, true); assert.equal(q.actions.children[2].hidden, true);
});
T3('source contract: textContent only, no innerHTML, no new shortcut, 32px buttons with a 44px hit area', () => {
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8'), css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(js, /addEventListener\('key(down|press|up)'[^]*?['"]y['"]/i);
  assert.match(css, /\.q-toast-act \{[^}]*height: 32px/); assert.match(css, /\.q-toast-act::after \{[^}]*inset: -6px/);
  assert.equal(T.TOAST.hMax, 96, 'TOAST numbers unchanged');
  assert.match(css, /\[data-decide="true"\] \.q-toast-body \{[^}]*-webkit-line-clamp: unset[^}]*overflow: visible/, 'R1: no clamp while buttons show');
});

(async () => {
  for (const [name, fn] of mounted) { try { await fn(); passed += 1; } catch (e) { console.log(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; } }
  console.log(`question-toast-check: ${passed} checks ok${process.exitCode ? ' — WITH FAILURES' : ''}`);
})();
