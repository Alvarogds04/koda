# K2-02 T2 (decision B): the installer ships its own Node+Pi runtime as ONE sha256-verified
# archive. This smoke proves the shipped runtime natively, in its OWN runner-temp directory
# (ci/public/smoke-windows.ps1 owns and uninstalls its own install): the installer's certutil
# check and System32 tar extraction run on a real runner, runtime\node.exe and the bundled Pi
# answer with the pinned versions, the archive is never left behind, and the uninstaller
# removes $INSTDIR\runtime. Version pins come from the same files the builder uses.
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Runtime smoke requires a disposable GitHub-hosted Windows runner'
}
$root = Join-Path $env:RUNNER_TEMP 'abito-runtime-smoke'
if (Test-Path -LiteralPath $root) { throw 'Runtime smoke root already exists; refusing to reuse state' }
New-Item -ItemType Directory -Path $root | Out-Null
$install = Join-Path $root 'installed'
$nodePin = (Get-Content packaging/runtime/node.sha256 | Where-Object { $_ -match 'win-x64\.zip' }).Trim() -split '\s+'
if ($nodePin.Count -ne 2 -or $nodePin[1] -notmatch '^node-v[\d.]+-win-x64\.zip$') { throw 'Unexpected Node win-x64 pin in packaging/runtime/node.sha256' }
$nodeVersion = $nodePin[1] -replace '^node-v', '' -replace '-win-x64\.zip$', ''
$piVersion = (Get-Content -Raw packaging/runtime/package.json | ConvertFrom-Json).dependencies.'@earendil-works/pi-coding-agent'
if (-not $piVersion) { throw 'Cannot read the pinned Pi version from packaging/runtime/package.json' }
$savedEnv = @{}
foreach ($key in @('HOME', 'USERPROFILE', 'APPDATA', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY')) {
    $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
try {
    $setupProcess = Start-Process -FilePath (Resolve-Path -LiteralPath $Setup).Path -ArgumentList @('/S', "/D=$install") -PassThru -Wait
    if ($setupProcess.ExitCode -ne 0) { throw "Installer failed: $($setupProcess.ExitCode)" }
    # The runtime archive was verified with certutil and extracted with System32 tar.exe during
    # install; success means the archive is gone and the extracted runtime is in place.
    if (Test-Path -LiteralPath (Join-Path $install 'koda-runtime.tar.gz')) { throw 'Installer left the runtime archive in the install directory' }
    $runtimeNode = Join-Path $install 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $runtimeNode -PathType Leaf)) { throw 'runtime\node.exe missing after install' }
    # No junction or symlink anywhere under runtime (the extracted archive holds only files and folders).
    $reparse = @(Get-ChildItem -LiteralPath (Join-Path $install 'runtime') -Recurse -Force -Attributes ReparsePoint)
    if ($reparse.Count -ne 0) { throw "Bundled runtime contains reparse points: $($reparse[0].FullName)" }
    # The installed node.exe is byte-identical to the one this build pinned in abito-install.json.
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $install 'abito-install.json') | ConvertFrom-Json
    $pinnedNode = $manifest.files.'runtime/node.exe'
    if ($pinnedNode -notmatch '^[0-9a-f]{64}$') { throw 'abito-install.json does not pin runtime/node.exe' }
    if ((Get-FileHash -LiteralPath $runtimeNode -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pinnedNode) { throw 'runtime\node.exe differs from its abito-install.json hash' }
    Write-Host 'PASS bundled runtime has no reparse points and node.exe matches abito-install.json'
    $runtimeManifest = Get-Content -Raw (Join-Path $install 'runtime\koda-runtime.json') | ConvertFrom-Json
    if ($runtimeManifest.node -ne $nodeVersion -or $runtimeManifest.pi -ne $piVersion) {
        throw "Bundled runtime is Node $($runtimeManifest.node) + Pi $($runtimeManifest.pi), expected Node $nodeVersion + Pi $piVersion"
    }
    $version = & $runtimeNode --version
    if ($LASTEXITCODE -ne 0 -or $version -ne "v$nodeVersion") { throw "runtime\node.exe --version printed '$version', expected v$nodeVersion" }
    Write-Host "PASS bundled runtime node.exe is v$nodeVersion"
    # The bundled Pi answers with the pinned version, offline, with a private empty profile.
    $piCli = Join-Path $install ("runtime\" + ($runtimeManifest.piCli -replace '/', '\'))
    if (-not (Test-Path -LiteralPath $piCli -PathType Leaf)) { throw "Bundled Pi CLI missing: $piCli" }
    # $HOME is a read-only automatic variable in PowerShell: use another name.
    $privateHome = Join-Path $root 'home'
    New-Item -ItemType Directory -Path $privateHome | Out-Null
    $env:HOME = $privateHome; $env:USERPROFILE = $privateHome; $env:APPDATA = $privateHome
    $env:PI_OFFLINE = '1'; $env:PI_SKIP_VERSION_CHECK = '1'; $env:PI_TELEMETRY = '0'
    $piOut = & $runtimeNode $piCli --version
    if ($LASTEXITCODE -ne 0 -or $piOut -ne $piVersion) { throw "Bundled Pi printed '$piOut', expected $piVersion" }
    Write-Host "PASS bundled Pi answers $piVersion offline with a private empty profile"
    # Preserving uninstall: the guarded recursive removal takes $INSTDIR\runtime with it.
    $uninstaller = Start-Process -FilePath (Join-Path $install 'uninstall.exe') -ArgumentList '/S' -PassThru -Wait
    if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstaller.ExitCode)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        if (-not (Test-Path -LiteralPath (Join-Path $install 'uninstall.exe'))) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (Test-Path -LiteralPath (Join-Path $install 'uninstall.exe')) { throw 'Uninstaller did not finish' }
    if (Test-Path -LiteralPath (Join-Path $install 'runtime')) { throw 'Uninstall left the bundled runtime directory' }
    Write-Host 'PASS uninstall removed the bundled runtime directory'
} finally {
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
}
Write-Host 'PASS bundled runtime install, offline Pi and preserving uninstall (K2-02 decision B)'
