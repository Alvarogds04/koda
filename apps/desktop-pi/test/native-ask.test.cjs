'use strict';
// Native ask interception: Pi's own `ask_user_choice` / `ask_user_question` (gentle-pi) are answered from
// Abito OR the terminal, first answer wins. Everything here runs against a fake pi/ctx/controller.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createNativeAskHandler, isSensitive } = require('../native-ask.cjs');

const OPTIONS = [
  { label: 'Alpha', description: 'First one', value: 'val-alpha' },
  { label: 'Beta', description: '', value: 'val-beta' },
];
const choiceEvent = (over = {}) => ({ type: 'tool_call', toolName: 'ask_user_choice', toolCallId: 't1',
  input: { question: 'Which route?', options: OPTIONS, ...over } });
const questionEvent = (q = {}) => ({ type: 'tool_call', toolName: 'ask_user_question', toolCallId: 't2',
  input: { questions: [{ question: 'Which route?', header: 'Route', options: [{ label: 'Alpha', description: 'A' }, { label: 'Beta', description: 'B' }], ...q }] } });

// A controllable pair: fake Abito controller + fake terminal ui.
function rig({ available = true, structured = false } = {}) {
  const abito = { asks: [], signals: [], resolvers: [] };
  const controller = {
    canAsk: () => available,
    structured: () => structured,
    ask: (request, ctx, signal) => new Promise(resolve => {
      abito.asks.push(request); abito.signals.push(signal);
      abito.resolvers.push(resolve);
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }),
  };
  const term = { selects: [], inputs: [], selectResolvers: [], inputResolvers: [] };
  const dialog = (list, resolvers) => (title, options, opts) => new Promise(resolve => {
    list.push({ title, options, opts }); resolvers.push(resolve);
    opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const ui = {
    select: dialog(term.selects, term.selectResolvers),
    input: (title, placeholder, opts) => dialog(term.inputs, term.inputResolvers)(title, [placeholder], opts),
  };
  term.notes = []; ui.notify = (message, type) => { term.notes.push([message, type]); };
  const ctx = { hasUI: true, mode: 'tui', ui, cwd: '/tmp/x', sessionManager: { getSessionId: () => 's' }, signal: undefined };
  return { abito, controller, term, ctx };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const handler = (r, env = {}) => createNativeAskHandler({ controller: r.controller, env });

test('Abito answers first: exact native text, original value mapped back, terminal dialog withdrawn', async () => {
  const r = rig(); const run = handler(r)(choiceEvent(), r.ctx); await tick();
  const sent = r.abito.asks[0];
  assert.equal(sent.kind, 'question'); assert.equal(sent.text, 'Which route?'); assert.equal(sent.allowFreeText, false);
  assert.deepEqual(sent.options.map(o => o.value), ['o1', 'o2']);
  assert.ok(!JSON.stringify(sent).includes('val-alpha'), 'original values never leave Pi');
  assert.deepEqual(sent.options.map(o => [o.label, o.description]), [['Alpha', 'First one'], ['Beta', '']]);
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'o2' } });
  assert.deepEqual(await run, { block: true, reason: 'User selected: 2. Beta (value: val-beta)' });
  assert.equal(r.term.selects[0].opts.signal.aborted, true);
});

test('terminal answers first: same text, Abito question withdrawn, a late Abito answer changes nothing', async () => {
  const r = rig(); const run = handler(r)(choiceEvent(), r.ctx); await tick();
  assert.deepEqual(r.term.selects[0].options, ['Alpha — First one', 'Beta']);
  r.term.selectResolvers[0]('Alpha — First one');
  assert.deepEqual(await run, { block: true, reason: 'User selected: 1. Alpha (value: val-alpha)' });
  assert.equal(r.abito.signals[0].aborted, true, 'question_cancel path: the broker is aborted');
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'o2' } }); await tick(); // too late, ignored
});

test('both answer in the same tick: exactly one result is produced', async () => {
  const r = rig(); let results = 0; const run = handler(r)(choiceEvent(), r.ctx).then(v => { results += 1; return v; }); await tick();
  r.term.selectResolvers[0]('Beta'); r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'o1' } });
  const result = await run; await tick();
  // either side may win a true tie; what must hold is ONE result, never two applied
  assert.equal(results, 1); assert.match(result.reason, /^User selected: [12]\. (Alpha|Beta) \(value: val-(alpha|beta)\)$/);
});

