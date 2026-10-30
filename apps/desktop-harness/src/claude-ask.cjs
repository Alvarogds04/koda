'use strict';
// AskUserQuestion answers for the PermissionRequest hook: question TEXT is the key, original labels are the values.
// This module only plans and decodes (plan/requestFor/answersFor); claude.cjs builds the PermissionRequest output.
const { sanitizeText } = require('./projection.cjs');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fits = (s, max) => typeof s === 'string' && [...s].length <= max;
// F5: the island card is Spanish; the length bound counts the exact text the card shows.
const shownText = q => `Claude Code pregunta: ${q}`;
const other = s => /^(other|otra(?: cosa)?|otro|type something)(?:[.\s…:!¡¿?]*)$/iu.test(s.trim());
function plan(toolInput) {
  if (!isObject(toolInput) || !Array.isArray(toolInput.questions) || toolInput.questions.length < 1 || toolInput.questions.length > 4) return null;
  const structured = toolInput.questions.length > 1 || toolInput.questions.some(q => q?.multiSelect === true);
  const steps = [], seen = new Set();
  for (const q of toolInput.questions) {
    if (!isObject(q) || typeof q.question !== 'string' || !q.question.trim() || seen.has(q.question) ||
        !fits(shownText(q.question), structured ? 2000 : 500) ||
        (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')) return null;
    seen.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return null;
    if (q.multiSelect && (q.allowFreeText === true || q.options.some(o => typeof o?.label === 'string' && other(o.label)))) return null;
    const header = q.header === undefined ? `Pregunta ${steps.length + 1}` : q.header;
    if (toolInput.questions.length > 1 && (!fits(header, 32) || !header.trim())) return null;
    const labels = [], options = [];
    for (let i = 0; i < q.options.length; i++) {
      const o = q.options[i];
      if (!isObject(o) || typeof o.label !== 'string' || !o.label.trim() ||
          (o.description !== undefined && typeof o.description !== 'string')) return null;
      if (structured && (!fits(o.label, 120) || !fits(o.description || '', 400))) return null;
      const label = sanitizeText(o.label, { max: structured ? 120 : 60 });
      if (!label) return null;
      labels.push(o.label);
      options.push({ value: `o${i}`, label, description: sanitizeText(o.description || '', { max: structured ? 400 : 160 }) });
    }
    steps.push({ question: q.question, header: sanitizeText(header, { max: 32 }), multiSelect: q.multiSelect === true,
      text: sanitizeText(shownText(q.question), { max: structured ? 2000 : 500 }), labels, options });
  }
  return { steps };
}
// Multi-select encoding is UNKNOWN in repository Claude documentation. Conservatively retain the
// existing string-valued contract, joining original labels with ', '. Needs a real-Claude check.
function encodeLabels(labels) { return labels.join(', '); }
function pickedLabel(step, result) {
  if (!result || result.status !== 'answered' || !isObject(result.answer)) return null;
  const a = result.answer;
  let values;
  if (step.multiSelect) {
    if (a.type !== 'options' || Object.keys(a).sort().join() !== 'type,values' || !Array.isArray(a.values) ||
        a.values.length < 1 || a.values.length > step.options.length || new Set(a.values).size !== a.values.length) return null;
    values = a.values;
  } else {
    if (a.type !== 'option' || Object.keys(a).sort().join() !== 'type,value') return null;
    values = [a.value];
  }
  const labels = [];
  for (const value of values) {
    const i = step.options.findIndex(o => o.value === value);
    if (i < 0) return null;
    labels.push(step.labels[i]);
  }
  return step.multiSelect ? encodeLabels(labels) : labels[0];
}
function requestFor({ steps }, timeoutMs) {
  const base = { kind: 'question', text: steps[0].text, options: steps[0].options, allowFreeText: false, timeoutMs };
  if (steps.length === 1) return { ...base, ...(steps[0].multiSelect ? { multiSelect: true } : {}) };
  return { ...base, options: [], questions: steps.map(s => ({ header: s.header, text: s.text, options: s.options,
    multiSelect: s.multiSelect, allowFreeText: false })) };
}
function answersFor({ steps }, result) {
  if (result?.status !== 'answered') return null;
  const form = steps.length > 1;
  const a = result.answer;
  if (form && (!isObject(a) || Object.keys(a).sort().join() !== 'answers,type' || a.type !== 'form' ||
      !Array.isArray(a.answers) || a.answers.length !== steps.length)) return null;
  const answers = Object.create(null);
  for (let i = 0; i < steps.length; i++) {
    const label = pickedLabel(steps[i], { status: 'answered', answer: form ? a.answers[i] : a });
    if (label === null) return null;
    answers[steps[i].question] = label;
  }
  return answers;
}
module.exports = { plan, pickedLabel, requestFor, answersFor };
