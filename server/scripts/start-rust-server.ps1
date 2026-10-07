[CmdletBinding()]
param(
  [int]$ApiPort = 8080,
  [string]$AppOrigin = 'http://127.0.0.1:5180,http://localhost:5180',
  # The character server's API (backend/) for /admin, e.g. http://127.0.0.1:8000. FACTORY_JWT_SECRET and friends pass through
  # from the calling environment when the character server checks tokens.
  [string]$FactoryUrl = '',
  # Only the local PostgreSQL, checked and started: scripts/dev.ps1 runs this first, where its refusals show (the server
  # it starts afterwards runs hidden).
  [switch]$DatabaseOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $projectRoot 'docker-compose.yml'

# The compose PostgreSQL publishes 127.0.0.1:55432. A PostgreSQL started there outside Docker (a cluster made from the
# native binaries for tests) keeps the compose one from starting, and the server would use its database instead.
$listener = Get-NetTCPConnection -State Listen -LocalPort 55432 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($owner -and $owner.ProcessName -eq 'postgres') {
    throw "Port 55432 is held by a PostgreSQL outside Docker (pid $($owner.Id)), not the compose one. Stop it (pg_ctl -D <its data folder> stop) and run again."
  }
}
# Windows PowerShell turns a native command's stderr progress into errors under 'Stop'.
$ErrorActionPreference = 'Continue'
$volumes = @(& docker volume ls --format '{{.Name}}' 2>$null)
$listed = $LASTEXITCODE -eq 0
if (-not $listed) { throw 'Docker does not answer (docker volume ls failed): start Docker Desktop and run again.' }
# The compose file runs PostgreSQL 17 (CI and production's major) in a volume of its own; an older checkout ran 18 in
# postgres-data, whose files 17 cannot open. Started without that data moved over, it would come up empty.
if ($volumes -contains 'mogaesup-server_postgres-data' -and $volumes -notcontains 'mogaesup-server_postgres17-data') {
  throw "The local data is still in PostgreSQL 18's volume (mogaesup-server_postgres-data), and this compose file starts 17 in a new, empty one. Move it over first (the steps are in README.md, local setup, and server/docker-compose.yml), or start empty on purpose with: docker compose -f server/docker-compose.yml up -d --wait postgres"
}
& docker compose -f $compose up -d --wait postgres
if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL (docker compose) did not start.' }
if ($DatabaseOnly) { return }

Set-Location $projectRoot
$password = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { 'postgres-dev' }
$env:DATABASE_URL = "postgres://postgres:$password@127.0.0.1:55432/mogaesup"

# Live-room tickets need a signing secret; keep one per machine outside git.
if (-not $env:REALTIME_TICKET_SECRET) {
  $secretFile = Join-Path $projectRoot 'data/local/realtime-ticket-secret.txt'
  if (-not (Test-Path $secretFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $secretFile) | Out-Null
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes) | Set-Content -NoNewline -Encoding ascii $secretFile
  }
  $env:REALTIME_TICKET_SECRET = (Get-Content -Raw $secretFile).Trim()
}
$env:LISTEN_ADDR = "127.0.0.1:$ApiPort"
$env:APP_ORIGIN = $AppOrigin
$env:COOKIE_SECURE = 'false'
$env:MODEL_STORE = Join-Path $projectRoot 'data/local/models'
if ($FactoryUrl) { $env:FACTORY_URL = $FactoryUrl }
if (-not $env:RUST_LOG) { $env:RUST_LOG = 'info' }
# Runs a copy of the build, so cargo can rebuild and test while this server runs.
& cargo build
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' }
$bin = Join-Path $projectRoot 'data/local/bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$exe = Join-Path $bin 'mogaesup-server.exe'
Copy-Item -LiteralPath (Join-Path $projectRoot 'target/debug/mogaesup-server.exe') -Destination $exe -Force
& $exe