test('allowCustomResponse: «Other…» in the terminal and free text from Abito both give the native text', async () => {
  let r = rig(); let run = handler(r)(choiceEvent({ allowCustomResponse: true }), r.ctx); await tick();
  assert.equal(r.abito.asks[0].allowFreeText, true);
  assert.deepEqual(r.term.selects[0].options.at(-1), 'Other…');
  r.term.selectResolvers[0]('Other…'); await tick();
  r.term.inputResolvers[0]('mi respuesta');
  assert.deepEqual(await run, { block: true, reason: 'User responded: mi respuesta' });
  assert.equal(r.abito.signals[0].aborted, true);
  r = rig(); run = handler(r)(choiceEvent({ allowCustomResponse: true }), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'text', text: 'desde Abito' } });
  assert.deepEqual(await run, { block: true, reason: 'User responded: desde Abito' });
  assert.equal(r.term.selects[0].opts.signal.aborted, true);
  // free text is only ever accepted when the call allowed it
  r = rig(); run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'text', text: 'nope' } }); await tick();
  r.term.selectResolvers[0]('Beta');
  assert.match((await run).reason, /^User selected: 2\. Beta/);
});

test('cancelling is a decision too: Esc in the terminal or «Omitir» in Abito -> the native cancel text, other side withdrawn', async () => {
  let r = rig(); let run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.term.selectResolvers[0](undefined);
  assert.deepEqual(await run, { block: true, reason: 'User cancelled the choice' });
  assert.equal(r.abito.signals[0].aborted, true);
  r = rig(); run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'human_cancelled' });
  assert.deepEqual(await run, { block: true, reason: 'User cancelled the choice' });
  assert.equal(r.term.selects[0].opts.signal.aborted, true);
});

test('Abito failing mid-race never answers: the terminal keeps waiting and still decides', async () => {
  for (const status of ['busy', 'expired', 'unavailable', 'disconnected', 'protocol_error', 'session_changed', 'invalid_request', 'unsupported_receiver', 'cancelled']) {
    const r = rig(); let done = false; const run = handler(r)(choiceEvent(), r.ctx).then(v => { done = true; return v; }); await tick();
    r.abito.resolvers[0]({ status }); await tick(); await tick();
    assert.equal(done, false, `${status}: no auto-answer, no early return`);
    assert.equal(r.term.selects[0].opts.signal.aborted, false, `${status}: terminal dialog stays open`);
    r.term.selectResolvers[0]('Beta');
    assert.match((await run).reason, /^User selected: 2\. Beta/, status);
  }
});

test('the terminal dialog failing outright falls through to the native tool untouched', async () => {
  const r = rig(); r.ctx.ui.select = () => Promise.reject(new Error('no tty'));
  const run = handler(r)(choiceEvent(), r.ctx);
  assert.equal(await run, undefined);
  await tick(); assert.equal(r.abito.signals[0].aborted, true, 'the Abito question is withdrawn too');
});

test('the agent run being aborted withdraws both sides', async () => {
  const r = rig(); const ac = new AbortController(); r.ctx.signal = ac.signal;
  const run = handler(r)(choiceEvent(), r.ctx); await tick(); ac.abort();
  assert.deepEqual(await run, { block: true, reason: 'User cancelled the choice' });
  assert.equal(r.abito.signals[0].aborted, true); assert.equal(r.term.selects[0].opts.signal.aborted, true);
});

