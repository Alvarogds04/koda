'use strict';
/* M2 verification harness (test-node/): drives the UNCHANGED Node producer
   logic — the committed Electron `adapter.cjs` + `core.cjs` + `transport.cjs`,
   loaded read-only from the legacy worktree — against the Rust receiver.

   No npm install, no network, no writes: those modules only use Node
   builtins. Usage:
     node producer-check.cjs <endpoint> <runtime> <cwd>
   The adapter resolves its identity exactly like a Pi session would
   (projectId(realpathSync(cwd), getSessionId()), and connects only after
   verifyEndpoint(endpoint, runtime) passes. Prints one JSON line and exits 0. */
const path = require('node:path');
const fs = require('node:fs');

// The producer under test is the SHIPPED Pi adapter of this repository (apps/desktop-pi), not a machine-specific checkout of the
// retired Electron app (the old default path only existed on one developer machine, so the test failed everywhere else).
// ABITO_LEGACY_DESKTOP still points the harness at another adapter.cjs/core.cjs pair.
const SHIPPED = path.resolve(__dirname, '../../desktop-pi');
const LEGACY = process.env.ABITO_LEGACY_DESKTOP || SHIPPED;
const [endpoint, runtime, cwd] = process.argv.slice(2);
if (!endpoint || !runtime || !cwd) {
  console.error('usage: producer-check.cjs <endpoint> <runtime> <cwd>');
  process.exit(2);
}

const { registerAdapter } = require(path.join(LEGACY, 'adapter.cjs'));
const { projectId } = process.env.ABITO_LEGACY_DESKTOP ? require(path.join(LEGACY, 'core.cjs')) : require(path.join(LEGACY, 'adapter.cjs'));

const handlers = new Map();
const fakePi = { on: (name, handler) => handlers.set(name, handler) };
// retryMs keeps reconnects snappy in tests; heartbeatMs stays far beyond the
// harness lifetime so `settled` is the only post-ready write (the adapter
// skips writes while one is still pending).
registerAdapter(fakePi, { endpoint, runtime, retryMs: 100, heartbeatMs: 60000 });

const ctx = { cwd, sessionManager: { getSessionId: () => 'harness-session' } };
handlers.get('session_start')({}, ctx);
// agent_settled only writes when `ready` is true (adapter.cjs), so this is a
// real handshake proof: a skipped write means no ready line ever arrived.
setTimeout(() => { handlers.get('agent_settled')({}, ctx); }, 600);
setTimeout(() => {
  handlers.get('session_shutdown')();
  console.log(JSON.stringify({ project: projectId(fs.realpathSync(cwd)), endpoint }));
  process.exit(0);
}, 1000);
