# ==========================================================================
#  LIS CMU Catalog - One-click Windows setup
#  Run via SETUP.bat (it elevates to Administrator automatically).
#
#  What it does (safe to run again - it skips what is already done,
#  and re-running also works as an "update app" command):
#    1. Visual C++ 2012 runtime (needed by XAMPP 1.8.3)
#    2. XAMPP 1.8.3 (portable zip -> C:\xampp)
#    3. MySQL (+ Apache) as Windows services, auto-start on boot
#    4. Create database + import .sql from .\database\
#    5. Bun runtime (runs the TypeScript server, no Node.js needed)
#    6. Copy server app, write .env, install packages, prisma generate
#    7. Run server in background on boot (Task Scheduler, SYSTEM, auto-restart)
#    8. Cloudflare tunnel as a Windows service (.json credentials file or Zero Trust token)
# ==========================================================================

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SetupRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# ------------------------------------------------------------------ helpers
function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Fail($msg) {
  Write-Host ""
  Write-Host "    [ERROR] $msg" -ForegroundColor Red
  Write-Host "    Setup stopped. See log: $script:LogFile" -ForegroundColor Red
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-Config($path) {
  $cfg = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#') -or $t.StartsWith(';')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $t.Substring(0, $i).Trim()
    $v = $t.Substring($i + 1).Trim().Trim('"')
    $cfg[$k] = $v
  }
  return $cfg
}

function Cfg($key, $default) {
  if ($script:Config.ContainsKey($key) -and $script:Config[$key] -ne '') { return $script:Config[$key] }
  return $default
}

# Download $url to downloads\$name (re-uses the file if it is already there = offline mode)
function Get-Download($name, $url, $minBytes) {
  $dir = Join-Path $SetupRoot 'downloads'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $out = Join-Path $dir $name
  if ((Test-Path -LiteralPath $out) -and ((Get-Item -LiteralPath $out).Length -ge $minBytes)) {
    Write-Ok "Using cached $name"
    return $out
  }
  Write-Host "    Downloading $name ..."
  Write-Host "    $url"
  $tmp = "$out.part"
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -L --fail --retry 3 --retry-delay 3 -o $tmp $url
  }
  if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -lt $minBytes) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -UserAgent 'curl/8.0'
    } catch { Write-Warn2 $_.Exception.Message }
  }
  if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -lt $minBytes) {
    Fail "Download failed: $name`n    You can download it manually from:`n    $url`n    and put it in: $dir\$name"
  }
  Move-Item -LiteralPath $tmp -Destination $out -Force
  Write-Ok "Downloaded $name"
  return $out
}

function Expand-Zip($zip, $dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    & $tar -xf $zip -C $dest
    if ($LASTEXITCODE -eq 0) { return }
    Write-Warn2 "tar.exe failed, falling back to Expand-Archive (slower)"
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
}

function Test-PortListening($port) {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
  } catch {
    return [bool](netstat -ano | Select-String -Pattern "[:.]$port\s+.*LISTENING")
  }
}