test('not intercepted (undefined, no Abito question, no terminal dialog): off switch, no Abito, no UI, other tools', async () => {
  const cases = [
    ['ABITO_NATIVE_ASK=0', rig(), { ABITO_NATIVE_ASK: '0' }, choiceEvent()],
    ['Abito not available', rig({ available: false }), {}, choiceEvent()],
    ['no UI', Object.assign(rig(), {}), {}, choiceEvent()],
    ['another tool', rig(), {}, { ...choiceEvent(), toolName: 'bash' }],
    ['abito_ask itself', rig(), {}, { ...choiceEvent(), toolName: 'abito_ask' }],
    ['malformed input', rig(), {}, { ...choiceEvent(), input: { question: 7, options: 'x' } }],
    ['one option only', rig(), {}, choiceEvent({ options: [OPTIONS[0]] })],
    ['five options', rig(), {}, choiceEvent({ options: Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, description: '', value: `v${i}` })) })],
    ['question over 500 chars', rig(), {}, choiceEvent({ question: 'q'.repeat(501) })],
    ['label over 60 chars', rig(), {}, choiceEvent({ options: [{ ...OPTIONS[0], label: 'x'.repeat(61) }, OPTIONS[1]] })],
    ['description over 160', rig(), {}, choiceEvent({ options: [{ ...OPTIONS[0], description: 'd'.repeat(161) }, OPTIONS[1]] })],
    ['control character', rig(), {}, choiceEvent({ question: 'a\u0000b' })],
    ['duplicate labels', rig(), {}, choiceEvent({ options: [OPTIONS[0], { ...OPTIONS[0], value: 'other' }] })],
  ];
  for (const [name, r, env, event] of cases) {
    if (name === 'no UI') r.ctx.hasUI = false;
    assert.equal(await handler(r, env)(event, r.ctx), undefined, name);
    assert.equal(r.abito.asks.length, 0, name); assert.equal(r.term.selects.length, 0, name);
  }
});

test('SECURITY: consent / authorization prompts are never answerable from Abito (both sides of the rule)', async () => {
  const sensitive = [
    choiceEvent({ question: 'Grant consent for this review candidate?', consentBinding: 'b' }),
    choiceEvent({ question: 'gentle-ai.review-integration: allow the push?' }),
    choiceEvent({ question: 'Authorize maintenance?' }),
    choiceEvent({ question: 'Provider envelope', options: OPTIONS }),
    choiceEvent({ question: 'Decide', options: [{ label: 'A', description: '', value: 'gentle-ai.review-integration.consent/v3:abc' }, OPTIONS[1]] }),
    choiceEvent({ question: 'Decide', options: [{ label: 'A', description: '', value: 'a3f9c2d41b7e8a90c1d2e3f405a6b7c8' }, OPTIONS[1]] }),
    choiceEvent({ question: 'Decide', options: [{ label: 'A', description: '', value: 'id-20260101123456' }, OPTIONS[1]] }),
    choiceEvent({ question: 'Decide', options: [{ label: 'A', description: '', value: '{"binding":1}' }, OPTIONS[1]] }),
    questionEvent({ question: 'Enter your password' }),
  ];
  for (const event of sensitive) {
    const r = rig();
    assert.equal(await handler(r)(event, r.ctx), undefined, JSON.stringify(event.input).slice(0, 90));
    assert.equal(r.abito.asks.length, 0); assert.equal(r.term.selects.length, 0, 'the native tool runs untouched');
  }
  // the other side: ordinary choices ARE intercepted
  for (const event of [choiceEvent(), choiceEvent({ question: '¿Qué rama uso?', options: [{ label: 'main', description: 'rama principal', value: 'main' }, { label: 'dev', description: '', value: 'dev_2' }] })]) {
    const r = rig(); const run = handler(r)(event, r.ctx); await tick();
    assert.equal(r.abito.asks.length, 1); r.term.selectResolvers[0](undefined); await run;
  }
  assert.equal(isSensitive('Which branch should I use?'), false);
  assert.equal(isSensitive('please GRANT access'), false, 'HU-052: grant is a topic word for ask tools');
  assert.equal(isSensitive('paste your password'), true);
});

