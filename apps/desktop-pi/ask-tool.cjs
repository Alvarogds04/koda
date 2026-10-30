'use strict';
// The model-facing side of `abito_ask`, extended to the shape Claude Code's AskUserQuestion uses:
//   - one question, single choice (the original call: kind/text/options/allowFreeText/timeoutMs), passed through UNCHANGED;
//   - one question with `multiSelect: true` (several options may be ticked);
//   - `questions[1..4]`, each { header, question, options[2..4], multiSelect?, allowFreeText? }: ONE frame, ONE queue slot,
//     one answer per step. Option `value` is optional here: missing values are synthesised (o1..o4) and the answers come back
//     with the chosen LABELS next to the values, so the model never has to map them itself.
// The wire protocol (questions.cjs / question.rs, level 3 «structured») already carries all of it; this module only maps the tool's
// parameters onto it and the human's answer back. Everything the broker enforces (sizes, uniqueness, all-or-nothing answers) stays
// there; the checks here only refuse a request early and name the problem.
const { normalizeRequest, DEFAULT_TIMEOUT_MS, formatResult } = require('./questions.cjs');

const TOP_KEYS = ['kind', 'text', 'options', 'allowFreeText', 'timeoutMs', 'multiSelect', 'questions'];
const STEP_KEYS = ['header', 'question', 'options', 'multiSelect', 'allowFreeText'];
const OPTION_KEYS = ['label', 'description', 'value'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const invalid = () => ({ error: 'invalid_request' });

function questionnaire(params) {
  if ((params.kind !== undefined && params.kind !== 'question') || (params.options !== undefined && !(Array.isArray(params.options) && params.options.length === 0)) ||
      params.multiSelect !== undefined || params.allowFreeText !== undefined || !Array.isArray(params.questions) ||
      params.questions.length < 1 || params.questions.length > 4) return invalid();
  const items = [];
  for (const step of params.questions) {
    if (!only(step, STEP_KEYS) || typeof step.header !== 'string' || typeof step.question !== 'string' || !Array.isArray(step.options) ||
        (step.multiSelect !== undefined && typeof step.multiSelect !== 'boolean') || (step.allowFreeText !== undefined && typeof step.allowFreeText !== 'boolean')) return invalid();
    const options = [];
    for (let i = 0; i < step.options.length; i++) {
      const o = step.options[i];
      if (!only(o, OPTION_KEYS) || typeof o.label !== 'string' || (o.description !== undefined && typeof o.description !== 'string') ||
          (o.value !== undefined && typeof o.value !== 'string')) return invalid();
      options.push({ value: o.value ?? `o${i + 1}`, label: o.label, description: o.description ?? '' });
    }
    items.push({ header: step.header, text: step.question, options, multiSelect: step.multiSelect === true, allowFreeText: step.allowFreeText === true });
  }
  const request = { kind: 'question', text: params.text ?? items.map(i => i.header).join(' · '), options: [], allowFreeText: false,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }), questions: items };
  return { request, shape: 'form' };
}

/** tool parameters -> { request, shape: 'single'|'multi'|'form' } or { error: 'invalid_request' }. Sends nothing. */
function toRequest(params) {
  if (!only(params, TOP_KEYS)) return invalid();
  const mapped = params.questions !== undefined ? questionnaire(params)
    : { request: { ...params }, shape: params.multiSelect === true ? 'multi' : 'single' };
  if (mapped.error) return mapped;
  try { normalizeRequest(mapped.request, DEFAULT_TIMEOUT_MS, true); } catch { return invalid(); } // the superset: the broker applies the negotiated limits
  return mapped;
}

const labelsOf = (options, values) => values.map(v => options.find(o => o.value === v)?.label).filter(l => l !== undefined);
function selectedOf(mapped, answer) {
  const one = (options, a) => (a.type === 'option' ? { selected: labelsOf(options, [a.value]) }
    : a.type === 'options' ? { selected: labelsOf(options, a.values), ...(a.text === undefined ? {} : { text: a.text }) }
    : { selected: [], text: a.text });
  if (mapped.shape === 'form') {
    return mapped.request.questions.map((item, i) => ({ header: item.header, question: item.text, ...one(item.options, answer.answers[i]) }));
  }
  return [one(mapped.request.options, answer)];
}

const NO_STRUCTURED = 'No human answer: this Koda connection does not carry multi-select questions or questionnaires (it needs question level 3: ABITO_QUESTIONS=3 and a receiver that supports it). Ask ONE single-choice question with abito_ask, or ask through normal chat instead. Do not infer a decision or choose a default.';

/** Runs one abito_ask call. Returns { text, details, isError } for the tool result. Never throws for a bad request. */
async function runAsk(controller, params, ctx, signal) {
  const mapped = toRequest(params);
  if (mapped.error) { const details = { status: 'invalid_request' }; return { text: formatResult(details), details, isError: true }; }
  if (mapped.shape !== 'single' && !controller.structured()) {
    if (controller.canAsk()) {
      const details = { status: 'invalid_request', reasonCode: 'structured_unavailable' };
      return { text: NO_STRUCTURED, details, isError: true };
    }
    const details = { status: 'unavailable' };
    return { text: formatResult(details), details, isError: true };
  }
  const result = await controller.ask(mapped.request, ctx, signal);
  if (result.status !== 'answered') return { text: formatResult(result), details: result, isError: true };
  const text = mapped.shape === 'single' ? formatResult(result) : JSON.stringify({ ...result, selected: selectedOf(mapped, result.answer) });
  return { text, details: result, isError: false };
}

module.exports = { toRequest, runAsk, NO_STRUCTURED };
