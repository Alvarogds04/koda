#!/usr/bin/env node
'use strict';
// Offline pre-install evidence using the real installed Pi in a disposable root.
// No credentials are enrolled, no existing island is read, no external provider call.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-host-smoke-'));
const root = path.join(base, 'island');
const cli = path.resolve(__dirname, '../../desktop-daemon/src/cli.cjs');
const childPath = `${process.env.PATH || '/usr/bin:/bin'}:${process.env.HOME}/.local/bin:/usr/bin`;
const child = cp.spawn(process.execPath, [cli, 'run', '--app-owned'], {
  env: { PATH: childPath, HOME: process.env.HOME, ABITO_ISLAND_DIR: root },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let log = '';
child.stdout.resume(); child.stderr.on('data', b => { log += b; });
const exited = once(child, 'exit');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() >= deadline) throw new Error('smoke deadline'); await sleep(20); }
}
const sessionFile = path.join(root, 'runtime/session.json');
let socket;
(async () => {
  try {
    await waitFor(() => fs.existsSync(sessionFile) || child.exitCode !== null);
    assert.equal(child.exitCode, null, log);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const frames = [];
    let pending = '';
    socket = net.createConnection(session.endpoint);
    socket.on('data', b => {
      pending += b.toString();
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { frames.push(JSON.parse(line)); } catch { throw new Error('invalid host frame'); }
      }
    });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const send = msg => socket.write(JSON.stringify(msg) + '\n');
    const frame = async (type) => { await waitFor(() => frames.some(f => f.type === type)); return frames.find(f => f.type === type); };
    send({ type: 'hello', protocol: 'island-agent/1', token: session.token });
    await frame('ready'); console.log('handshake=ready');
    send({ type: 'providers_list' });
    const providers = await frame('providers');
    console.log('providers=' + JSON.stringify(providers));
    send({ type: 'accounts_list' });
    console.log('accounts=' + JSON.stringify(await frame('accounts')));
    // Chat owns the engine accounts; the removed Conexiones connector section is no longer a UI smoke target.
    console.log('chat_engine_providers=' + JSON.stringify((providers.providers || []).filter(p => Array.isArray(p.methods) && p.methods.length).map(p => p.id)));
    // No chat request: private root has no credentials, and paid/external calls
    // are not authorized. Report that honestly rather than enrolling host auth.
    console.log('chat=NOT_RUN: no isolated provider account configured; no paid/external call authorized');
    const layout = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = path.join(rel, entry.name), file = path.join(dir, entry.name);
        console.log('mode=' + (fs.lstatSync(file).mode & 0o777).toString(8) + ' ' + name);
        if (entry.isDirectory()) layout(file, name);
      }
    };
    console.log('root_mode=' + (fs.statSync(root).mode & 0o777).toString(8)); layout(root);
    socket.destroy(); child.stdin.end();
    const [code, signal] = await exited;
    assert.equal(code, 0, log); assert.equal(signal, null);
    assert.equal(fs.existsSync(sessionFile), false);
    console.log('host_exit=0; session_handoff_removed=true');
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch(error => { console.error('smoke_failed=' + error.message); process.exitCode = 1; });
