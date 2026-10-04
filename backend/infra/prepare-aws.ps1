[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$Region = 'ap-northeast-2',
  [string]$Bucket = 'gaesup-character-assets-960243570517-apne2',
  [switch]$Upload
)
$ErrorActionPreference = 'Stop'
# The release keeps the layout the instance scripts expect (backend/, infra/, the uv workspace files at its root);
# in this repository infra/ lives under backend/ and the workspace files at the repository root.
$backend = Split-Path $PSScriptRoot -Parent
$root = Split-Path $backend -Parent
$artifactRoot = Join-Path $backend 'dist/aws'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI is required.' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'tar is required.' }
# What the archive holds from the working tree, below the repository root (infra/ is packed from backend/infra).
$releasePaths = @('backend/src', 'backend/assets', 'backend/migrations', 'backend/pyproject.toml', 'backend/main.py',
                  'backend/README.md', 'backend/infra', 'pyproject.toml', 'uv.lock', '.dockerignore')

function Invoke-Git([string[]]$Arguments) {
  # Windows PowerShell 5.1 turns redirected stderr into errors under Stop; the exit code decides instead.
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $text = & git -C $root @Arguments 2>$null } finally { $ErrorActionPreference = $previous }
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @($text | ForEach-Object { "$_" } | Where-Object { $_ }) }
}

# In a git checkout the release is exactly a commit: uncommitted or untracked release files are refused, and the
# commit is recorded in the receipt and in the release itself (release.json, published by the image as version.json).
$gitCommit = $null
if (Get-Command git -ErrorAction SilentlyContinue) {
  $inside = Invoke-Git @('rev-parse', '--is-inside-work-tree')
  if ($inside.ExitCode -eq 0 -and $inside.Lines -contains 'true') {
    $changes = Invoke-Git (@('status', '--porcelain', '--untracked-files=all', '--') + $releasePaths)
    if ($changes.ExitCode -ne 0) { throw 'git status of the release files failed.' }
    if ($changes.Lines.Count -gt 0) {
      throw "Release files have uncommitted changes; commit them (or discard them) before packing: $($changes.Lines -join '; ')"
    }
    $head = Invoke-Git @('rev-parse', 'HEAD')
    if ($head.ExitCode -ne 0 -or $head.Lines.Count -ne 1 -or $head.Lines[0] -notmatch '^[0-9a-f]{40}$') { throw 'The git commit could not be read.' }
    $gitCommit = $head.Lines[0]
  }
}

