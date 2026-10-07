[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstanceId,
  [Parameter(Mandatory)][string]$Bucket,
  [Parameter(Mandatory)][string]$ReleaseKey,
  [string]$Region = 'ap-northeast-2',
  [string]$Profile = '',
  # The deployment's SSM command: migrations, the data root's share, the worker check, the drain and the replacement.
  [ValidateRange(60, 1800)][int]$TimeoutSeconds = 900,
  # The release's image is built first, in an SSM command of its own that touches nothing of the running release: a
  # Dockerfile change rebuilds the whole image (apt, Blender), which must not use up the deployment's time limit.
  [ValidateRange(60, 3600)][int]$BuildTimeoutSeconds = 1500
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

# Run by hand (set-factory-jwt.py too), nothing is installed while a pipeline run on main is queued or in progress: it may
# deploy the studio as well, and the instance's deploy lock only keeps the two installs apart, not in order. gh's JSON is
# read here rather than through a --jq argument whose quotes Windows PowerShell 5.1 would strip.
if ($env:GITHUB_ACTIONS -ne 'true') {
  $listed = $false
  $active = 0
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    Push-Location (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
    try { $json = (& gh run list --workflow pipeline.yml --branch main --limit 20 --json status 2>$null) -join "`n"; $code = $LASTEXITCODE }
    finally { Pop-Location; $ErrorActionPreference = $previous }
    if ($code -eq 0) {
      try {
        $runs = ConvertFrom-Json -InputObject $json
        $active = @($runs | Where-Object { $null -ne $_ -and $_.status -ne 'completed' }).Count
        $listed = $true
      } catch { $listed = $false }
    }
  }
  if (-not $listed) {
    Write-Warning 'gh could not list the pipeline runs (install it and run gh auth login), so a pipeline run that deploys at the same time cannot be ruled out.'
  } elseif ($active -gt 0) {
    throw 'A pipeline run on main is queued or in progress and may deploy the studio as well; wait for it, or use its Run workflow (target studio) instead.'
  }
}

$headResult = Invoke-Aws @('s3api', 'head-object', '--bucket', $Bucket, '--key', $ReleaseKey)
$head = $headResult.Text | ConvertFrom-Json
if ($head.Metadata.sha256 -ne $releaseSha) { throw 'S3 release metadata does not match its content-addressed key.' }

# Both commands take the instance's prepare lock, and fetch the release, check it against its content address and unpack
# it before handing it to deploy-on-instance.sh.
$prepare = @"
set -Eeuo pipefail
release_key='$ReleaseKey'
release_sha='$releaseSha'
exec 8>/var/lock/asset-studio-prepare.lock
flock -n 8 || { echo 'another release preparation is active' >&2; exit 3; }
incoming="/opt/asset-studio/incoming/`$release_sha"
"@
$fetch = @"
rm -rf "`$incoming"
install -d -m 700 "`$incoming/source"
aws s3 cp 's3://$Bucket/$ReleaseKey' "`$incoming/release.tar.gz" --region '$Region' --checksum-mode ENABLED --only-show-errors
printf '%s  %s\n' "`$release_sha" "`$incoming/release.tar.gz" | sha256sum -c -
tar -xzf "`$incoming/release.tar.gz" -C "`$incoming/source"
printf '%s\n' "`$release_sha" > "`$incoming/source/.release-sha256"
"@
# The image, unless the instance has it already (a release deployed again, set-factory-jwt.py's redeploy). A release
# whose deploy-on-instance.sh predates the build mode would take `build` for a deployment: it builds in its deployment.
$build = $prepare + "`n" + @"
if docker image inspect "gaesup-asset-studio:`$release_sha" >/dev/null 2>&1; then echo "image gaesup-asset-studio:`$release_sha is built"; exit 0; fi
"@ + "`n" + $fetch + "`n" + @"
if grep -qF 'mode="`${4:-deploy}"' "`$incoming/source/infra/deploy-on-instance.sh"; then
  /bin/bash "`$incoming/source/infra/deploy-on-instance.sh" "`$release_key" "`$release_sha" "`$incoming/source" build
else
  echo 'this release builds its image during its deployment'
fi
rm -f "`$incoming/release.tar.gz"
"@
# The SSM execution timeout ends the deployment without its EXIT trap; deploy-on-instance.sh plans its drain, replacement
# and rollback within this deadline (the instance's clock, with a margin for the SSM agent).
$deploy = $prepare + "`n" + @"
export ASSET_DEPLOY_DEADLINE=`$(( `$(date +%s) + $TimeoutSeconds - 30 ))
"@ + "`n" + $fetch + "`n" + @"
/bin/bash "`$incoming/source/infra/deploy-on-instance.sh" "`$release_key" "`$release_sha" "`$incoming/source"
rm -f "`$incoming/release.tar.gz"
"@

$artifactRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist/aws'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
# UTF-8 without a BOM in Windows PowerShell 5.1 and PowerShell 7 alike.
$utf8 = New-Object System.Text.UTF8Encoding $false

# Runs one script on the instance through SSM with its own execution limit and waits for it; returns the command ID.
function Invoke-OnInstance([string]$Name, [string]$Script, [int]$Seconds) {
  $parametersPath = Join-Path $artifactRoot "ssm-$Name.json"
  # A Windows checkout has CRLF line endings; the instance's shell needs LF.
  $Script = $Script -replace "`r", ''
  [IO.File]::WriteAllText($parametersPath, (@{ commands = @($Script); executionTimeout = @("$Seconds") } | ConvertTo-Json -Depth 4), $utf8)
  $send = Invoke-Aws @('ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', $InstanceId, '--comment', "asset-studio $Name $($releaseSha.Substring(0,12))", '--parameters', ('file://' + $parametersPath), '--timeout-seconds', "$Seconds")
  $commandId = (($send.Text | ConvertFrom-Json).Command.CommandId)
  if (-not $commandId) { throw 'SSM did not return a command ID.' }

  $deadline = (Get-Date).AddSeconds($Seconds + 30)
  # Pending until the instance reports otherwise. A lookup that fails (the invocation not registered yet, a throttled
  # call) is asked again until the deadline: `continue` in a do/while goes to its condition, so the loop must read as
  # pending.
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
    Write-Host "SSM $Name command $commandId status: $($invocation.Status)"
  } while ($invocation.Status -in @('Pending', 'InProgress', 'Delayed') -and (Get-Date) -lt $deadline)

  if ($invocation.Status -in @('Pending', 'InProgress', 'Delayed')) {
    $last = if ($lookupFailure) { " The last lookup failed: $lookupFailure" } else { '' }
    throw "SSM $Name is still non-terminal: $commandId. Inspect this existing command; do not submit the release again.$last"
  }
  if ($invocation.StandardOutputContent) { Write-Host $invocation.StandardOutputContent }
  if ($invocation.Status -ne 'Success') {
    if ($invocation.StandardErrorContent) { Write-Error $invocation.StandardErrorContent -ErrorAction Continue }
    throw "SSM $Name failed with status $($invocation.Status): $commandId"
  }
  return $commandId
}

# A failed or cut-short build changes nothing that runs; the next deployment builds again from the layers it cached.
$buildCommandId = Invoke-OnInstance 'build' $build $BuildTimeoutSeconds
$commandId = Invoke-OnInstance 'deployment' $deploy $TimeoutSeconds
$receipt = [ordered]@{ command_id=$commandId; build_command_id=$buildCommandId; instance_id=$InstanceId; bucket=$Bucket; release_key=$ReleaseKey; sha256=$releaseSha; status='Success'; deployed_at=(Get-Date).ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText((Join-Path $artifactRoot 'deployment-receipt.json'), ($receipt | ConvertTo-Json), $utf8)
$receipt | ConvertTo-Json
