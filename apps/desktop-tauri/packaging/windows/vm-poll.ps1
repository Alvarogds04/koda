# Command channel for the Abito Windows-port test VM. Registered by vm-setup.ps1
# as the AbitoPortPoll scheduled task (every minute, as SYSTEM).
#
# Why a CD poll instead of sshd: the guest never has to accept an inbound
# connection. The host rewrites a small ISO (ABITO_SETUP) and hot-swaps it as
# the second CD-ROM; this script notices a new number and runs it. Results come
# back over HTTP POST to the host's collect listener (192.168.122.1, the libvirt
# NAT gateway), and are echoed to COM1, which the host logs.
$ErrorActionPreference = 'Continue'
$state = 'C:\abito'
$log = Join-Path $state 'poll.log'
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 's'), $m) }

$last = 0
$lastfile = Join-Path $state 'last.txt'
if (Test-Path $lastfile) { [int]::TryParse((Get-Content $lastfile -Raw).Trim(), [ref]$last) | Out-Null }

$cd = Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=5' |
  Where-Object { $_.VolumeName -eq 'ABITO_SETUP' } | Select-Object -First 1
if (-not $cd) { exit 0 }
$root = $cd.DeviceID + '\'
$cmds = Get-ChildItem -Path $root -Filter 'command-*.bat' -ErrorAction SilentlyContinue |
  ForEach-Object {
    if ($_.Name -match '^command-(\d+)\.bat$') { [pscustomobject]@{ N = [int]$Matches[1]; Path = $_.FullName } }
  } | Sort-Object N

foreach ($c in $cmds) {
  if ($c.N -le $last) { continue }
  Log ("ejecutando command-{0} desde {1}" -f $c.N, $root)
  $outFile = Join-Path $state ("out-{0}.txt" -f $c.N)
  $bat = Join-Path $env:TEMP ("abito-cmd-{0}.bat" -f $c.N)
  # The CD copy is read-only and its path has spaces; run a local copy.
  Copy-Item $c.Path $bat -Force
  $body = & cmd.exe /c "`"$bat`"" 2>&1 | Out-String
  Set-Content -Path $outFile -Value $body -Encoding utf8
  $tail = if ($body.Length -gt 4000) { $body.Substring(0, 4000) + '...' } else { $body }
  Log ("salida command-{0}:{1}{2}" -f $c.N, "`r`n", $tail)
  try {
    $com = New-Object System.IO.StreamWriter('COM1:', 115200)
    $com.AutoFlush = $true
    $com.WriteLine("ABITO-CMD $($c.N) START")
    $com.WriteLine($tail)
    $com.WriteLine("ABITO-CMD $($c.N) END")
    $com.Close()
  } catch { Log 'COM1 ocupado o inexistente; solo quedó el log' }
  try {
    $hostip = (Get-Content (Join-Path $state 'host.txt') -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not $hostip) { $hostip = '192.168.122.1' }
    $json = @{ name = "out-$($c.N).txt"; body = $body } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "http://${hostip}:8765/upload" -Body $json -ContentType 'application/json' -TimeoutSec 10 | Out-Null
  } catch { Log "collect no respondió: $($_.Exception.Message)" }
  Set-Content -Path $lastfile -Value $c.N -Encoding ascii
  $last = $c.N
}
