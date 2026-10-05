[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstanceId,
  [Parameter(Mandatory)][string]$Bucket,
  [Parameter(Mandatory)][string]$ReleaseKey,
  [string]$Region = 'ap-northeast-2',
  [string]$Profile = '',
  [ValidateRange(60, 1800)][int]$TimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'
if ($InstanceId -notmatch '^i-[0-9a-f]{8,17}$') { throw 'Invalid EC2 instance ID.' }
if ($Bucket -notmatch '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') { throw 'Invalid S3 bucket name.' }
if ($ReleaseKey -notmatch '^releases/studio/([0-9a-f]{64})\.tar\.gz$') { throw 'Invalid release key.' }
$releaseSha = $Matches[1]
# The region goes into the script the instance runs.
if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-[0-9]+$') { throw 'Invalid AWS region.' }
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI is required.' }

function Invoke-Aws([string[]]$Arguments, [switch]$AllowFailure) {
  $common = @('--region', $Region, '--cli-connect-timeout', '5', '--cli-read-timeout', '20', '--output', 'json')
  if ($Profile) { $common += @('--profile', $Profile) }
  # stdout alone is parsed as JSON; stderr goes to a file, so a CLI warning cannot break the parse. Windows PowerShell
  # 5.1 turns a redirected stderr line into a terminating error under Stop, so the exit code decides failure instead.
  $errorFile = [IO.Path]::GetTempFileName()
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $text = & aws @Arguments @common 2>$errorFile
    $code = $LASTEXITCODE
    $errorText = (Get-Content -LiteralPath $errorFile -Raw -ErrorAction SilentlyContinue)
  } finally {
    $ErrorActionPreference = $previous
    Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
  }
  $text = $text | ForEach-Object { "$_" }
  $errorText = if ($errorText) { $errorText.Trim() } else { '' }
  if ($code -ne 0 -and -not $AllowFailure) { throw "AWS CLI request failed: $($Arguments[0..1] -join ' '): $errorText" }
  return [pscustomobject]@{ ExitCode = $code; Text = ($text -join "`n"); Error = $errorText }
}

$headResult = Invoke-Aws @('s3api', 'head-object', '--bucket', $Bucket, '--key', $ReleaseKey)
$head = $headResult.Text | ConvertFrom-Json
if ($head.Metadata.sha256 -ne $releaseSha) { throw 'S3 release metadata does not match its content-addressed key.' }

$remote = @"
set -Eeuo pipefail
# The SSM execution timeout ends this script without its EXIT trap; deploy-on-instance.sh plans its drain, replacement
# and rollback within this deadline (the instance's clock, with a margin for the SSM agent).
export ASSET_DEPLOY_DEADLINE=`$(( `$(date +%s) + $TimeoutSeconds - 30 ))
release_key='$ReleaseKey'
release_sha='$releaseSha'
exec 8>/var/lock/asset-studio-prepare.lock
flock -n 8 || { echo 'another release preparation is active' >&2; exit 3; }
incoming="/opt/asset-studio/incoming/`$release_sha"
rm -rf "`$incoming"
install -d -m 700 "`$incoming/source"
aws s3 cp 's3://$Bucket/$ReleaseKey' "`$incoming/release.tar.gz" --region '$Region' --checksum-mode ENABLED --only-show-errors
printf '%s  %s\n' "`$release_sha" "`$incoming/release.tar.gz" | sha256sum -c -
tar -xzf "`$incoming/release.tar.gz" -C "`$incoming/source"
printf '%s\n' "`$release_sha" > "`$incoming/source/.release-sha256"
/bin/bash "`$incoming/source/infra/deploy-on-instance.sh" "`$release_key" "`$release_sha" "`$incoming/source"
rm -f "`$incoming/release.tar.gz"
"@

$artifactRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist/aws'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$parametersPath = Join-Path $artifactRoot 'ssm-parameters.json'
# A Windows checkout has CRLF line endings; the instance's shell needs LF.
$remote = $remote -replace "`r", ''
# UTF-8 without a BOM in Windows PowerShell 5.1 and PowerShell 7 alike.
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText($parametersPath, (@{ commands = @($remote); executionTimeout = @("$TimeoutSeconds") } | ConvertTo-Json -Depth 4), $utf8)
$send = Invoke-Aws @('ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', $InstanceId, '--comment', "asset-studio $($releaseSha.Substring(0,12))", '--parameters', ('file://' + $parametersPath), '--timeout-seconds', "$TimeoutSeconds")
$commandId = (($send.Text | ConvertFrom-Json).Command.CommandId)
if (-not $commandId) { throw 'SSM did not return a command ID.' }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds + 30)
# Pending until the instance reports otherwise. A lookup that fails (the invocation not registered yet, a throttled call)
# is asked again until the deadline: `continue` in a do/while goes to its condition, so the loop must read as pending.
$invocation = [pscustomobject]@{ Status = 'Pending' }
$lookupFailure = $null
do {
  Start-Sleep -Seconds 5
  $get = Invoke-Aws @('ssm', 'get-command-invocation', '--command-id', $commandId, '--instance-id', $InstanceId) -AllowFailure
  if ($get.ExitCode -ne 0) {
    $lookupFailure = ($get.Error -split "`n" | Select-Object -Last 1)
    continue
  }
  $lookupFailure = $null
  $invocation = $get.Text | ConvertFrom-Json
  Write-Host "SSM command $commandId status: $($invocation.Status)"
} while ($invocation.Status -in @('Pending', 'InProgress', 'Delayed') -and (Get-Date) -lt $deadline)

if ($invocation.Status -in @('Pending', 'InProgress', 'Delayed')) {
  $last = if ($lookupFailure) { " The last lookup failed: $lookupFailure" } else { '' }
  throw "SSM deployment is still non-terminal: $commandId. Inspect this existing command; do not submit the release again.$last"
}
if ($invocation.StandardOutputContent) { Write-Host $invocation.StandardOutputContent }
if ($invocation.Status -ne 'Success') {
  if ($invocation.StandardErrorContent) { Write-Error $invocation.StandardErrorContent -ErrorAction Continue }
  throw "SSM deployment failed with status $($invocation.Status): $commandId"
}
$receipt = [ordered]@{ command_id=$commandId; instance_id=$InstanceId; bucket=$Bucket; release_key=$ReleaseKey; sha256=$releaseSha; status=$invocation.Status; deployed_at=(Get-Date).ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText((Join-Path $artifactRoot 'deployment-receipt.json'), ($receipt | ConvertTo-Json), $utf8)
$receipt | ConvertTo-Json
