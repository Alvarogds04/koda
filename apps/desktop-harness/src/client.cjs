'use strict';
// Short-lived QP/1 level-1 / negotiated structured client for harness hook processes. Validation rules mirror
// apps/desktop-pi/questions.cjs (normalizeRequest, QuestionBroker.receive) and adapter.cjs
// (handshake, framing). There is NO approval path: kind is always 'question', and the island
// never decides for the CLI. Diagnostics carry fixed reason codes only (no text, options, ids).
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { verifyEndpoint } = require('./security.cjs');
const { createWindowsConnection } = require('./windows-transport.cjs');
const { projectId, sessionToken, displayFields } = require('./identity.cjs');

const QUESTION_FRAME_BYTES = 4096, STRUCTURED_FRAME_BYTES = 16384, NOTICE_FRAME_BYTES = 512;
const ATTENTION_TITLE_MAX = 64, ATTENTION_DETAIL_MAX = 200;
// The tail of a truncated attention detail: the human is told where the answer lives, so it is never cut.
const ATTENTION_TAIL_CHARS = 26;
const INBOUND_BUFFER_BYTES = 32768, MAX_FRAMES_PER_MIN = 120;
const MIN_TIMEOUT_MS = 30000, MAX_TIMEOUT_MS = 900000;
const READY = '{"v":1,"type":"ready"}';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const token = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
// C0 (except tab/LF/CR), DEL, C1, bidi/format spoofing characters and lone surrogates.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const text = (v, max, empty = false) => typeof v === 'string' && (empty || v.trim().length > 0) &&
  [...v].length <= max && !CONTROL_RE.test(v);

function normalizeRequest(input, structured = false) {
  if (!object(input) || Object.keys(input).some(k => !['kind', 'text', 'options', 'allowFreeText', 'timeoutMs', ...(structured ? ['multiSelect', 'questions'] : [])].includes(k))) {
    throw new Error('Invalid request');
  }
  // Snapshot every field exactly once (getter/proxy TOCTOU); validate and emit only the snapshot.
  const { kind: rawKind, text: questionText, options: rawOptions, timeoutMs, allowFreeText: rawFree, multiSelect, questions } = input;
  const kind = rawKind === undefined ? 'question' : rawKind;
  const allowFreeText = rawFree === undefined ? false : rawFree;
  if (kind !== 'question' || !text(questionText, structured ? 2000 : 500) || !Array.isArray(rawOptions) ||
      typeof allowFreeText !== 'boolean' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('Invalid request');
  }
  if (multiSelect !== undefined && typeof multiSelect !== 'boolean') throw new Error('Invalid request');
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4 || rawOptions.length || allowFreeText || multiSelect === true) throw new Error('Invalid form');
    const items = questions.map(q => {
      if (!exact(q, ['header', 'text', 'options', 'multiSelect', 'allowFreeText']) || !text(q.header, 32)) throw new Error('Invalid form');
      const step = normalizeRequest({ kind: 'question', text: q.text, options: q.options, multiSelect: q.multiSelect,
        allowFreeText: q.allowFreeText, timeoutMs }, true);
      if (step.options.length < 2) throw new Error('Invalid form');
      return { header: q.header, text: step.text, options: step.options, multiSelect: q.multiSelect, allowFreeText: step.allowFreeText };
    });
    return { text: questionText, options: [], allowFreeText: false, timeoutMs, questions: items };
  }
  const length = rawOptions.length;
  if (multiSelect === true && length < 2) throw new Error('Invalid request');
  if (!((length >= 2 && length <= 4) || (length === 0 && allowFreeText))) throw new Error('Invalid request');
  const seen = new Set();
  const copy = [];
  for (let i = 0; i < length; i++) {
    const o = rawOptions[i];
    if (!exact(o, ['value', 'label', 'description'])) throw new Error('Invalid option');
    const value = o.value, label = o.label, description = o.description;
    if (!token(value) || seen.has(value) || !text(label, structured ? 120 : 60) || !text(description, structured ? 400 : 160, true)) throw new Error('Invalid option');
    seen.add(value);
    copy.push({ value, label, description });
  }
  return { text: questionText, options: copy, allowFreeText, timeoutMs, ...(multiSelect === true ? { multiSelect: true } : {}) };
}

