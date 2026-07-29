param(
  [string] $Snapshot = '',
  [string] $SourceRevision = 'HEAD',
  [long] $MaxSourceBytes = 5242880,
  [long] $MaxTotalSourceBytes = 134217728,
  [int] $MaxPublicFiles = 2000,
  [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath(
  (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
)
. (Join-Path $PSScriptRoot 'public-source-policy.ps1')

$temporarySnapshot = $null
$temporarySnapshotValidated = $false
$plan = $null
try {
  if ([string]::IsNullOrWhiteSpace($Snapshot)) {
    $temporarySnapshot = Join-Path (
      [System.IO.Path]::GetPathRoot($root)
    ) ("Monarch-public-gate-" + [guid]::NewGuid().ToString('N'))
    & (Join-Path $PSScriptRoot 'export-public.ps1') `
      -Destination $temporarySnapshot `
      -SourceRevision $SourceRevision `
      -MaxSourceBytes $MaxSourceBytes `
      -MaxTotalSourceBytes $MaxTotalSourceBytes `
      -MaxPublicFiles $MaxPublicFiles
    $Snapshot = $temporarySnapshot
  }
  $snapshotPath = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $Snapshot).Path
  )
  $plan = New-MonarchPublicSnapshotPlan `
    $root `
    $SourceRevision `
    $MaxSourceBytes `
    $MaxTotalSourceBytes `
    $MaxPublicFiles
  $result = Test-MonarchPublicSnapshot $snapshotPath $plan $MaxSourceBytes
  $temporarySnapshotValidated = $null -ne $temporarySnapshot

  if ($Json) {
    $result | ConvertTo-Json -Depth 4
  } else {
    Write-Host 'Monarch exact public snapshot gate'
    $result | Format-List | Out-String | Write-Host
  }
} catch {
  $snapshotDisplay = try {
    [System.IO.Path]::GetFullPath($Snapshot)
  } catch {
    [string]$Snapshot
  }
  $failure = [pscustomobject]@{
    snapshot = $snapshotDisplay
    sourceRevision = $SourceRevision
    files = 0
    bytes = 0
    violations = 1
    reason = $_.Exception.Message
  }
  if ($Json) {
    $failure | ConvertTo-Json -Depth 4
  } else {
    Write-Host 'Monarch exact public snapshot gate'
    $failure | Format-List | Out-String | Write-Host
  }
  exit 2
} finally {
  if ($temporarySnapshot -and (Test-Path -LiteralPath $temporarySnapshot)) {
    if ($temporarySnapshotValidated -and $null -ne $plan) {
      Remove-MonarchValidatedSnapshot `
        $temporarySnapshot `
        $plan `
        $MaxSourceBytes
    } else {
      Write-Warning "Disposable public snapshot was not validated and was preserved for inspection: $temporarySnapshot"
    }
  }
}
