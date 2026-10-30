'use strict';
const { randomUUID } = require('node:crypto');
const DEFAULT_TIMEOUT_MS = 300000;
const MIN_TIMEOUT_MS = 30000, MAX_TIMEOUT_MS = 900000;
const FRAME_BYTES = 4096;
// Two processes never read the same clock: the island stamps `at`, this process compares it with its own. On Windows their
// Date.now() differ by a few ms, so an honest answer could look "before the question" or "in the future" and be refused.
// A skew this small is tolerated on those two bounds; staleness (15 s) and a far-future stamp stay rejected.
// Mirrors CLOCK_SKEW_MS in desktop-harness/src/client.cjs and protocol.rs.
const CLOCK_SKEW_MS = 1000;
// A connection that negotiated `structured:1` (level 3) may carry multiSelect, questionnaires and larger limits.
const STRUCTURED_FRAME_BYTES = 16384;
const MAX_FORM_ITEMS = 4;
const LEGACY = { text: 500, label: 60, desc: 160, free: 2000, header: 0 };
const STRUCTURED = { text: 2000, label: 120, desc: 400, free: 4000, header: 32 };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const token = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const text = (v, max, empty = false) => typeof v === 'string' && (empty || v.trim().length > 0) &&
  [...v].length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const timeoutValid = ms => Number.isSafeInteger(ms) && ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS;