// Mirrors QP/1 level 3: answers are positional and validated all-or-nothing against offered values.
function structuredAnswer(frame, a) {
  if (frame.questions) {
    if (!exact(a, ['type', 'answers']) || a.type !== 'form' || !Array.isArray(a.answers) || a.answers.length !== frame.questions.length) return null;
    const answers = frame.questions.map((q, i) => structuredAnswer(q, a.answers[i]));
    return answers.every(Boolean) ? { type: 'form', answers } : null;
  }
  const offered = v => typeof v === 'string' && frame.options.some(o => o.value === v);
  if (frame.multiSelect) {
    if (!object(a) || a.type !== 'options' || !Array.isArray(a.values) ||
        !Object.keys(a).every(k => ['type', 'values', 'text'].includes(k)) || a.values.length > frame.options.length ||
        new Set(a.values).size !== a.values.length || !a.values.every(offered) ||
        (a.text !== undefined && !(frame.allowFreeText && text(a.text, 4000))) ||
        (!a.values.length && a.text === undefined)) return null;
    return { type: 'options', values: [...a.values], ...(a.text === undefined ? {} : { text: a.text }) };
  }
  if (exact(a, ['type', 'value']) && a.type === 'option' && offered(a.value)) return { type: 'option', value: a.value };
  if (exact(a, ['type', 'text']) && a.type === 'text' && frame.allowFreeText && text(a.text, 4000)) return { type: 'text', text: a.text };
  return null;
}

// At most 120 inbound frames per rolling minute window.
function createFrameGate(now = Date.now) {
  let count = 0, period = now();
  return () => {
    if (now() - period >= 60000) { count = 0; period = now(); }
    return ++count <= MAX_FRAMES_PER_MIN;
  };
}

// S4/T2 (human L3, option A): an «attention» notice is display-only text — no option, no answer, no deadline.
// It is validated with the same closed rules the island applies (protocol::notice_text_ok): one visible line,
// bounded length, no C0/C1/bidi/format characters and no lone surrogates.
const noticeText = (value, max) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= max &&
  !/[\x00-\x1f\x7f]/.test(value) && !CONTROL_RE.test(value);
function normalizeAttention(input) {
  if (!object(input) || Object.keys(input).some(k => k !== 'title' && k !== 'detail')) throw new Error('Invalid notice');
  const { title, detail } = input;
  if (!noticeText(title, ATTENTION_TITLE_MAX) || !noticeText(detail, ATTENTION_DETAIL_MAX)) throw new Error('Invalid notice');
  return { title, detail };
}

// Windows (T2/S3): the connection is the native stdio relay child (never a
// direct named-pipe connection); Unix keeps net.createConnection unchanged.
function openConnection(endpoint, platform) {
  return platform === 'win32'
    ? createWindowsConnection(endpoint)
    : net.createConnection(endpoint);
}

// `platform` is an explicit seam (tests simulate win32 on Linux); production
// never passes it, so the choice is process.platform.
const options_platform = platform => platform ?? process.platform;

// The island stamps `at` with ITS clock; this process reads another one. On Windows two processes' Date.now() differ by a few
// milliseconds (coarse timer), so an honest answer could land "before the question" or "in the future" and be dropped as a
// protocol error. A skew far smaller than any replay worth rejecting (staleness stays 15 s, future stays rejected) is tolerated.
const CLOCK_SKEW_MS = 1000;

class IslandClient {
  constructor({ endpoint, runtime, cwd, sessionId, agent, projectName, onDiagnostic, connectTimeoutMs = 3000,
    handshakeTimeoutMs = 3000, clock, open, platform } = {}) {
    this.endpoint = endpoint; this.runtime = runtime; this.cwd = cwd; this.sessionId = sessionId; this.agent = agent; this.projectName = projectName;
    // `open` is an explicit seam (tests); production picks by platform.
    this.open = typeof open === 'function' ? open : undefined;
    this.platform = options_platform(platform);
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : () => {};
    this.connectTimeoutMs = connectTimeoutMs; this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.clock = clock ?? { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout };
    this.asking = false;
  }
  diagnostic(reason) { try { this.onDiagnostic({ reason }); } catch { /* observer only */ } }

  notify() {
    return this.run(null, null);
  }