test('ask_user_question: exactly one single-select question is raced, with the questionnaire texts', async () => {
  let r = rig(); let run = handler(r)(questionEvent(), r.ctx); await tick();
  assert.equal(r.term.selects[0].title, 'Route: Which route?');
  assert.equal(r.abito.asks[0].text, 'Which route?'); assert.equal(r.abito.asks[0].allowFreeText, true, 'the questionnaire always offers free text');
  assert.deepEqual(r.term.selects[0].options, ['Alpha — A', 'Beta — B', 'Type something.']);
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'o1' } });
  assert.deepEqual(await run, { block: true, reason: '1. Which route? — Alpha' });
  r = rig(); run = handler(r)(questionEvent(), r.ctx); await tick();
  r.term.selectResolvers[0]('Type something.'); await tick(); r.term.inputResolvers[0]('otra cosa');
  assert.deepEqual(await run, { block: true, reason: '1. Which route? — (custom) otra cosa' });
  r = rig(); run = handler(r)(questionEvent(), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'human_cancelled' });
  assert.deepEqual(await run, { block: true, reason: 'User cancelled the questionnaire' });
});

test('ask_user_question: several questions or multiSelect WITHOUT the structured capability, or an invalid shape, stay native and terminal-only', async () => {
  const two = { ...questionEvent() }; two.input = { questions: [...two.input.questions, ...two.input.questions] };
  for (const event of [two, questionEvent({ multiSelect: true }), { ...questionEvent(), input: { questions: [] } }, { ...questionEvent(), input: {} }]) {
    const r = rig(); assert.equal(await handler(r)(event, r.ctx), undefined);
    assert.equal(r.abito.asks.length, 0); assert.equal(r.term.selects.length, 0);
  }
});

test('wiring: the extension hooks tool_call with the handler, the adapter exposes canAsk, the README states the trade-offs', () => {
  const ext = fs.readFileSync(path.join(__dirname, '../pi-extension.ts'), 'utf8');
  assert.match(ext, /pi\.on\('tool_call', nativeAsk\.createNativeAskHandler\(/);
  assert.match(fs.readFileSync(path.join(__dirname, '../adapter.cjs'), 'utf8'), /canAsk/);
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  for (const needle of ['ABITO_NATIVE_ASK', 'ask_user_choice', 'tool error', 'plain', 'receipts']) assert.match(readme, new RegExp(needle), needle);
});


// ---- structured: multiSelect and several questions ---------------------------------------------------
const q2 = (over = {}) => ({ question: 'Which extras?', header: 'Extras', options: [{ label: 'One', description: 'first' }, { label: 'Two', description: '' }, { label: 'Three', description: 'third' }], multiSelect: true, ...over });
const formEvent = (...qs) => ({ type: 'tool_call', toolName: 'ask_user_question', toolCallId: 't3', input: { questions: qs } });
const route = () => ({ question: 'Which route?', header: 'Route', options: [{ label: 'Alpha', description: 'A' }, { label: 'Beta', description: 'B' }] });

test('multiSelect single question: Abito answers with a list -> the native «selected:» line, terminal withdrawn', async () => {
  const r = rig({ structured: true }); const run = handler(r)(formEvent(q2()), r.ctx); await tick();
  const sent = r.abito.asks[0];
  assert.equal(sent.multiSelect, true); assert.equal(sent.questions, undefined);
  assert.deepEqual(sent.options.map(o => o.value), ['o1', 'o2', 'o3']); assert.equal(sent.options[0].description, 'first');
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'options', values: ['o3', 'o1'] } });
  assert.deepEqual(await run, { block: true, reason: '1. Which extras? — selected: One, Three' });
  assert.equal(r.term.selects[0].opts.signal.aborted, true);
});

test('multiSelect in the terminal: toggle rounds until Done, same text, Abito withdrawn', async () => {
  const r = rig({ structured: true }); const run = handler(r)(formEvent(q2()), r.ctx); await tick();
  assert.equal(r.term.selects[0].title, 'Extras: Which extras?');
  assert.deepEqual(r.term.selects[0].options, ['[ ] One — first', '[ ] Two', '[ ] Three — third', 'Type something.', 'Done']);
  r.term.selectResolvers[0]('[ ] Two'); await tick();
  assert.deepEqual(r.term.selects[1].options.slice(0, 3), ['[ ] One — first', '[x] Two', '[ ] Three — third']);
  r.term.selectResolvers[1]('[ ] Three — third'); await tick();
  r.term.selectResolvers[2]('Done');
  assert.deepEqual(await run, { block: true, reason: '1. Which extras? — selected: Two, Three' });
  assert.equal(r.abito.signals[0].aborted, true);
});