function normalizeOptions(options, L) {
  const seen = new Set();
  return options.map(o => {
    if (!exact(o, ['value', 'label', 'description']) || !token(o.value) || seen.has(o.value) ||
        !text(o.label, L.label) || !text(o.description, L.desc, true)) throw new Error('Invalid option');
    seen.add(o.value);
    return { value: o.value, label: o.label, description: o.description };
  });
}
function normalizeRequest(input, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, structured = false) {
  const L = structured ? STRUCTURED : LEGACY;
  const allowed = ['kind', 'text', 'options', 'allowFreeText', 'timeoutMs', ...(structured ? ['multiSelect', 'questions'] : [])];
  if (!object(input) || Object.keys(input).some(k => !allowed.includes(k))) {
    throw new Error('Invalid request');
  }
  const { kind, text: questionText, options, allowFreeText = false, timeoutMs = defaultTimeoutMs, multiSelect, questions } = input;
  if (!['question', 'approval'].includes(kind) || !text(questionText, L.text) || !Array.isArray(options) ||
      typeof allowFreeText !== 'boolean' || !timeoutValid(timeoutMs) ||
      (multiSelect !== undefined && typeof multiSelect !== 'boolean')) {
    throw new Error('Invalid request');
  }
  if (questions !== undefined) { // a questionnaire: every question lives in its item
    if (kind !== 'question' || !Array.isArray(questions) || questions.length < 1 || questions.length > MAX_FORM_ITEMS ||
        options.length !== 0 || allowFreeText || multiSelect === true) throw new Error('Invalid request');
    const items = questions.map(q => {
      if (!exact(q, ['header', 'text', 'options', 'multiSelect', 'allowFreeText']) &&
          !(object(q) && Object.keys(q).every(k => ['header', 'text', 'options', 'multiSelect', 'allowFreeText'].includes(k)) &&
            ['header', 'text', 'options'].every(k => Object.hasOwn(q, k)))) throw new Error('Invalid request');
      if (!text(q.header, L.header) || !text(q.text, L.text) || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4 ||
          (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') ||
          (q.allowFreeText !== undefined && typeof q.allowFreeText !== 'boolean')) throw new Error('Invalid request');
      return { header: q.header, text: q.text, options: normalizeOptions(q.options, L),
        multiSelect: q.multiSelect === true, allowFreeText: q.allowFreeText === true };
    });
    return { kind, text: questionText, options: [], allowFreeText: false, timeoutMs, questions: items };
  }
  if ((kind === 'approval' && (allowFreeText || options.length !== 2 || multiSelect === true)) ||
      (multiSelect === true && (options.length < 2 || options.length > 4)) ||
      !((options.length >= 2 && options.length <= 4) || (options.length === 0 && kind === 'question' && allowFreeText && multiSelect !== true))) {
    throw new Error('Invalid request');
  }
  return { kind, text: questionText, options: normalizeOptions(options, L), allowFreeText, timeoutMs,
    ...(multiSelect === true ? { multiSelect: true } : {}) };
}

class QuestionBroker {
  constructor({ send, available, scope, isCurrent, display, structured = () => false, busyReasonSupported = () => false, onDiagnostic = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS,
    clock = { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout } }) {
    if (!timeoutValid(timeoutMs)) throw new Error('Invalid question timeout');
    Object.assign(this, { send, available, scope, isCurrent, display, structured, busyReasonSupported, onDiagnostic, timeoutMs, clock });
    this.live = null;
  }
  diagnostic(id, reason) {
    // No text, options, answers or private paths in diagnostics. Observer errors
    // cannot prevent expiration or change whether an answer was consumed.
    try { this.onDiagnostic({ id, reason }); } catch { /* observer only */ }
  }
  ask(input, ctx, signal) {
    let request;
    const structured = this.structured() === true;
    try { request = normalizeRequest(input, this.timeoutMs, structured); } catch { return Promise.resolve({ status: 'invalid_request' }); }
    if (this.live) return Promise.resolve({ status: 'busy' }); // never queue the second call
    if (!this.available()) return Promise.resolve({ status: 'unavailable' }); // fail fast, no wait for handshake
    if (!this.isCurrent(ctx)) return Promise.resolve({ status: 'session_changed' });
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled' });
    const id = randomUUID(), at = this.clock.now(), identity = this.scope();
    // S3: who asks (agent + project name) from the adapter's display seam; absent = unlabelled.
    let shown = {};
    try { shown = (typeof this.display === 'function' && this.display(ctx)) || {}; } catch { shown = {}; }
    const { timeoutMs, ...rest } = request;
    const fields = { ...rest, ...shown };
    const frame = { ...identity, v: 1, type: 'question', questionVersion: 1, at, id, ...fields, expiresAt: at + timeoutMs };
    if (Buffer.byteLength(JSON.stringify(frame)) > (structured ? STRUCTURED_FRAME_BYTES : FRAME_BYTES)) return Promise.resolve({ status: 'invalid_request' });
    return new Promise(resolve => {
      const live = { id, frame, ctx, resolve, signal, timer: undefined, abort: () => this.finish('cancelled', true) };
      this.live = live;
      signal?.addEventListener('abort', live.abort, { once: true });
      live.timer = this.clock.setTimer(() => this.finish('expired', true), timeoutMs);
      if (!this.send('question', { questionVersion: 1, id, ...fields, expiresAt: frame.expiresAt }, at)) {
        this.finish('disconnected');
      }
    });
  }
  finish(status, notify = false, answer, reasonCode) {
    const live = this.live;
    if (!live) return;
    // Atomic consumption before any writes, observers or Promise continuations.
    this.live = null;
    this.clock.clearTimer(live.timer);
    live.signal?.removeEventListener('abort', live.abort);
    if (notify) this.send('question_cancel', { questionVersion: 1, id: live.id,
      reason: status === 'expired' ? 'expired' : 'cancelled' });
    if (['answered', 'human_cancelled'].includes(status)) {
      this.send('question_resolved', { questionVersion: 1, id: live.id, status });
    }
    this.diagnostic(live.id, status);
    live.resolve({ status, id: live.id, ...(answer ? { answer } : {}), ...(reasonCode ? { reasonCode } : {}) });
  }
  failProtocol(reasonCode = 'invalid_frame') { this.finish('protocol_error', true, undefined, reasonCode); }
  reject(message, reason) {
    if (this.live && message?.id === this.live.id) this.failProtocol(reason);
    const id = uuid(message?.id) ? message.id : undefined;
    this.diagnostic(id, reason);
    if (id) this.send('question_answer_rejected', { questionVersion: 1, id, reason });
  }
  receive(message) {
    const live = this.live;
    if (!live || message.id !== live.id) { this.reject(message, 'not_live'); return; }
    if (!this.isCurrent(live.ctx)) { this.finish('session_changed', true); this.reject(message, 'not_live'); return; }
    if (this.clock.now() >= live.frame.expiresAt) { this.finish('expired', true); this.reject(message, 'not_live'); return; }
    const scope = live.frame;
    if (message.project !== scope.project || message.sessionId !== scope.sessionId) {
      this.reject(message, 'scope_mismatch'); return;
    }
    const base = ['v', 'type', 'questionVersion', 'project', 'sessionId', 'at', 'id', 'source'];
    if (message.v !== 1 || message.questionVersion !== 1 || !Number.isSafeInteger(message.at) ||
        message.at < scope.at - CLOCK_SKEW_MS || message.at > this.clock.now() + CLOCK_SKEW_MS || message.at < this.clock.now() - 15000) {
      this.reject(message, 'invalid_answer'); return;
    }
    if (message.type === 'question_closed') {
      const hasDetail = Object.hasOwn(message, 'busyReason');
      if (!exact(message, [...base, 'reason', ...(hasDetail ? ['busyReason'] : [])]) ||
          (hasDetail && (!this.busyReasonSupported() || message.source !== 'system' || message.reason !== 'busy' ||
            !['native_transition_busy', 'native_transition_degraded'].includes(message.busyReason))) ||
          !['human', 'system'].includes(message.source) ||
          !['expired', 'cancelled', 'busy'].includes(message.reason) ||
          (message.source === 'human' && message.reason !== 'cancelled')) {
        this.reject(message, 'invalid_answer'); return;
      }
      // A receiver clock cannot move the authoritative producer deadline early.
      if (message.reason === 'expired') { this.reject(message, 'invalid_answer'); return; }
      this.finish(message.source === 'human' ? 'human_cancelled' : message.reason, false, undefined,
        hasDetail ? message.busyReason : undefined); return;
    }
    if (!exact(message, [...base, 'answer']) || message.type !== 'answer' || message.source !== 'human') {
      this.reject(message, 'invalid_answer'); return;
    }
    const a = message.answer;
    const outcome = validAnswer(live.frame, a, this.structured() === true);
    if (outcome) this.finish('answered', false, outcome);
    else this.reject(message, 'invalid_answer');
  }
}
// One answer, checked against the question that was ASKED. Anything else is refused whole (all-or-nothing).
function validAnswer(frame, a, structured) {
  const free = structured ? STRUCTURED.free : LEGACY.free;
  const offered = (options, v) => options.some(o => o.value === v);
  const single = (options, allowFree, x) => {
    if (exact(x, ['type', 'value']) && x.type === 'option' && offered(options, x.value)) return { type: 'option', value: x.value };
    if (exact(x, ['type', 'text']) && x.type === 'text' && allowFree && text(x.text, free)) return { type: 'text', text: x.text };
    return null;
  };
  const many = (options, allowFree, x) => {
    if (!object(x) || x.type !== 'options' || !Array.isArray(x.values) || x.values.length > options.length ||
        Object.keys(x).some(k => !['type', 'values', 'text'].includes(k))) return null;
    if (new Set(x.values).size !== x.values.length || !x.values.every(v => typeof v === 'string' && offered(options, v))) return null;
    if (x.text !== undefined && !(allowFree && text(x.text, free))) return null;
    if (x.values.length === 0 && x.text === undefined) return null;
    return { type: 'options', values: [...x.values], ...(x.text === undefined ? {} : { text: x.text }) };
  };
  if (frame.questions) {
    if (!structured || !exact(a, ['type', 'answers']) || a.type !== 'form' || !Array.isArray(a.answers) || a.answers.length !== frame.questions.length) return null;
    const out = [];
    for (let i = 0; i < frame.questions.length; i++) {
      const q = frame.questions[i];
      const one = q.multiSelect ? many(q.options, q.allowFreeText, a.answers[i]) : single(q.options, q.allowFreeText, a.answers[i]);
      if (!one) return null;
      out.push(one);
    }
    return { type: 'form', answers: out };
  }
  return frame.multiSelect ? (structured ? many(frame.options, frame.allowFreeText, a) : null) : single(frame.options, frame.allowFreeText, a);
}
function formatResult(result) {
  if (result.status === 'answered') return JSON.stringify(result);
  if (result.status === 'unsupported_receiver') return `No human answer: receiver at ${result.runtime} does not support the requested question capability level (handshake failed). Notices also stopped; no downgrade. Check the selected receiver root.`;
  if (result.status === 'protocol_error') return `No human answer: question protocol error (${result.reasonCode}). The pending call ended immediately; no decision was made. Ask through normal chat instead.`;
  if (result.status === 'busy' && result.reasonCode) {
    const why = result.reasonCode === 'native_transition_busy' ? 'The island is adjusting its window.' :
      'The island cannot verify its window size (native transition degraded).';
    return `No human answer: busy (${result.reasonCode}). ${why} Ask through normal chat instead; do not infer a decision or choose a default.`;
  }
  return `No human answer: ${result.status}. Do not infer a decision or choose a default. If unavailable, ask through normal chat.`;
}
module.exports = { QuestionBroker, normalizeRequest, timeoutValid, DEFAULT_TIMEOUT_MS, FRAME_BYTES, STRUCTURED_FRAME_BYTES, formatResult };
