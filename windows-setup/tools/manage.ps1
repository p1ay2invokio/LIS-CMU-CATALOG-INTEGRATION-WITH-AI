# LIS CMU Catalog - manage installed services
# Usage: manage.ps1 start|stop|restart|status
param([string]$Action = 'status')

$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BunExe = Join-Path $InstallDir 'bin\bun.exe'
$Task = 'LIS-Catalog-Server'
$Services = @('mysql', 'Apache2.4', 'cloudflared')

function Stop-Server {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-Process -Name bun -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $BunExe } | Stop-Process -Force -ErrorAction SilentlyContinue
}

switch ($Action) {
  'start' {
    foreach ($s in $Services) { if (Get-Service $s -ErrorAction SilentlyContinue) { Start-Service $s -ErrorAction SilentlyContinue } }
    Start-ScheduledTask -TaskName $Task
  }
  'stop' {
    Stop-Server
    foreach ($s in @('cloudflared', 'Apache2.4', 'mysql')) { if (Get-Service $s -ErrorAction SilentlyContinue) { Stop-Service $s -Force -ErrorAction SilentlyContinue } }
  }
  'restart' {
    Stop-Server
    foreach ($s in $Services) { if (Get-Service $s -ErrorAction SilentlyContinue) { Restart-Service $s -Force -ErrorAction SilentlyContinue } }
    Start-ScheduledTask -TaskName $Task
  }
}

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "=== Services ===" -ForegroundColor Cyan
foreach ($s in $Services) {
  $svc = Get-Service $s -ErrorAction SilentlyContinue
  if ($svc) { Write-Host ("  {0,-12} {1}" -f $s, $svc.Status) } else { Write-Host ("  {0,-12} (not installed)" -f $s) }
}
$t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Write-Host ("  {0,-12} {1}" -f 'server', $(if ($t) { $t.State } else { '(not installed)' }))

$port = 3001
$envFile = Join-Path $InstallDir 'app\.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3
  Write-Host "  http://localhost:$port -> $($r.StatusCode) OK" -ForegroundColor Green
} catch {
  Write-Host "  http://localhost:$port -> not responding" -ForegroundColor Yellow
}

$log = Join-Path $InstallDir 'logs\server.log'
if (Test-Path $log) {
  Write-Host ""
  Write-Host "=== Last lines of logs\server.log ===" -ForegroundColor Cyan
  Get-Content $log -Tail 15
}