  // One non-blocking notice for an agent that answers in its own terminal (Codex). Never waits for a reply.
  attention(input) {
    let notice;
    try { notice = normalizeAttention(input); } catch { return Promise.resolve({ status: 'invalid_request' }); }
    return this.run(null, { type: 'attention', ...notice });
  }

  // The prompt was resolved (a Stop): every attention notice of this session goes away at once.
  clearAttention() {
    return this.run(null, { type: 'attention_clear' });
  }

  ask(input) {
    let request;
    try { request = normalizeRequest(input, input?.multiSelect === true || input?.questions !== undefined); } catch { return Promise.resolve({ status: 'invalid_request' }); }
    if (this.asking) return Promise.resolve({ status: 'busy' }); // never queue
    let scope;
    try { scope = { project: projectId(this.cwd), sessionId: sessionToken(this.sessionId) }; } catch {
      return Promise.resolve({ status: 'unavailable' });
    }
    const probe = JSON.stringify({ v: 1, type: 'question', ...scope, at: this.clock.now(), questionVersion: 1,
      id: randomUUID(), kind: 'question', text: request.text, options: request.options,
      allowFreeText: request.allowFreeText, ...(request.multiSelect ? { multiSelect: true } : {}),
      ...(request.questions ? { questions: request.questions } : {}), expiresAt: this.clock.now() + request.timeoutMs });
    if (Buffer.byteLength(probe) > (request.multiSelect || request.questions ? STRUCTURED_FRAME_BYTES : QUESTION_FRAME_BYTES)) return Promise.resolve({ status: 'invalid_request' });
    this.asking = true;
    return this.run(request);
  }