test('multiSelect with free text: «(custom) text — selected: …» and text-only', async () => {
  let r = rig({ structured: true }); let run = handler(r)(formEvent(q2()), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'options', values: ['o2'], text: 'más' } });
  assert.deepEqual(await run, { block: true, reason: '1. Which extras? — (custom) más — selected: Two' });
  r = rig({ structured: true }); run = handler(r)(formEvent(q2()), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'options', values: [], text: 'solo' } });
  assert.deepEqual(await run, { block: true, reason: '1. Which extras? — (custom) solo' });
  r = rig({ structured: true }); run = handler(r)(formEvent(q2()), r.ctx); await tick();
  r.term.selectResolvers[0]('[ ] One — first'); await tick(); r.term.selectResolvers[1]('Type something.'); await tick(); r.term.inputResolvers[0]('terminal text');
  assert.deepEqual(await run, { block: true, reason: '1. Which extras? — (custom) terminal text — selected: One' });
});

test('questionnaire from Abito: ONE request with every question, ONE native result, all or nothing', async () => {
  const r = rig({ structured: true }); const run = handler(r)(formEvent(route(), q2()), r.ctx); await tick();
  const sent = r.abito.asks[0];
  assert.equal(sent.questions.length, 2); assert.deepEqual(sent.options, []); assert.equal(r.abito.asks.length, 1);
  assert.deepEqual(sent.questions[0].options.map(o => o.value), ['o1', 'o2']);
  assert.deepEqual(sent.questions.map(q => q.header), ['Route', 'Extras']);
  assert.ok(!JSON.stringify(sent).includes('"preview"'));
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'form', answers: [{ type: 'option', value: 'o2' }, { type: 'options', values: ['o1', 'o3'] }] } });
  assert.deepEqual(await run, { block: true, reason: '1. Which route? — Beta\n2. Which extras? — selected: One, Three' });
  assert.equal(r.term.selects[0].opts.signal.aborted, true);
});

test('questionnaire in the terminal: questions asked in order; Abito answering midway wins and aborts the rest', async () => {
  let r = rig({ structured: true }); let run = handler(r)(formEvent(route(), q2()), r.ctx); await tick();
  assert.equal(r.term.selects[0].title, 'Route: Which route?');
  r.term.selectResolvers[0]('Alpha — A'); await tick();
  assert.equal(r.term.selects[1].title, 'Extras: Which extras?');
  r.term.selectResolvers[1]('[ ] Two'); await tick(); r.term.selectResolvers[2]('Done');
  assert.deepEqual(await run, { block: true, reason: '1. Which route? — Alpha\n2. Which extras? — selected: Two' });
  assert.equal(r.abito.signals[0].aborted, true);
  r = rig({ structured: true }); run = handler(r)(formEvent(route(), q2()), r.ctx); await tick();
  r.term.selectResolvers[0]('Alpha — A'); await tick();       // terminal is on question 2 now
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'form', answers: [{ type: 'option', value: 'o2' }, { type: 'options', values: ['o2'] }] } });
  assert.deepEqual(await run, { block: true, reason: '1. Which route? — Beta\n2. Which extras? — selected: Two' }, 'the terminal\'s partial answer is discarded, never mixed in');
  assert.equal(r.term.selects[1].opts.signal.aborted, true);
});

test('questionnaire: cancelling anywhere cancels the whole questionnaire; Abito failures never answer', async () => {
  let r = rig({ structured: true }); let run = handler(r)(formEvent(route(), q2()), r.ctx); await tick();
  r.term.selectResolvers[0]('Alpha — A'); await tick(); r.term.selectResolvers[1](undefined);
  assert.deepEqual(await run, { block: true, reason: 'User cancelled the questionnaire' });
  assert.equal(r.abito.signals[0].aborted, true);
  r = rig({ structured: true }); run = handler(r)(formEvent(route(), q2()), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'human_cancelled' });
  assert.deepEqual(await run, { block: true, reason: 'User cancelled the questionnaire' });
  r = rig({ structured: true }); let done = false; run = handler(r)(formEvent(route(), q2()), r.ctx).then(v => { done = true; return v; }); await tick();
  r.abito.resolvers[0]({ status: 'busy' }); await tick(); await tick();
  assert.equal(done, false, 'Abito busy: the terminal keeps waiting');
  r.term.selectResolvers[0]('Beta — B'); await tick(); r.term.selectResolvers[1]('Done'); // Done with nothing toggled commits the empty selection natively
  assert.match((await run).reason, /^1\. Which route\? — Beta\n2\. Which extras\? — selected: $/);
});

