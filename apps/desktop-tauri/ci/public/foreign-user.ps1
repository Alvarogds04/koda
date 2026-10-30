# CI-only account launcher. All modes require PowerShell 7 on GitHub-hosted
# Windows. Passwords are random, DPAPI-encrypted, and never exported or logged.
# setup | run <outdir> -- <exe> [args...] | cleanup
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $IsWindows) {
    throw 'Foreign-user probes require GitHub-hosted Windows and pwsh.'
}
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV -or
    $env:GITHUB_RUN_ID -notmatch '^[0-9]{1,11}$') {
    throw 'Missing or invalid hosted-runner identity.'
}
$mode = $args[0]
if ($mode -notin @('setup', 'run', 'cleanup')) { throw 'Invalid launcher mode.' }
$name = 'abito-ci-' + $env:GITHUB_RUN_ID
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$credPath = Join-Path $temp ($name + '.cred')
$intentPath = Join-Path $temp ($name + '.intent.json')
if ($env:ABITO_FU_USER -and $env:ABITO_FU_USER -cne $name) {
    throw 'Account environment does not match this run.'
}
if ($env:ABITO_FU_CRED -and
    [IO.Path]::GetFullPath($env:ABITO_FU_CRED) -ine $credPath) {
    throw 'Credential environment does not match this run.'
}

function Read-Intent {
    if (-not (Test-Path -LiteralPath $intentPath)) { return $null }
    $item = Get-Item -LiteralPath $intentPath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing a redirected ownership record.'
    }
    $record = Get-Content -LiteralPath $intentPath -Raw | ConvertFrom-Json
    if ($record.name -cne $name -or
        $record.run -cne $env:GITHUB_RUN_ID -or
        $record.nonce -notmatch '^[0-9a-f]{32}$') {
        throw 'Ownership record does not match this run.'
    }
    return $record
}

function Remove-OwnedAccount {
    $record = Read-Intent
    if ($null -eq $record) {
        Write-Output 'No account creation intent for this run; nothing removed.'
        return
    }
    $account = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($account) {
        # Description is written AT account creation. An intent record alone
        # never grants permission to remove a pre-existing/unrelated account.
        # Account name and intent bind the run. The 41-character description
        # binds ownership without exceeding New-LocalUser's 48-character limit.
        $description = 'Abito CI ' + $record.nonce
        if ($account.Description -cne $description) {
            throw 'Refusing cleanup of an account not created by this script.'
        }
        $identity = $env:COMPUTERNAME + '\' + $name
        Get-Process -IncludeUserName -ErrorAction SilentlyContinue |
            Where-Object { $_.UserName -ieq $identity } |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Remove-LocalUser -SID $account.SID
        if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) {
            throw 'Probe account cleanup did not complete.'
        }
    }
    # Paths are derived above, never selected by ABITO_FU_CRED. No profile
    # recursion or wildcard deletion: the runner itself is disposable.
    if (Test-Path -LiteralPath $credPath) {
        Remove-Item -LiteralPath $credPath -Force
    }
    Remove-Item -LiteralPath $intentPath -Force
    Write-Output 'Owned probe account and credential record cleaned.'
}

if ($mode -eq 'cleanup') {
    Remove-OwnedAccount
    exit 0
}

