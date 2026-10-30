"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("Windows native-healthy CLI status never cleans up and stop still refuses", () => {
  for (const command of ["status", "stop"]) {
    const source = `
      const daemon = require('./src/daemon.cjs');
      const isolation = require('./src/isolation.cjs');
      const config = require('./src/config.cjs');
      const fs = require('node:fs');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      isolation.windowsIslandRootViolation = () => null;
      isolation.defaultIslandRoot = () => 'fixture';
      daemon.readSession = () => ({ pid: 4242, startedAt: 1, endpoint: 'fixture-pipe' });
      daemon.classifySession = async () => ({ state: 'healthy', reason: 'ready', ready: true });
      daemon.isDaemonProcess = () => false;
      daemon.pidState = () => 'alive';
      config.loadConfig = () => ({ workspace: 'fixture', workspaceSource: 'default' });
      config.detectMemoryPinConflict = () => false;
      fs.unlinkSync = () => { throw new Error('unexpected cleanup'); };
      process.kill = () => { throw new Error('unexpected signal'); };
      require('./src/cli.cjs').main([${JSON.stringify(command)}]).then(code => { process.exitCode = code; });
    `;
    const result = spawnSync(process.execPath, ["-e", source], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    if (command === "status") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { running: true, pid: 4242, startedAt: 1, endpoint: "fixture-pipe", workspace: "fixture", workspaceSource: "default", memoryPinConflict: false, state: "healthy", reason: "ready", ready: true });
    } else {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "abito-island-daemon: session.json does not belong to a confirmed daemon; refusing to signal it\n");
    }
  }
});

test("CLI startup diagnostics name failures without paths or secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-cli-diagnostic-"));
  try {
    for (const [message, code, expected, syscall] of [
      ["EACCES: permission denied, open C:\\Users\\private\\token-secret", "EACCES", "Error/EACCES: system operation failed"],
      ["refusing symlink component in island path: /private/token-secret", undefined, "Error/unknown: refusing symlink component in island path [details redacted]"],
      ["token-secret /private/account", "token-secret", "Error/unknown: details redacted"],
      ["native session helper refused the session", undefined, "Error/unknown: native session helper refused the session"],
      ["ENOENT /private/token-secret", "ENOENT", "Error/ENOENT: spawn; system operation failed", "spawn"],
      ["secret", "ENOENT", "Error/ENOENT: system operation failed", "spawn /private/token-secret"],
      ["daemon already running", undefined, null],
    ]) {
      const source = `
        const { Daemon } = require('./src/daemon.cjs');
        Daemon.prototype.start = async function () { throw Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)}, syscall: ${JSON.stringify(syscall)} }); };
        Daemon.prototype.stop = async function () {};
        Daemon.prototype.cleanupSync = function () {};
        require('./src/cli.cjs').main(['run']).then(code => { process.exitCode = code; });
      `;
      const result = spawnSync(process.execPath, ["-e", source], {
        cwd: path.join(__dirname, ".."), encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: root, ABITO_ISLAND_DIR: path.join(root, "Abito") },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, expected === null
        ? "abito-island-daemon: daemon already running\n"
        : `abito-island-daemon: failed (see the island directory permissions and the daemon log) [${expected}]\n`);
      assert.deepEqual(fs.readdirSync(root), [], "rejected startup must not write state");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
