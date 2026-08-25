param(
  [string]$CandidateRoot = "",
  [Parameter(Mandatory = $true)][string]$TrustedManifestDirectory,
  [string]$Destination = "",
  [string]$ArchivePath = "",
  [switch]$RequireCandidate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-TrustedRuntimeContract {
  param([Parameter(Mandatory = $true)][string]$Directory)

  $trustedRoot = [System.IO.Path]::GetFullPath($Directory).TrimEnd("\")
  $bundlePath = Join-Path $trustedRoot "bundle-source.json"
  $cpuPath = Join-Path $trustedRoot "llama-cpp-cpu-portable.json"
  $nativePath = Join-Path $trustedRoot "manifest.json"
  foreach ($required in @($bundlePath, $cpuPath, $nativePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Trusted runtime dependency contract is missing: $required"
    }
  }

  $bundle = Get-Content -LiteralPath $bundlePath -Raw | ConvertFrom-Json
  $cpu = Get-Content -LiteralPath $cpuPath -Raw | ConvertFrom-Json
  $native = Get-Content -LiteralPath $nativePath -Raw | ConvertFrom-Json
  if ([int]$bundle.schemaVersion -ne 1 -or
      [string]$bundle.url -notmatch '^https://github\.com/MrPastio/monarch-releases/releases/download/' -or
      [long]$bundle.size -le 0 -or
      [string]$bundle.sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Trusted runtime dependency bundle contract is invalid: $bundlePath"
  }
  if ([int]$cpu.schemaVersion -ne 1 -or
      [long]$cpu.artifact.size -le 0 -or
      [string]$cpu.artifact.sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Trusted CPU runtime contract is invalid: $cpuPath"
  }
  if ([int]$native.schemaVersion -ne 1 -or @($native.files).Count -le 0) {
    throw "Trusted native runtime contract is invalid: $nativePath"
  }

  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  foreach ($name in @("llama-cpp-cpu-portable.json", "manifest.json", [string]$cpu.artifact.name)) {
    if ([string]::IsNullOrWhiteSpace($name) -or
        $name -ne [System.IO.Path]::GetFileName($name) -or
        -not $names.Add($name)) {
      throw "Trusted runtime dependency name is invalid or duplicated: $name"
    }
  }
  foreach ($entry in @($native.files)) {
    $name = [string]$entry.name
    if ([string]::IsNullOrWhiteSpace($name) -or
        $name -ne [System.IO.Path]::GetFileName($name) -or
        [long]$entry.size -le 0 -or
        [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' -or
        -not $names.Add($name)) {
      throw "Trusted native runtime entry is invalid or duplicated: $name"
    }
  }

  return [pscustomobject]@{
    trustedRoot = $trustedRoot
    bundle = $bundle
    cpu = $cpu
    native = $native
    expectedNames = @($names)
  }
}

function Assert-VerifiedRuntimeDependencyRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)]$Contract
  )

  $resolved = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "Runtime dependency root is missing: $resolved"
  }
  $items = @(Get-ChildItem -LiteralPath $resolved -Force)
  $bundleSource = @($items | Where-Object { $_.Name -ceq "bundle-source.json" })
  if ($bundleSource.Count -gt 1) {
    throw "Runtime dependency root contains duplicate bundle contracts: $resolved"
  }
  if ($bundleSource.Count -eq 1) {
    if ($bundleSource[0].PSIsContainer -or
        ($bundleSource[0].Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        (Get-Sha256Hex -Path $bundleSource[0].FullName) -cne
          (Get-Sha256Hex -Path (Join-Path $Contract.trustedRoot "bundle-source.json"))) {
      throw "Runtime dependency bundle contract differs from the public contract."
    }
    $items = @($items | Where-Object { $_.Name -cne "bundle-source.json" })
  }
  if ($items.Count -ne @($Contract.expectedNames).Count) {
    throw "Runtime dependency root has an unexpected entry count: $resolved"
  }
  $actualNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  foreach ($item in $items) {
    if (-not $item.PSIsContainer -and
        -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
        $actualNames.Add($item.Name)) {
      continue
    }
    throw "Runtime dependency root contains a non-regular or duplicate entry: $($item.FullName)"
  }
  foreach ($name in @($Contract.expectedNames)) {
    if (-not $actualNames.Contains([string]$name)) {
      throw "Runtime dependency root is missing an exact contracted entry: $name"
    }
  }

  foreach ($manifestName in @("llama-cpp-cpu-portable.json", "manifest.json")) {
    $trusted = Join-Path $Contract.trustedRoot $manifestName
    $candidate = Join-Path $resolved $manifestName
    if ((Get-Sha256Hex -Path $candidate) -cne (Get-Sha256Hex -Path $trusted)) {
      throw "Runtime dependency manifest differs from the public contract: $manifestName"
    }
  }
  $wheel = Join-Path $resolved ([string]$Contract.cpu.artifact.name)
  if ((Get-Item -LiteralPath $wheel).Length -ne [long]$Contract.cpu.artifact.size -or
      (Get-Sha256Hex -Path $wheel) -cne [string]$Contract.cpu.artifact.sha256) {
    throw "Runtime dependency CPU wheel failed exact verification: $wheel"
  }
  foreach ($entry in @($Contract.native.files)) {
    $candidate = Join-Path $resolved ([string]$entry.name)
    if ((Get-Item -LiteralPath $candidate).Length -ne [long]$entry.size -or
        (Get-Sha256Hex -Path $candidate) -cne [string]$entry.sha256) {
      throw "Runtime dependency native file failed exact verification: $candidate"
    }
  }
  return $resolved
}