if ($mode -eq 'setup') {
    if ((Get-LocalUser -Name $name -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath $intentPath) -or
        (Test-Path -LiteralPath $credPath)) {
        throw 'Refusing to overwrite an existing account or ownership record.'
    }
    $record = @{ name = $name; run = $env:GITHUB_RUN_ID;
        nonce = [Guid]::NewGuid().ToString('N') }
    # Persist intent before account creation, using exclusive creation. Cleanup
    # can derive this path even if setup dies before GITHUB_ENV is written.
    $file = [IO.File]::Open($intentPath, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json))
        $file.Write($bytes, 0, $bytes.Length)
        $file.Flush($true)
    } finally { $file.Dispose() }
    $setupStage = 'random-password'
    try {
        $random = [byte[]]::new(24)
        # Use the byte[] overload: PowerShell cannot bind the static Span<byte>
        # Fill API reliably. No password bytes are printed on any error path.
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($random) } finally { $rng.Dispose() }
        $password = 'Aa1!' + [Convert]::ToBase64String($random)
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        $password = $null
        $description = 'Abito CI ' + $record.nonce
        $setupStage = 'create-account'
        $account = New-LocalUser -Name $name -Password $secure `
            -Description $description -PasswordNeverExpires -AccountNeverExpires
        $setupStage = 'users-membership'
        $users = Get-LocalGroup -SID 'S-1-5-32-545'
        $member = Get-LocalGroupMember -Group $users |
            Where-Object { $_.SID -eq $account.SID }
        if (-not $member) { Add-LocalGroupMember -Group $users -Member $account }
        $setupStage = 'encrypt-credential'
        ConvertFrom-SecureString $secure |
            Set-Content -LiteralPath $credPath -Encoding ascii
        $setupStage = 'publish-environment'
        Add-Content -LiteralPath $env:GITHUB_ENV -Value "ABITO_FU_USER=$name"
        Add-Content -LiteralPath $env:GITHUB_ENV -Value "ABITO_FU_CRED=$credPath"
    } catch {
        # Keep only bounded diagnostic metadata; never emit the exception
        # message, invocation, arguments, password, or credential contents.
        $errorType = $_.Exception.GetType().Name
        $errorCode = $_.Exception.HResult
        Remove-OwnedAccount
        throw "Probe setup failed at $setupStage ($errorType, $errorCode); owned resources were cleaned."
    }
    Write-Output "Probe account ready: $name"
    exit 0
}

if ($args.Count -lt 4 -or $args[2] -ne '--') {
    throw 'Usage: run <outdir> -- <exe> [args...]'
}
$record = Read-Intent
$account = Get-LocalUser -Name $name -ErrorAction Stop
if ($null -eq $record -or
    $account.Description -cne ('Abito CI ' + $record.nonce)) {
    throw 'Run requires the account owned by this script.'
}
$blob = Get-Item -LiteralPath $credPath -Force
if ($blob.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing a redirected credential record.'
}
$secure = ConvertTo-SecureString (Get-Content -LiteralPath $credPath -Raw).Trim()
$credential = [Management.Automation.PSCredential]::new(
    ($env:COMPUTERNAME + '\' + $name), $secure)
$outdir = $args[1]
$exe = $args[3]
$quoted = @()
if ($args.Count -gt 4) {
    foreach ($arg in $args[4..($args.Count - 1)]) {
        $quoted += '"' + ($arg -replace '"', '\"') + '"'
    }
}
$stdout = Join-Path $outdir 'foreign-stdout.txt'
$stderr = Join-Path $outdir 'foreign-stderr.txt'
$timeout = 180
if ($env:ABITO_FU_CHILD_TIMEOUT) { $timeout = [int]$env:ABITO_FU_CHILD_TIMEOUT }
if ($timeout -lt 1 -or $timeout -gt 180) { throw 'Invalid child timeout.' }
$child = Start-Process -FilePath $exe -ArgumentList ($quoted -join ' ') `
    -Credential $credential -WorkingDirectory $outdir -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
if (-not $child.WaitForExit($timeout * 1000)) {
    Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    throw 'Foreign-user child timed out and was stopped.'
}
$child.Refresh()
if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout }
if (Test-Path -LiteralPath $stderr) {
    Get-Content -LiteralPath $stderr | ForEach-Object {
        [Console]::Error.WriteLine($_)
    }
}
if ($null -eq $child.ExitCode) { throw 'Child exit status unavailable.' }
Write-Output ('foreign-user: child exit ' + $child.ExitCode)
exit $child.ExitCode
