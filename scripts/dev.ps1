<#
.SYNOPSIS
Runs the local pipeline from the monorepo root: PostgreSQL, the Rust server, the web app and, with -Character, the
character server behind the server's studio gateway.

.DESCRIPTION
Each service starts hidden with its log in .data/dev/<name>.log; one already listening on its port is kept as it is.
With -Character the character API (gaesup-character/backend from the root uv environment) runs on 127.0.0.1:8016 with
auto-resume off, and the Rust server gets FACTORY_URL plus the API key and JWT settings from gaesup-character/.env
(read here, never printed), so /admin imports and /studio work end to end. Admins may change studio records
(FACTORY_ACCESS=write); paid studio work stays blocked unless -Paid, capped at -PaidMonthly requests.
gaesup-character/.env holds production keys: only use -Character when you mean to reach them, and -Paid when you mean
to spend. -Stop ends what this script started.

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
  foreach ($property in $saved.PSObject.Properties) { $map[$property.Name] = [int]$property.Value }
  return $map
}

if ($Stop) {
  foreach ($entry in (Read-Started).GetEnumerator()) {
    # taskkill /T also ends the children (cargo's server, vite's esbuild, uvicorn's worker).
    & taskkill.exe /PID $entry.Value /T /F 2>$null | Out-Null
    Write-Host "stopped $($entry.Key) ($($entry.Value))"
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
  $started[$Name] = $process.Id
  $started | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
  Write-Host "$Name`: started (pid $($process.Id)), log $log"
}

$factoryKeys = @('FACTORY_URL', 'FACTORY_API_KEY', 'FACTORY_JWT_SECRET', 'FACTORY_JWT_ISSUER', 'FACTORY_JWT_AUDIENCE', 'FACTORY_ACCESS', 'FACTORY_PAID_MONTHLY', 'ASSET_AUTO_RESUME')
$saved = @{}
foreach ($key in $factoryKeys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
  $serverArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'server\scripts\start-rust-server.ps1'))
  if ($Character) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $root 'gaesup-character\.env')) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
    }
    # Stages a previous run left unfinished are not resumed by a dev start: that would be paid work nobody asked for.
    $env:ASSET_AUTO_RESUME = '0'
    Start-DevProcess 'character' 8016 'uv' @('run', 'python', '-m', 'uvicorn', 'src.api.server:app', '--host', '127.0.0.1', '--port', '8016')
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
  # The children have their copies; this shell does not keep the secrets.
  foreach ($key in $factoryKeys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
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
