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
// A Windows checkout may convert these text files to CRLF (core.autocrlf); the rules are about content, not line endings.
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
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
  assert.match(linux, /strace -f -qq (-s \d+ )?-e trace=connect(,execve)? -o "\$WORK\/connect\.trace"/);
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
  assert.match(step, /STAGE=\$\(find "\$RUNNER_TEMP\/koda-smoke\/stage\/koda" -mindepth 1 -maxdepth 1 -type d/, 'the stage the existing smoke built');
  assert.match(step, /--stage "\$STAGE" --work "\$RUNNER_TEMP\/koda-no-node"/);
  assert.match(j, /koda-no-node\/\*\.log/, 'its logs are uploaded');
});

test('Linux S3 window (RDD advisory 8): the trace also records execve, proves the bundled Pi actually ran inside it, and waits on evidence, not a fixed sleep', () => {
  assert.match(linux, /strace -f -qq -s 4096 -e trace=connect,execve -o "\$WORK\/connect\.trace"/);
  // The smoke itself greps the trace for the bundled node exec-ing Pi's CLI (S1 + S3: the traced window covers Pi).
  assert.ok(linux.includes('grep -q "execve(\\"$PREFIX/runtime/node\\".*pi-coding-agent/dist/bundle/cli.js" "$WORK/connect.trace"'),
    'Pi was exec-ed by the bundled node, inside the traced window');
  assert.doesNotMatch(linux, /\nsleep 5 #/, 'no blind fixed sleep');
  assert.match(linux, /PI_CHECK_WINDOW=\d+/, 'a named, bounded observation window after the daemon is ready');
});
test('Linux: a failed part exits non-zero even though the EXIT trap runs cleanup (the trap never resets the status)', () => {
  const cleanup = linux.slice(linux.indexOf('cleanup() {'), linux.indexOf('trap cleanup EXIT INT TERM'));
  assert.match(cleanup, /trap - EXIT INT TERM/);
  assert.doesNotMatch(cleanup, /\bexit 0\b/, 'cleanup never forces a success status');
  assert.match(linux, /failx\(\) \{ printf 'FAIL %s\\n' "\$\*"; diag; exit 1; \}/);
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
test('smoke-macos.py (K2-02): the missing-runtime case is a BROKEN BUNDLED RUNTIME, never the 0.1 «Falta Pi» advice an installed Koda can no longer show', () => {
  // CI 42109391233 (main d18404c): with the bundled runtime the daemon STARTED when the runner's Pi was hidden (correct), so
  // waiting for «pi_missing»/«Falta Pi…» failed. The macOS twin of the Windows fix f94afcd: the installed runtime manifest is
  // moved away, the island must print the exact code line and reinstall sentence, the daemon must NOT start, notices still
  // work (the transport starts before and apart from the daemon), and the manifest is restored in a finally.
  const smoke = read(path.join(crate, 'ci/public/smoke-macos.py'));
  assert.doesNotMatch(smoke, /pi_missing|Falta Pi: instalalo|smoke-disabled/, 'no 0.1 missing-Pi expectation from an installed Koda');
  const at = smoke.indexOf('manifest = app / "Contents/Resources/runtime/koda-runtime.json"');
  assert.ok(at > 0, 'the case targets the installed Resources/runtime manifest');
  const block = smoke.slice(at);
  assert.match(block, /manifest\.rename\(moved\)/, 'the manifest is moved away');
  assert.match(block, /broken = launch\("broken-runtime"\)/);
  assert.ok(block.includes('"island host: no_daemon (bundled_runtime_invalid)" in broken'), 'exact code line');
  assert.ok(block.includes('"La instalación de Koda está dañada: volvé a instalar Koda." in broken'), 'exact sentence');
  assert.match(block, /"abito-island-daemon: running" not in broken/, 'the daemon must not start');
  assert.match(block, /"KODA_DESKTOP_SOCKET=" in broken/, 'notices still work on a broken runtime');
  assert.match(block, /finally:\n\s+moved\.rename\(manifest\)/, 'the manifest is put back');
  const j = job('installer-smoke-macos');
  assert.match(j, /- name: Broken bundled runtime fails closed with notices still available \(installed copy\)\n/);
  assert.doesNotMatch(j, /Missing-Pi advice/);
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

/* ---------------- this check itself runs in CI (RDD advisory 7) ---------------- */
test('this check runs in CI on all 3 OS: run-node-checks.cjs (no file arguments) selects it, and the island-checks shards cover exactly that set', () => {
  const runner = read(path.join(repo, 'run-node-checks.cjs'));
  assert.match(runner, /\.filter\(\(f\) => f\.endsWith\('-check\.cjs'\) && f !== 'producer-check\.cjs'\)/, 'the default set is every *-check.cjs but producer-check');
  assert.ok(fs.readdirSync(path.join(crate, 'test-node')).includes('no-node-smoke-check.cjs'));
  const checks = job('island-checks');
  assert.match(checks, /os: \[ubuntu-latest, macos-26, windows-latest\]/);
  // The default set is split in N shards over the whole set (never a file list): the matrix lists 1..N and the runner is
  // invoked with `--shard <i>/<N>` and nothing else, so no check can fall outside every shard.
  const shards = checks.match(/^\s+shard: \[([0-9, ]+)\]\s*$/m);
  assert.ok(shards, 'island-checks has a shard matrix');
  const list = shards[1].split(',').map((s) => Number(s.trim()));
  const n = list.length;
  assert.deepEqual(list, Array.from({ length: n }, (_, i) => i + 1), 'shards are 1..N');
  const call = checks.match(/^\s+node run-node-checks\.cjs --shard \$\{\{ matrix\.shard \}\}\/([0-9]+)\s*$/m);
  assert.ok(call, 'island-checks runs the runner with only --shard <matrix.shard>/<N> (the whole default set, split)');
  assert.equal(Number(call[1]), n, 'the shard count in the invocation equals the matrix size');
  // The runner really partitions: every default file lands in exactly one of the N shards (`--list` prints the selection).
  const run = (args, env = {}) => require('node:child_process').execFileSync(process.execPath, [path.join(repo, 'run-node-checks.cjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const all = run(['--list']).trim().split(/\r?\n/);
  const seen = [];
  for (let i = 1; i <= n; i++) seen.push(...run(['--shard', `${i}/${n}`, '--list']).trim().split(/\r?\n/));
  assert.deepEqual(seen.sort(), [...all].sort(), 'the N shards cover the default set exactly once');
  assert.ok(all.includes(path.join('test-node', 'no-node-smoke-check.cjs')), 'this check is in the default set');
  // macOS runners are about twice as slow as ubuntu on the browser checks (install-check 56 s vs the 120 s cap on
  // ubuntu; island-s31 156 s vs 420 s), so the wall-clock caps double there and only there (`--list --caps` prints them).
  const caps = (platform) => Object.fromEntries(run(['--list', '--caps'], { RUN_NODE_CHECKS_PLATFORM: platform }).trim().split(/\r?\n/).map((l) => l.split('\t')));
  const linux = caps('linux'), darwin = caps('darwin'), win = caps('win32');
  assert.equal(linux[path.join('test-node', 'install-check.cjs')], '120');
  assert.equal(linux[path.join('test-node', 'island-s31-check.cjs')], '420');
  assert.equal(darwin[path.join('test-node', 'install-check.cjs')], '240');
  assert.equal(darwin[path.join('test-node', 'island-s31-check.cjs')], '840');
  assert.deepEqual(win, linux, 'Windows keeps the ubuntu caps');
});

console.log(`no-node-smoke-check: ${passed} passed`);
