'use strict';
/* K2-08 «01 · Una a la vez con contador» (design/k2-08-fila-permisos/01-contador.html): the permission take-over with a FIFO queue.
   Part 1 runs the REAL notify.js on a small fake DOM with a controlled clock and host (no browser): counter text, live-region
   messages, focus on «Rechazar», input bound to the request that was RENDERED (head-change guard), and a hidden request that
   expires never making the visible head look expired. Part 2 measures the real CSS in headless Chromium (island-geometry-harness):
   the counter's type/colour/separation, its absence with one request, the slide-in and the reduced-motion contract.
   Run: node apps/desktop-tauri/test-node/question-queue-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..', 'frontend');
const N = require(path.join(frontend, 'notify-view.js'));
const L = require(path.join(frontend, 'island-layout.js'));

const A = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a01', B = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a02', C = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a03';
const T0 = 1_000_000;
const LABEL = { codex: 'Codex', 'claude-code': 'Claude Code' };
const perm = (id, agent, project, cmd, now = T0) => ({ id, kind: 'question', agent, agent_label: LABEL[agent], project_name: project,
  text: `${LABEL[agent]} pide permiso para Bash: ${cmd}`, allow_free_text: false, expires_at: now + 120000,
  options: [{ index: 0, label: 'Aprobar una vez', description: '' }, { index: 1, label: 'Rechazar', description: '' }] });
const state = (head, queued = [], extra = {}) => ({ available: true, native_transition: 'idle', pending: head, queued, queued_count: queued.length, deliveries: [], notice: null, ...extra });
const pA = () => perm(A, 'codex', 'koda', 'cargo test');
const pB = () => perm(B, 'claude-code', 'api', 'npm run build');
const pC = () => perm(C, 'codex', 'koda', 'git status');
// a plain numbered question (three options: never the approval look) and a multi-select, for the row/primary paths
const ask = (id, now = T0) => ({ id, kind: 'question', agent: 'codex', agent_label: 'Codex', project_name: 'koda', text: '¿Qué rama uso?', allow_free_text: false,
  expires_at: now + 120000, options: ['main', 'develop', 'release'].map((label, index) => ({ index, label, description: '' })) });
const many = (id, now = T0) => ({ ...ask(id, now), text: '¿Qué lenguajes?', multi_select: true });

// ---- part 1: the real controller on a fake DOM -------------------------------------------------------------------------------
function boot(initial) {
  const clock = { t: T0 };
  const calls = [], said = [], docListeners = {};
  const doc = { activeElement: null };
  class El {
    constructor(tag, id) {
      Object.assign(this, { tagName: String(tag).toUpperCase(), id: id || '', className: '', dataset: {}, style: {}, attrs: {}, children: [], parentNode: null,
        listeners: {}, hidden: false, inert: false, disabled: false, value: '', title: '', maxLength: 0, offsetHeight: 148, scrollHeight: 20, _t: '', isContentEditable: false });
    }
    get textContent() { return this._t + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._t = v == null ? '' : String(v); this.children = []; if (this.id === 'question-live' && this._t) said.push(this._t); }
    append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } }
    appendChild(k) { this.append(k); return k; }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    insertBefore(k) { this.append(k); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
    querySelectorAll(sel) {
      const all = [], walk = e => { for (const c of e.children) { all.push(c); walk(c); } };
      walk(this);
      return sel === 'button' ? all.filter(e => e.tagName === 'BUTTON') : [];
    }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    requestSubmit() {}
    click() { for (const f of this.listeners.click || []) f({ isTrusted: true, preventDefault() {}, stopPropagation() {} }); }
  }
  const TAGS = { 'question-text': 'textarea', 'question-send': 'button', 'question-skip': 'button', 'question-prev': 'button', 'question-primary': 'button', 'question-freeform': 'form',
    'chat-input': 'textarea', 'island-btn': 'button' };
  const ids = ['question', 'capsule', 'question-head', 'question-body', 'question-options', 'question-freeform', 'question-text', 'question-word', 'question-send',
    'question-skip', 'question-live', 'question-expiry', 'question-state', 'question-expiry-word', 'question-state-icon', 'question-state-word',
    'question-step', 'question-step-header', 'question-summary', 'question-nav', 'question-prev', 'question-primary', 'question-queue', 'question-asker-name',
    'question-approval', 'question-approval-title', 'question-approval-cmd', 'question-approval-note', 'question-approval-actions', 'question-reason',
    'chat-input', 'island-btn', 'note-edit']; // the last three live OUTSIDE the take-over: the chat field, an island control, a contenteditable
  const nodes = Object.fromEntries(ids.map(id => [id, new El(TAGS[id] || 'div', id)]));
  nodes['note-edit'].isContentEditable = true;
  nodes['question-state'].parentNode = nodes['question-head'];
  // every card node sits inside #question (root.contains), the chat field and island controls do not
  for (const id of ids) if (id.startsWith('question-') && !nodes[id].parentNode) nodes[id].parentNode = nodes.question;
  nodes['question-approval-actions'].parentNode = nodes['question-approval'];
  Object.assign(nodes.capsule.dataset, { phase: 'expanded', view: 'overview' });
  doc.body = new El('body'); doc.activeElement = doc.body; doc.documentElement = new El('html');
  Object.assign(doc, { getElementById: id => nodes[id] || null, createElement: tag => new El(tag),
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); }, dispatchEvent() {} });
  let pushed = null;
  const host = { reply: null };
  const invoke = (name, args) => {
    const p = args && args.payload;
    if (name === 'question_action') calls.push(p);
    if (name === 'question_action' && p.action === 'view') return Promise.resolve(initial);
    if (name === 'question_action' && ['answer', 'decline', 'answer_many', 'answer_form', 'text'].includes(p.action)) {
      if (host.fail) return Promise.reject(new Error(host.fail));
      return Promise.resolve(host.reply ? host.reply(p) : initial);
    }
    if (name === 'question_action' && p.action === 'budget') return Promise.resolve({ allowed: true });
    return Promise.resolve({});
  };
  const timers = [];
  const win = { AbitoNotify: N, AbitoIslandLayout: L, AbitoIcons: { svg: () => '' },
    __TAURI__: { core: { invoke }, event: { listen: (name, fn) => { if (name === 'question:state') pushed = fn; return Promise.resolve(() => {}); } } } };
  const ctx = vm.createContext({ window: win, document: doc, Date: { now: () => clock.t }, performance: { now: () => clock.t }, setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.t + (ms || 0) }); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: f => f(), getComputedStyle: () => ({ getPropertyValue: () => '' }), MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, Promise, console });
  vm.runInContext(fs.readFileSync(path.join(frontend, 'notify.js'), 'utf8'), ctx);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
  const key = k => { for (const f of docListeners.keydown || []) f({ key: k, isTrusted: true, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, repeat: false, preventDefault() {}, stopPropagation() {} }); };
  const buttons = () => nodes['question-approval-actions'].querySelectorAll('button');
  const button = role => buttons().find(b => b.className.split(' ').includes(`q-${role}`));
  const answers = () => structuredClone(calls.filter(c => c.action === 'answer')); // main-realm copies: the payloads come from the vm realm
  const sent = () => structuredClone(calls.filter(c => c.action !== 'view' && c.action !== 'budget')); // every answer of any shape
  const rows = () => nodes['question-options'].querySelectorAll('button');
  return { nodes, clock, said, host, settle, key, buttons, button, answers, sent, rows, doc,
    push: async s => { pushed({ payload: s }); await settle(); },
    advance: ms => { clock.t += ms; } };
}

const checks = [];
const test = (name, fn) => checks.push([name, fn]);

test('S1: one pending request is today\'s take-over: no counter, today\'s announcement', async () => {
  const h = boot(state(pA()));
  await h.settle();
  assert.equal(h.nodes.question.dataset.look, 'approval');
  assert.equal(h.nodes['question-queue'].textContent, '', 'no counter with one request');
  assert.equal(h.nodes['question-queue'].hidden, true);
  assert.equal(h.said.at(-1), `Codex pregunta: ${pA().text}`, 'the single request is announced exactly as before');
});

test('S2/S5/S6: with N ≥ 2 the who-row says «1 de N», focus goes to «Rechazar», the head is announced with its place in the queue', async () => {
  const h = boot(state(pA(), [pB(), pC()]));
  await h.settle();
  assert.equal(h.nodes['question-queue'].textContent, '1 de 3');
  assert.equal(h.nodes['question-queue'].hidden, false);
  assert.equal(h.said.at(-1), 'Permiso 1 de 3: Codex, koda quiere ejecutar cargo test');
  assert.equal(h.doc.activeElement, h.button('reject'), 'focus lands on «Rechazar»');
  assert.notEqual(h.doc.activeElement, h.button('approve'), 'never on the approve button');
});

test('S3/S4/S5/S6: answering the head brings the next one; a key or click only ever answers the request that was rendered', async () => {
  const h = boot(state(pA(), [pB(), pC()]));
  await h.settle();
  h.advance(1000); // past the guard the first sight of A arms
  const staleApprove = h.button('approve');
  // Y approves A; the host answers with the queue advanced (B is the head now, C waits)
  h.host.reply = () => state(pB(), [pC()], { notice: 'sent' });
  h.key('y');
  await h.settle();
  assert.deepEqual(h.answers(), [{ action: 'answer', id: A, index: 0 }], 'Y approved A, the request on screen');
  assert.equal(h.nodes['question-queue'].textContent, '1 de 2', 'the counter goes down');
  assert.equal(h.said.at(-1), 'Permitido. Siguiente: Claude Code, api');
  assert.equal(h.doc.activeElement, h.button('reject'), 'the new head gets focus on «Rechazar»');
  // a second Y pressed as A resolved must never approve B: input is ignored while the head changes
  h.key('y');
  staleApprove.click(); // the button A's card drew, clicked after B replaced it
  await h.settle();
  assert.equal(h.answers().length, 1, 'nothing answered B during the head-change guard, and A\'s stale button answers nothing');
  // once the guard is over, keys answer the rendered head (B); A's stale button still answers nothing
  h.advance(1000);
  staleApprove.click();
  await h.settle();
  assert.equal(h.answers().length, 1, 'a button drawn for A never answers B, even after the guard');
  h.host.reply = () => state(pC(h.clock.t - 1000), [], { notice: 'sent' });
  h.key('n');
  await h.settle();
  assert.deepEqual(h.answers().at(-1), { action: 'answer', id: B, index: 1 }, 'N rejected B, the request that was rendered');
  assert.equal(h.said.at(-1), 'Rechazado. Siguiente: Codex, koda');
  assert.equal(h.nodes['question-queue'].textContent, '', 'one left: the counter is gone');
  assert.equal(h.nodes['question-queue'].hidden, true);
  assert.equal(h.doc.activeElement, h.button('reject'));
});

test('S4: a head pushed by the host between render and keypress is never answered by that keypress', async () => {
  const h = boot(state(pA(), [pB()]));
  await h.settle();
  await h.push(state(pB(), [], { notice: 'expired' })); // A expired on its own; B arrives right before the human's Y
  h.key('y');
  await h.settle();
  assert.equal(h.answers().length, 0, 'the Y meant for A does not approve B');
  h.advance(1000);
  h.key('y');
  await h.settle();
  assert.deepEqual(h.answers(), [{ action: 'answer', id: B, index: 0 }]);
});

test('S5: a head that arrives while the island is closed gets its focus on «Rechazar» when it is first on screen', async () => {
  const h = boot(state(pA(), [pB()]));
  h.nodes.capsule.dataset.phase = 'compact';
  await h.settle();
  assert.notEqual(h.doc.activeElement, h.button('reject'), 'nothing is focused while hidden');
  h.nodes.capsule.dataset.phase = 'expanded';
  await h.push(state(pA(), [pB()])); // any render after the reveal
  assert.equal(h.doc.activeElement, h.button('reject'));
  h.button('approve').focus();
  await h.push(state(pA(), [pB()]));
  assert.equal(h.doc.activeElement, h.button('approve'), 'once focused, the human\'s own focus is kept across renders');
});

test('S6: a HIDDEN request that expires is announced, and the visible head does not look expired', async () => {
  const h = boot(state(pA(), [pB(), pC()]));
  await h.settle();
  h.advance(1000); // past the guard the first sight of A arms
  await h.push(state(pA(), [pC()], { notice: 'expired' }));
  assert.equal(h.said.at(-1), 'Un permiso de Claude Code pasó a la terminal');
  assert.equal(h.nodes.capsule.dataset.question, 'pending', 'the head is still pending');
  assert.equal(h.nodes['question-state'].hidden, true, 'no «Vencida» outcome over the live head');
  assert.notEqual(h.nodes['question-expiry-word'].textContent, 'Vencida');
  assert.equal(h.nodes['question-queue'].textContent, '1 de 2');
  assert.ok(h.buttons().length === 2 && h.buttons().every(b => !b.disabled), 'the head stays answerable');
  h.key('y'); // the head did not change: no guard, the human may answer at once
  await h.settle();
  assert.deepEqual(h.answers(), [{ action: 'answer', id: A, index: 0 }]);
});

// ---- verifier findings (S4/S5/S6 hardening) -----------------------------------------------------------------------------------
test('S4/S5 (finding 1): typing in #chat-input when a request paints on top: focus stays in the field and a typed «y» sends nothing', async () => {
  const h = boot(state(null));
  await h.settle();
  h.nodes['chat-input'].focus();
  h.advance(1000);
  await h.push(state(pA(), [pB()]));
  assert.equal(h.doc.activeElement, h.nodes['chat-input'], 'the request never takes the focus out of the field the human is typing in');
  h.key('y');
  h.advance(1000);
  h.key('y');
  await h.settle();
  assert.deepEqual(h.sent(), [], 'letters typed in the chat field never answer the request');
});

test('S4 (finding 1): a contenteditable outside the take-over keeps its focus and its keys', async () => {
  const h = boot(state(null));
  await h.settle();
  h.nodes['note-edit'].focus();
  await h.push(state(pA()));
  assert.equal(h.doc.activeElement, h.nodes['note-edit']);
  h.advance(1000);
  h.key('y'); h.key('1');
  await h.settle();
  assert.deepEqual(h.sent(), []);
});

test('S4 (finding 1): Y/N and digits answer an approval only with the focus inside #question or on the page body', async () => {
  const h = boot(state(pA()));
  await h.settle();
  h.advance(1000);
  h.nodes['island-btn'].focus(); // the human tabbed to an island control outside the card
  h.key('y'); h.key('1');
  await h.settle();
  assert.deepEqual(h.sent(), [], 'a key on a control outside the take-over answers nothing');
  h.doc.activeElement = h.doc.body;
  h.key('y');
  await h.settle();
  assert.deepEqual(h.answers(), [{ action: 'answer', id: A, index: 0 }], 'with the focus on the page body Y approves the rendered head');
});

test('S4 (finding 1): the FIRST head after an empty state is guarded like a swap', async () => {
  const h = boot(state(null));
  await h.settle();
  h.advance(1000);
  await h.push(state(pA(), [pB()]));
  assert.equal(h.doc.activeElement, h.button('reject'), 'nothing editable had the focus: «Rechazar» gets it');
  h.key('y');
  h.button('approve').click();
  await h.settle();
  assert.deepEqual(h.sent(), [], 'a key or click in the first moment of the first head answers nothing');
  h.advance(1000);
  h.key('y');
  await h.settle();
  assert.deepEqual(h.answers(), [{ action: 'answer', id: A, index: 0 }]);
});

test('S4 (finding 1): a head is guarded the first time it comes on screen', async () => {
  const h = boot(state(pA()));
  h.nodes.capsule.dataset.phase = 'compact';
  await h.settle();
  h.advance(1000);
  h.nodes.capsule.dataset.phase = 'expanded';
  await h.push(state(pA()));
  h.key('y');
  await h.settle();
  assert.deepEqual(h.sent(), [], 'the key that opened the island does not answer what it revealed');
  h.advance(1000);
  h.key('y');
  await h.settle();
  assert.deepEqual(h.answers(), [{ action: 'answer', id: A, index: 0 }]);
});

test('S4 (finding 2): multi-select row click + «Hecho» within the guard after a swap sends nothing; after it, they answer the rendered head', async () => {
  const h = boot(state(many(A), [many(B)]));
  await h.settle();
  h.advance(1000);
  await h.push(state(many(B), [], { notice: 'sent' })); // A was answered elsewhere: B takes its place
  h.rows()[0].click();
  h.nodes['question-primary'].click();
  await h.settle();
  assert.deepEqual(h.sent(), [], 'neither the row nor «Hecho» acts inside the guard');
  assert.equal(h.rows()[0].dataset.selected, 'false', 'the row click did not toggle anything');
  h.advance(1000);
  h.rows()[1].focus();
  h.rows()[0].click();
  assert.equal(h.doc.activeElement && h.doc.activeElement.dataset.number, '2', 'a rebuild of the SAME request keeps the focus on its row');
  h.host.reply = () => state(null, [], { notice: 'sent' });
  h.nodes['question-primary'].click();
  await h.settle();
  assert.deepEqual(h.sent().map(c => [c.action, c.id]), [['answer_many', B]], '«Hecho» sends the rendered head');
});

test('S4 (finding 2): «Omitir» and «Enviar» (free text) also respect the guard', async () => {
  const form = id => ({ ...ask(id), text: 'Cuestionario', options: [], form: [{ header: 'Uno', text: '¿Uno?', options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] },
    { header: 'Dos', text: '¿Dos?', options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }] }] });
  const h = boot(state(ask(A), [form(B)]));
  await h.settle();
  h.advance(1000);
  await h.push(state(form(B), []));
  const step = () => h.nodes['question-step-header'].textContent;
  h.advance(1000);
  h.rows()[0].click();
  h.nodes['question-primary'].click();
  assert.match(step(), /2 de 2/);
  await h.push(state(ask(C), [])); // B was answered elsewhere: C takes its place
  h.nodes['question-skip'].click();
  await h.settle();
  assert.deepEqual(h.sent(), [], '«Omitir» inside the guard sends nothing');
  const text = { ...ask(C), options: [], allow_free_text: true };
  await h.push(state(text, []));
  h.nodes['question-text'].value = 'hola';
  for (const f of h.nodes['question-text'].listeners.input || []) f({});
  await h.settle(); // the host's byte budget allows it
  for (const f of h.nodes['question-freeform'].listeners.submit || []) f({ isTrusted: true, preventDefault() {} });
  await h.settle();
  assert.deepEqual(h.sent(), [], 'free text submitted inside the guard sends nothing');
  h.advance(1000);
  for (const f of h.nodes['question-freeform'].listeners.submit || []) f({ isTrusted: true, preventDefault() {} });
  await h.settle();
  assert.deepEqual(h.sent().map(c => [c.action, c.id, c.text]), [['text', C, 'hola']], 'after the guard the text answers the rendered head');
});

test('S4 (finding 3): the focus on row N of a request is not carried to row N of the next head', async () => {
  const h = boot(state(ask(A), [ask(B)]));
  await h.settle();
  h.advance(1000);
  h.rows()[1].focus();
  await h.push(state(ask(B), []));
  assert.ok(!h.rows().includes(h.doc.activeElement), `focus moved onto the new head's row ${h.doc.activeElement && h.doc.activeElement.dataset.number}`);
});

test('S6 (finding 4): a stale «expired» notice does not announce a hidden request that left for another reason', async () => {
  const h = boot(state(pA(), [pB(), pC()]));
  await h.settle();
  await h.push(state(pA(), [pC()], { notice: 'expired' }));
  await h.push(state(pA(), [], { notice: 'expired' })); // C disconnected long before its deadline; the notice is the old one
  assert.deepEqual(h.said.filter(s => /pasó a la terminal/.test(s)), ['Un permiso de Claude Code pasó a la terminal']);
  const late = boot(state(pA(), [pB(), perm(C, 'codex', 'koda', 'git status', T0 - 118000)]));
  await late.settle();
  await late.push(state(pA(), [perm(C, 'codex', 'koda', 'git status', T0 - 118000)], { notice: 'expired' }));
  late.advance(3000); // C's own deadline has passed
  await late.push(state(pA(), [], { notice: 'expired' }));
  assert.deepEqual(late.said.filter(s => /pasó a la terminal/.test(s)), ['Un permiso de Claude Code pasó a la terminal', 'Un permiso de Codex pasó a la terminal'],
    'a second hidden expiry under the same notice is still announced when its own deadline passed');
});

test('S6 (finding 5): an answer that failed to send is never announced as «Permitido»', async () => {
  const h = boot(state(pA(), [pB()]));
  await h.settle();
  h.advance(1000);
  h.host.fail = 'No se pudo enviar.';
  h.key('y');
  await h.settle();
  assert.equal(h.said.at(-1), 'No se pudo enviar.');
  await h.push(state(pB(), [], { notice: 'expired' })); // A went to its terminal; B is the head
  assert.ok(!h.said.some(s => /^Permitido/.test(s)), `announced: ${JSON.stringify(h.said)}`);
});

// ---- part 2: the real CSS in headless Chromium ------------------------------------------------------------------------------
async function browserChecks() {
  const H = require('./island-geometry-harness.cjs');
  if (!H.findPlaywright()) { console.log('SKIPPED question-queue-check part 2: no playwright — NOT a pass'); return 0; }
  const h = await H.open({ question: 'approval', quick: true });
  let n = 0;
  try {
    const emit = (head, queued, motion) => h.page.evaluate(({ head, queued, motion, now }) => {
      const fix = p => p && { ...p, expires_at: now + 120000 };
      if (motion) document.documentElement.dataset.motion = motion;
      window.__emit('question:state', { available: true, native_transition: 'idle', pending: fix(head), queued: queued.map(fix), queued_count: queued.length, deliveries: [], notice: null });
      const q = document.getElementById('question-queue'), name = document.getElementById('question-asker-name'), ap = document.getElementById('question-approval');
      const qs = getComputedStyle(q), as = getComputedStyle(ap);
      return { text: q.textContent, display: qs.display, size: qs.fontSize, colour: qs.color, gap: q.getBoundingClientRect().left - name.getBoundingClientRect().right,
        line: qs.borderLeftWidth, anim: as.animationName, dur: as.animationDuration, transform: as.transform, transition: as.transitionDuration };
    }, { head, queued, motion, now: Date.now() });
    let s = await emit(pA(), []);
    assert.equal(s.display, 'none', `S1: no counter with one request: ${JSON.stringify(s)}`);
    s = await emit(pA(), [pB(), pC()]);
    assert.deepEqual([s.text, s.size, s.colour], ['1 de 3', '11px', 'rgba(255, 255, 255, 0.62)'], `S2 counter: ${JSON.stringify(s)}`);
    assert.ok(s.display !== 'none' && s.gap >= 6 && s.line === '1px', `S2: separated from the name by a thin divider: ${JSON.stringify(s)}`);
    n++;
    s = await emit(pB(), [pC()]);
    assert.ok(s.anim !== 'none' && s.dur === '0.32s', `S3: the next head slides in over 320ms: ${JSON.stringify(s)}`);
    await h.page.waitForTimeout(400);
    s = await emit(pC(), [], 'reduce');
    assert.ok(s.anim === 'none' && s.transform === 'none', `S3: data-motion=reduce: no movement: ${JSON.stringify(s)}`);
    await emit(pA(), [pB()], 'full');
    await h.page.emulateMedia({ reducedMotion: 'reduce' });
    await h.page.waitForTimeout(400);
    s = await emit(pB(), [], 'full');
    assert.ok(s.anim === 'none' && s.transform === 'none', `S3: prefers-reduced-motion: no movement: ${JSON.stringify(s)}`);
    n++;
  } finally { await h.close(); }
  return n;
}

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${e.message}`); }
  }
  try { passed += await browserChecks(); } catch (e) { failed++; console.error(`FAIL browser checks\n  ${e.message}`); }
  console.log(`question-queue-check: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
