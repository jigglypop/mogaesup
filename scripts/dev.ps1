<#
.SYNOPSIS
Runs the local pipeline from the monorepo root: PostgreSQL, the Rust server, the web app and, with -Character, the
character server behind the server's studio gateway.

.DESCRIPTION
Each service starts hidden with its log in .data/dev/<name>.log; one already listening on its port is kept as it is.
With -Character the character server (backend/, from the root uv environment) runs on 127.0.0.1:8016 with auto-resume
off, and the Rust server gets FACTORY_URL plus the API key and JWT settings from backend/.env (read here, never
printed), so /admin imports and the studio screens (/character, /admin/studio) work end to end. The character server alone gets CHARACTER_DATABASE_URL: its
records live in mogaesup_character on the compose PostgreSQL, created and migrated here; copy the records of its
storage prefix in once with `uv run python -m src.records import --prefix <prefix>` while it is stopped. Admins may
change studio records (FACTORY_ACCESS=write); paid studio work stays blocked unless -Paid, capped at -PaidMonthly requests. backend/.env holds production keys: only use
-Character when you mean to reach them, and -Paid when you mean to spend. -Stop ends what this script started.

.EXAMPLE
scripts/dev.ps1
scripts/dev.ps1 -Character
scripts/dev.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch]$Character,
  [switch]$Paid,
  [int]$PaidMonthly = 20,
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.data\dev'
$pidFile = Join-Path $runtime 'pids.json'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

function Read-Started {
  if (-not (Test-Path -LiteralPath $pidFile)) { return @{} }
  $saved = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
  $map = @{}
  foreach ($property in $saved.PSObject.Properties) {
    $value = $property.Value
    # Entries written before process names and start times were kept are the bare PID.
    $map[$property.Name] = if ($value -is [System.Management.Automation.PSCustomObject]) {
      @{ pid = [int]$value.pid; name = $value.name; started = $value.started }
    } else {
      @{ pid = [int]$value; name = $null; started = $null }
    }
  }
  return $map
}

if ($Stop) {
  # A PID is reused once its process ends (after a reboot, say): only a process with the recorded name and start time is
  # ended. A bare-PID entry must be the program that service is started with, running since before the file was written.
  $written = if (Test-Path -LiteralPath $pidFile) { (Get-Item -LiteralPath $pidFile).LastWriteTimeUtc } else { [datetime]::MinValue }
  $launchers = @{ server = 'powershell'; frontend = 'cmd'; character = 'uv' }
  foreach ($entry in (Read-Started).GetEnumerator()) {
    $record = $entry.Value
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    $since = $null
    if ($process) { try { $since = $process.StartTime.ToUniversalTime() } catch { $since = $null } }
    $ours = $false
    if ($since -and $record.started) {
      $ours = $process.ProcessName -eq $record.name -and [math]::Abs($since.Ticks - [long]$record.started) -lt [TimeSpan]::TicksPerSecond
    } elseif ($since) {
      $ours = $process.ProcessName -eq $launchers[$entry.Key] -and $since -le $written
    }
    if (-not $process) {
      Write-Host "$($entry.Key) ($($record.pid)) is not running"
    } elseif (-not $ours) {
      Write-Host "$($entry.Key): pid $($record.pid) is now $($process.ProcessName), not the process this script started; left running"
    } else {
      # taskkill /T also ends the children (cargo's server, vite's esbuild, uvicorn's worker). Its complaints about
      # children that are already gone go to stderr, which Windows PowerShell 5.1 would turn into a stop.
      $ErrorActionPreference = 'Continue'
      & taskkill.exe /PID $record.pid /T /F 2>$null | Out-Null
      $ErrorActionPreference = 'Stop'
      Write-Host "stopped $($entry.Key) ($($record.pid))"
    }
  }
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  return
}

