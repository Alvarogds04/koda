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
assert.match(smoke, /if \(\$Mode -eq 'explicit-root'\) \{ \$env:ABITO_PROJECT_ROOT = \$workspace \}\s+else \{ Remove-Item Env:ABITO_PROJECT_ROOT/);
assert.match(smoke, /Start-Island 'explicit-root'/);
assert.match(smoke, /return \$candidate\.pid -eq \$script:process\.Id/);
assert.match(smoke, /if \(\$metadata\.pid -ne \$script:process\.Id\) \{ throw 'Receiver metadata does not belong/);
assert.doesNotMatch(smoke, /Wait-For \{ \(Test-Path[^\n]*endpoint\.json/);
assert.match(smoke, /\} catch \{\s+Show-SmokeDiagnostics\s+throw\s+\} finally/);
assert.match(smoke, /Get-Content -LiteralPath \$log.FullName -Tail 80/);
assert.doesNotMatch(smoke, /Get-Content[^\n]*session\.json/);
assert.match(smoke, /Get-Command node -All -ErrorAction SilentlyContinue/);
assert.match(smoke, /'\/d', '\/c', 'set PATH&set ProgramFiles'/);
assert.match(smoke, /Test-Path -LiteralPath \$candidate -PathType Leaf/);
assert.match(smoke, /\$runtimeFailures\.Add/);
assert.ok(smoke.indexOf("PASS preserving uninstall") < smoke.indexOf('if ($runtimeFailures.Count -gt 0)'), 'uninstall must precede aggregated runtime failure');
console.log('PASS: hosted-Windows guards and independent install continuation (structural only)');