function Wait-Port($port, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-PortListening $port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Write-Utf8NoBom($path, $text) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

# Run mysql.exe with SQL, returns output lines. $pw = '' means no password.
# Password is passed via MYSQL_PWD env var (not on the command line).
function Invoke-MySql($sql, $pw, [switch]$Quiet) {
  $env:MYSQL_PWD = $pw
  $mysqlArgs = @('-u', 'root', '-h', '127.0.0.1', '-P', '3306', '-N', '-B', '-e', $sql)
  $out = & $script:MySqlExe @mysqlArgs 2>&1
  $script:MySqlExit = $LASTEXITCODE
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  if (-not $Quiet -and $LASTEXITCODE -ne 0) { Write-Warn2 ($out | Out-String) }
  return $out
}

# ------------------------------------------------------------------ start
if (-not (Test-Admin)) {
  Write-Host "Please run SETUP.bat (it asks for Administrator rights)." -ForegroundColor Red
  exit 1
}

$cfgPath = Join-Path $SetupRoot 'config.ini'
if (-not (Test-Path $cfgPath)) {
  Write-Host "config.ini not found in $SetupRoot" -ForegroundColor Red
  Write-Host "Copy config.example.ini to config.ini and fill in CLOUDFLARE_TOKEN and GEMINI_API_KEY." -ForegroundColor Red
  exit 1
}
$script:Config = Read-Config $cfgPath

$InstallDir   = Cfg 'INSTALL_DIR' 'C:\LISCatalog'
$XamppDir     = Cfg 'XAMPP_DIR' 'C:\xampp'
$DbName       = Cfg 'DB_NAME' 'library'
$DbUser       = Cfg 'DB_USER' 'root'
$DbPassword   = Cfg 'DB_PASSWORD' ''
$ServerPort   = [int](Cfg 'SERVER_PORT' '3001')
$CfHostname   = Cfg 'CLOUDFLARE_HOSTNAME' 'api.liscmu.online'
$CfToken      = Cfg 'CLOUDFLARE_TOKEN' ''
$GeminiKey    = Cfg 'GEMINI_API_KEY' ''
$InstallApache = (Cfg 'INSTALL_APACHE' 'yes') -match '^(y|yes|true|1)$'

$CfJsonSrc = Get-ChildItem -Path (Join-Path $SetupRoot 'cloudflared') -Filter '*.json' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $CfJsonSrc) {
  $CfJsonSrc = Get-ChildItem -Path $SetupRoot -Filter '*.json' -File -ErrorAction SilentlyContinue | Select-Object -First 1
}

$BinDir  = Join-Path $InstallDir 'bin'
$AppDir  = Join-Path $InstallDir 'app'
$LogDir  = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Force -Path $InstallDir, $BinDir, $AppDir, $LogDir | Out-Null

$script:LogFile = Join-Path $LogDir ("setup-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
Start-Transcript -Path $script:LogFile | Out-Null

# Files copied from the internet are "blocked" by Windows - unblock them
Get-ChildItem -LiteralPath $SetupRoot -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   LIS CMU Catalog - Windows Setup" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Install dir : $InstallDir"
Write-Host "   XAMPP dir   : $XamppDir"
Write-Host "   Database    : $DbName"
Write-Host "   Server port : $ServerPort"

if (-not [Environment]::Is64BitOperatingSystem) { Fail "64-bit Windows is required (Bun / cloudflared)." }
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 17763) { Write-Warn2 "Windows build $build detected. Bun needs Windows 10 (1809) or newer - setup may fail." }
if ($GeminiKey -eq '') { Write-Warn2 "GEMINI_API_KEY is empty - AI features will not work until you set it." }
if (-not $CfJsonSrc -and $CfToken -eq '') { Write-Warn2 "No cloudflared/*.json and CLOUDFLARE_TOKEN is empty - tunnel step will be skipped." }

# ------------------------------------------------------------------ 1. VC++ 2012
Write-Step "1/8 Visual C++ 2012 runtime (x86) for XAMPP 1.8.3"
$vcKey = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\11.0\VC\Runtimes\x86'
$vcInstalled = $false
try { $vcInstalled = ((Get-ItemProperty -Path $vcKey -ErrorAction Stop).Installed -eq 1) } catch {}
if ($vcInstalled) {
  Write-Ok "Already installed"
} else {
  $vc = Get-Download 'vcredist_2012_x86.exe' 'https://download.microsoft.com/download/1/6/B/16B06F60-3B20-4FF2-B699-5E9B7962F9AE/VSU_4/vcredist_x86.exe' 1000000
  $p = Start-Process -FilePath $vc -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  if ($p.ExitCode -in 0, 1638, 3010) { Write-Ok "Installed (exit $($p.ExitCode))" } else { Write-Warn2 "vcredist exit code $($p.ExitCode) - continuing" }
}