test('an Abito answer that does not fit the questionnaire is ignored: terminal keeps deciding', async () => {
  const bad = [
    { type: 'form', answers: [{ type: 'option', value: 'o1' }] },                                   // partial
    { type: 'form', answers: [{ type: 'option', value: 'o1' }, { type: 'option', value: 'o1' }] },  // wrong kind for a multi item
    { type: 'form', answers: [{ type: 'option', value: 'o9' }, { type: 'options', values: ['o1'] }] },
    { type: 'option', value: 'o1' },
  ];
  for (const answer of bad) {
    const r = rig({ structured: true }); let done = false; const run = handler(r)(formEvent(route(), q2()), r.ctx).then(v => { done = true; return v; }); await tick();
    r.abito.resolvers[0]({ status: 'answered', answer }); await tick(); await tick();
    assert.equal(done, false, JSON.stringify(answer));
    r.term.selectResolvers[0](undefined); await run;
  }
});

test('structured shapes WITHOUT the capability: native only, nothing asked anywhere', async () => {
  for (const event of [formEvent(route(), q2()), formEvent(q2()), formEvent(route(), route(), route(), route())]) {
    const r = rig({ structured: false });
    assert.equal(await handler(r)(event, r.ctx), undefined);
    assert.equal(r.abito.asks.length, 0); assert.equal(r.term.selects.length, 0);
  }
  // one single-select question still works without it (legacy frame)
  const r = rig({ structured: false }); const run = handler(r)(questionEvent(), r.ctx); await tick();
  assert.equal(r.abito.asks.length, 1); assert.equal(r.abito.asks[0].questions, undefined); r.term.selectResolvers[0](undefined); await run;
});

test('structured shapes: limits, five questions, sensitive text anywhere, duplicate rows -> not intercepted', async () => {
  const five = formEvent(...Array.from({ length: 5 }, (_, i) => route()));
  const tooLong = formEvent({ ...route(), question: 'q'.repeat(2001) });
  const sensitive = formEvent(route(), q2({ options: [{ label: 'Yes', description: 'binding envelope' }, { label: 'No', description: '' }] }));
  const dup = formEvent(q2({ options: [{ label: 'Same', description: '' }, { label: 'Same', description: '' }] }));
  const longHeader = formEvent({ ...route(), header: 'h'.repeat(33) });
  for (const event of [five, tooLong, sensitive, dup, longHeader]) {
    const r = rig({ structured: true }); assert.equal(await handler(r)(event, r.ctx), undefined);
    assert.equal(r.abito.asks.length, 0); assert.equal(r.term.selects.length, 0);
  }
  // the largest accepted shapes DO go through
  const big = formEvent(...Array.from({ length: 4 }, (_, i) => ({ ...route(), question: 'ab '.repeat(500) + i, options: [{ label: 'l '.repeat(30), description: 'd '.repeat(150) }, { label: 'm '.repeat(30), description: '' }] })));
  const r = rig({ structured: true }); const run = handler(r)(big, r.ctx); await tick();
  assert.equal(r.abito.asks.length, 1); r.term.selectResolvers[0](undefined); await run;
});


