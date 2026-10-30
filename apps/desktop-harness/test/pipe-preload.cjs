'use strict';
// Test-only preload (node -r) for CHILD-process hook tests on Windows. In production the hook reaches the island through the native
// relay (windows-transport.cjs), which the hosted runner does not have. When ABITO_TEST_PIPE names the fake receiver's named pipe, the
// IslandClient the real bin/abito-hook.cjs builds connects to that pipe directly; everything else (stdin, watchdog, exit codes, wire
// protocol) is the real code. Without ABITO_TEST_PIPE this file does nothing, so the no-relay path stays testable.
const pipe = process.env.ABITO_TEST_PIPE;
if (pipe) {
  const net = require('node:net');
  const client = require('../src/client.cjs');
  const Base = client.IslandClient;
  client.IslandClient = class extends Base {
    constructor(options = {}) { super({ ...options, platform: 'win32', open: () => net.createConnection(pipe) }); }
  };
}