# ------------------------------------------------------------------ 2. XAMPP
Write-Step "2/8 XAMPP 1.8.3"
$script:MySqlExe = Join-Path $XamppDir 'mysql\bin\mysql.exe'
$MySqldExe = Join-Path $XamppDir 'mysql\bin\mysqld.exe'
if (Test-Path $MySqldExe) {
  Write-Ok "Found existing XAMPP at $XamppDir"
} else {
  $zip = Get-Download 'xampp-portable-win32-1.8.3-5-VC11.zip' 'https://downloads.sourceforge.net/project/xampp/XAMPP%20Windows/1.8.3/xampp-portable-win32-1.8.3-5-VC11.zip' 100000000
  $parent = Split-Path -Parent $XamppDir
  Write-Host "    Extracting (this takes a few minutes) ..."
  Expand-Zip $zip $parent
  # zip contains a top-level "xampp" folder
  $extracted = Join-Path $parent 'xampp'
  if (($extracted -ne $XamppDir) -and (Test-Path $extracted) -and -not (Test-Path $XamppDir)) {
    Move-Item -LiteralPath $extracted -Destination $XamppDir
  }
  if (-not (Test-Path $MySqldExe)) { Fail "XAMPP extraction failed ($MySqldExe not found)" }
  if ($XamppDir -ne 'C:\xampp') {
    # Fix paths inside XAMPP config when not installed in the default location
    $setupBat = Join-Path $XamppDir 'setup_xampp.bat'
    if (Test-Path $setupBat) {
      Write-Host "    Running setup_xampp.bat to relocate paths ..."
      cmd /c "cd /d `"$XamppDir`" && echo.| `"$setupBat`"" | Out-Null
    }
  }
  Write-Ok "XAMPP extracted to $XamppDir"
}

# my.ini: allow bigger packets (big SQL dumps / book covers)
$myIni = Join-Path $XamppDir 'mysql\bin\my.ini'
if (Test-Path $myIni) {
  $ini = Get-Content -LiteralPath $myIni -Raw
  $newIni = [regex]::Replace($ini, '(?m)^(\s*max_allowed_packet\s*=\s*)\d+[KMG]?', '${1}64M')
  if ($newIni -ne $ini) { Set-Content -LiteralPath $myIni -Value $newIni -Encoding ASCII; Write-Ok "my.ini: max_allowed_packet = 64M" }
}

# ------------------------------------------------------------------ 3. Services
Write-Step "3/8 MySQL / Apache as Windows services (auto start)"
$mysqlSvc = Get-Service -Name 'mysql' -ErrorAction SilentlyContinue
if (-not $mysqlSvc) {
  if (Test-PortListening 3306) { Fail "Port 3306 is already used by another MySQL/program. Stop/uninstall it first." }
  & $MySqldExe --install mysql "--defaults-file=$myIni"
  $mysqlSvc = Get-Service -Name 'mysql' -ErrorAction SilentlyContinue
  if (-not $mysqlSvc) { Fail "Could not install MySQL service" }
  Write-Ok "MySQL service installed"
}
Set-Service -Name 'mysql' -StartupType Automatic
if ((Get-Service mysql).Status -ne 'Running') { Start-Service mysql -ErrorAction SilentlyContinue }
if (-not (Wait-Port 3306 60)) { Fail "MySQL did not start. Check $XamppDir\mysql\data\*.err" }
Write-Ok "MySQL running on port 3306"

if ($InstallApache) {
  $httpd = Join-Path $XamppDir 'apache\bin\httpd.exe'
  $apacheSvc = Get-Service -Name 'Apache2.4' -ErrorAction SilentlyContinue
  if (-not $apacheSvc) {
    if (Test-PortListening 80) {
      Write-Warn2 "Port 80 is in use (IIS/Skype/other) - Apache service not installed. Free port 80 and run setup again."
    } else {
      & $httpd -k install -n 'Apache2.4' 2>&1 | Out-Host
      $apacheSvc = Get-Service -Name 'Apache2.4' -ErrorAction SilentlyContinue
    }
  }
  if ($apacheSvc) {
    # Optional: copy PHP site (e.g. OpenBiblio) from .\htdocs into XAMPP htdocs
    $srcHtdocs = Join-Path $SetupRoot 'htdocs'
    if ((Test-Path $srcHtdocs) -and @(Get-ChildItem $srcHtdocs -Exclude 'README*').Count -gt 0) {
      robocopy $srcHtdocs (Join-Path $XamppDir 'htdocs') /E /XF 'README*' /NFL /NDL /NJH /NJS /NP | Out-Null
      Write-Ok "Copied htdocs files"
    }
    Set-Service -Name 'Apache2.4' -StartupType Automatic
    if ((Get-Service 'Apache2.4').Status -ne 'Running') { Start-Service 'Apache2.4' -ErrorAction SilentlyContinue }
    Write-Ok "Apache service: $((Get-Service 'Apache2.4').Status)"
  }
}

