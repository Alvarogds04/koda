'use strict';
// Structural pre-commit evidence only. Toy executable; never an official build.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const L = require('../packaging/lib.cjs');
const crate = path.resolve(__dirname, '..');
// Every module the daemon and the harness load, transitively (subfolders such as src/minikodas/, `../` requires,
// the sibling desktop-harness package), and every file they locate next to themselves (e.g. the Minikoda kit
// extension Pi loads with -e), must ship (L.STAGED). Any load the walker cannot follow FAILS the check unless it
// is listed in REVIEWED with a reason; nothing is skipped silently. Paths are apps/-relative, the stage layout.
const APPS = path.resolve(crate, '..');
const realTree = {
  read: (rel) => fs.readFileSync(path.join(APPS, rel), 'utf8'),
  exists: (rel) => { try { return fs.statSync(path.join(APPS, rel)).isFile(); } catch { return false; } },
};
/**
 * Loads and file references the walker cannot resolve statically, reviewed one by one. Each `text` must still
 * occur in its file (a stale entry fails), and is then masked out of the scan.
 */
const REVIEWED = [
  { file: 'desktop-daemon/src/sdk-helper.mjs', text: 'import(primary)', why: 'the Pi SDK (ABITO_SDK_MODULE or its package name): provided by the Pi install, never shipped here' },
  { file: 'desktop-daemon/src/sdk-helper.mjs', text: 'import(fallback)', why: 'the Pi SDK found next to the installed `pi`, read-only' },
  { file: 'desktop-daemon/src/custom-provider-extension.cjs', text: 'import("@earendil-works/pi-ai/compat")', why: 'inside TEMPLATE: runs in the Pi process, which provides pi-ai' },
  { file: 'desktop-daemon/src/daemon.cjs', text: 'path.resolve(srcDir, "..", "..", "abito-private-session.exe")', why: 'Windows session helper placed by the Windows installer, verified by sha256 before use' },
  { file: 'desktop-harness/src/windows-transport.cjs', text: "path.resolve(__dirname, '..', '..', RELAY_NAME)", why: 'Windows relay exe placed by the Windows installer next to the package' },
  { file: 'desktop-harness/src/windows-transport.cjs', text: "path.resolve(__dirname, '..', '..', 'desktop-tauri', 'target', 'debug', RELAY_NAME)", why: 'development layout only' },
  { file: 'desktop-harness/src/install-recap.cjs', text: "path.resolve(__dirname, '../bin/abito-recap-hook.cjs')", why: 'the removed 0.1 Recap script: only its path is matched, to take old hooks out; never loaded' },
];
const BUILTINS = new Set(require('node:module').builtinModules);
const SHIPPED = new Set(L.STAGED);
const SHIPPED_DIRS = new Set(['.', ...L.STAGED_DIRS]);
const MODULE = /\.(?:cjs|mjs|js)$/;
// A string literal: '…', "…" or a template literal without ${…} (group 1 = its content).
const LIT = String.raw`(?:'([^'\n]*)'|"([^"\n]*)"|\x60([^\x60$\n]*)\x60)`;
const lit = (m, i) => m[i] ?? m[i + 1] ?? m[i + 2];
const LITS = new RegExp(LIT, 'g');
const RESIDUAL = [
  [/\brequire\s*\(/, 'require() of a non-literal'],
  [/\brequire\.resolve\b/, 'require.resolve'],
  [/\bimport\s*\(/, 'import() of a non-literal'],
  [/\bcreateRequire\b/, 'createRequire not called at once with a literal'],
  [/__dirname|__filename|import\.meta/, 'a module-relative path the walker cannot follow'],
  [/^\s*import\b(?!\s*\()/m, 'a static import it cannot parse'],
  [/\bmodule\.require\b|\bprocess\.dlopen\b|\bModule\._load\b/, 'a low-level module load'],
];

/** Same length, same line breaks: line numbers survive masking. */
const blank = (text) => text.replace(/[^\n]/g, ' ');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Walks daemon and harness sources from their entry points and every shipped module, following each way a file
 * is loaded or located: require/import()/createRequire(...)(…)/static import/new URL(…, import.meta.url) with a
 * literal (extension-less resolved like Node), and path.join/resolve(__dirname | <param = __dirname>, literals…).
 * A target must be shipped (L.STAGED / L.STAGED_DIRS); modules are walked in turn. Anything else that loads or
 * locates a file (non-literal specifier, bare __dirname, …) is a problem unless it is REVIEWED.
 */
function checkTree(tree, reviewed = REVIEWED) {
  const problems = [];
  const seen = new Set();
  const usedReview = new Set();
  const resolveSpec = (target) => {
    if (/\.\w+$/.test(path.posix.basename(target))) return target;
    return ['', '.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs'].map((x) => target + x).find((c) => tree.exists(c)) ?? target;
  };
  const visit = (rel, target, what, line) => {
    if (target.startsWith('..')) return problems.push(`${rel}:${line} ${what} reaches outside apps/: ${target}`);
    if (SHIPPED_DIRS.has(target)) return;
    if (!SHIPPED.has(target)) return problems.push(`${rel}:${line} ${what} ${target}, which is not shipped`);
    if (MODULE.test(target) && tree.exists(target)) walk(target);
  };
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let text = tree.read(rel);
    // Full-line comments are not code (kept as blanks so line numbers hold).
    text = text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
    const here = path.posix.dirname(rel);
    for (const entry of reviewed.filter((r) => r.file === rel)) {
      if (!text.includes(entry.text)) { problems.push(`${rel}: reviewed entry no longer present: ${entry.text}`); continue; }
      usedReview.add(entry);
      text = text.split(entry.text).join(blank(entry.text));
    }
    const take = (re, fn) => {
      text = text.replace(re, (...args) => {
        const match = args[0];
        const index = args.at(-2);
        fn(args, lineOf(text, index));
        return blank(match);
      });
    };
    const spec = (rel2, s, what, line) => {
      if (s.startsWith('node:') || BUILTINS.has(s)) return;
      if (!s.startsWith('./') && !s.startsWith('../')) return problems.push(`${rel2}:${line} ${what} the package "${s}", which is not shipped`);
      visit(rel2, resolveSpec(path.posix.normalize(path.posix.join(here, s))), what, line);
    };
    // createRequire(<anything without parentheses deeper than one level>)("<literal>")
    take(new RegExp(String.raw`\bcreateRequire\s*\((?:[^()]|\([^()]*\))*\)\s*\(\s*${LIT}\s*\)`, 'g'), (m, line) => spec(rel, lit(m, 1), 'createRequire loads', line));
    take(new RegExp(String.raw`\brequire\s*\(\s*${LIT}\s*\)`, 'g'), (m, line) => spec(rel, lit(m, 1), 'requires', line));
    take(new RegExp(String.raw`\bimport\s*\(\s*${LIT}\s*\)`, 'g'), (m, line) => spec(rel, lit(m, 1), 'imports', line));
    take(new RegExp(String.raw`^[ \t]*(?:import|export)\b(?:[^'"\x60;()]*?\bfrom)?\s*${LIT}`, 'gm'), (m, line) => spec(rel, lit(m, 1), 'imports', line));
    take(new RegExp(String.raw`\bnew\s+URL\s*\(\s*${LIT}\s*,\s*import\.meta\.url\s*\)`, 'g'), (m, line) => spec(rel, lit(m, 1), 'locates', line));
    // A last default parameter `(<name> = __dirname)` makes <name> an anchor like __dirname itself; any other use
    // of <name> in that file is then a residual problem below.
    const aliases = [];
    take(/\b([A-Za-z_$][\w$]*)\s*=\s*__dirname\s*(?=\))/g, (m) => aliases.push(m[1]));
    const anchor = ['__dirname', ...aliases].map((a) => a.replace(/\$/g, '\\$')).join('|');
    take(new RegExp(String.raw`\bpath(?:\.posix)?\.(?:join|resolve)\(\s*(?:${anchor})\s*((?:,\s*${LIT}\s*)*)\)`, 'g'), (m, line) => {
      const segs = [...m[1].matchAll(LITS)].map((x) => lit(x, 1));
      visit(rel, path.posix.normalize(path.posix.join(here, ...segs)), 'locates', line);
    });
    for (const alias of aliases) {
      const m = new RegExp(String.raw`(?<![\w$.])${alias.replace(/\$/g, '\\$')}(?![\w$])`).exec(text);
      if (m) problems.push(`${rel}:${lineOf(text, m.index)} ${alias} (= __dirname) is used outside path.join/resolve with literals`);
    }
    for (const [re, what] of RESIDUAL) {
      const m = re.exec(text);
      if (m) problems.push(`${rel}:${lineOf(text, m.index)} ${what}: ${m[0].trim()} (follow it in host-stage-check or review it in REVIEWED)`);
    }
  };
  // Entry points, then every shipped daemon/harness module (an unreached module is checked too).
  for (const rel of ['desktop-daemon/src/cli.cjs', 'desktop-daemon/src/daemon.cjs', 'desktop-daemon/src/agents-direct.cjs',
    ...L.DAEMON_FILES.map((f) => `desktop-daemon/${f}`), ...L.HARNESS_FILES.map((f) => `desktop-harness/${f}`)]) {
    if (MODULE.test(rel)) walk(rel);
  }
  for (const entry of reviewed) if (!usedReview.has(entry) && !problems.some((p) => p.includes(entry.text))) problems.push(`${entry.file}: reviewed entry not reached: ${entry.text}`);
  return { problems, seen };
}
{
  const { problems, seen } = checkTree(realTree);
  assert.deepEqual(problems, [], 'daemon/harness load problems:\n' + problems.join('\n'));
  assert.ok(seen.has('desktop-daemon/src/sdk-helper.mjs') && seen.has('desktop-daemon/src/minikodas/kit-extension.js'), 'the module walk must see path-loaded files and subfolders');
  // Every folder that holds a shipped file is a declared staged directory (the closed layout check refuses others).
  const dirs = new Set(L.DAEMON_FILES.map((f) => path.posix.dirname(`desktop-daemon/${f}`)));
  const undeclared = [...dirs].filter((d) => !L.STAGED_DIRS.includes(d));
  assert.deepEqual(undeclared, [], 'staged daemon folders missing from STAGED_DIRS: ' + undeclared.join(', '));
  // RED regressions: each way of loading an unshipped file (or an unreviewable dynamic load) must be refused.
  // The ghost files EXIST in the virtual tree, so only the shipping rule can refuse them.
  const GHOSTS = ['desktop-daemon/src/ghost.cjs', 'desktop-daemon/src/ghost.mjs', 'desktop-daemon/src/ghost.js', 'desktop-daemon/src/minikodas/ghost.js', 'desktop-harness/src/ghost.cjs'];
  const withLine = (file, line) => ({
    read: (rel) => (rel === file ? `${realTree.read(rel)}\n${line}\n` : GHOSTS.includes(rel) ? '"use strict";\n' : realTree.read(rel)),
    exists: (rel) => GHOSTS.includes(rel) || realTree.exists(rel),
  });
  const SVC = 'desktop-daemon/src/minikodas/service.cjs';
  const REGRESSIONS = [
    ['createRequire(...)("./x")', 'desktop-daemon/src/sdk-helper.mjs', 'const g = createRequire(import.meta.url)("./ghost.cjs");'],
    ['extension-less require', 'desktop-daemon/src/daemon.cjs', 'const g = require("./ghost");'],
    ['template-string require', 'desktop-daemon/src/daemon.cjs', 'const g = require(`./ghost.cjs`);'],
    ['static import … from "./x"', 'desktop-daemon/src/sdk-helper.mjs', 'import { ghost } from "./ghost.mjs";'],
    ['static side-effect import', 'desktop-daemon/src/sdk-helper.mjs', 'import "./ghost.mjs";'],
    ['multi-segment path.join(__dirname, "a", "b.js")', 'desktop-daemon/src/daemon.cjs', 'const g = path.join(__dirname, "minikodas", "ghost.js");'],
    ['path.resolve(__dirname, …)', SVC, 'const g = path.resolve(__dirname, "ghost.js");'],
    ['new URL(…, import.meta.url)', 'desktop-daemon/src/sdk-helper.mjs', 'const g = new URL("./ghost.js", import.meta.url);'],
    ['literal dynamic import()', SVC, 'const g = import("../ghost.mjs");'],
    ['harness module require', 'desktop-harness/bin/abito-hook.cjs', "const g = require('../src/ghost.cjs');"],
    ['bare package require', SVC, 'const g = require("left-pad");'],
    ['unrecognised: require(variable)', SVC, 'const g = require(name);'],
    ['unrecognised: template with ${}', SVC, 'const g = require(`./${name}.cjs`);'],
    ['unrecognised: import(variable)', SVC, 'const g = import(spec);'],
    ['unrecognised: require.resolve', SVC, 'const g = require.resolve("./ghost.cjs");'],
    ['unrecognised: bare __dirname', SVC, 'const here = __dirname;'],
    ['unrecognised: __dirname parameter used otherwise', 'desktop-daemon/src/cli.cjs', 'function ghostPath(dir = __dirname) { return dir + "/ghost.cjs"; }'],
    ['unrecognised: import.meta.url', 'desktop-daemon/src/sdk-helper.mjs', 'const here = fileURLToPath(import.meta.url);'],
    ['unrecognised: path.join(__dirname, variable)', SVC, 'const g = path.join(__dirname, name);'],
    ['unrecognised: createRequire alias', 'desktop-daemon/src/sdk-helper.mjs', 'const req = createRequire(import.meta.url); req("./ghost.cjs");'],
  ];
  const missed = REGRESSIONS.filter(([, file, line]) => checkTree(withLine(file, line)).problems.length === 0).map(([name]) => name);
  assert.deepEqual(missed, [], 'load patterns the walker does not refuse: ' + missed.join('; '));
  // Not vacuous: shipped targets reached through the new patterns are accepted.
  const fine = [
    [SVC, 'const g = require("./recipe");'],
    ['desktop-daemon/src/daemon.cjs', 'const g = path.join(__dirname, "minikodas", "kit-extension.js");'],
    ['desktop-daemon/src/sdk-helper.mjs', 'import { writePrivateFile } from "./isolation.cjs";'],
  ].filter(([file, line]) => checkTree(withLine(file, line)).problems.length > 0);
  assert.deepEqual(fine, [], 'shipped targets refused');
  console.log(`module-walk: ${seen.size} files, ${REGRESSIONS.length} load-pattern regressions refused`);
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-host-stage-fixture-'));
try {
  fs.writeFileSync(path.join(stage, 'abito-island'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'abito-island-launcher'), L.launcherText(), { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'abito-island.png'), fs.readFileSync(path.join(crate, 'icons/icon.png')), { mode: 0o644 });
  fs.writeFileSync(path.join(stage, `${L.IDENTIFIER}.desktop`), L.desktopText(), { mode: 0o644 });
  for (const file of L.DAEMON_FILES) {
    const target = path.join(stage, 'desktop-daemon', file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '../desktop-daemon', file), target);
    fs.chmodSync(target, 0o644);
  }
  for (const file of L.HARNESS_FILES) {
    const target = path.join(stage, 'desktop-harness', file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(crate, '../desktop-harness', file), target);
    fs.chmodSync(target, 0o644);
  }
  for (const name of L.PI_FILES) {
    const file = path.join(stage, 'desktop-pi', name); fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o755});
    fs.copyFileSync(path.join(crate, '..', 'desktop-pi', name), file); fs.chmodSync(file, 0o644);
  }
  // K2-02 T2 (parent-approved minimal addition): the runtime archive is part of the closed staged set;
  // this structural fixture only needs its bytes present for the receipt/verifyStage hashing.
  fs.writeFileSync(path.join(stage, 'koda-runtime-linux-x64.tar.gz'), 'runtime archive fixture (structural test only; install.sh parses the real archive)\n', { mode: 0o644 });
  const receipt = {
    fixture: 'PRE-COMMIT STRUCTURAL TEST ONLY; toy executable, synthetic provenance, NOT RELEASE EVIDENCE',
    identifier: L.IDENTIFIER, version: L.checkConfig(crate).version,
    format: 'A user-local', r6_sha256: L.checkR6(crate),
    provenance: { head: 'a'.repeat(40), clean: true, dirty_entries: 0 },
    files: Object.fromEntries(L.STAGED.map(f => [f, L.sha256File(path.join(stage, f))])),
  };
  fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
  assert.deepEqual(L.verifyStage(stage), []);
  console.log(receipt.fixture);
  console.log('STAGED=' + JSON.stringify(L.STAGED));
  for (const file of [...L.STAGED, 'receipt.json']) console.log(`${(fs.lstatSync(path.join(stage, file)).mode & 0o777).toString(8)} ${file}`);
  console.log('RECEIPT=' + JSON.stringify(receipt, null, 2));
  const result = cp.spawnSync(process.execPath, [path.join(crate, 'packaging/verify.cjs'), stage], { encoding: 'utf8' });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 0);
  console.log('verify_exit=' + result.status);

  // Exercise the public CLI from the shipped tree, not the source checkout. A valid
  // receipt alone cannot prove that every transitively required module was shipped.
  const island = path.join(stage, 'missing-island');
  const status = () => cp.spawnSync(process.execPath, [path.join(stage, 'desktop-daemon/src/cli.cjs'), 'status'], {
    cwd: stage, encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin', HOME: stage, ABITO_ISLAND_DIR: island },
  });
  const baseline = status();
  assert.equal(baseline.error, undefined);
  assert.equal(baseline.signal, null);
  assert.equal(baseline.status, 3, baseline.stderr);
  assert.equal(baseline.stdout, '');
  assert.equal(baseline.stderr, 'abito-island-daemon: not running (stale: no_session)\n');
  assert.equal(fs.existsSync(island), false, 'status must not create or start an island');
  assert.deepEqual(L.verifyStage(stage), [], 'status must leave every shipped byte unchanged');

  // Each connector-host module is required even when no host binary is configured.
  // Removing either file from this disposable stage must fail, never use a checkout
  // fallback or quietly change the CLI's not-running baseline.
  for (const name of ['connector-host.cjs', 'connector-host-client.cjs', 'minikodas/index.cjs']) {
    const file = path.join(stage, 'desktop-daemon/src', name);
    const contents = fs.readFileSync(file);
    try {
      fs.unlinkSync(file);
      const missing = status();
      assert.equal(missing.error, undefined);
      assert.equal(missing.signal, null);
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, '');
      assert.ok(missing.stderr.includes(`Error: Cannot find module './${name}'`), missing.stderr);
      assert.equal(fs.existsSync(island), false, 'missing module must not create an island');
    } finally { fs.writeFileSync(file, contents, { mode: 0o644 }); }
    assert.deepEqual(L.verifyStage(stage), [], 'omission probe must restore the exact staged files');
  }
  console.log('staged-cli: status baseline + 3 module-omission regressions passed');
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