function Invoke-Aws([string[]]$Arguments) {
  $common = @('--region', $Region, '--cli-connect-timeout', '5', '--cli-read-timeout', '20', '--output', 'json')
  if ($Profile) { $common += @('--profile', $Profile) }
  $result = & aws @Arguments @common
  if ($LASTEXITCODE -ne 0) { throw 'AWS CLI request failed.' }
  return ($result | ConvertFrom-Json)
}
$identity = Invoke-Aws @('sts', 'get-caller-identity')
$location = Invoke-Aws @('s3api', 'get-bucket-location', '--bucket', $Bucket)
$bucketRegion = if ($location.LocationConstraint) { $location.LocationConstraint } else { 'us-east-1' }
if ($bucketRegion -ne $Region) { throw 'S3 bucket region mismatch.' }
$publicAccess = Invoke-Aws @('s3api', 'get-public-access-block', '--bucket', $Bucket)
$publicFlags = $publicAccess.PublicAccessBlockConfiguration
if (-not ($publicFlags.BlockPublicAcls -and $publicFlags.IgnorePublicAcls -and $publicFlags.BlockPublicPolicy -and $publicFlags.RestrictPublicBuckets)) { throw 'S3 bucket public access block is incomplete.' }
$encryption = Invoke-Aws @('s3api', 'get-bucket-encryption', '--bucket', $Bucket)
if (-not $encryption.ServerSideEncryptionConfiguration.Rules.ApplyServerSideEncryptionByDefault.SSEAlgorithm) { throw 'S3 bucket default encryption is required.' }
$versioning = Invoke-Aws @('s3api', 'get-bucket-versioning', '--bucket', $Bucket)
if ($versioning.Status -ne 'Enabled') { throw 'S3 bucket versioning is required.' }
$ownership = Invoke-Aws @('s3api', 'get-bucket-ownership-controls', '--bucket', $Bucket)
if ($ownership.OwnershipControls.Rules.ObjectOwnership -notcontains 'BucketOwnerEnforced') { throw 'S3 BucketOwnerEnforced ownership is required.' }
$validation = Invoke-Aws @('cloudformation', 'validate-template', '--template-body', ('file://' + (Join-Path $PSScriptRoot 'ec2.yaml')))
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $artifactRoot 'release.json'), ([ordered]@{ git_commit = $gitCommit } | ConvertTo-Json -Compress), $utf8)
$archive = Join-Path $artifactRoot 'studio.tar.gz'
$archiveTemp = Join-Path $artifactRoot 'studio.tar.gz.tmp'
if (Test-Path -LiteralPath $archiveTemp) { Remove-Item -LiteralPath $archiveTemp -Force }
$fromRoot = @($releasePaths | Where-Object { $_ -ne 'backend/infra' })
& tar -czf $archiveTemp --exclude='node_modules' --exclude='__pycache__' --exclude='*.egg-info' --exclude='build' --exclude='dist' --exclude='test-results' --exclude='playwright-report' --exclude='.env*' -C $root @fromRoot -C $backend infra -C $artifactRoot release.json
if ($LASTEXITCODE -ne 0) { throw 'Release archive failed.' }
$entries = @(& tar -tzf $archiveTemp)
if ($LASTEXITCODE -ne 0) { throw 'Release archive inspection failed.' }
$forbidden = @($entries | Where-Object { $_ -match '(^|/)(\.env($|\.)|provider\.json$|credentials$|\.aws/)' })
if ($forbidden.Count -gt 0) { throw 'Release archive contains a forbidden credential path.' }
$unsafe = @($entries | Where-Object { $_ -match '(^/)|(^|/)\.\.(/|$)' })
if ($unsafe.Count -gt 0) { throw 'Release archive contains an unsafe path.' }
# The exclusions above match a name at any depth; none of them may drop a tracked release file (a package named build/).
if ($gitCommit) {
  $tracked = Invoke-Git (@('-c', 'core.quotePath=false', 'ls-files', '--') + $releasePaths)
  if ($tracked.ExitCode -ne 0) { throw 'git ls-files of the release files failed.' }
  $packed = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($entry in $entries) { [void]$packed.Add(($entry -replace '^\./', '')) }
  $dropped = @($tracked.Lines | ForEach-Object { $_ -replace '^backend/infra/', 'infra/' } | Where-Object { -not $packed.Contains($_) })
  if ($dropped.Count -gt 0) { throw "Release archive is missing tracked files: $($dropped -join ', ')" }
}
Move-Item -LiteralPath $archiveTemp -Destination $archive -Force
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$key = 'releases/studio/' + $hash + '.tar.gz'
if ($Upload) {
  $uploadArgs = @('s3', 'cp', $archive, "s3://$Bucket/$key", '--region', $Region, '--metadata', "sha256=$hash", '--checksum-algorithm', 'SHA256', '--only-show-errors')
  if ($Profile) { $uploadArgs += @('--profile', $Profile) }
  & aws @uploadArgs
  if ($LASTEXITCODE -ne 0) { throw 'S3 release upload failed.' }
  $head = Invoke-Aws @('s3api', 'head-object', '--bucket', $Bucket, '--key', $key)
  if ($head.Metadata.sha256 -ne $hash -or $head.ContentLength -ne (Get-Item -LiteralPath $archive).Length) { throw 'Uploaded release verification failed.' }
}
$receipt = [ordered]@{account=$identity.Account; region=$Region; bucket=$Bucket; release_key=$key; sha256=$hash; git_commit=$gitCommit; uploaded=[bool]$Upload; template_validated=$true; bucket_private=$true; bucket_encrypted=$true; bucket_versioned=$true; bucket_owner_enforced=$true; ec2_created=$false; created_at=(Get-Date).ToUniversalTime().ToString('o')}
$receipt | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $artifactRoot 'receipt.json')
$receipt | ConvertTo-Json
