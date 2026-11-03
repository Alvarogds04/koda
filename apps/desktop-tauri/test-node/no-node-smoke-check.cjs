'use strict';
/* K2-02 T5 (S1, S3): the no-Node/no-Pi installer smokes exist, are wired into CI AFTER the existing smokes in the same
   job, refuse to run anywhere but a disposable GitHub-hosted runner, really remove every node/npm/npx/pi/corepack
   before installing, and assert what the parent decided (daemon running on <install>/runtime/node, installed
   status ok; Linux also records connect() with strace). Structural only: the scripts run for real on CI.
   Run: node apps/desktop-tauri/test-node/no-node-smoke-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const crate = path.resolve(__dirname, '..');
const repo = path.resolve(crate, '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};
const ci = read(path.join(repo, '.github/workflows/ci.yml'));
const job = (name) => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const next = ci.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
};
const GUARD = /GITHUB_ACTIONS.*true.*RUNNER_ENVIRONMENT.*github-hosted|RUNNER_ENVIRONMENT.*github-hosted.*GITHUB_ACTIONS.*true/;

/* ---------------- Linux ---------------- */
const linuxScript = path.join(crate, 'ci/public/smoke-linux-no-node.sh');
test('Linux: smoke-linux-no-node.sh exists', () => assert.ok(fs.existsSync(linuxScript)));
const linux = fs.existsSync(linuxScript) ? read(linuxScript) : '';
test('Linux: refuses to run outside a disposable GitHub-hosted runner, before touching anything', () => {
  const guard = linux.search(GUARD);
  assert.ok(guard >= 0, 'hosted-runner guard');
  // the commands themselves (the header comment may name them before the guard)
  for (const action of ['sudo mv "$hit"', 'sh "$APP/packaging/install.sh"', 'mkdir -p "$WORK"']) {
    const at = linux.indexOf(action);
    assert.ok(at > 0, `the script runs «${action}»`);
    assert.ok(guard < at, `guard comes before «${action}»`);
  }
});
test('Linux: quarantines every node/npm/npx/pi/corepack (all PATH hits) and the toolcache, then proves none is left', () => {
  assert.match(linux, /for tool in node npm npx pi corepack/);
  assert.match(linux, /which -a "\$tool"/);
  assert.match(linux, /RUNNER_TOOL_CACHE/);
  assert.match(linux, /sudo mv /);
  assert.match(linux, /if command -v node >\/dev\/null 2>&1; then .*still/);
  assert.match(linux, /if command -v pi >\/dev\/null 2>&1; then .*still/);
  assert.ok(linux.indexOf('which -a "$tool"') < linux.indexOf('sh "$APP/packaging/install.sh"'), 'quarantine happens before installing');
});
test('Linux: installs the shipped stage with install.sh, launches it, and asserts the daemon runs on <prefix>/runtime/node', () => {
  assert.match(linux, /sh "\$APP\/packaging\/install\.sh" "\$STAGE"/);
  assert.match(linux, /abito-island-daemon: running \(pid /);
  assert.match(linux, /readlink "\/proc\/\$DAEMON_PID\/exe"/);
  assert.match(linux, /= "\$PREFIX\/runtime\/node"/);
  assert.match(linux, /"\$PREFIX\/runtime\/node" "\$PREFIX\/desktop-daemon\/src\/cli\.cjs" status/);
});
test('Linux: records every connect() of the launched tree with strace and refuses any non-loopback address', () => {
  assert.match(linux, /strace -f -qq -e trace=connect -o "\$WORK\/connect\.trace"/);
  assert.match(linux, /sin_addr=inet_addr\("127\.|inet_pton\(AF_INET6, "::1"/);
  assert.match(linux, /pi\.dev/);
});
test('ci.yml installer-smoke-linux: installs strace, then runs the no-node smoke AFTER the existing smoke', () => {
  const j = job('installer-smoke-linux');
  assert.match(j, /strace/);
  const existing = j.indexOf('ci/public/smoke-linux.sh');
  const noNode = j.indexOf('ci/public/smoke-linux-no-node.sh');
  assert.ok(existing > 0 && noNode > existing, 'no-node smoke after the existing smoke');
  const step = j.slice(j.lastIndexOf('      - name:', noNode), j.indexOf('      - name:', noNode));
  assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/, 'runs even if a later part of the existing smoke failed');
  assert.match(step, /STAGE=\$\(find "\$RUNNER_TEMP\/koda-smoke\/stage\/abito-island" -mindepth 1 -maxdepth 1 -type d/, 'the stage the existing smoke built');
  assert.match(step, /--stage "\$STAGE" --work "\$RUNNER_TEMP\/koda-no-node"/);
  assert.match(j, /koda-no-node\/\*\.log/, 'its logs are uploaded');
});

/* ---------------- macOS ---------------- */
const macScript = path.join(crate, 'ci/public/smoke-macos-no-node.py');
test('macOS: smoke-macos-no-node.py exists', () => assert.ok(fs.existsSync(macScript)));
const mac = fs.existsSync(macScript) ? read(macScript) : '';
test('macOS: refuses outside a disposable GitHub-hosted runner before touching anything', () => {
  const guard = mac.search(/os\.environ\.get\("GITHUB_ACTIONS"\) != "true" or os\.environ\.get\("RUNNER_ENVIRONMENT"\) != "github-hosted"/);
  assert.ok(guard > 0);
  for (const action of ['["sudo", "mv"', '"/usr/bin/hdiutil", "attach"', 'd.mkdir(']) assert.ok(guard < mac.indexOf(action), `guard before «${action}»`);
});
test('macOS: quarantines node/npm/npx/pi/corepack (which -a), the toolcache and Homebrew//usr/local, then proves none is left', () => {
  assert.match(mac, /for tool in \("node", "npm", "npx", "pi", "corepack"\)/);
  assert.match(mac, /"\/usr\/bin\/which", "-a", tool/);
  assert.match(mac, /RUNNER_TOOL_CACHE/);
  assert.match(mac, /"\/opt\/homebrew\/bin\/node", "\/usr\/local\/bin\/node"/);
  assert.match(mac, /command -v node; command -v pi/);
  assert.ok(mac.indexOf('"/usr/bin/which", "-a", tool') < mac.indexOf('"/usr/bin/hdiutil", "attach"'), 'quarantine before install');
});
test('macOS: installs from the dmg, starts the installed binary with a Finder-minimal env, daemon on Resources/runtime/node, status running', () => {
  assert.match(mac, /"PATH": "\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
  assert.match(mac, /abito-island-daemon: running \(pid /);
  assert.match(mac, /app \/ "Contents\/Resources\/runtime\/node"/);
  assert.match(mac, /"\/bin\/ps", "-o", "comm=", "-p", pid/);
  assert.match(mac, /os\.path\.realpath\(comm\) == os\.path\.realpath\(str\(runtime_node\)\)/);
  assert.match(mac, /"status"\]/);
  assert.match(mac, /pi-offline\.test\.cjs/, 'the docstring names where S3 is proven for macOS');
});
test('ci.yml installer-smoke-macos: runs the no-node smoke AFTER the existing installed smoke, on the same dmg', () => {
  const j = job('installer-smoke-macos');
  const existing = j.indexOf('ci/public/smoke-macos.py');
  const noNode = j.indexOf('ci/public/smoke-macos-no-node.py');
  assert.ok(existing > 0 && noNode > existing, 'after the existing smokes');
  const step = j.slice(j.lastIndexOf('      - name:', noNode), j.indexOf('      - name:', noNode));
  assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(step, /python3 ci\/public\/smoke-macos-no-node\.py "\$dmg" "\$RUNNER_TEMP\/koda-no-node"/);
  assert.match(j, /koda-no-node\/\*\.log/, 'its log is uploaded');
});

/* ---------------- Windows ---------------- */
const winScript = path.join(crate, 'ci/public/smoke-windows-runtime.ps1');
const win = read(winScript);
test('Windows: the runtime smoke quarantines every node/npm/npx/pi/corepack (Get-Command -All) and the npm prefix, then proves none is left', () => {
  assert.match(win, /foreach \(\$tool in @\('node', 'npm', 'npx', 'pi', 'corepack'\)\)/);
  assert.match(win, /Get-Command \$tool -All -ErrorAction SilentlyContinue/);
  assert.match(win, /Rename-Item -LiteralPath \$hit/);
  assert.match(win, /npm/, 'the npm global prefix leaves PATH');
  assert.match(win, /if \(Get-Command node -ErrorAction SilentlyContinue\) \{ throw /);
  assert.match(win, /if \(Get-Command pi -ErrorAction SilentlyContinue\) \{ throw /);
  const guard = win.indexOf("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'");
  assert.ok(guard > 0 && guard < win.indexOf('Rename-Item -LiteralPath $hit'), 'hosted-runner guard before any quarantine');
});
test('Windows: the installed island starts with no node anywhere; its daemon runs on <install>\\runtime\\node.exe; installed status ok; stopped before uninstall', () => {
  assert.ok(win.includes(String.raw`'abito-island-daemon: running \(pid (\d+)\)'`), 'parses the daemon pid from the ready line');
  assert.match(win, /\(Get-Process -Id \$daemonPid\)\.Path/);
  assert.match(win, /-ne \$runtimeNode\) \{ throw /);
  assert.match(win, /& \$runtimeNode \(Join-Path \$install 'desktop-daemon\\cli\.cjs'\) status|& \$runtimeNode \(Join-Path \$install 'desktop-daemon\/src\/cli\.cjs'\) status/);
  assert.ok(win.indexOf('Get-Process -Id $daemonPid') < win.indexOf("Join-Path $install 'uninstall.exe'"), 'checked before uninstall');
  assert.match(win, /\$island\.Kill\(\$true\)/, 'the island tree is stopped before uninstalling');
  assert.match(win, /pi-offline\.test\.cjs/, 'names where S3 is proven for Windows');
});

console.log(`no-node-smoke-check: ${passed} passed`);
