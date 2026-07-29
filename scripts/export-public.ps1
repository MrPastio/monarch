param(
  [Parameter(Mandatory = $true)][string] $Destination,
  [string] $SourceRevision = 'HEAD',
  [long] $MaxSourceBytes = 5242880,
  [long] $MaxTotalSourceBytes = 134217728,
  [int] $MaxPublicFiles = 2000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath(
  (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
)
. (Join-Path $PSScriptRoot 'public-source-policy.ps1')

function Test-MonarchContainedPath {
  param(
    [Parameter(Mandatory = $true)][string] $Candidate,
    [Parameter(Mandatory = $true)][string] $Parent
  )

  $candidatePath = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $candidatePath -eq $parentPath -or
    $candidatePath.StartsWith(
      "$parentPath\",
      [System.StringComparison]::OrdinalIgnoreCase
    )
}

$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if (Test-MonarchContainedPath $destinationPath $root) {
  throw 'Public export must be outside the Monarch source tree.'
}
if (Test-Path -LiteralPath $destinationPath) {
  throw "Destination already exists. Use a new path so prior snapshots are preserved: $destinationPath"
}

$destinationParent = Split-Path -Parent $destinationPath
if ([string]::IsNullOrWhiteSpace($destinationParent)) {
  throw "Public export destination has no parent: $destinationPath"
}
if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
  throw "Public export parent must already exist: $destinationParent"
}
$destinationLeaf = [System.IO.Path]::GetFileName($destinationPath)
if ([string]::IsNullOrWhiteSpace($destinationLeaf) -or
    $destinationLeaf.EndsWith('.') -or
    $destinationLeaf.EndsWith(' ') -or
    $destinationLeaf -match '[<>:"|?*\x00-\x1f]' -or
    $destinationLeaf -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
  throw "Public export destination leaf is not safe on Windows: $destinationLeaf"
}
Assert-MonarchNoReparsePath $destinationParent
Assert-MonarchNoGitRepositoryContext $destinationParent

$plan = New-MonarchPublicSnapshotPlan `
  $root `
  $SourceRevision `
  $MaxSourceBytes `
  $MaxTotalSourceBytes `
  $MaxPublicFiles
$staging = "$destinationPath.staging-$([guid]::NewGuid().ToString('N'))"
if (Test-Path -LiteralPath $staging) {
  throw "Fresh staging path unexpectedly exists: $staging"
}
[System.IO.Directory]::CreateDirectory($staging) | Out-Null
Assert-MonarchNoReparsePath $staging

try {
  $manifestFiles = New-Object System.Collections.Generic.List[object]
  [long]$totalBytes = 0
  foreach ($sourceRecord in @($plan.files)) {
    $targetPath = Join-Path $staging $sourceRecord.path
    $outputRecord = Write-MonarchGitBlobToFile `
      $root `
      $sourceRecord.objectId `
      $targetPath `
      $sourceRecord.size `
      $MaxSourceBytes
    [void]$manifestFiles.Add([ordered]@{
      path = $sourceRecord.path
      mode = $sourceRecord.mode
      size = [long]$outputRecord.size
      sha256 = $outputRecord.sha256
    })
    $totalBytes += [long]$outputRecord.size
  }
  if ($totalBytes -ne [long]$plan.totalBytes) {
    throw "Exported byte total differs from preflight: $totalBytes != $($plan.totalBytes)"
  }

  $manifest = [ordered]@{
    schemaVersion = $MonarchPublicSnapshotSchemaVersion
    kind = 'monarch-public-snapshot'
    historyBoundary = 'fresh-unrelated'
    sourceRevision = $plan.sourceRevision
    policyDigest = $plan.policyDigest
    structureRegistryDigest = $plan.structureRegistryDigest
    totalFiles = $manifestFiles.Count
    totalBytes = $totalBytes
    files = $manifestFiles.ToArray()
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6
  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  Write-MonarchExclusiveSnapshotMetadata `
    -TargetPath (Join-Path $staging $MonarchPublicSnapshotMarkerName) `
    -Bytes ($strictUtf8.GetBytes($manifestJson))

  $result = Test-MonarchPublicSnapshot $staging $plan $MaxSourceBytes
  Assert-MonarchNoReparsePath $destinationParent
  Assert-MonarchNoReparsePath $staging
  if (Test-Path -LiteralPath $destinationPath) {
    throw "Destination appeared during export; staging was preserved: $staging"
  }
  [System.IO.Directory]::Move($staging, $destinationPath)
  $finalPath = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $destinationPath).Path
  )
  if ($finalPath -cne $destinationPath) {
    throw "Final public snapshot path changed during atomic publish: $finalPath"
  }
  Assert-MonarchNoReparsePath $finalPath
  $result = Test-MonarchPublicSnapshot $finalPath $plan $MaxSourceBytes

  Write-Host "Public snapshot ready: $destinationPath"
  Write-Host "Source revision: $($result.sourceRevision)"
  Write-Host "Policy digest: $($result.policyDigest)"
  Write-Host "Files: $($result.files)"
  Write-Host "Size: $([math]::Round($result.bytes / 1MB, 2)) MB"
} catch {
  $preservedPath = if (Test-Path -LiteralPath $staging) {
    $staging
  } elseif (Test-Path -LiteralPath $destinationPath) {
    $destinationPath
  } else {
    '(no generated directory exists)'
  }
  throw "$($_.Exception.Message) Automatic recursive cleanup is intentionally disabled; inspect/remove the exact preserved path manually: $preservedPath"
}
