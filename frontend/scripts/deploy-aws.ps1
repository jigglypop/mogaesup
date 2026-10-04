[CmdletBinding()]
param(
  [string]$StackName = 'mogaesup-web',
  [string]$ServerStackName = 'mogaesup-server',
  [string]$Region = 'ap-northeast-2',
  [string]$BucketName = 'mogaesup-web-960243570517-apne2',
  [string]$ExpectedAccount = '960243570517',
  [string]$DomainName = 'mogaesup.com',
  [string]$RedirectDomainName = 'www.mogaesup.com',
  [string]$HostedZoneId = 'Z05454042ZQ3PMG0TW4JR',
  # Defaults to the issued us-east-1 certificate for DomainName.
  [string]$CertificateArn,
  [switch]$ProvisionOnly,
  [switch]$SkipBuild,
  # Uploads to the stack as it is and does not touch its resources (the pipeline's release).
  [switch]$SkipProvision
)

$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''
$projectRoot = Split-Path -Parent $PSScriptRoot
$template = Join-Path $projectRoot 'infra/aws-static.yaml'
$dist = Join-Path $projectRoot 'dist'

function Invoke-Native {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  # Windows PowerShell turns a native command's stderr progress into errors under 'Stop'.
  $ErrorActionPreference = 'Continue'
  $output = & $Arguments[0] @($Arguments | Select-Object -Skip 1)
  if ($LASTEXITCODE -ne 0) { throw "Failed: $($Arguments -join ' ')" }
  $output
}

$account = (Invoke-Native aws sts get-caller-identity --query Account --output text).Trim()
if ($account -ne $ExpectedAccount) { throw "Refusing deployment to AWS account $account; expected $ExpectedAccount." }

if ($DomainName -and -not $CertificateArn -and -not $SkipProvision) {
  $CertificateArn = (Invoke-Native aws acm list-certificates --region us-east-1 --certificate-statuses ISSUED --query "CertificateSummaryList[?DomainName=='$DomainName'].CertificateArn | [0]" --output text).Trim()
  if (-not $CertificateArn -or $CertificateArn -eq 'None') { throw "No issued us-east-1 certificate for $DomainName." }
}

$overrides = @("BucketName=$BucketName")
if ($DomainName) {
  $overrides += "DomainName=$DomainName", "CertificateArn=$CertificateArn", "HostedZoneId=$HostedZoneId"
  if ($RedirectDomainName) { $overrides += "RedirectDomainName=$RedirectDomainName" }
}
# The server stack's VPC origin carries /api/*; without it the site deploys static-only.
if (-not $SkipProvision) {
  $serverOutputs = & aws cloudformation describe-stacks --region $Region --stack-name $ServerStackName --query 'Stacks[0].Outputs' --output json 2>$null
  if ($LASTEXITCODE -eq 0 -and $serverOutputs) {
    $server = @{}; foreach ($item in ($serverOutputs | ConvertFrom-Json)) { $server[$item.OutputKey] = $item.OutputValue }
    if ($server.VpcOriginId -and $server.ApiPrivateDns) {
      $overrides += "ApiVpcOriginId=$($server.VpcOriginId)", "ApiPrivateDns=$($server.ApiPrivateDns)"
    }
  }
}

