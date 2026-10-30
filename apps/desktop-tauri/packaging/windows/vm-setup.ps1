# First-logon setup for the Abito Windows-port test VM.
# Runs elevated once, launched by win11-autounattend.xml from the ABITO_SETUP CD.
# Everything it prints also goes to COM1, which the host logs, so the port
# session can watch provisioning without any inbound connection to the guest.
$ErrorActionPreference = 'Continue'
try {
  $com = New-Object System.IO.StreamWriter('COM1:', 115200)
  $com.AutoFlush = $true
} catch {
  $com = $null
}
function Log($m) {
  $t = (Get-Date -Format 'HH:mm:ss')
  Write-Host "$t $m"
  if ($com) { try { $com.WriteLine("$t $m") } catch { } }
}

Log 'ABITO-SETUP begin'

# DriveType 5 = removable: the ABITO_SETUP answer/command CD.
$cd = Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=5' |
  Where-Object { $_.VolumeName -eq 'ABITO_SETUP' } | Select-Object -First 1
$cdroot = if ($cd) { "$($cd.DeviceID)\" } else { 'C:\' }
Log "ABITO-SETUP answer media: $cdroot"

New-Item -ItemType Directory -Force -Path 'C:\abito' | Out-Null
New-Item -ItemType Directory -Force -Path 'C:\abito\inbox' | Out-Null
Copy-Item "$($cdroot)vm-poll.ps1" 'C:\abito\vm-poll.ps1' -Force -ErrorAction SilentlyContinue
if (-not (Test-Path 'C:\abito\vm-poll.ps1')) {
  Log 'ABITO-SETUP FALLO: vm-poll.ps1 no estaba en el medio de respuesta'
}

# The command channel: a poll task that looks for command-<N>.bat on the
# ABITO_SETUP CD. The CD is read-only from the guest's point of view, so each
# round is named by its own number; the last one executed lives in
# C:\abito\last.txt.
schtasks /Delete /TN AbitoPortPoll /F 2>&1 | Out-Null
schtasks /Create /TN AbitoPortPoll /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\abito\vm-poll.ps1" /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /F | Out-Null
Log 'ABITO-SETUP poll task registered (every minute)'

# A collect listener runs on the host at 192.168.122.1 (the libvirt NAT
# gateway). The guest pushes results out; nothing has to accept a connection
# here.
Set-Content -Path 'C:\abito\host.txt' -Value '192.168.122.1' -Encoding ascii
Log 'ABITO-SETUP host gateway recorded'

# OpenSSH server is best effort: it is a Feature-on-Demand payload that usually
# needs the network. If it lands, the port session gets an inbound shell too; if
# it does not, the CD + collect channels still cover everything.
try {
  Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop | Out-Null
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  Log 'ABITO-SETUP sshd: instalado y arrancando'
} catch {
  Log "ABITO-SETUP sshd no disponible: $($_.Exception.Message)"
}

Log 'ABITO-SETUP end'
if ($com) { $com.Close() }
