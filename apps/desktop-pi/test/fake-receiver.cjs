'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');

// The platform's real transport, strictly below this worktree; not the installed app.
// Linux/macOS: an AF_UNIX socket at `<runtime>/p-XXXXXX/s`. Windows: a local named pipe `\\.\pipe\...` (AF_UNIX
// listen is refused there) plus the `<runtime>\endpoint.json` metadata file the adapter validates; the receiver then
// carries `platform: 'win32'` and an `open` seam that connects straight to the pipe (the native relay .exe that
// production uses in between is covered by windows-transport.test.cjs and the island's Rust tests).
// `runtime` (optional) binds a SECOND receiver under an existing private root: the handoff test needs the same
// runtime to publish a different endpoint, exactly as an island restart does.
// Bounded CI diagnostics (HU-054): with ABITO_TEST_DIAG=1 the Windows pipe path logs, per client write, writableLength before and
// after, the write-callback latency, 'drain' events, and each frame the server actually reads. Off by default; never alters timing.
const DIAG = process.env.ABITO_TEST_DIAG === '1';
const t0 = Date.now();
let diagLines = 0;
const diag = message => { if (DIAG && diagLines++ < 400) console.log(`# diag +${Date.now() - t0}ms ${message}`); };
function instrument(socket) {
  if (!DIAG) return socket;
  const write = socket.write.bind(socket);
  socket.write = (data, ...rest) => {
    const before = socket.writableLength, started = Date.now();
    const text = String(data).slice(0, 40).replace(/\n/g, '');
    const callback = typeof rest.at(-1) === 'function' ? rest.pop() : undefined;
    const ok = write(data, ...rest, (...args) => { diag(`client write cb ${text} after ${Date.now() - started}ms, writableLength=${socket.writableLength}`); callback?.(...args); });
    diag(`client write ${text} len-before=${before} len-after=${socket.writableLength} returned=${ok}`);
    return ok;
  };
  socket.on('drain', () => diag('client drain'));
  return socket;
}
async function fakeReceiver(t, { questions = false, busyReason = false, structured = false, runtime: parent } = {}) {
  const runtime = parent ?? fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.test-'));
  const windows = process.platform === 'win32';
  let directory, endpoint, listenOn, transport = {};
  if (windows) {
    listenOn = `\\\\.\\pipe\\abito-test-${process.pid}-${require('node:crypto').randomBytes(6).toString('hex')}`;
    endpoint = path.win32.join(runtime, 'endpoint.json');
    fs.writeFileSync(endpoint, JSON.stringify({ v: 1, pipe: listenOn }));
    transport = { platform: 'win32', open: () => instrument(net.createConnection(listenOn)) };
  } else {
    fs.chmodSync(runtime, 0o700);
    directory = fs.mkdtempSync(path.join(runtime, 'p-'));
    fs.chmodSync(directory, 0o700);
    endpoint = listenOn = path.join(directory, 's');
  }
  const capabilities = new Map();
  const clients = new Set(), frames = [], rawFrames = [], events = new EventEmitter();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { clients.delete(socket); capabilities.delete(socket); });
    let bytes = '';
    socket.on('data', chunk => {
      bytes += chunk.toString('utf8');
      let end;
      while ((end = bytes.indexOf('\n')) >= 0) {
        const raw = bytes.slice(0, end); rawFrames.push(raw + '\n');
        const frame = JSON.parse(raw); bytes = bytes.slice(end + 1);
        frames.push(frame);
        events.emit('frame', frame);
        diag(`server read frame ${frame.type}`);
        if (frame.type === 'hello') {
          socket.write('{"v":1,"type":"ready"}\n');

        }
        if (frame.type === 'questions_hello' && questions) {
          capabilities.set(socket, busyReason && frame.busyReason === 1);
          socket.write(JSON.stringify({ v: 1, type: 'questions_ready', questionVersion: 1,
            ...(busyReason && frame.busyReason === 1 ? { busyReason: 1 } : {}),
            ...(structured && frame.structured === 1 ? { structured: 1 } : {}) }) + '\n');
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenOn, resolve); });
  if (!windows) fs.chmodSync(endpoint, 0o600);
  let closed;
  // Idempotent stop: models an island restart (socket closes) without waiting for the test to end.
  const close = () => closed ??= (async () => {
    for (const client of clients) client.destroy();
    await new Promise(resolve => server.close(resolve));
  })();
  t.after(async () => {
    await close();
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  function next(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off('frame', handler); reject(new Error('No frame: ' + type)); }, 1500);
      function handler(frame) {
        if (frame.type !== type) return;
        clearTimeout(timer); events.off('frame', handler); resolve(frame);
      }
      events.on('frame', handler);
    });
  }
  return { ...transport, runtime, endpoint, frames, rawFrames, clients, next, close,
    send: value => { for (const c of clients) c.write(JSON.stringify(value) + '\n'); },
    replyBusy: (q, code) => {
      const replies = [];
      for (const c of clients) {
        const reply = { v: 1, type: 'question_closed', questionVersion: 1, project: q.project,
          sessionId: q.sessionId, at: Date.now(), id: q.id, source: 'system', reason: 'busy',
          ...(capabilities.get(c) ? { busyReason: code } : {}) };
        const raw = JSON.stringify(reply) + '\n'; replies.push(raw); c.write(raw);
      }
      return replies;
    } };
}
function harness(registerAdapter, options) {
  const handlers = new Map();
  // ABITO_TEST_DIAG=1: log every Pi lifecycle event the test delivers and whether the handler threw (CI evidence only).
  const traced = (name, handler) => !DIAG ? handler : (...args) => {
    diag(`pi event ${name}`);
    try { return handler(...args); } catch (error) { diag(`pi event ${name} THREW ${error?.message}`); throw error; }
  };
  const pi = { on: (name, handler) => handlers.set(name, traced(name, handler)) };
  const controller = registerAdapter(pi, { retryMs: 20, heartbeatMs: 30, ...options });
  const ctx = { cwd: path.resolve(__dirname, '..'), sessionManager: { getSessionId: () => 'test-session' } };
  return { pi, handlers, controller, ctx };
}
module.exports = { fakeReceiver, harness };
