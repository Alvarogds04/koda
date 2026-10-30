# Full installed-runtime smoke. Only the disposable GitHub-hosted Windows runner.
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installed smoke requires a disposable GitHub-hosted Windows runner'
}
$root = Join-Path $env:RUNNER_TEMP 'abito-installed-smoke'
if (Test-Path -LiteralPath $root) { throw 'Smoke root already exists; refusing to reuse state' }
New-Item -ItemType Directory -Path $root | Out-Null
$install = Join-Path $root 'installed'
$workspace = Join-Path $root 'workspace'
$nodeDir = Join-Path $root 'node'
$roaming = Join-Path $root 'roaming'
$empty = Join-Path $root 'empty'
foreach ($dir in @($workspace, $nodeDir, $roaming, $empty)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$node = Join-Path $nodeDir 'node.exe'
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination $node
# Pi is a real package, isolated from the runner's global npm prefix. No model call.
& npm.cmd install --global --prefix (Join-Path $roaming 'npm') '@earendil-works/pi-coding-agent'
if ($LASTEXITCODE -ne 0) { throw 'Isolated Pi installation failed' }
$localData = [Environment]::GetFolderPath('LocalApplicationData')
$recap = Join-Path $localData 'com.abitog.AbitoTauri/recap.json'
if (Test-Path -LiteralPath $recap) { throw 'Runner already has island recap data; refusing smoke against existing state' }
if (Test-Path -LiteralPath (Join-Path $localData 'Abito')) { throw 'Runner already has island runtime data; refusing reuse' }
$originalEnv = @{}
foreach ($key in @('PATH', 'HOME', 'USERPROFILE', 'ABITO_ISLAND_EXE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ABITO_PROJECT_ROOT', 'ABITO_ISLAND_DIR', 'ABITO_DESKTOP_SOCKET')) {
    $originalEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$process = $null
function Show-SmokeDiagnostics {
    Write-Host 'Installed smoke diagnostics (no session/token/config contents)'
    if ($null -ne $script:process) {
        Write-Host "Island pid=$($script:process.Id), exited=$($script:process.HasExited)"
    }
    $logs = @(Get-ChildItem -LiteralPath $root -Filter '*.log' -File)
    foreach ($log in $logs) {
        Write-Host "--- $($log.Name) ---"
        Get-Content -LiteralPath $log.FullName -Tail 80 | ForEach-Object { Write-Host $_ }
    }
    Write-Host 'The app-owned daemon inherits island stderr; generic startup exceptions have a redacted diagnostic suffix.'
    foreach ($dir in @((Join-Path $env:LOCALAPPDATA 'Abito'), (Join-Path $env:LOCALAPPDATA 'Abito/runtime'), (Join-Path $env:LOCALAPPDATA 'Abito/notices'))) {
        if (Test-Path -LiteralPath $dir) {
            Write-Host "Directory: $dir"
            Get-ChildItem -LiteralPath $dir -Force | Select-Object Name,Length,Mode | Format-Table | Out-String | Write-Host
            try { Write-Host "ACL: $((Get-Acl -LiteralPath $dir).Sddl)" } catch { Write-Host 'ACL diagnostic unavailable' }
        } else { Write-Host "Directory absent: $dir" }
    }
    Write-Host 'No separate daemon.log/failure-record writer is used by the app-owned daemon; session.json is deliberately not printed.'
}
function Wait-For([scriptblock]$Condition, [string]$Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        if (& $Condition) { return }
        if ($null -ne $script:process -and $script:process.HasExited) { throw "Island exited while waiting for $Description" }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Description"
}
# HU-060: the island resolves the canonical `%ProgramFiles%\nodejs\node.exe` from the ProgramFiles it inherits. The smoke sets
# ProgramFiles to an empty directory, but the child process still reports the runner's real `C:\Program Files` (see the
# no-node.environment.log of CI run 40742299960: the cmd.exe child printed ProgramFiles=C:\Program Files), and actions/setup-node
# installs Node right there, so the island legitimately found a Node, passed the Node gate and failed on Pi (pi_missing) instead of
# Node. The product is right; the smoke must make Node REALLY absent. For the no-node case the runner's canonical Node folder is moved
# aside and always put back (Stop-Island runs in every case's finally and again at the end).
$script:hiddenNode = $null
function Hide-CanonicalNode {
    $real = $originalEnv['ProgramFiles']
    if ([string]::IsNullOrWhiteSpace($real)) { return }
    $dir = Join-Path $real 'nodejs'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
    $aside = "$dir.abito-smoke-hidden"
    if (Test-Path -LiteralPath $aside) { throw "Refusing to reuse $aside" }
    Move-Item -LiteralPath $dir -Destination $aside
    $script:hiddenNode = @{ Dir = $dir; Aside = $aside }
    Write-Host "no-node: moved the runner's canonical Node folder aside ($dir)"
}
function Restore-CanonicalNode {
    if ($null -eq $script:hiddenNode) { return }
    $h = $script:hiddenNode; $script:hiddenNode = $null
    Move-Item -LiteralPath $h.Aside -Destination $h.Dir
    # Proven, not assumed: the next case (and the uninstall) must find the runner exactly as it was.
    if (-not (Test-Path -LiteralPath (Join-Path $h.Dir 'node.exe') -PathType Leaf) -or (Test-Path -LiteralPath $h.Aside)) {
        throw "no-node: the runner's canonical Node was NOT restored ($($h.Dir))"
    }
    Write-Host "no-node: restored the runner's canonical Node folder (node.exe is back, the aside folder is gone)"
}
function Stop-Island {
    Restore-CanonicalNode
    if ($null -ne $script:process) {
        if (-not $script:process.HasExited) { $script:process.Kill($true) }
        if (-not $script:process.WaitForExit(10000)) { throw 'Owned island did not exit' }
        $script:process.Dispose()
        $script:process = $null
    }
}
function Show-NodeDiscovery {
    Write-Host "no-node parent PATH=$env:PATH"
    Write-Host "no-node parent ProgramFiles=$env:ProgramFiles"
    Get-Command node -All -ErrorAction SilentlyContinue | Select-Object Name,CommandType,Source | Format-Table | Out-String | Write-Host
    $systemNode = $false
    foreach ($directory in @($env:PATH -split ';')) {
        if (-not [IO.Path]::IsPathFullyQualified($directory)) { continue }
        $candidate = Join-Path $directory 'node.exe'
        $exists = Test-Path -LiteralPath $candidate -PathType Leaf
        Write-Host "discover_node candidate: $candidate exists=$exists"
        if ($exists -and ($directory -eq "$env:SystemRoot\System32" -or $directory -eq $env:SystemRoot)) { $systemNode = $true }
    }
    $candidate = Join-Path $env:ProgramFiles 'nodejs/node.exe'
    Write-Host "discover_node candidate: $candidate exists=$(Test-Path -LiteralPath $candidate -PathType Leaf)"
    $real = Join-Path $originalEnv['ProgramFiles'] 'nodejs/node.exe'
    Write-Host "discover_node candidate (real ProgramFiles, as the child sees it): $real exists=$(Test-Path -LiteralPath $real -PathType Leaf)"
    if ($systemNode) {
        $env:PATH = $empty
        Write-Host 'Runner has Node in a Windows system directory; no-node PATH now contains only the empty smoke directory.'
    }
    # Never dump all environment variables: only discovery-relevant path names.
    $diagnostic = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/cmd.exe') -WorkingDirectory $workspace `
        -ArgumentList @('/d', '/c', 'set PATH&set ProgramFiles') -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $root 'no-node.environment.log') -RedirectStandardError (Join-Path $root 'no-node.environment.stderr.log')
    if ($diagnostic.ExitCode -ne 0) { throw 'Child discovery environment diagnostic failed' }
    Get-Content -LiteralPath (Join-Path $root 'no-node.environment.log') | ForEach-Object { Write-Host $_ }
}
function Start-Island([string]$Mode) {
    # The ready scenario must prove the real default profile ACL works. Never
    # rewrite it to make the test pass. Missing-runtime scenarios use fresh roots.
    $ready = $Mode -eq 'ready' -or $Mode -eq 'explicit-root'
    $data = if ($ready) { $localData } else { Join-Path $root $Mode }
    if (-not $ready) {
        New-Item -ItemType Directory -Path $data | Out-Null
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $data -AclObject $acl
    }
    $env:LOCALAPPDATA = $data
    $env:APPDATA = if ($ready) { $roaming } else { $empty }
    $env:ProgramFiles = $empty
    $systemPath = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:PATH = if ($Mode -eq 'no-node') { $systemPath } else { "$nodeDir;$systemPath" }
    if ($Mode -eq 'explicit-root') { $env:ABITO_PROJECT_ROOT = $workspace }
    else { Remove-Item Env:ABITO_PROJECT_ROOT -ErrorAction SilentlyContinue }
    Remove-Item Env:ABITO_ISLAND_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:ABITO_DESKTOP_SOCKET -ErrorAction SilentlyContinue
    if ($Mode -eq 'no-node') { Hide-CanonicalNode; Show-NodeDiscovery }
    $script:process = Start-Process -FilePath (Join-Path $install 'abito-island.exe') -WorkingDirectory $workspace -PassThru `
        -RedirectStandardOutput (Join-Path $root "$Mode.stdout.log") -RedirectStandardError (Join-Path $root "$Mode.stderr.log")
    # A forced stop can leave the previous process's metadata. Wait for this
    # launch to publish its own record; existence alone is not readiness.
    Wait-For {
        try {
            $candidate = Get-Content -Raw -LiteralPath (Join-Path $data 'Abito/notices/endpoint.json') | ConvertFrom-Json
            return $candidate.pid -eq $script:process.Id
        } catch { return $false }
    } "$Mode receiver metadata"
    $metadata = Get-Content -Raw -LiteralPath (Join-Path $data 'Abito/notices/endpoint.json') | ConvertFrom-Json
    if ($metadata.pid -ne $script:process.Id) { throw 'Receiver metadata does not belong to installed island process' }
}
try {
    $setupProcess = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList @('/S', "/D=$install") -PassThru -Wait
    if ($setupProcess.ExitCode -ne 0) { throw "Installer failed: $($setupProcess.ExitCode)" }
    # Exact file set from the same closed lists as staging, without a parallel payload list.
    $expectedJson = & $node -e 'const s=require("./packaging/windows/stage-runtime.cjs"); console.log(JSON.stringify([...s.BINARY_FILES,...s.RUNTIME_FILES,"uninstall.exe"].sort()))'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot load expected installed file set' }
    $expected = @($expectedJson | ConvertFrom-Json)
    $actual = @(Get-ChildItem -LiteralPath $install -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($install, $_.FullName).Replace('\', '/') } | Sort-Object)
    if (@(Compare-Object $expected $actual).Count -ne 0) { throw 'Installed payload differs from closed file set' }
    foreach ($file in $expected) {
        if ($file -eq 'uninstall.exe') { continue }
        $source = if ($file.EndsWith('.exe') -or $file -eq 'abito-install.json') { Join-Path $PWD "dist/$file" } else { Join-Path $PWD "dist/windows-runtime/$file" }
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath (Join-Path $install $file)).Hash) { throw "Installed hash mismatch: $file" }
    }
    Start-Island 'ready'
    Wait-For { (Get-Content -Raw -LiteralPath (Join-Path $root 'ready.stderr.log')) -match 'abito-island-daemon: running' } 'installed daemon startup'
    # Public installed daemon status performs the native authenticated session checks.
    & $node (Join-Path $install 'desktop-daemon/src/cli.cjs') status
    if ($LASTEXITCODE -ne 0) { throw 'Installed daemon status refused' }
    $payload = @{ hook_event_name = 'Stop'; cwd = $workspace; session_id = 'ci4-installed-stop'; stop_hook_active = $false } | ConvertTo-Json -Compress
    $hookOutput = $payload | & $node (Join-Path $install 'desktop-harness/bin/abito-hook.cjs') claude stop 2> (Join-Path $root 'hook.stderr.log')
    if ($LASTEXITCODE -ne 0 -or $hookOutput -or (Get-Item -LiteralPath (Join-Path $root 'hook.stderr.log')).Length -ne 0) { throw 'Installed hook contract failed' }
    # Only the island's accepted settled callback writes this turn. CLI exit alone is NOT proof.
    # Tauri's Windows Known Folder lookup may use the actual profile or the child LOCALAPPDATA.
    $recapCandidates = @($recap, (Join-Path $env:LOCALAPPDATA 'com.abitog.AbitoTauri/recap.json')) | Select-Object -Unique
    Wait-For {
        foreach ($candidate in $recapCandidates) {
            if (Test-Path -LiteralPath $candidate) {
                $history = Get-Content -Raw -LiteralPath $candidate | ConvertFrom-Json
                if (@($history.turns).Count -eq 1) { $script:acceptedRecap = $candidate; return $true }
            }
        }
        return $false
    } 'island persisted installed hook receipt'
    Write-Host 'PASS installed hook -> installed authenticated relay -> receiver -> island persisted turn'
    Stop-Island

    # HU-047: install hooks and the Pi extension from the INSTALLED runtime with Windows ACL checks.
    # The profile below mirrors a real one (protected DACL: current user, SYSTEM, Administrators).
    $hookCli = Join-Path $install 'desktop-harness/bin/abito-hook.cjs'
    $agentHome = Join-Path $root 'agent-home'
    function New-PrivateDir($path) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        & icacls.exe $path /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls failed for $path" }
    }
    function Invoke-Install([string[]]$InstallArgs) {
        $env:HOME = $agentHome; $env:USERPROFILE = $agentHome
        $env:ABITO_ISLAND_EXE = (Get-Process -Id $PID).Path
        $out = & $node $hookCli install @InstallArgs 2> (Join-Path $root 'install.stderr.log')
        $code = $LASTEXITCODE
        if ((Get-Item -LiteralPath (Join-Path $root 'install.stderr.log')).Length -ne 0) { throw 'install wrote to stderr' }
        $json = $out | ConvertFrom-Json
        if ($json.PSObject.Properties['code'] -and $json.code -eq 'not_island') {
            Write-Host "DIAG not_island: ABITO_ISLAND_EXE=$($env:ABITO_ISLAND_EXE) pid=$PID"
            $helper = Join-Path $install 'abito-private-session.exe'
            Write-Host "DIAG parent-check: $(& $helper --parent-check $PID 2>&1) exit=$LASTEXITCODE"
        }
        return [pscustomobject]@{ Code = $code; Json = $json }
    }
    New-PrivateDir $agentHome
    foreach ($d in @('.claude', '.codex', '.pi', '.pi\agent')) { New-PrivateDir (Join-Path $agentHome $d) }
    $auditDir = Join-Path $agentHome 'audit'
    $settings = Join-Path $agentHome '.claude\settings.json'
    [IO.File]::WriteAllText($settings, "{`n  `"keep`": 1`n}`n")
    & icacls.exe $settings /inheritance:r /grant:r "${env:USERNAME}:F" 'SYSTEM:F' 'Administrators:F' | Out-Null
    $pv = Invoke-Install @('claude', '--user', '--json')
    if ($pv.Code -ne 0 -or -not $pv.Json.ok -or -not $pv.Json.changed) { throw 'Windows claude preview failed' }
    $ap = Invoke-Install @('claude', '--user', '--json', '--apply-plan', $pv.Json.plan_hash, '--audit-dir', $auditDir)
    if ($ap.Code -ne 0 -or -not $ap.Json.ok -or $ap.Json.mode -ne 'applied') { throw "Windows claude apply failed: $($ap.Json | ConvertTo-Json -Compress)" }
    $written = Get-Content -Raw -LiteralPath $settings | ConvertFrom-Json
    if ($written.keep -ne 1 -or -not (Get-Content -Raw -LiteralPath $settings).Contains('abito-hook.cjs')) { throw 'Windows claude settings not patched as planned' }
    $auditFile = Join-Path $auditDir 'hook-installs.jsonl'
    if (@(Get-Content -LiteralPath $auditFile).Count -ne 2) { throw 'Windows audit record missing' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $agentHome '.claude') -Force | Where-Object { $_.Name -like '*.abito-lock' -or $_.Name -like '*abito-tmp*' }).Count -ne 0) { throw 'Windows install left lock or temp files' }
    $acl = Get-Acl -LiteralPath $settings
    if ($acl.AreAccessRulesProtected -ne $true) { throw 'Windows settings file DACL is not protected' }
    $stranger = @($acl.Access | Where-Object { $_.IdentityReference.Value -match 'Users|Everyone|Authenticated' })
    if ($stranger.Count -ne 0) { throw 'Windows settings file grants access to other principals' }
    Write-Host 'PASS Windows install: Claude hooks patched under verified ACLs, private audit record, no leftovers'
    # L6 (HU-062): the status-line command is written for the shell Claude Code uses: Git Bash gets forward-slash quoted paths,
    # PowerShell gets the call operator with backslash paths; the cmd form is no longer written.
    $pv = Invoke-Install @('statusline', '--user', '--json')
    if ($pv.Code -ne 0 -or -not $pv.Json.ok) { throw "Windows statusline preview failed: $($pv.Json | ConvertTo-Json -Compress)" }
    $ap = Invoke-Install @('statusline', '--user', '--json', '--apply-plan', $pv.Json.plan_hash, '--audit-dir', $auditDir)
    if ($ap.Code -ne 0 -or -not $ap.Json.ok) { throw "Windows statusline apply failed: $($ap.Json | ConvertTo-Json -Compress)" }
    $sl = (Get-Content -Raw -LiteralPath $settings | ConvertFrom-Json).statusLine.command
    $bash = '^"[A-Za-z]:/[^"\\]+" "[A-Za-z]:/[^"\\]+/abito-statusline\.cjs"$'
    $pwsh = '^& "[A-Za-z]:\\[^"]+" "[A-Za-z]:\\[^"]+\\abito-statusline\.cjs"$'
    if ($sl -notmatch $bash -and $sl -notmatch $pwsh) { throw "Windows statusline command is neither the Git Bash nor the PowerShell form: $sl" }
    Write-Host 'PASS Windows status-line relay installed with the command form of the shell Claude Code uses'
    # Refusals write nothing and say why. HU-047 messages: a refused parent folder reports unsafe_folder (folder + reason);
    # a refused target file itself still reports unsafe_target. Either way nothing is written.
    $codexTarget = Join-Path $root 'codex-real'; New-PrivateDir $codexTarget
    Remove-Item -LiteralPath (Join-Path $agentHome '.codex') -Recurse -Force
    New-Item -ItemType Junction -Path (Join-Path $agentHome '.codex') -Target $codexTarget | Out-Null
    $r = Invoke-Install @('codex', '--user', '--json')
    if ($r.Code -eq 0 -or $r.Json.ok -or $r.Json.code -notin @('unsafe_folder','unsafe_target')) { throw "Junction target was not refused: $($r.Json | ConvertTo-Json -Compress)" }
    if (@(Get-ChildItem -LiteralPath $codexTarget -Force).Count -ne 0) { throw 'Junction refusal wrote into the target' }
    $openDir = Join-Path $agentHome '.copilot'; New-PrivateDir $openDir; New-PrivateDir (Join-Path $openDir 'hooks')
    & icacls.exe (Join-Path $openDir 'hooks') /grant 'Users:(OI)(CI)M' | Out-Null
    $r = Invoke-Install @('copilot', '--user', '--json')
    if ($r.Code -eq 0 -or $r.Json.ok -or $r.Json.code -notin @('unsafe_folder','unsafe_target')) { throw "Users-writable folder was not refused: $($r.Json | ConvertTo-Json -Compress)" }
    if (@(Get-ChildItem -LiteralPath (Join-Path $openDir 'hooks') -Force).Count -ne 0) { throw 'Users-writable refusal wrote a file' }
    Write-Host 'PASS Windows refusals: junction and Users-writable targets write nothing, report unsafe_folder or unsafe_target'
    # Pi extension: install, verify the closed payload, then refuse after a bundled file is tampered.
    $pv = Invoke-Install @('pi', '--user', '--json')
    if ($pv.Code -ne 0 -or -not $pv.Json.ok) { throw "Windows Pi preview failed: $($pv.Json | ConvertTo-Json -Compress)" }
    $ap = Invoke-Install @('pi', '--user', '--json', '--apply-plan', $pv.Json.plan_hash, '--audit-dir', $auditDir)
    if ($ap.Code -ne 0 -or -not $ap.Json.ok) { throw "Windows Pi apply failed: $($ap.Json | ConvertTo-Json -Compress)" }
    $ext = Join-Path $agentHome '.pi\agent\extensions\abito-island'
    foreach ($f in @('index.ts', 'adapter.cjs', '.abito-manifest.json')) { if (-not (Test-Path -LiteralPath (Join-Path $ext $f))) { throw "Pi extension file missing: $f" } }
    $tampered = Join-Path $install 'desktop-pi/adapter.cjs'
    $original = [IO.File]::ReadAllBytes($tampered)
    [IO.File]::AppendAllText($tampered, "`n// tamper")
    try {
        $r = Invoke-Install @('pi', '--user', '--json')
        if ($r.Code -eq 0 -or $r.Json.code -ne 'install_unverified') { throw "Tampered bundled file was not refused: $($r.Json | ConvertTo-Json -Compress)" }
    } finally { [IO.File]::WriteAllBytes($tampered, $original) }
    $rm = Invoke-Install @('pi', '--user', '--json', '--remove')
    $rm = Invoke-Install @('pi', '--user', '--json', '--remove', '--apply-plan', $rm.Json.plan_hash, '--audit-dir', $auditDir)
    if ($rm.Code -ne 0 -or (Test-Path -LiteralPath $ext)) { throw 'Windows Pi removal failed' }
    Write-Host 'PASS Windows Pi extension: installed, tamper refused (install_unverified), removed'
    foreach ($key in @('HOME', 'USERPROFILE', 'ABITO_ISLAND_EXE')) { [Environment]::SetEnvironmentVariable($key, $originalEnv[$key], 'Process') }

    Start-Island 'explicit-root'
    Wait-For { (Get-Content -Raw -LiteralPath (Join-Path $root 'explicit-root.stderr.log')) -match 'abito-island-daemon: running' } 'explicit Windows root daemon startup'
    Write-Host 'PASS installed receiver and daemon with explicit Windows project root'
    Stop-Island
    $runtimeFailures = [System.Collections.Generic.List[string]]::new()
    foreach ($case in @(
        @{ mode = 'no-pi'; message = 'Falta Pi: instalalo con npm install -g @earendil-works/pi-coding-agent.' },
        @{ mode = 'no-node'; message = 'Falta Node.js: instalalo desde nodejs.org.' }
    )) {
        try {
            Start-Island $case.mode
            Wait-For { (Get-Content -Raw -LiteralPath (Join-Path $root "$($case.mode).stderr.log")) -like "*$($case.message)*" } $case.message
            if ((Get-Content -Raw -LiteralPath (Join-Path $root "$($case.mode).stderr.log")) -match 'abito-island-daemon: running') { throw 'Daemon unexpectedly started without runtime' }
            Write-Host "PASS installed missing-runtime diagnostic: $($case.message)"
        } catch {
            $runtimeFailures.Add("$($case.mode): $($_.Exception.Message)")
            Show-SmokeDiagnostics
        } finally { Stop-Island }
    }
    $unrelated = Join-Path $install 'desktop-daemon/src/user-note.txt'
    [IO.File]::WriteAllText($unrelated, 'must survive uninstall')
    $recapHash = (Get-FileHash -LiteralPath $script:acceptedRecap).Hash
    $uninstaller = Start-Process -FilePath (Join-Path $install 'uninstall.exe') -ArgumentList '/S' -PassThru -Wait
    if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstaller.ExitCode)" }
    Wait-For { -not (Test-Path -LiteralPath (Join-Path $install 'uninstall.exe')) } 'uninstaller completion'
    foreach ($file in $expected) { if (Test-Path -LiteralPath (Join-Path $install $file)) { throw "Uninstall left shipped file: $file" } }
    if ([IO.File]::ReadAllText($unrelated) -ne 'must survive uninstall') { throw 'Uninstall changed unrelated file' }
    if ((Get-FileHash -LiteralPath $script:acceptedRecap).Hash -ne $recapHash) { throw 'Uninstall changed island user data' }
    Write-Host 'PASS preserving uninstall: shipped files removed, unrelated fixture and recap unchanged'
    if ($runtimeFailures.Count -gt 0) { throw ($runtimeFailures -join '; ') }
    Write-Host 'PASS full install, native runtime, missing runtimes and exact preserving uninstall'
} catch {
    Show-SmokeDiagnostics
    throw
} finally {
    Stop-Island
    foreach ($key in $originalEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $originalEnv[$key], 'Process') }
    # Keep disposable runner logs/data for diagnostics. No recursive user-profile cleanup.
}
