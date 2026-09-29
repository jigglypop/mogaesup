[CmdletBinding()]
param(
  [int]$ApiPort = 8080,
  [string]$AppOrigin = 'http://127.0.0.1:5180,http://localhost:5180',
  # The character server's API (backend/) for /admin, e.g. http://127.0.0.1:8000. FACTORY_JWT_SECRET and friends pass through
  # from the calling environment when the character server checks tokens.
  [string]$FactoryUrl = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

# Windows PowerShell turns a native command's stderr progress into errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& docker compose up -d --wait postgres
if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL (docker compose) did not start.' }
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
& cargo run