  run(request, notice = null) {
    const { clock } = this;
    const structured = !!(request?.multiSelect || request?.questions);
    const frameCap = structured ? STRUCTURED_FRAME_BYTES : QUESTION_FRAME_BYTES;
    return new Promise(resolve => {
      let scope;
      try {
        if (!this.endpoint) throw new Error('no endpoint');
        scope = { project: projectId(this.cwd), sessionId: sessionToken(this.sessionId) };
      } catch { this.asking = false; resolve({ status: 'unavailable' }); return; }
      let file;
      try { file = verifyEndpoint(this.endpoint, this.runtime, { platform: this.platform }); } catch {
        this.diagnostic('endpoint_rejected'); this.asking = false; resolve({ status: 'unavailable' }); return;
      }
      let stage = 'connect', settled = false, timer, expiryTimer, live = null, buf = Buffer.alloc(0);
      const gate = createFrameGate(clock.now);
      const socket = (this.open ?? (endpoint => openConnection(endpoint, this.platform)))(this.endpoint, this.runtime);
      const stopTimer = () => { if (timer !== undefined) clock.clearTimer(timer); timer = undefined; };
      const stageTimer = ms => { stopTimer(); timer = clock.setTimer(() => violation('timeout'), ms); };
      // `at` can be pinned by the caller so a frame's `at` and `expiresAt` come from ONE clock read.
      const write = (type, extra = {}, at = clock.now()) => {
        if (socket.destroyed) return null;
        const bytes = JSON.stringify({ v: 1, type, ...scope, at, ...extra });
        if (Buffer.byteLength(bytes) > (extra.questionVersion ? frameCap : NOTICE_FRAME_BYTES)) return null;
        return bytes + '\n';
      };
      // Resolve first, then flush an optional last frame, then always destroy the socket.
      const finish = (result, last) => {
        if (settled) return;
        settled = true;
        stopTimer();
        if (expiryTimer !== undefined) clock.clearTimer(expiryTimer);
        expiryTimer = undefined;
        this.asking = false;
        resolve(result);
        const destroy = () => socket.destroy();
        if (last && !socket.destroyed) {
          const backstop = setTimeout(destroy, 500); backstop.unref();
          try { socket.write(last, () => { clearTimeout(backstop); destroy(); }); } catch { destroy(); }
        } else destroy();
      };
      const failure = () => stage === 'qready' ? { status: 'unsupported_receiver' } : { status: 'unavailable' };
      // The one line a notice connection carries: the legacy `settled`, the new `attention`, or its `attention_clear`.
      const noticeLine = () => {
        const at = clock.now();
        if (!notice) return write('settled', { id: randomUUID(), ...displayFields(this.cwd, this.agent, this.projectName) }, at);
        if (notice.type === 'attention_clear') return write('attention_clear', {}, at);
        const id = randomUUID();
        const fields = displayFields(this.cwd, this.agent, this.projectName);
        const frame = detail => {
          const bytes = JSON.stringify({ v: 1, type: 'attention', ...scope, at, id, title: notice.title, detail, ...fields });
          // The newline is framing, but keeping the WHOLE line inside the cap is the strict reading of it.
          return Buffer.byteLength(bytes) + 1 <= NOTICE_FRAME_BYTES ? bytes + '\n' : null;
        };
        const direct = frame(notice.detail);
        if (direct !== null) return direct;
        // A pathological session id can overflow the notice cap: cut the MIDDLE and keep the tail (where the
        // answer lives) visible. A notice that still cannot fit is dropped — never sent cut into a lie.
        const chars = [...notice.detail];
        const tail = chars.slice(Math.max(0, chars.length - ATTENTION_TAIL_CHARS)).join('');
        const head = chars.slice(0, Math.max(0, chars.length - ATTENTION_TAIL_CHARS));
        for (let n = head.length; n > 0; n--) {
          const line = frame(head.slice(0, n).join('') + '… ' + tail);
          if (line !== null) return line;
        }
        return null;
      };
      function cancelFrame(reason) { return live && write('question_cancel', { questionVersion: 1, id: live.id, reason }); }
      const violation = reason => {
        if (settled) return;
        this.diagnostic(reason);
        if (stage === 'wait') finish({ status: 'protocol_error', id: live.id }, cancelFrame('cancelled'));
        else finish(failure());
      };
      const sendOrFail = (type, extra) => {
        const bytes = write(type, extra);
        if (bytes === null) { finish({ status: 'unavailable' }); return false; }
        try { socket.write(bytes); } catch { finish({ status: 'unavailable' }); return false; }
        return true;
      };
      const receive = raw => {
        const l = live;
        let m;
        try { m = JSON.parse(raw); } catch { violation('invalid_json'); return; }
        if (!object(m) || typeof m.id !== 'string' || m.id !== l.id) { violation('invalid_frame'); return; }
        const now = clock.now();
        if (now >= l.expiresAt) { finish({ status: 'expired', id: l.id }, cancelFrame('expired')); return; }
        if (m.project !== l.project || m.sessionId !== l.sessionId) { violation('scope_mismatch'); return; }
        const base = ['v', 'type', 'questionVersion', 'project', 'sessionId', 'at', 'id', 'source'];
        if (m.v !== 1 || m.questionVersion !== 1 || !Number.isSafeInteger(m.at) ||
            m.at < l.at - CLOCK_SKEW_MS || m.at > now + CLOCK_SKEW_MS || m.at < now - 15000) { violation('invalid_frame'); return; }
        if (m.type === 'question_closed') {
          if (!exact(m, [...base, 'reason']) || !['human', 'system'].includes(m.source) ||
              !['cancelled', 'busy'].includes(m.reason) || (m.source === 'human' && m.reason !== 'cancelled')) {
            violation('invalid_frame'); return;
          }
          if (m.source === 'human') {
            finish({ status: 'human_cancelled', id: l.id }, write('question_resolved', { questionVersion: 1, id: l.id, status: 'human_cancelled' }));
          } else finish({ status: m.reason, id: l.id });
          return;
        }
        if (m.type !== 'answer' || !exact(m, [...base, 'answer']) || m.source !== 'human') { violation('invalid_frame'); return; }
        const a = m.answer;
        let answer;
        if (structured) {
          answer = structuredAnswer(l, a);
          if (!answer) { violation('invalid_answer'); return; }
        } else if (exact(a, ['type', 'value']) && a.type === 'option' && l.options.some(o => o.value === a.value)) {
          answer = { type: 'option', value: a.value };
        } else if (exact(a, ['type', 'text']) && a.type === 'text' && l.allowFreeText && text(a.text, 2000)) {
          answer = { type: 'text', text: a.text };
        } else { violation('invalid_answer'); return; }
        finish({ status: 'answered', id: l.id, answer },
          write('question_resolved', { questionVersion: 1, id: l.id, status: 'answered' }));
      };
      const handle = raw => {
        if (stage === 'ready') {
          if (raw !== READY) { violation('handshake'); return; }
          if (!request) {
            const bytes = noticeLine();
            if (bytes === null) finish({ status: 'unavailable' }); else finish({ status: 'sent' }, bytes);
            return;
          }
          stage = 'qready';
          if (sendOrFail('questions_hello', { questionVersion: 1, ...(structured ? { structured: 1 } : {}) })) stageTimer(this.handshakeTimeoutMs);
        } else if (stage === 'qready') {
          let m;
          try { m = JSON.parse(raw); } catch { violation('capability'); return; }
          if (!exact(m, ['v', 'type', 'questionVersion', ...(structured ? ['structured'] : [])]) || m.v !== 1 || m.type !== 'questions_ready' || m.questionVersion !== 1 || (structured && m.structured !== 1)) {
            violation('capability'); return;
          }
          stopTimer();
          const id = randomUUID(), at = clock.now();
          live = { ...request, id, at, ...scope, options: request.options, allowFreeText: request.allowFreeText,
            expiresAt: at + request.timeoutMs };
          stage = 'wait';
          // S3: who asks (agent + project name) travels with the question; both or neither (see displayFields).
          const bytes = write('question', { questionVersion: 1, id, kind: 'question', text: request.text,
            options: request.options, allowFreeText: request.allowFreeText,
            ...(request.multiSelect ? { multiSelect: true } : {}), ...(request.questions ? { questions: request.questions } : {}), expiresAt: live.expiresAt,
            ...displayFields(this.cwd, this.agent, this.projectName) }, at);
          if (bytes === null) { finish({ status: 'unavailable' }); return; }
          try { socket.write(bytes); } catch { finish({ status: 'unavailable' }); return; }
          // Deadline is relative to the emitted frame: its `at` and `expiresAt` share one clock read.
          expiryTimer = clock.setTimer(() => {
            if (!settled) finish({ status: 'expired', id }, cancelFrame('expired'));
          }, request.timeoutMs);
        } else if (stage === 'wait') receive(raw);
      };
      socket.on('error', () => socket.destroy());
      socket.on('close', () => { if (!settled) finish(failure()); });
      socket.on('connect', () => {
        try {
          const after = verifyEndpoint(this.endpoint, this.runtime, { platform: this.platform });
          if (after.dev !== file.dev || after.ino !== file.ino) throw new Error('Endpoint changed');
        } catch { this.diagnostic('endpoint_changed'); finish({ status: 'unavailable' }); return; }
        stage = 'ready';
        if (sendOrFail('hello')) stageTimer(this.handshakeTimeoutMs);
      });
      socket.on('data', chunk => {
        if (settled) return;
        if (buf.length + chunk.length > INBOUND_BUFFER_BYTES) { violation('buffer_cap'); return; }
        buf = Buffer.concat([buf, chunk]);
        let end;
        while (!settled && (end = buf.indexOf(10)) >= 0) {
          const line = buf.subarray(0, end); buf = buf.subarray(end + 1);
          if (!gate()) { violation('frame_quota'); return; }
          if (line.length > frameCap) { violation('frame_size'); return; }
          let raw;
          try { raw = new TextDecoder('utf-8', { fatal: true }).decode(line); } catch { violation('encoding'); return; }
          handle(raw);
        }
        if (!settled && buf.length > (stage === 'ready' ? 64 : frameCap)) violation('frame_size');
      });
      timer = clock.setTimer(() => violation('timeout'), this.connectTimeoutMs);
    });
  }
}

// Fixed English text for adapters. Never includes question text, options, paths or ids.
function formatNoDecision(result) {
  const known = ['expired', 'cancelled', 'human_cancelled', 'busy', 'unavailable', 'unsupported_receiver',
    'protocol_error', 'invalid_request', 'disconnected', 'session_changed'];
  let raw; try { raw = result?.status; } catch { raw = undefined; }
  const status = known.includes(raw) ? raw : 'error';
  return `Koda island: no answer (${status}). Answer in the terminal.`;
}
module.exports = { IslandClient, formatNoDecision, createFrameGate, normalizeRequest, normalizeAttention, ATTENTION_TITLE_MAX, ATTENTION_DETAIL_MAX };