// ---- what the terminal shows -------------------------------------------------------------------------------
// A blocked call gets `details: {}` and gentle-pi's renderResult prints «Cancelled» for that; the public API cannot
// change that row (tool_result does not run for blocked calls; the live row is painted from tool_execution_end).
// So the human is told who answered and what, with one info notification (a dim line below the tool row).
test('the terminal says who answered and what: one info notification per decision, before the call returns', async () => {
  let r = rig(); let run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'o2' } }); await run;
  assert.deepEqual(r.term.notes, [['Respondido en Koda: Beta', 'info']]);
  r = rig(); run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.term.selectResolvers[0]('Alpha — First one'); await run;
  assert.deepEqual(r.term.notes, [['Respondido en la terminal: Alpha', 'info']]);
  // free text, from either side
  r = rig(); run = handler(r)(choiceEvent({ allowCustomResponse: true }), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'text', text: 'desde Abito' } }); await run;
  assert.deepEqual(r.term.notes, [['Respondido en Koda: desde Abito', 'info']]);
  r = rig(); run = handler(r)(choiceEvent({ allowCustomResponse: true }), r.ctx); await tick();
  r.term.selectResolvers[0]('Other…'); await tick(); r.term.inputResolvers[0]('mi respuesta'); await run;
  assert.deepEqual(r.term.notes, [['Respondido en la terminal: mi respuesta', 'info']]);
});

test('cancelling is told too, naming the side', async () => {
  let r = rig(); let run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'human_cancelled' }); await run;
  assert.deepEqual(r.term.notes, [['Cancelado en Koda', 'info']]);
  r = rig(); run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.term.selectResolvers[0](undefined); await run;
  assert.deepEqual(r.term.notes, [['Cancelado en la terminal', 'info']]);
});

test('multiSelect and questionnaires are summarised per question', async () => {
  let r = rig({ structured: true }); let run = handler(r)(formEvent(route(), q2()), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'form', answers: [{ type: 'option', value: 'o2' }, { type: 'options', values: ['o1', 'o3'], text: 'más' }] } }); await run;
  assert.deepEqual(r.term.notes, [['Respondido en Koda: Route: Beta · Extras: One, Three, más', 'info']]);
  r = rig({ structured: true }); run = handler(r)(formEvent(q2()), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'options', values: ['o2'] } }); await run;
  assert.deepEqual(r.term.notes, [['Respondido en Koda: Two', 'info']]);
});

test('no notification when nothing was decided or the call was not intercepted; a long answer is cut; a broken notify never changes the result', async () => {
  // run aborted, terminal unable to ask, Abito failing: no decision, no note
  let r = rig(); const ac = new AbortController(); r.ctx.signal = ac.signal;
  let run = handler(r)(choiceEvent(), r.ctx); await tick(); ac.abort(); await run;
  assert.deepEqual(r.term.notes, []);
  r = rig(); r.ctx.ui.select = () => Promise.reject(new Error('no tty')); await handler(r)(choiceEvent(), r.ctx);
  assert.deepEqual(r.term.notes, []);
  r = rig({ available: false }); await handler(r)(choiceEvent(), r.ctx);
  assert.deepEqual(r.term.notes, []);
  r = rig(); run = handler(r)(choiceEvent({ question: 'Enter your password' }), r.ctx); assert.equal(await run, undefined);
  assert.deepEqual(r.term.notes, []);
  r = rig(); run = handler(r)(choiceEvent(), r.ctx); await tick(); r.abito.resolvers[0]({ status: 'busy' }); await tick();
  assert.deepEqual(r.term.notes, []); r.term.selectResolvers[0](undefined); await run;
  // long answer
  r = rig(); run = handler(r)(choiceEvent({ allowCustomResponse: true }), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'text', text: 'x'.repeat(500) } }); await run;
  const [[note]] = r.term.notes; assert.ok(note.length <= 200 && note.endsWith('…'), note.length);
  // notify throwing, or absent: the decision still goes through unchanged
  r = rig(); r.ctx.ui.notify = () => { throw new Error('boom'); }; run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'o1' } });
  assert.deepEqual(await run, { block: true, reason: 'User selected: 1. Alpha (value: val-alpha)' });
  r = rig(); delete r.ctx.ui.notify; run = handler(r)(choiceEvent(), r.ctx); await tick();
  r.term.selectResolvers[0]('Beta'); assert.match((await run).reason, /^User selected: 2\. Beta/);
});

// ---- HU-052: ordinary questions are routed; only real secret prompts and opaque consents stay terminal-only ----
async function routed(event, r = rig({ structured: true })) {
  const run = handler(r)(event, r.ctx); await tick();
  const sent = r.abito.asks.length === 1;
  if (sent) { r.term.selectResolvers[0](undefined); await run; } else { assert.equal(await run, undefined); }
  return sent;
}
const choiceQ = (question, over = {}) => choiceEvent({ question, ...over });