function Test-Listening([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-Http([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

$started = Read-Started
function Start-DevProcess([string]$Name, [int]$Port, [string]$File, [string[]]$Arguments) {
  if (Test-Listening $Port) {
    Write-Host "$Name`: port $Port is already in use, keeping what runs there"
    return
  }
  $log = Join-Path $runtime "$Name.log"
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  # Name and start time (UTC ticks) let -Stop tell this process from a later one that gets the same PID.
  $entry = @{ pid = $process.Id; name = $null; started = $null }
  try {
    $entry.name = $process.ProcessName
    $entry.started = $process.StartTime.ToUniversalTime().Ticks
  } catch {
    # It has exited already; -Stop finds nothing of it to end.
  }
  $started[$Name] = $entry
  $started | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
  Write-Host "$Name`: started (pid $($process.Id)), log $log"
}

$factoryKeys = @('FACTORY_URL', 'FACTORY_API_KEY', 'FACTORY_JWT_SECRET', 'FACTORY_JWT_ISSUER', 'FACTORY_JWT_AUDIENCE', 'FACTORY_ACCESS', 'FACTORY_PAID_MONTHLY', 'ASSET_AUTO_RESUME')
$saved = @{}
foreach ($key in $factoryKeys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$savedRecords = [Environment]::GetEnvironmentVariable('CHARACTER_DATABASE_URL', 'Process')
# uv finds the workspace from the working directory: run from the repository root wherever this was started, and give
# the caller's location back afterwards.
Push-Location -LiteralPath $root
try {
  $serverArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'server\scripts\start-rust-server.ps1'))
  if ($Character) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $root 'backend\.env')) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
    }
    # Stages a previous run left unfinished are not resumed by a dev start: that would be paid work nobody asked for.
    $env:ASSET_AUTO_RESUME = '0'
    if (-not (Test-Listening 8016)) {
      # Character records live in a local database (mogaesup_character) on the compose PostgreSQL.
      $ErrorActionPreference = 'Continue'
      & docker compose -f (Join-Path $root 'server\docker-compose.yml') up -d --wait postgres
      $ErrorActionPreference = 'Stop'
      if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL (docker compose) did not start.' }
      $password = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { 'postgres-dev' }
      $env:CHARACTER_DATABASE_URL = "postgresql://postgres:$password@127.0.0.1:55432/mogaesup_character"
      & uv run python -m src.records migrate --create-database
      if ($LASTEXITCODE -ne 0) { throw 'Character record database migration failed.' }
      # A prefix whose records were never imported is refused; status names the import command.
      $prefix = if ($values.ContainsKey('ASSET_S3_PREFIX')) { $values['ASSET_S3_PREFIX'] } else { 'assets' }
      & uv run python -m src.records status --prefix $prefix
    }
    Start-DevProcess 'character' 8016 'uv' @('run', 'python', '-m', 'uvicorn', 'src.api.server:app', '--host', '127.0.0.1', '--port', '8016')
    # The record database is the character server's alone.
    [Environment]::SetEnvironmentVariable('CHARACTER_DATABASE_URL', $savedRecords, 'Process')
    $env:FACTORY_API_KEY = $values['API_KEY']
    $env:FACTORY_JWT_SECRET = $values['JWT_SECRET']
    if ($values['JWT_ISSUER']) { $env:FACTORY_JWT_ISSUER = $values['JWT_ISSUER'] }
    if ($values['JWT_AUDIENCE']) { $env:FACTORY_JWT_AUDIENCE = $values['JWT_AUDIENCE'] }
    $env:FACTORY_ACCESS = if ($Paid) { 'paid' } else { 'write' }
    $env:FACTORY_PAID_MONTHLY = if ($Paid) { "$PaidMonthly" } else { '0' }
    $serverArguments += @('-FactoryUrl', 'http://127.0.0.1:8016')
  }
  Start-DevProcess 'server' 8080 'powershell.exe' $serverArguments
  Start-DevProcess 'frontend' 5180 'npm.cmd' @('run', 'dev', '--workspace', 'frontend')
} finally {
  Pop-Location
  # The children have their copies; this shell does not keep the secrets.
  foreach ($key in $factoryKeys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
  [Environment]::SetEnvironmentVariable('CHARACTER_DATABASE_URL', $savedRecords, 'Process')
}

$checks = @()
if ($Character) { $checks += , @('character', 'http://127.0.0.1:8016/health') }
$checks += , @('server', 'http://127.0.0.1:8080/api/health')
$checks += , @('frontend', 'http://127.0.0.1:5180/')
foreach ($check in $checks) {
  # The first server start compiles; give it minutes, not seconds.
  $ready = Wait-Http $check[1] 600
  Write-Host ("{0,-10} {1} {2}" -f $check[0], $(if ($ready) { 'ready' } else { 'NOT READY (see .data/dev logs)' }), $check[1])
}
