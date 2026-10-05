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
  # Lists the stack's change set and deletes it: nothing is applied or uploaded (read it before -ProvisionOnly).
  [switch]$Preview,
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

$repoRoot = Split-Path -Parent $projectRoot
# The pipeline (.github/workflows/pipeline.yml) deploys main one run at a time and ships the build its checks made. Run
# by hand, this script builds a release only from committed files, and not while a pipeline run could upload too.
$inPipeline = $env:GITHUB_ACTIONS -eq 'true'
if (-not $inPipeline -and -not $ProvisionOnly -and -not $Preview) {
  if ($SkipBuild) { throw '-SkipBuild is for the pipeline, which ships the build it checked; run by hand, this script builds the release itself.' }
  $dirty = Invoke-Native git -C $repoRoot status --porcelain --untracked-files=all -- frontend package.json package-lock.json .nvmrc
  if ($dirty) { throw "Uncommitted web files would go live unreviewed; commit them first: $($dirty -join '; ')" }
  $ErrorActionPreference = 'Continue'
  & git -C $repoRoot merge-base --is-ancestor HEAD origin/main 2>$null
  $pushed = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if (-not $pushed) { throw 'HEAD is not on origin/main; push it first (git fetch if origin/main is stale).' }
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $active = Invoke-Native gh run list --workflow pipeline.yml --branch main --limit 20 --json status --jq '[.[] | select(.status != "completed")] | length'
    if ([int]$active -gt 0) { throw 'A pipeline run on main is queued or in progress and may deploy the web as well; wait for it, or use its Run workflow (target web) instead.' }
  } else {
    Write-Warning 'gh is not installed, so a pipeline run that deploys at the same time cannot be ruled out.'
  }
}
$releaseCommit = if ($inPipeline) { $env:GITHUB_SHA } else { (Invoke-Native git -C $repoRoot rev-parse HEAD | Select-Object -First 1).Trim() }
if ($releaseCommit -notmatch '^[0-9a-f]{40}$') { throw 'The commit of this release could not be read.' }

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
    if ($Preview) {
      $made = (Invoke-Native aws cloudformation deploy --region $Region --stack-name $StackName --template-file $template --parameter-overrides @overrides --no-fail-on-empty-changeset --no-execute-changeset --tags application=mogaesup) -join "`n"
      if ($made -notmatch '(arn:aws[a-z-]*:cloudformation:\S+:changeSet/\S+)') { Write-Host 'No changes to the stack.'; return }
      $changeSet = $Matches[1]
      Invoke-Native aws cloudformation describe-change-set --region $Region --change-set-name $changeSet --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
      Invoke-Native aws cloudformation delete-change-set --region $Region --change-set-name $changeSet | Out-Null
      Write-Host 'Listed only; apply with -ProvisionOnly.'
      return
    }
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

  # Order: the hashed bundles (new names nothing references yet), the other files without a hash, then the engine's
  # WebAssembly and the index.html that loads it back to back, so a new script meets an old WebAssembly (or the other way
  # round) only for the seconds between the two. Old hashed chunks stay for tabs still open on the previous release.
  $bucket = "s3://$($outputs.BucketName)"
  # Scripts and stylesheets get their types named rather than guessed from the machine's MIME table.
  $immutable = 'public,max-age=31536000,immutable'
  $assets = Join-Path $dist 'assets'
  Invoke-Native aws s3 cp $assets "$bucket/assets" --recursive --region $Region '--exclude=*' '--include=*.js' --content-type 'text/javascript; charset=utf-8' --cache-control $immutable --no-progress --only-show-errors
  Invoke-Native aws s3 cp $assets "$bucket/assets" --recursive --region $Region '--exclude=*' '--include=*.css' --content-type 'text/css; charset=utf-8' --cache-control $immutable --no-progress --only-show-errors
  Invoke-Native aws s3 cp $assets "$bucket/assets" --recursive --region $Region '--exclude=*.js' '--exclude=*.css' '--exclude=*.map' --cache-control $immutable --no-progress --only-show-errors
  $typed = @(
    @{ Pattern = '*.glb'; Type = 'model/gltf-binary'; Cache = 'public,max-age=3600' },
    @{ Pattern = '*.woff2'; Type = 'font/woff2'; Cache = 'public,max-age=3600' }
  )
  # Patterns are written as one `--option=value` token: PowerShell on Linux expands a lone '*' or '/*' argument into file names.
  $excludes = @('--exclude=index.html', '--exclude=assets/*', '--exclude=*.map', '--exclude=wasm/*')
  foreach ($entry in $typed) { $excludes += "--exclude=$($entry.Pattern)" }
  Invoke-Native aws s3 sync $dist $bucket --region $Region @excludes --cache-control 'public,max-age=3600' --no-progress --only-show-errors
  foreach ($entry in $typed) {
    Invoke-Native aws s3 cp $dist $bucket --recursive --region $Region '--exclude=*' "--include=$($entry.Pattern)" '--exclude=assets/*' '--exclude=wasm/*' --content-type $entry.Type --cache-control $entry.Cache --no-progress --only-show-errors
  }

  # What is live now, to put back if the published release fails its checks below.
  $previous = Join-Path ([IO.Path]::GetTempPath()) "mogaesup-web-previous-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path (Join-Path $previous 'wasm') -Force | Out-Null
  $previousIndex = Join-Path $previous 'index.html'
  $previousRelease = Join-Path $previous 'previous-release.json'
  $previousWasm = Join-Path $previous 'wasm'
  # None on the first deploy. Windows PowerShell turns redirected stderr into errors under 'Stop'.
  $ErrorActionPreference = 'Continue'
  foreach ($pair in @(@('index.html', $previousIndex), @('release.json', $previousRelease))) {
    & aws s3 cp "$bucket/$($pair[0])" $pair[1] --region $Region --only-show-errors 2>$null
    if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $pair[1] -Force -ErrorAction SilentlyContinue }
  }
  $ErrorActionPreference = 'Stop'
  Invoke-Native aws s3 cp "$bucket/wasm" $previousWasm --recursive --region $Region --only-show-errors
  $published = $false
  function Restore-Previous {
    if (-not $published) { return }
    Write-Warning 'The published release failed its checks; putting the previous index.html and WebAssembly back.'
    if (Test-Path -LiteralPath $previousIndex) {
      if (Get-ChildItem -LiteralPath $previousWasm -File) {
        Invoke-Native aws s3 cp $previousWasm "$bucket/wasm" --recursive --region $Region --content-type application/wasm --cache-control no-cache --no-progress --only-show-errors
      }
      Invoke-Native aws s3 cp $previousIndex "$bucket/index.html" --region $Region --cache-control 'no-cache,max-age=0,must-revalidate' --content-type 'text/html; charset=utf-8' --no-progress --only-show-errors
      if (-not (Test-Path -LiteralPath $previousRelease)) {
        [IO.File]::WriteAllText($previousRelease, '{"git_commit":null}', (New-Object System.Text.UTF8Encoding $false))
      }
      Invoke-Native aws s3 cp $previousRelease "$bucket/release.json" --region $Region --cache-control no-cache --content-type 'application/json' --no-progress --only-show-errors
      Invoke-Native aws cloudfront create-invalidation --distribution-id $outputs.DistributionId '--paths=/*' --output json | Out-Null
    } else {
      Write-Warning 'There was no previous index.html to put back.'
    }
  }
  try {
    $published = $true
    # The WebAssembly keeps its name across engine releases. It goes up without a cache lifetime, so browsers and (with
    # the stack's StaticRevalidateCachePolicy) the edges ask whether it changed; unchanged bytes change nothing.
    Invoke-Native aws s3 cp (Join-Path $dist 'wasm') "$bucket/wasm" --recursive --region $Region --content-type application/wasm --cache-control no-cache --no-progress --only-show-errors
    Invoke-Native aws s3 cp (Join-Path $dist 'index.html') "$bucket/index.html" --region $Region --cache-control 'no-cache,max-age=0,must-revalidate' --content-type 'text/html; charset=utf-8' --no-progress --only-show-errors
    # Which commit the site runs (also for a deploy made by hand).
    $releaseFile = Join-Path $previous 'release.json'
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($releaseFile, (([ordered]@{ git_commit = $releaseCommit; deployed_at = (Get-Date).ToUniversalTime().ToString('o'); by = $(if ($inPipeline) { 'pipeline' } else { 'manual' }) }) | ConvertTo-Json -Compress), $utf8)
    Invoke-Native aws s3 cp $releaseFile "$bucket/release.json" --region $Region --cache-control no-cache --content-type 'application/json' --no-progress --only-show-errors

    $invalidation = Invoke-Native aws cloudfront create-invalidation --distribution-id $outputs.DistributionId '--paths=/*' --output json | ConvertFrom-Json
    # index.html is served without caching; the wait covers the edges' older models and engine files. One that runs out
    # leaves the checks below to decide.
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
  } catch {
    $failure = $_
    try { Restore-Previous } catch { Write-Warning "The previous release could not be put back: $_" }
    throw $failure
  } finally {
    Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Deployed and verified: $site $releaseCommit (invalidation $($invalidation.Invalidation.Id))"
} finally {
  Pop-Location
}