test('HU-052: ordinary questions that only MENTION permisos / proveedor / token / rechazar are routed to Abito', async () => {
  const events = [
    choiceQ('¿Qué permisos le damos al agente?'),
    choiceQ('Elige el proveedor de modelos'),
    choiceQ('¿Rotamos el token de la API?'),
    choiceQ('¿Rechazamos estos cambios?', { options: [{ label: 'Rechazar', description: 'descartar', value: 'reject' }, { label: 'Declinar', description: '', value: 'decline' }] }),
    choiceQ('Review the diff before merging?'),
    choiceQ('Which permission level?'),
    choiceQ('Grant access to the staging folder?'),
    choiceQ('¿Autorizas el despliegue?'),
    choiceQ('Choose', { options: [{ label: 'Yes', description: 'grant a permission token', value: 'yes' }, OPTIONS[1]] }),
    choiceQ('¿Rotamos la clave de la API?'),
    questionEvent({ question: '¿Qué permisos damos?' }),
    questionEvent({ question: 'Elige proveedor', options: [{ label: 'Rechazar', description: 'no' }, { label: 'Aceptar', description: 'sí' }] }),
  ];
  for (const event of events) assert.equal(await routed(event), true, JSON.stringify(event.input).slice(0, 90));
});

test('HU-052: secret VALUE prompts stay terminal-only (free-text asks for a password / key / token value)', async () => {
  const events = [
    choiceQ('Pega tu contraseña'), choiceQ('Enter your API key'), choiceQ('Pega tu token de la API'),
    choiceQ('Escribe la clave de la API'), choiceQ('Please paste the secret'), choiceQ('Dame el token'),
    choiceQ('Introduce tu passphrase'), choiceQ('Login required'), choiceQ('Type your credentials'),
    choiceQ('Which one?', { options: [{ label: 'Paste your token', description: '', value: 'a' }, OPTIONS[1]] }),
    choiceQ('¿Rotamos el token de la API?', { allowCustomResponse: true }), // token + free text allowed
    questionEvent({ question: '¿Rotamos el token de la API?' }),            // a questionnaire always allows free text
    questionEvent({ question: 'Which secreto?' }),
  ];
  for (const event of events) assert.equal(await routed(event), false, JSON.stringify(event.input).slice(0, 90));
});

test('HU-052: opaque values, consent envelopes and maintenance authorizations stay terminal-only', async () => {
  const opaque = v => choiceQ('Decide', { options: [{ label: 'A', description: '', value: v }, OPTIONS[1]] });
  const events = [
    opaque('a3f9c2d41b7e8a90c1d2e3f405a6b7c8'), opaque('id-20260101123456'), opaque('{"x":1}'),
    choiceQ('Decide', { consentBinding: 'x' }),
    choiceQ('Decide', { options: [{ label: 'A', description: '', value: 'yes', consentBinding: 'x' }, OPTIONS[1]] }),
    choiceQ('gentle-ai.review-integration consent'),
    choiceQ('Decide', { options: [{ label: 'A', description: 'gentle-ai.review-integration', value: 'yes' }, OPTIONS[1]] }),
    choiceQ('Authorize maintenance?'), choiceQ('Provider envelope'), choiceQ('Do you consent to the plan?'), choiceQ('¿Das tu consentimiento?'),
    questionEvent({ question: 'ok?', options: [{ label: 'A', description: 'consentBinding' }, { label: 'B', description: '' }] }),
  ];
  for (const event of events) assert.equal(await routed(event), false, JSON.stringify(event.input).slice(0, 90));
});

test('HU-052: the showable gate and obfuscation folding still apply to ask tools', async () => {
  const events = [choiceQ('Pеga tu contraseña'), choiceQ('Which branch\u200b?'), choiceQ('Pega tu t0ken'), choiceQ('Enter the p@ssw0rd'), choiceQ('Reset the pass word')];
  for (const event of events) assert.equal(await routed(event), false, JSON.stringify(event.input).slice(0, 60));
  assert.equal(await routed(choiceQ('¿Qué rama uso?')), true);
});
