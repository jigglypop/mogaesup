[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$Region = 'ap-northeast-2',
  [string]$Bucket = 'gaesup-character-assets-960243570517-apne2',
  [switch]$Upload
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$artifactRoot = Join-Path $repo 'dist/aws'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI is required.' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'tar is required.' }
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
$archive = Join-Path $artifactRoot 'studio.tar.gz'
$archiveTemp = Join-Path $artifactRoot 'studio.tar.gz.tmp'
if (Test-Path -LiteralPath $archiveTemp) { Remove-Item -LiteralPath $archiveTemp -Force }
Push-Location $repo
try {
  & tar -czf $archiveTemp --exclude='node_modules' --exclude='__pycache__' --exclude='*.egg-info' --exclude='build' --exclude='dist' --exclude='test-results' --exclude='playwright-report' --exclude='.env*' backend/src backend/assets backend/pyproject.toml backend/main.py backend/README.md frontend/src frontend/public frontend/index.html frontend/avatar.html frontend/package.json frontend/package-lock.json frontend/tsconfig.json frontend/vite.config.ts pyproject.toml uv.lock infra .dockerignore
  if ($LASTEXITCODE -ne 0) { throw 'Release archive failed.' }
} finally { Pop-Location }
$entries = @(& tar -tzf $archiveTemp)
if ($LASTEXITCODE -ne 0) { throw 'Release archive inspection failed.' }
$forbidden = @($entries | Where-Object { $_ -match '(^|/)(\.env($|\.)|provider\.json$|credentials$|\.aws/)' })
if ($forbidden.Count -gt 0) { throw 'Release archive contains a forbidden credential path.' }
$unsafe = @($entries | Where-Object { $_ -match '(^/)|(^|/)\.\.(/|$)' })
if ($unsafe.Count -gt 0) { throw 'Release archive contains an unsafe path.' }
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
$receipt = [ordered]@{account=$identity.Account; region=$Region; bucket=$Bucket; release_key=$key; sha256=$hash; uploaded=[bool]$Upload; template_validated=$true; bucket_private=$true; bucket_encrypted=$true; bucket_versioned=$true; bucket_owner_enforced=$true; ec2_created=$false; created_at=(Get-Date).ToUniversalTime().ToString('o')}
$receipt | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $artifactRoot 'receipt.json')
$receipt | ConvertTo-Json