# ------------------------------------------------------------------ 4. Database
Write-Step "4/8 Database '$DbName'"
# Find which root password works (fresh XAMPP = empty)
$rootPw = $null
Invoke-MySql 'SELECT 1' '' -Quiet | Out-Null
if ($script:MySqlExit -eq 0) { $rootPw = '' }
elseif ($DbPassword -ne '') {
  Invoke-MySql 'SELECT 1' $DbPassword -Quiet | Out-Null
  if ($script:MySqlExit -eq 0) { $rootPw = $DbPassword }
}
if ($null -eq $rootPw) { Fail "Cannot log in to MySQL as root. Check DB_PASSWORD in config.ini." }

if ($rootPw -eq '' -and $DbPassword -ne '' -and $DbUser -eq 'root') {
  Invoke-MySql "UPDATE mysql.user SET Password=PASSWORD('$($DbPassword.Replace("'", "''"))') WHERE User='root'; FLUSH PRIVILEGES;" '' | Out-Null
  if ($script:MySqlExit -eq 0) { $rootPw = $DbPassword; Write-Ok "Set MySQL root password" }
}

Invoke-MySql "CREATE DATABASE IF NOT EXISTS ``$DbName`` DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;" $rootPw | Out-Null
$tableCount = [int]((Invoke-MySql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DbName';" $rootPw) | Select-Object -Last 1)
$sqlFiles = @(Get-ChildItem -Path (Join-Path $SetupRoot 'database') -Filter '*.sql' -File -ErrorAction SilentlyContinue | Sort-Object Name)

if ($tableCount -gt 0) {
  Write-Ok "Database already has $tableCount tables - skip import (existing data is kept)"
} elseif ($sqlFiles.Count -eq 0) {
  Write-Warn2 "No .sql file in .\database\ - database is empty. Put your export there and run setup again."
} else {
  Invoke-MySql 'SET GLOBAL max_allowed_packet=67108864;' $rootPw | Out-Null
  foreach ($f in $sqlFiles) {
    Write-Host "    Importing $($f.Name) ..."
    $env:MYSQL_PWD = $rootPw
    $cmdLine = "/s /c `"`"$script:MySqlExe`" -u root -h 127.0.0.1 -P 3306 --default-character-set=utf8 --max_allowed_packet=64M `"$DbName`" < `"$($f.FullName)`"`""
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -Wait -PassThru -NoNewWindow
    Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0) { Fail "Import failed: $($f.Name)" }
    Write-Ok "Imported $($f.Name)"
  }
}

# ------------------------------------------------------------------ 5. Bun
Write-Step "5/8 Bun runtime"
$BunExe = Join-Path $BinDir 'bun.exe'
if (Test-Path $BunExe) {
  Write-Ok "Found $BunExe ($(& $BunExe --version))"
} else {
  $bunZip = Get-Download 'bun-windows-x64-baseline.zip' 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64-baseline.zip' 10000000
  $tmpDir = Join-Path $env:TEMP 'lis-bun'
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  Expand-Zip $bunZip $tmpDir
  $found = Get-ChildItem -Path $tmpDir -Recurse -Filter 'bun.exe' | Select-Object -First 1
  if (-not $found) { Fail "bun.exe not found in zip" }
  Copy-Item -LiteralPath $found.FullName -Destination $BunExe -Force
  Write-Ok "Installed Bun $(& $BunExe --version)"
}

# ------------------------------------------------------------------ 6. App
Write-Step "6/8 Server app"
$srcApp = Join-Path $SetupRoot 'app'
if (-not (Test-Path (Join-Path $srcApp 'src\index.ts'))) { Fail "App source not found in $srcApp" }

# Stop running server before updating files
Stop-ScheduledTask -TaskName 'LIS-Catalog-Server' -ErrorAction SilentlyContinue
Get-Process -Name bun -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $BunExe } | Stop-Process -Force -ErrorAction SilentlyContinue

robocopy $srcApp $AppDir /MIR /XD node_modules generated .git cert /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copy app failed (robocopy $LASTEXITCODE)" }
Write-Ok "Copied app to $AppDir"

$dbPwForEnv = $rootPw
if ($DbUser -ne 'root') { $dbPwForEnv = $DbPassword }
$encPw = [Uri]::EscapeDataString($dbPwForEnv)
$envText = @"
DATABASE_URL="mysql://$($DbUser):$encPw@127.0.0.1:3306/$($DbName)?charset=utf8"
DATABASE_USER="$DbUser"
DATABASE_PASSWORD="$dbPwForEnv"
DATABASE_NAME="$DbName"
DATABASE_HOST="127.0.0.1"
DATABASE_PORT=3306

GEMINI_API_KEY="$GeminiKey"

PORT=$ServerPort
"@
Write-Utf8NoBom (Join-Path $AppDir '.env') $envText
Write-Ok "Wrote .env"

Push-Location $AppDir
Write-Host "    bun install ..."
& $BunExe install 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "bun install failed (internet connection?)" }
Write-Host "    prisma generate ..."
& $BunExe --bun x prisma generate 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "prisma generate failed" }
Pop-Location
Write-Ok "Packages installed"

# ------------------------------------------------------------------ 7. Background server
Write-Step "7/8 Background server (starts automatically on boot)"
$runBat = Join-Path $InstallDir 'run-server.bat'
$serverLog = Join-Path $LogDir 'server.log'
$runText = @"
@echo off
rem Runs the LIS server forever (restarts after crash). Started by Task Scheduler at boot.
cd /d "$AppDir"
:loop
for %%F in ("$serverLog") do if %%~zF GTR 10485760 move /y "$serverLog" "$serverLog.old" >nul
echo [%date% %time%] starting server >> "$serverLog"
"$BunExe" run src\index.ts >> "$serverLog" 2>&1
echo [%date% %time%] server stopped (exit %errorlevel%), restarting in 5s >> "$serverLog"
ping -n 6 127.0.0.1 >nul
goto loop
"@
Set-Content -LiteralPath $runBat -Value $runText -Encoding ASCII

$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runBat`"" -WorkingDirectory $AppDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'LIS-Catalog-Server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'LIS-Catalog-Server'
Write-Ok "Task 'LIS-Catalog-Server' registered and started"

# Allow LAN access to the server port (optional, cloudflared itself does not need it)
if (-not (Get-NetFirewallRule -DisplayName 'LIS Catalog Server' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'LIS Catalog Server' -Direction Inbound -Protocol TCP -LocalPort $ServerPort -Action Allow -Profile Private,Domain | Out-Null
}

# Helper scripts (start / stop / status)
$toolsSrc = Join-Path $SetupRoot 'tools'
if (Test-Path $toolsSrc) { Copy-Item -Path (Join-Path $toolsSrc '*') -Destination $InstallDir -Force }

# ------------------------------------------------------------------ 8. Cloudflare tunnel
Write-Step "8/8 Cloudflare Tunnel"
if (-not $CfJsonSrc -and $CfToken -eq '') {
  Write-Warn2 "Skipped (put <Tunnel-UUID>.json in .\cloudflared\ or set CLOUDFLARE_TOKEN in config.ini)"
} else {
  $CfExe = Join-Path $BinDir 'cloudflared.exe'
  if (-not (Test-Path $CfExe)) {
    $dl = Get-Download 'cloudflared-windows-amd64.exe' 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' 10000000
    Copy-Item -LiteralPath $dl -Destination $CfExe -Force
  }
  if (Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue) {
    Write-Host "    Re-installing existing cloudflared service ..."
    Stop-Service cloudflared -Force -ErrorAction SilentlyContinue
    & $CfExe service uninstall 2>&1 | Out-Host
    Start-Sleep -Seconds 2
  }

  if ($CfJsonSrc) {
    # Method 1: .json credentials file + config.yml (no Zero Trust dashboard needed)
    $CfDir = Join-Path $InstallDir 'cloudflared'
    New-Item -ItemType Directory -Force -Path $CfDir | Out-Null

    $tunnelId = $CfJsonSrc.BaseName
    try {
      $parsed = Get-Content -LiteralPath $CfJsonSrc.FullName -Raw | ConvertFrom-Json
      if ($parsed.TunnelID) { $tunnelId = $parsed.TunnelID }
    } catch {}

    $destJson = Join-Path $CfDir "$tunnelId.json"
    Copy-Item -LiteralPath $CfJsonSrc.FullName -Destination $destJson -Force

    $destCfg = Join-Path $CfDir 'config.yml'
    $customCfg = Join-Path $SetupRoot 'cloudflared\config.yml'
    if (Test-Path $customCfg) {
      $cfgText = Get-Content -LiteralPath $customCfg -Raw
      $cfgText = [regex]::Replace($cfgText, '(?m)^tunnel\s*:.*$', "tunnel: $tunnelId")
      $cfgText = [regex]::Replace($cfgText, '(?m)^credentials-file\s*:.*$', "credentials-file: $destJson")
    } else {
      $cfgText = @"
tunnel: $tunnelId
credentials-file: $destJson

ingress:
  - hostname: $CfHostname
    service: http://localhost:$ServerPort
  - service: http_status:404
"@
    }
    Write-Utf8NoBom $destCfg $cfgText
    Write-Ok "Wrote $destCfg (tunnel $tunnelId -> $CfHostname -> localhost:$ServerPort)"

    # Also copy to systemprofile\.cloudflared (default path for Windows LocalSystem service)
    $sysCfDir = Join-Path $env:SystemRoot 'System32\config\systemprofile\.cloudflared'
    New-Item -ItemType Directory -Force -Path $sysCfDir -ErrorAction SilentlyContinue | Out-Null
    Copy-Item -LiteralPath $destJson -Destination (Join-Path $sysCfDir "$tunnelId.json") -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $destCfg  -Destination (Join-Path $sysCfDir 'config.yml') -Force -ErrorAction SilentlyContinue

    & $CfExe service install 2>&1 | Out-Host
    & sc.exe config cloudflared binPath= "`"$CfExe`" --config `"$destCfg`" tunnel run" start= auto | Out-Null
  } else {
    # Method 2: Zero Trust token
    & $CfExe service install $CfToken 2>&1 | Out-Host
  }

  Start-Sleep -Seconds 3
  $cf = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($cf) {
    Set-Service -Name 'cloudflared' -StartupType Automatic
    if ($cf.Status -ne 'Running') { Start-Service cloudflared -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Write-Ok "cloudflared service: $((Get-Service cloudflared).Status)"
  } else {
    Write-Warn2 "cloudflared service was not created."
  }
}

# ------------------------------------------------------------------ check
Write-Step "Checking server ..."
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ServerPort/" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}

$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress)

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
if ($ok) {
  Write-Host "   SETUP COMPLETE - server is running" -ForegroundColor Green
} else {
  Write-Host "   SETUP FINISHED, but server did not answer yet." -ForegroundColor Yellow
  Write-Host "   Check log: $serverLog" -ForegroundColor Yellow
}
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   Local    : http://localhost:$ServerPort"
foreach ($ip in $ips) { Write-Host "   Network  : http://$($ip):$ServerPort" }
if ($CfJsonSrc) {
  Write-Host "   Tunnel   : https://$CfHostname -> http://localhost:$ServerPort"
} else {
  Write-Host "   Tunnel   : point your Cloudflare public hostname to http://localhost:$ServerPort"
}
Write-Host "   Logs     : $LogDir"
Write-Host "   Tools    : $InstallDir (START / STOP / STATUS .bat)"
Write-Host ""
Write-Host "   Everything starts automatically when Windows boots."
Stop-Transcript | Out-Null
