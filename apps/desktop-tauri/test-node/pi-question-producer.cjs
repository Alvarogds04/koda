'use strict';
// Real producer, real UnixStream. Only Pi event/context registration is stubbed.
// Wire observation never substitutes writes, schema, broker or endpoint checks.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const source = process.env.ABITO_PI_PRODUCER_DIR;
assert(source && path.isAbsolute(source), 'ABITO_PI_PRODUCER_DIR is required');
assert.equal(fs.realpathSync(source), source, 'explicit canonical producer directory required');
for (const name of ['adapter.cjs', 'questions.cjs']) {
  const file = fs.lstatSync(path.join(source, name));
  assert(file.isFile() && !file.isSymbolicLink(), 'real producer source required');
}
const [endpoint, runtime, cwd, mode, requestedSession = 'qp-real-session'] = process.argv.slice(2);
assert(['questions', 'questions-level2', 'legacy', 'native-busy', 'native-degraded',
  'native-busy-level1', 'native-degraded-level1', 'cross-project'].includes(mode));
assert.equal(fs.realpathSync(cwd), cwd);
const nativeBusy = mode.startsWith('native-');
const questionLevel = mode === 'legacy' ? 0 :
  mode === 'questions-level2' || (nativeBusy && !mode.endsWith('-level1')) ? 2 : 1;
const enabled = questionLevel > 0;
const sessionId = requestedSession;
const diagnostics = [];
const legacy = {};
const received = [];
const types = [];
let question, ack, transportError, questionsHello, closedReply;
let incoming = Buffer.alloc(0);
function observedFrame(raw) {
  try { return JSON.parse(raw); }
  catch { throw new Error('invalid_wire_observation'); } // Never echo a private payload in an error.
}

// Observe the real socket returned by the original factory. No fabricated
// server messages, retries, timestamps, UUIDs, tokens or default answers.
const createConnection = net.createConnection;
net.createConnection = function (...args) {
  const socket = createConnection.apply(this, args);
  const write = socket.write;
  socket.write = function (chunk, ...rest) {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const frame = observedFrame(raw);
    if (types.length < 16) types.push(frame.type);
    if (['hello', 'heartbeat', 'settled'].includes(frame.type) && !legacy[frame.type]) legacy[frame.type] = raw;
    if (frame.type === 'questions_hello') questionsHello = raw;
    if (frame.type === 'question') question = { id: frame.id, project: frame.project, sessionId: frame.sessionId };
    if (frame.type === 'question_resolved') ack = { id: frame.id, status: frame.status };
    return write.call(this, chunk, ...rest);
  };
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    assert(incoming.length <= 32768, 'bounded observation');
    let end;
    while ((end = incoming.indexOf(10)) >= 0) {
      const raw = incoming.subarray(0, end + 1).toString('utf8');
      incoming = incoming.subarray(end + 1);
      const type = observedFrame(raw).type;
      // Never retain the answer payload in the trace.
      if (['ready', 'questions_ready'].includes(type)) received.push(raw);
      if (type === 'question_closed') closedReply = raw;
    }
  });
  return socket;
};
const { registerAdapter, projectId } = require(path.join(source, 'adapter.cjs'));
assert(require.cache[path.join(source, 'questions.cjs')], 'adapter must load the real QuestionBroker');
const events = new Map();
const pi = { on(name, callback) { assert(!events.has(name)); events.set(name, callback); } };
const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };
const config = require(path.join(source, 'config.cjs'));
const options = { ...config.resolveConfig({ ABITO_DESKTOP_SOCKET: endpoint, ABITO_SOCKET_DIR: runtime }, process.getuid()),
  ...config.resolveQuestionConfig({ ...(enabled ? { ABITO_QUESTIONS: String(questionLevel) } : {}),
    ABITO_QUESTION_TIMEOUT_MS: '30000' }) };
const adapter = registerAdapter(pi, { ...options, retryMs: 10000, heartbeatMs: 200,
  onDiagnostic: d => diagnostics.push(d), onTransportError: error => { transportError = error; } });
const watchdog = setTimeout(() => { process.stderr.write('pi-question-producer: deadline\n'); process.exit(2); }, 8000);
const control = readline.createInterface({ input: process.stdin });
const finish = new Promise(resolve => control.once('line', line => { assert.equal(line, 'finish'); resolve(); }));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const wait = async predicate => { while (!predicate()) await new Promise(resolve => setTimeout(resolve, 10)); };
const request = { kind: 'question', text: 'QP2_PRIVATE_QUESTION_CANARY', options: [
  { value: 'opaque-real-A', label: 'First', description: '' },
  { value: 'opaque-real-B', label: 'Second', description: '' }], allowFreeText: false, timeoutMs: 30000 };

async function main() {
  events.get('session_start')({}, ctx);
  const ready = questionLevel === 2 ? '{"v":1,"type":"questions_ready","questionVersion":1,"busyReason":1}\n' :
    enabled ? '{"v":1,"type":"questions_ready","questionVersion":1}\n' : '{"v":1,"type":"ready"}\n';
  await wait(() => received.includes(ready) || transportError);
  if (transportError) {
    assert.equal(transportError.status, 'unsupported_receiver');
    assert.equal(transportError.runtime, runtime);
    emit({ phase: 'result', status: transportError.status, runtimeMatches: true });
  } else if (enabled) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 6000);
    const answer = adapter.ask(request, ctx, abort.signal);
    assert(question, 'ask must write a real question');
    assert.equal(question.project, projectId(cwd)); assert.equal(question.sessionId, sessionId);
    emit({ phase: 'question_pending', id: question.id, project: question.project, sessionId, received, questionsHello });
    const result = await answer;
    clearTimeout(timeout);
    for (const d of diagnostics) assert.deepEqual(Object.keys(d).sort(), ['id', 'reason']);
    const copy = nativeBusy ? require(path.join(source, 'questions.cjs')).formatResult(result) : undefined;
    emit({ phase: 'result', result, ack, diagnostics, types, copy, closedReply });
  } else {
    await wait(() => legacy.heartbeat);
    events.get('agent_settled')({}, ctx);
    await wait(() => legacy.settled);
    const result = await adapter.ask(request, ctx);
    assert.equal(result.status, 'unavailable');
    assert(types.every(t => ['hello', 'heartbeat', 'settled'].includes(t)));
    // Leave time for forbidden unsolicited QP bytes to surface, not just the
    // first read containing ready. The actual receiver callback is also tested.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(received, ['{"v":1,"type":"ready"}\n']);
    emit({ phase: 'result', result, legacy, received, diagnostics, project: projectId(cwd), sessionId });
  }
  // Rust confirms ACK while the originating socket is STILL connected. Closing
  // here first would let disconnect masquerade as successful ACK consumption.
  await finish;
  events.get('session_shutdown')({}, ctx);
  control.close(); net.createConnection = createConnection;
  clearTimeout(watchdog);
}
main().catch(() => {
  events.get('session_shutdown')?.({}, ctx);
  process.stderr.write('pi-question-producer: assertion_or_transport_failure\n');
  process.exit(1);
});
