'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { verifyEndpoint } = require('./security.cjs');
const { createWindowsConnection } = require('./windows-transport.cjs');
const { QuestionBroker, FRAME_BYTES, STRUCTURED_FRAME_BYTES } = require('./questions.cjs');
const projectId = cwd => createHash('sha256').update(cwd).digest('hex');
// S10 (L25): display-only fields of `settled`, sent ONLY after the receiver proved it speaks the extended protocol
// (`questions_ready`); with the flag off the frame stays the exact legacy v1 set. Basename reduced to the wire's
// `[A-Za-z0-9._ -]{1,64}`; the agent is always `pi`.
function displayFields(cwd) {
  try {
    const projectName = require('node:path').basename(fs.realpathSync(cwd)).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 64).trim();
    return projectName ? { projectName, agent: 'pi' } : {};
  } catch { return {}; }
}
const sessionToken = value => typeof value === 'string' && value.length <= 128 &&
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(value);

// Factory has no resources; disconnected notices/questions are never replayed.
// No history or lifecycle event payload is inspected. Questions are explicit.
function registerAdapter(pi, { endpoint, runtime, retryMs = 5000, heartbeatMs = 10000,
  questionTimeoutMs, questionClock, onDiagnostic, questionLevel = 0, onTransportError = () => {}, resolveEndpoint,
  platform = process.platform, open, readFile = fs.readFileSync }) {
  if (![0, 1, 2, 3].includes(questionLevel)) throw new Error('Invalid question capability level');
  let socket, retry, heartbeat, stopped = true, ready = false, questionsReady = false, structuredReady = false, identity, transportError;
  function isCurrent(ctx) {
    try {
      return Boolean(identity && ctx.sessionManager.getSessionId() === identity.sessionId &&
        projectId(fs.realpathSync(ctx.cwd)) === identity.project);
    } catch { return false; }
  }
  const broker = new QuestionBroker({ send: write, scope: () => ({ ...identity }), isCurrent, display: ctx => displayFields(ctx.cwd),
    available: () => !stopped && ready && questionsReady && socket && !socket.destroyed,
    timeoutMs: questionTimeoutMs, clock: questionClock, onDiagnostic,
    structured: () => questionLevel === 3 && structuredReady,
    busyReasonSupported: () => questionLevel >= 2 && questionsReady });
  function stop() {
    broker.finish('cancelled', true);
    stopped = true; ready = false; questionsReady = false; structuredReady = false; identity = undefined;
    clearTimeout(retry); clearInterval(heartbeat);
    const previous = socket; socket = undefined;
    previous?.destroy();
  }
  // Unflushed writes of the CURRENT connection, oldest first: { bytes, at }. Exact UTF-8 byte accounting (the stream's own
  // `writableLength` counts UTF-16 units for strings, so it cannot bound bytes). A write callback fires in FIFO order.
  let inflight = [];
  const INFLIGHT_GRACE_MS = 1000;
  function write(type, extra = {}, at = Date.now()) {
    // Not a one-frame lock: a pipe/relay completes a write a moment after the peer read it, so a small frame in flight (e.g. a
    // heartbeat) must not drop the next `settled`/`question`. Order is the stream's own FIFO (every frame goes through this one
    // socket.write). A STALLED receiver is refused promptly, as before: the oldest unflushed write is older than the grace period.
    // Memory is bounded in TOTAL by bytes: at most one max frame pending plus the frame itself (2 x STRUCTURED_FRAME_BYTES + newline).
    // A refusal returns `false`: a question turns that into status `disconnected` (questions.cjs ask), hello/questions_hello/heartbeat
    // callers destroy the connection (reconnect), and a refused `settled` is dropped without a result, as it always was.
    if (!socket || socket.destroyed || !identity) return false;
    const now = Date.now();
    if (inflight.length > 0 && (now - inflight[0].at > INFLIGHT_GRACE_MS ||
        inflight.reduce((sum, entry) => sum + entry.bytes, 0) > STRUCTURED_FRAME_BYTES)) return false;
    const bytes = JSON.stringify({ v: 1, type, project: identity.project, sessionId: identity.sessionId, at, ...extra });
    if (Buffer.byteLength(bytes) > (extra.questionVersion ? (structuredReady ? STRUCTURED_FRAME_BYTES : FRAME_BYTES) : 512)) return false;
    const entry = { bytes: Buffer.byteLength(bytes) + 1, at: now };
    const mine = inflight;
    mine.push(entry);
    try {
      socket.write(bytes + '\n', () => { const i = mine.indexOf(entry); if (i >= 0) mine.splice(i, 1); });
      return true;
    } catch { const i = mine.indexOf(entry); if (i >= 0) mine.splice(i, 1); return false; }
  }
  // The endpoint whose island dropped the question opt-in (an old receiver). Only THAT endpoint stays unsupported: a
  // restarted island publishes a new one (Unix: a new p-XXXXXX/s; Windows: a rewritten endpoint.json), which is tried.
  let refused;
  function schedule() {
    if (stopped) return;
    clearTimeout(retry);
    if (!transportError) { retry = setTimeout(connect, retryMs); retry.unref(); return; }
    if (transportError.status === 'unsupported_receiver' && refused && endpoint === undefined && resolveEndpoint) {
      retry = setTimeout(watchForNewIsland, retryMs); retry.unref();
    }
  }
  // Which island an endpoint names. Unix: the socket path and its inode (a restart binds a new p-XXXXXX/s). Windows: the
  // endpoint.json path never changes, so its CONTENT (the pipe the island publishes on each start) is the identity.
  function islandIdentity(target, file) {
    if (platform === 'win32') { try { return `${target}\n${readFile(target, 'utf8')}`; } catch { return `${target}\n`; } }
    return `${target}\n${file.dev}:${file.ino}`;
  }
  function watchForNewIsland() {
    if (stopped || !transportError) return;
    let target, file;
    try { target = resolveEndpoint(); file = verifyEndpoint(target, runtime, { platform }); } catch { file = undefined; }
    if (file && islandIdentity(target, file) !== refused) {
      transportError = undefined; refused = undefined; connect(); return;
    }
    schedule();
  }
  function connect() {
    if (stopped) return;
    // No explicit endpoint: re-read the island's stable handoff on every attempt (same checks as the harness
    // hooks). The island binds a new `p-XXXXXX/s` on each start, so a path resolved once would go stale.
    let target = endpoint;
    if (target === undefined && resolveEndpoint) {
      try { target = resolveEndpoint(); } catch { target = undefined; }
    }
    let file;
    try { file = verifyEndpoint(target, runtime, { platform }); } catch { schedule(); return; }
    const openConnection = open ?? (platform === 'win32' ? createWindowsConnection : net.createConnection);
    const connection = openConnection(target);
    socket = connection;
    inflight = [];
    let bytes = Buffer.alloc(0), count = 0, period = Date.now(), questionAttempted = false;
    connection.setTimeout(3000, () => connection.destroy());
    connection.on('connect', () => {
      try {
        const after = verifyEndpoint(target, runtime, { platform });
        if (after.dev !== file.dev || after.ino !== file.ino) throw new Error('Endpoint changed');
      } catch { connection.destroy(); return; }
      write('hello');
    });
    connection.on('data', chunk => {
      if (socket !== connection || stopped) return;
      if (bytes.length + chunk.length > FRAME_BYTES * 8) { broker.failProtocol(); connection.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      let end;
      while ((end = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
        try {
          if (Date.now() - period >= 60000) { count = 0; period = Date.now(); }
          if (++count > 120 || line.length > FRAME_BYTES) throw new Error('Frame quota');
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(line);
          if (!ready) {
            if (raw !== '{"v":1,"type":"ready"}') throw new Error('Handshake rejected');
            ready = true; connection.setTimeout(0);
            if (questionLevel > 0) {
              questionAttempted = true;
              if (!write('questions_hello', { questionVersion: 1, ...(questionLevel >= 2 ? { busyReason: 1 } : {}), ...(questionLevel === 3 ? { structured: 1 } : {}) })) { connection.destroy(); return; }
              connection.setTimeout(3000, () => connection.destroy());
            }
            heartbeat = setInterval(() => { if (!write('heartbeat')) connection.destroy(); }, heartbeatMs);
            heartbeat.unref();
            continue;
          }
          const message = JSON.parse(raw);
          if (message?.type === 'questions_ready') {
            const keys = [...(questionLevel >= 2 ? ['busyReason'] : []), 'questionVersion', ...(questionLevel === 3 ? ['structured'] : []), 'type', 'v'].sort().join(',');
            if (questionLevel === 0 || questionsReady || Object.keys(message).sort().join(',') !== keys ||
                message.v !== 1 || message.questionVersion !== 1 ||
                (questionLevel >= 2 && message.busyReason !== 1) || (questionLevel === 3 && message.structured !== 1)) throw new Error('Invalid capability');
            questionsReady = true; structuredReady = questionLevel === 3; connection.setTimeout(0);
          } else if (questionsReady && ['answer', 'question_closed'].includes(message?.type)) {
            broker.receive(message);
          } else throw new Error('Unknown frame');
        } catch { broker.failProtocol(); connection.destroy(); return; }
      }
      if (bytes.length > (ready ? (structuredReady ? STRUCTURED_FRAME_BYTES : FRAME_BYTES) : 64)) { broker.failProtocol(); connection.destroy(); }
    });
    connection.on('error', () => connection.destroy());
    connection.on('close', () => {
      if (socket !== connection) return;
      if (!stopped && questionAttempted && !questionsReady) {
        transportError = { status: 'unsupported_receiver', runtime };
        refused = islandIdentity(target, file);
        try { onTransportError(transportError); } catch { /* observation cannot alter teardown */ }
      }
      socket = undefined; ready = false; questionsReady = false; structuredReady = false;
      broker.finish('disconnected'); clearInterval(heartbeat); schedule();
    });
  }
  pi.on('session_start', (_event, ctx) => {
    stop(); transportError = undefined;
    // Unix sockets or the authenticated Windows relay; re-resolve discovery
    // on every attempt rather than retaining a stale endpoint after restart.
    if (!['linux', 'darwin', 'win32'].includes(platform) || (!endpoint && !resolveEndpoint)) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionToken(sessionId)) return;
      identity = { v: 1, project: projectId(fs.realpathSync(ctx.cwd)), sessionId };
    } catch { return; }
    stopped = false; connect();
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (stopped || !ready) return;
    try {
      if (!isCurrent(ctx)) { stop(); return; }
      write('settled', { id: randomUUID(), ...(questionsReady ? displayFields(ctx.cwd) : {}) });
    } catch { stop(); }
  });
  pi.on('agent_end', () => broker.finish('cancelled', true));
  pi.on('session_shutdown', stop);
  return { ask: (input, ctx, signal) => transportError ? Promise.resolve({ ...transportError }) :
      broker.ask(input, ctx, signal ?? ctx.signal),
    // True only when a question could be sent right now: receiver speaks QP/1 and no other question is live.
    structured: () => Boolean(questionLevel === 3 && structuredReady && questionsReady),
    canAsk: () => Boolean(!transportError && !stopped && ready && questionsReady && socket && !socket.destroyed && !broker.live) };
}
module.exports = { registerAdapter, projectId };
