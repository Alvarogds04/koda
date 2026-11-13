#!/usr/bin/env node
'use strict';
// Structural policy only; native ParseFile and install smoke must still run in CI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ci = path.join(__dirname, '../ci/public');
const workflow = fs.readFileSync(path.join(ci, 'preview-windows.yml'), 'utf8');
const firstStep = workflow.split('    steps:\n')[1].split('      - uses: actions/checkout@v4')[0];
assert.match(firstStep, /working-directory: \$\{\{ runner.temp \}\}/);
assert.match(firstStep, /if \(-not \$IsWindows -or \$env:GITHUB_ACTIONS -ne 'true' -or\s+\$env:RUNNER_ENVIRONMENT -ne 'github-hosted'\) \{\s+throw /);
assert.ok(firstStep.indexOf('throw ') < firstStep.indexOf('\n          }'));
assert.doesNotMatch(firstStep, /continue-on-error|choco|npm|uses:/);
const smoke = fs.readFileSync(path.join(ci, 'smoke-windows.ps1'), 'utf8');
assert.match(smoke.slice(0, smoke.indexOf('New-Item')), /if \(-not \$IsWindows -or \$env:GITHUB_ACTIONS -ne 'true' -or \$env:RUNNER_ENVIRONMENT -ne 'github-hosted'\) \{\s+throw /);
// Explicit status function avoids GitHub's implicit success() gate after a
// foreign-account failure; each install step still requires its own prerequisite.
for (const [name, dependency] of [
  ['Build native release island and helpers', 'native-daemon'],
  ['Stage closed runtime and build full installer', 'release-build'],
  ['Full install, hooks, diagnostics and uninstall smoke', 'installer-build'],
  ['Bundled runtime install and uninstall smoke', 'installer-build'],
]) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('      - name:')[0];
  assert.ok(step?.includes(`if: \${{ !cancelled() && steps.${dependency}.outcome == 'success' }}`), `${name} must be independent of foreign-account failure`);
}
assert.match(workflow, /name: Remove only this run's owned probe account\s+if: always\(\)/);
const foreign = fs.readFileSync(path.join(ci, 'foreign-user.ps1'), 'utf8');
assert.doesNotMatch(foreign, /RandomNumberGenerator\]::Fill\(/);
assert.match(foreign, /\$rng\.GetBytes\(\$random\)/);
assert.match(foreign, /finally \{ \$rng\.Dispose\(\) \}/);
assert.match(foreign, /Probe setup failed at \$setupStage \(\$errorType, \$errorCode\)/);
assert.doesNotMatch(foreign, /\$_.Exception.Message|Write-(?:Host|Output|Error).*\$password/);
assert.equal((foreign.match(/'Abito CI ' \+ \$record\.nonce/g) || []).length, 3, 'create/run/cleanup must share the ownership tag');
assert.doesNotMatch(foreign, /'Abito CI ' \+ \$record\.run/);
assert.ok(('Abito CI ' + 'f'.repeat(32)).length <= 48, 'New-LocalUser description limit');
assert.match(workflow, /tar -xjf \$archive -C \$env:RUNNER_TEMP/);
assert.match(workflow, /Test-Path \(Join-Path \$lib 'sherpa-onnx-c-api\.lib'\)/);
assert.match(workflow, /"SHERPA_ONNX_LIB_DIR=\$lib" >> \$env:GITHUB_ENV/);
const installer = workflow.split('      - name: Stage closed runtime and build full installer\n')[1].split('      - name:')[0];
assert.ok(installer.includes('"/DRUNTIMEDIR=$dist\\windows-runtime"'), 'native NSIS must receive an explicit Windows runtime directory');
for (const diagnostic of [
  'Get-ChildItem -Recurse dist | Select-Object FullName,Length',
  'Test-Path dist/windows-runtime/runtime.nsh',
  'Get-Content dist/windows-runtime/runtime.nsh -TotalCount 5',
]) {
  assert.ok(installer.includes(diagnostic), `missing pre-NSIS diagnostic: ${diagnostic}`);
  assert.ok(installer.indexOf(diagnostic) < installer.indexOf('& $nsis /V2'));
}
assert.doesNotMatch(installer, /Remove-Item|New-Item/);
assert.match(workflow, /cargo test --locked --lib identity::windows_path_tests/);
assert.match(smoke, /if \(\$Mode -eq 'explicit-root'\) \{ \$env:KODA_PROJECT_ROOT = \$workspace \}\s+else \{ Remove-Item Env:KODA_PROJECT_ROOT/);
assert.match(smoke, /Start-Island 'explicit-root'/);
assert.match(smoke, /return \$candidate\.pid -eq \$script:process\.Id/);
assert.match(smoke, /if \(\$metadata\.pid -ne \$script:process\.Id\) \{ throw 'Receiver metadata does not belong/);
assert.doesNotMatch(smoke, /Wait-For \{ \(Test-Path[^\n]*endpoint\.json/);
assert.match(smoke, /\} catch \{\s+Show-SmokeDiagnostics\s+throw\s+\} finally/);
assert.match(smoke, /Get-Content -LiteralPath \$log.FullName -Tail 80/);
assert.doesNotMatch(smoke, /Get-Content[^\n]*session\.json/);
// K2-02: the no-node discovery diagnostics went with the no-node case (an installed Koda never looks up a system Node);
// «no node/pi reachable» is now proven by smoke-windows-runtime.ps1, which quarantines them and checks the daemon's exe.
const runtimeSmoke = fs.readFileSync(path.join(ci, 'smoke-windows-runtime.ps1'), 'utf8');
assert.match(runtimeSmoke, /Get-Command \$tool -All -ErrorAction SilentlyContinue/);
assert.match(runtimeSmoke, /if \(\$daemonExe -ne \$runtimeNode\) \{ throw /);
assert.match(smoke, /\$runtimeFailures\.Add/);
assert.ok(smoke.indexOf("PASS preserving uninstall") < smoke.indexOf('if ($runtimeFailures.Count -gt 0)'), 'uninstall must precede aggregated runtime failure');
// K2-02 T2 (decision B): the installer stage builds the pinned runtime archive first and every
// rule is checked as its own block so each shows its own RED/GREEN.
const rootWorkflow = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/preview-windows.yml'), 'utf8');
const ciRules = [];
const ciRule = (name, fn) => ciRules.push([name, fn]);
ciRule('both preview-windows.yml copies stay byte-identical', () => {
  assert.equal(rootWorkflow, workflow);
});
ciRule('the installer stage builds the pinned runtime with --self-check and ships the archive through staging and the manifest, each step exiting on failure', () => {
  const build = installer.indexOf('node packaging/runtime/build-runtime.cjs --target win-x64 --out "$runtimeOut" --cache "$env:RUNNER_TEMP\\koda-runtime-cache" --self-check --archive "$runtimeArchive"');
  const stage = installer.indexOf('node packaging/windows/stage-runtime.cjs --runtime-archive "$runtimeArchive"');
  const manifest = installer.indexOf('node packaging/windows/install-manifest.cjs --runtime "$runtimeOut"');
  assert.ok(build >= 0 && stage >= 0 && manifest >= 0, 'build-runtime, stage-runtime and install-manifest lines present');
  assert.ok(build < stage && stage < manifest, 'runtime built before staging, staged before the manifest');
  assert.match(installer, /node packaging\/runtime\/build-runtime\.cjs[^\n]+\n          if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  assert.match(installer, /node packaging\/windows\/stage-runtime\.cjs --runtime-archive[^\n]+\n          if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  assert.match(installer, /--cache "\$env:RUNNER_TEMP\\koda-runtime-cache" --self-check/);
});
ciRule('the bundled-runtime smoke runs after the full install smoke, independently of it, in its own script', () => {
  const step = workflow.split('      - name: Bundled runtime install and uninstall smoke\n')[1]?.split('      - name:')[0];
  assert.ok(step, 'runtime smoke step exists');
  assert.ok(step.includes("if: ${{ !cancelled() && steps.installer-build.outcome == 'success' }}"), 'independent of the full smoke step');
  assert.match(step, /\.\/ci\/public\/smoke-windows-runtime\.ps1 -Setup \$setup/);
  assert.ok(workflow.indexOf('Full install, hooks, diagnostics and uninstall smoke') < workflow.indexOf('Bundled runtime install and uninstall smoke'));
});
ciRule('the runtime smoke script is parsed with the others before any account operation', () => {
  assert.match(workflow, /foreach \(\$script in @\('foreign-user\.ps1', 'smoke-windows\.ps1', 'smoke-windows-runtime\.ps1'\)\)/);
});
ciRule('the bundled-runtime smoke script keeps the hosted-runner guard before any state', () => {
  const script = fs.readFileSync(path.join(ci, 'smoke-windows-runtime.ps1'), 'utf8');
  assert.match(script.slice(0, script.indexOf('New-Item')), /if \(-not \$IsWindows -or \$env:GITHUB_ACTIONS -ne 'true' -or \$env:RUNNER_ENVIRONMENT -ne 'github-hosted'\) \{\s+throw /);
});
ciRule('smoke-windows.ps1: the closed-set comparison excludes exactly the runtime/ prefix (decision D4), nothing else', () => {
  const block = smoke.slice(smoke.indexOf('$actual = @(Get-ChildItem'), smoke.indexOf("throw 'Installed payload differs from closed file set'"));
  assert.match(block, /Where-Object \{ -not \$_\.StartsWith\('runtime\/'\) \}/, 'runtime/ files are left to smoke-windows-runtime.ps1');
  assert.equal((smoke.match(/StartsWith\('runtime\/'\)/g) || []).length, 1, 'one exclusion, only in the closed-set comparison');
  assert.doesNotMatch(smoke, /Where-Object \{[^}]*-notlike|Where-Object \{[^}]*-notmatch 'runtime/, 'no broader filter');
});
ciRule('smoke-windows-runtime.ps1 never assigns the read-only automatic $HOME variable', () => {
  const script = fs.readFileSync(path.join(ci, 'smoke-windows-runtime.ps1'), 'utf8');
  assert.doesNotMatch(script, /^\s*\$home\s*=/im);
});
ciRule('smoke-windows-runtime.ps1 checks runtime\\node.exe against abito-install.json and refuses reparse points in runtime', () => {
  const script = fs.readFileSync(path.join(ci, 'smoke-windows-runtime.ps1'), 'utf8');
  assert.match(script, /Get-Content -Raw -LiteralPath \(Join-Path \$install 'abito-install\.json'\) \| ConvertFrom-Json/);
  assert.match(script, /\.files\.'runtime\/node\.exe'/);
  assert.match(script, /\(Get-FileHash -LiteralPath \$runtimeNode -Algorithm SHA256\)\.Hash\.ToLowerInvariant\(\) -ne \$pinnedNode/);
  assert.match(script, /Get-ChildItem -LiteralPath \(Join-Path \$install 'runtime'\) -Recurse -Force -Attributes ReparsePoint/);
  const install = script.indexOf('Start-Process -FilePath (Resolve-Path');
  assert.ok(script.indexOf("'runtime/node.exe'") > install && script.indexOf('ReparsePoint') > install, 'checked on the installed tree');
  assert.ok(script.indexOf('ReparsePoint') < script.indexOf("& $runtimeNode --version"), 'before the bundled node is executed');
});
ciRule('smoke-windows.ps1 (K2-02): the missing-runtime case is a BROKEN BUNDLED RUNTIME, never the 0.1 «Falta Pi/Node» advice an installed Koda can no longer show', () => {
  // CI 41853593735: with the bundled runtime the daemon STARTED in the old no-pi/no-node cases (correct), so waiting for
  // «Falta Pi…»/«Falta Node.js…» timed out. The failure path is now: the installed runtime manifest is removed, the
  // island must report bundled_runtime_invalid with the reinstall sentence, the daemon must NOT start, and the manifest
  // is restored in a finally so the uninstall check still sees the shipped set.
  assert.doesNotMatch(smoke, /Falta Pi: instalalo|Falta Node\.js: instalalo/, 'no 0.1 missing-runtime advice expected from an installed Koda');
  assert.doesNotMatch(smoke, /Hide-CanonicalNode|Restore-CanonicalNode|Show-NodeDiscovery/, 'the system-Node hiding helpers are gone with the no-node case');
  const block = smoke.slice(smoke.indexOf("mode = 'broken-runtime'"), smoke.indexOf('$unrelated = '));
  assert.ok(block.length > 0, 'a broken-runtime case exists before the uninstall section');
  assert.match(block, /Rename-Item -LiteralPath \$manifest/, 'the installed runtime manifest is moved away');
  assert.ok(block.includes("island host: no_daemon (bundled_runtime_invalid)"), 'exact code line');
  assert.ok(block.includes('La instalación de Koda está dañada: volvé a instalar Koda.'), 'exact sentence');
  assert.match(block, /-match 'abito-island-daemon: running'\) \{ throw /, 'the daemon must not start');
  assert.match(block, /finally \{[^}]*Rename-Item -LiteralPath \$moved/, 'the manifest is restored in a finally');
});
ciRule('smoke-windows.ps1 broken-runtime (RDD advisories): the manifest is restored even if Stop-Island throws, and both stderr lines are WAITED for (no read-before-write race)', () => {
  const block = smoke.slice(smoke.indexOf("mode = 'broken-runtime'"), smoke.indexOf('$unrelated = '));
  // restore in its OWN finally that runs regardless of Stop-Island: try { Stop-Island } finally { <restore> }
  assert.match(block, /try \{ Stop-Island \} finally \{\s*(#[^\n]*\n\s*)*if \(Test-Path -LiteralPath \$moved\) \{ Rename-Item -LiteralPath \$moved/, 'restore is independent of Stop-Island');
  // the wait covers BOTH strings, so the code-line assertion never reads stderr before the line is written
  assert.match(block, /Wait-For \{ \$t = Get-Content -Raw -LiteralPath [^}]*\$t -like "\*\$\(\$case\.message\)\*" -and \$t\.Contains\(\$case\.code\) \}/, 'one wait for the code line AND the sentence');
});
ciRule('smoke-windows.ps1 (K2-03): the preserving-uninstall hash skips WebView2\'s own EBWebView cache, which a lingering msedgewebview2 keeps locked', () => {
  // CI 42207296565: Get-FileHash failed on com.abitog.AbitoTauri\EBWebView\BrowserMetrics\*.pma «because it is being used by
  // another process». That folder is the embedded browser's cache, not the person's island data; everything else is hashed.
  const line = smoke.split('\n').find((l) => l.includes('$islandDataHashes = {'));
  assert.ok(line, 'the island user data hash exists');
  assert.ok(line.includes("Where-Object { -not $_.FullName.Contains('\\EBWebView\\') }"), 'EBWebView is excluded before hashing');
  assert.ok(line.indexOf('EBWebView') < line.indexOf('Get-FileHash'), 'excluded before Get-FileHash runs');
  assert.match(line, /-join ';'/, 'compared as one string, not as arrays');
});
let ciFailed = 0;
for (const [name, fn] of ciRules) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { ciFailed += 1; console.log(`FAIL: ${name}\n      ${String(e.message).split('\n')[0]}`); }
}
if (ciFailed > 0) { console.error(`FAIL: ${ciFailed} workflow rule(s) failed`); process.exitCode = 1; }
console.log('PASS: hosted-Windows guards and independent install continuation (structural only)');