Push-Location $projectRoot
try {
  if (-not $SkipProvision) {
    Invoke-Native aws cloudformation validate-template --region $Region --template-body "file://$template" | Out-Null
    Invoke-Native aws cloudformation deploy --region $Region --stack-name $StackName --template-file $template --parameter-overrides @overrides --no-fail-on-empty-changeset --tags application=mogaesup
  }
  $stack = Invoke-Native aws cloudformation describe-stacks --region $Region --stack-name $StackName --query 'Stacks[0]' --output json | ConvertFrom-Json
  # A rolled-back update leaves the stack as it was before that update, which a release can go onto.
  if ($stack.StackStatus -eq 'UPDATE_ROLLBACK_COMPLETE') {
    Write-Warning 'The last stack update was rolled back (UPDATE_ROLLBACK_COMPLETE); deploying onto the stack as it stands.'
  } elseif ($stack.StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE')) {
    throw "CloudFormation stack is not ready: $($stack.StackStatus)"
  }
  $outputs = @{}; foreach ($item in $stack.Outputs) { $outputs[$item.OutputKey] = $item.OutputValue }
  Write-Host "Stack $StackName $($stack.StackStatus): $($outputs.SiteUrl)"
  if ($ProvisionOnly) { return }

  if (-not $SkipBuild) {
    Invoke-Native npm run build
  }
  if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { throw 'dist/index.html is missing; build first.' }
  # The engine's files the page cannot start without, checked before anything is uploaded.
  $required = @(
    @{ Path = 'wasm/gaesup_core.wasm'; Type = 'application/wasm' },
    @{ Path = 'wasm/gaesup_gi.wasm'; Type = 'application/wasm' },
    @{ Path = 'gltf/man.glb'; Type = 'model/gltf-binary' }
  )
  foreach ($asset in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $asset.Path))) { throw "Required runtime file is missing: $($asset.Path)" }
  }

  # Old hashed chunks stay for tabs still open on the previous release; index.html goes last.
  $bucket = "s3://$($outputs.BucketName)"
  # The WebAssembly keeps its name across engine releases while the hashed script that loads it changes, so browsers
  # ask whether it changed every time instead of running an hour-old copy against a new script.
  $typed = @(
    @{ Pattern = '*.glb'; Type = 'model/gltf-binary'; Cache = 'public,max-age=3600' },
    @{ Pattern = '*.wasm'; Type = 'application/wasm'; Cache = 'no-cache' },
    @{ Pattern = '*.woff2'; Type = 'font/woff2'; Cache = 'public,max-age=3600' }
  )
  # Patterns are written as one `--option=value` token: PowerShell on Linux expands a lone '*' or '/*' argument into file names.
  $excludes = @('--exclude=index.html', '--exclude=assets/*', '--exclude=*.map')
  foreach ($entry in $typed) { $excludes += "--exclude=$($entry.Pattern)" }
  Invoke-Native aws s3 sync $dist $bucket --region $Region @excludes --cache-control 'public,max-age=3600' --no-progress --only-show-errors
  foreach ($entry in $typed) {
    Invoke-Native aws s3 cp $dist $bucket --recursive --region $Region '--exclude=*' "--include=$($entry.Pattern)" '--exclude=assets/*' --content-type $entry.Type --cache-control $entry.Cache --no-progress --only-show-errors
  }
  # Scripts and stylesheets get their types named rather than guessed from the machine's MIME table.
  $immutable = 'public,max-age=31536000,immutable'
  $assets = Join-Path $dist 'assets'
  Invoke-Native aws s3 cp $assets "$bucket/assets" --recursive --region $Region '--exclude=*' '--include=*.js' --content-type 'text/javascript; charset=utf-8' --cache-control $immutable --no-progress --only-show-errors
  Invoke-Native aws s3 cp $assets "$bucket/assets" --recursive --region $Region '--exclude=*' '--include=*.css' --content-type 'text/css; charset=utf-8' --cache-control $immutable --no-progress --only-show-errors
  Invoke-Native aws s3 cp $assets "$bucket/assets" --recursive --region $Region '--exclude=*.js' '--exclude=*.css' '--exclude=*.map' --cache-control $immutable --no-progress --only-show-errors
  Invoke-Native aws s3 cp (Join-Path $dist 'index.html') "$bucket/index.html" --region $Region --cache-control 'no-cache,max-age=0,must-revalidate' --content-type 'text/html; charset=utf-8' --no-progress --only-show-errors

  $invalidation = Invoke-Native aws cloudfront create-invalidation --distribution-id $outputs.DistributionId '--paths=/*' --output json | ConvertFrom-Json
  # The release is live once index.html is uploaded (it is served without caching); a slow invalidation only delays the
  # edges' older models and engine files, so a wait that runs out is a warning, not a failed release.
  $invalidated = $false
  foreach ($attempt in 1..2) {
    try {
      Invoke-Native aws cloudfront wait invalidation-completed --distribution-id $outputs.DistributionId --id $invalidation.Invalidation.Id
      $invalidated = $true
      break
    } catch {
      Write-Host "CloudFront invalidation $($invalidation.Invalidation.Id) is still in progress ($attempt)"
    }
  }
  if (-not $invalidated) { Write-Warning "CloudFront invalidation $($invalidation.Invalidation.Id) did not finish within 20 minutes; edges keep older files until it does." }

  # The published page is this build, the API answers through the same origin, and a missing model is not the app.
  $site = $outputs.SiteUrl
  $page = Invoke-WebRequest -UseBasicParsing -Uri "$site/?verify=$([DateTime]::UtcNow.Ticks)"
  $local = [IO.File]::ReadAllText((Join-Path $dist 'index.html'))
  if ($page.Content -ne $local) { throw 'Published index.html differs from dist/index.html.' }
  # These engine files must be the uploaded build, with types the browser can load.
  foreach ($asset in $required) {
    $assetPath = Join-Path $dist $asset.Path
    $assetUrl = "$site/$($asset.Path)"
    $assetHead = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $assetUrl
    if ([string]$assetHead.Headers['Content-Type'] -notlike "$($asset.Type)*") {
      throw "Unexpected runtime file content type: $($asset.Path)"
    }
    $download = [IO.Path]::GetTempFileName()
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $assetUrl -OutFile $download
      if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash) {
        throw "Published runtime file differs from dist: $($asset.Path)"
      }
    } finally {
      Remove-Item -LiteralPath $download -Force
    }
    Write-Host "Verified runtime file: $($asset.Path)"
  }
  if ($stack.Parameters | Where-Object { $_.ParameterKey -eq 'ApiVpcOriginId' -and $_.ParameterValue }) {
    $health = Invoke-RestMethod -Uri "$site/api/health"
    if ($health.status -ne 'ok') { throw "API health through CloudFront: $($health | ConvertTo-Json -Compress)" }
    Write-Host "API through CloudFront: $($health | ConvertTo-Json -Compress)"
  }
  try {
    $missing = Invoke-WebRequest -UseBasicParsing -Method Head -Uri "$site/gltf/missing-model.glb"
    $missingType = $missing.Headers['Content-Type']
  } catch { $missingType = '' }
  if ($missingType -like 'text/html*') { throw 'A missing model returned the application HTML.' }
  Write-Host "Deployed and verified: $site (invalidation $($invalidation.Invalidation.Id))"
} finally {
  Pop-Location
}