$contract = Get-TrustedRuntimeContract -Directory $TrustedManifestDirectory
if ($CandidateRoot) {
  try {
    $verifiedCandidate = Assert-VerifiedRuntimeDependencyRoot -Root $CandidateRoot -Contract $contract
    Write-Output $verifiedCandidate
    exit 0
  } catch {
    if ($RequireCandidate) {
      throw
    }
    Write-Host "[runtime-dependencies] Local candidate is incomplete; provisioning the pinned bundle."
  }
} elseif ($RequireCandidate) {
  throw "An explicit runtime dependency root is required."
}

if (-not $Destination) {
  throw "Destination is required when the local runtime dependency candidate is unavailable."
}
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination).TrimEnd("\")
if (Test-Path -LiteralPath $resolvedDestination) {
  throw "Runtime dependency destination must not already exist: $resolvedDestination"
}
$archive = if ($ArchivePath) {
  [System.IO.Path]::GetFullPath($ArchivePath)
} else {
  $archiveParent = Split-Path -Parent $resolvedDestination
  New-Item -ItemType Directory -Path $archiveParent -Force | Out-Null
  $download = Join-Path $archiveParent ("runtime-dependencies-" + [guid]::NewGuid().ToString("N") + ".zip")
  Invoke-WebRequest -Uri ([string]$contract.bundle.url) -OutFile $download -MaximumRedirection 5
  $download
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or
    (Get-Item -LiteralPath $archive).Length -ne [long]$contract.bundle.size -or
    (Get-Sha256Hex -Path $archive) -cne [string]$contract.bundle.sha256) {
  throw "Runtime dependency archive failed exact size or SHA-256 verification: $archive"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
  $archiveNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  foreach ($entry in $zip.Entries) {
    if ([string]::IsNullOrWhiteSpace($entry.Name) -or
        $entry.FullName -cne $entry.Name -or
        -not $archiveNames.Add($entry.Name)) {
      throw "Runtime dependency archive contains an unsafe or duplicate entry: $($entry.FullName)"
    }
  }
  if ($archiveNames.Count -ne @($contract.expectedNames).Count) {
    throw "Runtime dependency archive has an unexpected entry count."
  }
  foreach ($name in @($contract.expectedNames)) {
    if (-not $archiveNames.Contains([string]$name)) {
      throw "Runtime dependency archive is missing an exact contracted entry: $name"
    }
  }

  New-Item -ItemType Directory -Path $resolvedDestination | Out-Null
  foreach ($entry in $zip.Entries) {
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
      $entry,
      (Join-Path $resolvedDestination $entry.Name),
      $false
    )
  }
} finally {
  $zip.Dispose()
}

$verifiedDestination = Assert-VerifiedRuntimeDependencyRoot `
  -Root $resolvedDestination `
  -Contract $contract
Write-Output $verifiedDestination
