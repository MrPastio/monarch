param(
  [Parameter(Mandatory = $true)][string]$StagingRoot,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$AppVersion = "0.1.5",
  [string]$RuntimeVersion = "2026.07.6",
  [string]$BackendEnvironment = "backend-0.1.5-offline4",
  [int]$DataSchemaVersion = 1,
  [int]$MinimumReadableDataSchema = 1,
  [int]$MaximumReadableDataSchema = 1,
  [int]$MinimumModelCatalogSchema = 1,
  [int]$MaximumModelCatalogSchema = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$staging = [System.IO.Path]::GetFullPath($StagingRoot).TrimEnd("\")
$appRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
$manifestPath = Join-Path $staging "payload-manifest.json"
$stagedApp = Join-Path $staging "app"
$stagedRuntime = Join-Path $staging "runtime"
$stagedEnvironment = Join-Path $staging "environment"
$transcriptStarted = $false

function Assert-NativeSuccess {
  param([Parameter(Mandatory = $true)][string]$Operation)
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

function Assert-CudaPayloadComplete {
  param([Parameter(Mandatory = $true)][string]$CudaRoot)

  foreach ($relativePath in @(
    "bin\ggml-cuda.dll",
    "llama_cpp\lib\llama.dll",
    "nvidia\cublas\bin\cublas64_12.dll",
    "nvidia\cublas\bin\cublasLt64_12.dll",
    "nvidia\cuda_runtime\bin\cudart64_12.dll",
    "nvidia\nvjitlink\bin\nvJitLink_120_0.dll"
  )) {
    $candidate = Join-Path $CudaRoot $relativePath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
        (Get-Item -LiteralPath $candidate).Length -le 0) {
      throw "CUDA payload is incomplete: $candidate"
    }
  }
}

function Test-NvidiaRuntimeAvailable {
  foreach ($candidate in @(
    (Join-Path $env:SystemRoot "System32\nvcuda.dll"),
    (Join-Path $env:SystemRoot "System32\nvidia-smi.exe"),
    (Join-Path $env:ProgramW6432 "NVIDIA Corporation\NVSMI\nvidia-smi.exe")
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $true
    }
  }
  return $false
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Test-ExcludedInstalledPath {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [string[]]$ExcludedPrefixes = @()
  )
  $normalized = $RelativePath.Replace("\", "/").TrimStart("/")
  foreach ($prefix in $ExcludedPrefixes) {
    $candidate = $prefix.Replace("\", "/").TrimStart("/").TrimEnd("/")
    if ($normalized.Equals($candidate, [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith("$candidate/", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-TreeRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$ExcludedPrefixes = @()
  )

  $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $records = New-Object System.Collections.Generic.List[string]
  $totalBytes = [long]0
  $files = @(
    Get-ChildItem -LiteralPath $resolved -Recurse -Force -File |
      Where-Object {
        $relative = $_.FullName.Substring($resolved.Length).TrimStart("\")
        -not (Test-ExcludedInstalledPath `
          -RelativePath $relative `
          -ExcludedPrefixes $ExcludedPrefixes)
      }
  )
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($resolved.Length).TrimStart("\").Replace("\", "/")
    $hash = Get-Sha256Hex -Path $file.FullName
    $records.Add("$relative`0$($file.Length)`0$hash`n")
    $totalBytes += $file.Length
  }
  $sortedRecords = $records.ToArray()
  [System.Array]::Sort($sortedRecords, [StringComparer]::Ordinal)
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($sortedRecords -join ""))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $treeHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  return [ordered]@{
    sha256 = $treeHash
    files = $files.Count
    size = $totalBytes
  }
}

function Assert-TreeRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Expected,
    [string[]]$ExcludedPrefixes = @()
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Offline $Name payload is missing: $Path"
  }
  $actual = Get-TreeRecord -Path $Path -ExcludedPrefixes $ExcludedPrefixes
  if ($actual.sha256 -ne [string]$Expected.sha256 -or
      $actual.files -ne [int]$Expected.files -or
      $actual.size -ne [long]$Expected.size) {
    throw "Offline $Name payload integrity verification failed."
  }
  return $actual
}

function Write-ComponentMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][object]$Record
  )

  $marker = [ordered]@{
    schemaVersion = 1
    component = $Name
    sha256 = [string]$Record.sha256
    files = [int]$Record.files
    size = [long]$Record.size
    verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Write-MonarchAtomicJson -Path (Join-Path $Path ".monarch-component.json") -Value $marker
}

function Publish-ImmutableComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][object]$Expected,
    [string[]]$InstalledExclusions = @()
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
      throw "Offline $Name payload and its immutable destination are both missing."
    }
    Assert-TreeRecord `
      -Name "existing $Name" `
      -Path $Destination `
      -Expected $Expected `
      -ExcludedPrefixes $InstalledExclusions | Out-Null
    return
  }

  Assert-TreeRecord -Name $Name -Path $Source -Expected $Expected | Out-Null
  if (Test-Path -LiteralPath $Destination) {
    Assert-TreeRecord `
      -Name "existing $Name" `
      -Path $Destination `
      -Expected $Expected `
      -ExcludedPrefixes $InstalledExclusions | Out-Null
    Remove-Item -LiteralPath $Source -Recurse -Force
    return
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Move-Item -LiteralPath $Source -Destination $Destination
  Write-ComponentMarker -Path $Destination -Name $Name -Record $Expected
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Offline payload manifest is missing: $manifestPath"
}
$payloadManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([int]$payloadManifest.schemaVersion -ne 1 -or
    [string]$payloadManifest.kind -ne "offline") {
  throw "Unsupported Monarch offline payload manifest."
}
foreach ($contract in @(
  @("appVersion", $AppVersion),
  @("runtimeVersion", $RuntimeVersion),
  @("backendEnvironment", $BackendEnvironment)
)) {
  $name = [string]$contract[0]
  $expected = [string]$contract[1]
  if ([string]$payloadManifest.$name -ne $expected) {
    throw "Offline payload $name does not match the installer contract."
  }
}

$layoutScript = if (Test-Path -LiteralPath (Join-Path $stagedApp "installer\layout.ps1") -PathType Leaf) {
  Join-Path $stagedApp "installer\layout.ps1"
} else {
  Join-Path $appRoot "versions\$AppVersion\installer\layout.ps1"
}
if (-not (Test-Path -LiteralPath $layoutScript -PathType Leaf)) {
  throw "Monarch layout helper is missing from the offline app payload."
}
. $layoutScript

$logRoot = Join-Path $appRoot "installer-logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot (
  "offline-$AppVersion-$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')).log"
)
try {
  Start-Transcript -LiteralPath $logPath -Force | Out-Null
  $transcriptStarted = $true
  Write-Host "Installer log: $logPath"
} catch {
  Write-Warning "Unable to start installer transcript: $($_.Exception.Message)"
}

try {
  Write-Host "[offline] Verifying signed payload contents"
  $payloadRoot = Resolve-MonarchPayloadRoot -InstallRoot $appRoot
  $versionRoot = Join-Path $appRoot "versions\$AppVersion"
  $runtimeRoot = Join-Path $payloadRoot "runtimes\runtime-$RuntimeVersion"
  $environmentRoot = Join-Path $payloadRoot "environments\$BackendEnvironment"
  $appDynamicPaths = @(
    ".monarch-component.json",
    "version.json",
    "gemma_models",
    "data\local",
    "logs",
    "oscar\data",
    "oscar\logs",
    "oscar\.venv",
    "security\data",
    "security\logs",
    "security\.venv",
    "artifacts\generated",
    "runtime\coder\models",
    "runtime\voice\models",
    "secrets"
  )

  Write-Host "[offline] Activating immutable versioned payload"
  Publish-ImmutableComponent `
    -Name "app" `
    -Source $stagedApp `
    -Destination $versionRoot `
    -Expected $payloadManifest.components.app `
    -InstalledExclusions $appDynamicPaths
  Publish-ImmutableComponent `
    -Name "runtime" `
    -Source $stagedRuntime `
    -Destination $runtimeRoot `
    -Expected $payloadManifest.components.runtime `
    -InstalledExclusions @(".monarch-component.json")
  Publish-ImmutableComponent `
    -Name "environment" `
    -Source $stagedEnvironment `
    -Destination $environmentRoot `
    -Expected $payloadManifest.components.environment `
    -InstalledExclusions @(".monarch-component.json")

  $layout = Initialize-MonarchInstallLayout `
    -InstallRoot $appRoot `
    -VersionRoot $versionRoot `
    -AppVersion $AppVersion `
    -RuntimeVersion $RuntimeVersion `
    -BackendEnvironment $BackendEnvironment `
    -PayloadRoot $payloadRoot

  $oscarConfigPath = Join-Path $layout.configRoot "config\oscar\.env"
  if (-not (Test-Path -LiteralPath $oscarConfigPath -PathType Leaf)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $oscarConfigPath) -Force | Out-Null
    Copy-Item `
      -LiteralPath (Join-Path $versionRoot "oscar\.env.example") `
      -Destination $oscarConfigPath
  }

  Write-Host "[offline] Validating installed runtimes without network access"
  $node = Join-Path $runtimeRoot "node\node.exe"
  $electron = Join-Path $runtimeRoot "electron\electron.exe"
  $python = Join-Path $runtimeRoot "python\python.exe"
  foreach ($required in @($node, $electron, $python)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Installed runtime is incomplete: $required"
    }
  }
  $cudaRoot = Join-Path $environmentRoot "oscar\profiles\cuda"
  Assert-CudaPayloadComplete -CudaRoot $cudaRoot
  & $node --version
  Assert-NativeSuccess "Offline Node runtime validation"
  & $electron --version
  Assert-NativeSuccess "Offline Electron runtime validation"
  $previousPythonPath = $env:PYTHONPATH
  $previousPath = $env:PATH
  $previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
  try {
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $env:PYTHONPATH = "$($environmentRoot)\oscar\common;$($environmentRoot)\oscar\profiles\cpu;$versionRoot\oscar\backend"
    & $python -B -c "import fastapi, uvicorn, llama_cpp, oscar_agent; print('installed-oscar-ok')"
    Assert-NativeSuccess "Installed Oscar runtime validation"
    $env:PYTHONPATH = "$($environmentRoot)\oscar\common;$($environmentRoot)\oscar\profiles\cuda;$versionRoot\oscar\backend"
    $env:PATH = "$($environmentRoot)\oscar\profiles\cuda\bin;$($environmentRoot)\oscar\profiles\cuda\nvidia\cublas\bin;$($environmentRoot)\oscar\profiles\cuda\nvidia\cuda_runtime\bin;$($environmentRoot)\oscar\profiles\cuda\nvidia\nvjitlink\bin;$previousPath"
    if (Test-NvidiaRuntimeAvailable) {
      & $python -B -c "import llama_cpp; print('installed-oscar-cuda-ok')"
      Assert-NativeSuccess "Installed Oscar CUDA runtime validation"
    } else {
      Write-Host "installed-oscar-cuda-payload-ok (dynamic import skipped: NVIDIA driver unavailable)"
    }
    $env:PYTHONPATH = "$($environmentRoot)\security\site-packages;$versionRoot\security\src"
    & $python -B -c "import psutil, monarch_security; print('installed-security-ok')"
    Assert-NativeSuccess "Installed Monarch Security runtime validation"
  } finally {
    $env:PYTHONPATH = $previousPythonPath
    $env:PATH = $previousPath
    $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
  }

  Write-MonarchVersionDescriptor `
    -VersionRoot $versionRoot `
    -AppVersion $AppVersion `
    -RuntimeVersion $RuntimeVersion `
    -BackendEnvironment $BackendEnvironment `
    -DataSchemaVersion $DataSchemaVersion `
    -MinimumReadableDataSchema $MinimumReadableDataSchema `
    -MaximumReadableDataSchema $MaximumReadableDataSchema `
    -MinimumModelCatalogSchema $MinimumModelCatalogSchema `
    -MaximumModelCatalogSchema $MaximumModelCatalogSchema | Out-Null

  $installManifest = [ordered]@{
    schemaVersion = 2
    installationMode = "offline"
    internetRequired = $false
    appVersion = $AppVersion
    runtimeVersion = $RuntimeVersion
    backendEnvironment = $BackendEnvironment
    dataSchemaVersion = $DataSchemaVersion
    minimumReadableDataSchema = $MinimumReadableDataSchema
    maximumReadableDataSchema = $MaximumReadableDataSchema
    minimumModelCatalogSchema = $MinimumModelCatalogSchema
    maximumModelCatalogSchema = $MaximumModelCatalogSchema
    installedAt = [DateTimeOffset]::UtcNow.ToString("o")
    installRoot = $appRoot
    versionRoot = $versionRoot
    payloadRoot = $payloadRoot
    nodeVersion = [string]$payloadManifest.nodeVersion
    pythonVersion = [string]$payloadManifest.pythonVersion
    electronVersion = [string]$payloadManifest.electronVersion
    profiles = @($payloadManifest.profiles)
    payloadBytes = (
      [long]$payloadManifest.components.app.size +
      [long]$payloadManifest.components.runtime.size +
      [long]$payloadManifest.components.environment.size
    )
    oscar = $true
    security = $true
    modelsBundled = $false
  }
  Write-MonarchAtomicJson `
    -Path (Join-Path $appRoot "install-manifest.json") `
    -Value $installManifest

  $previousVersion = ""
  $currentPointer = Join-Path $appRoot "current.json"
  if (Test-Path -LiteralPath $currentPointer -PathType Leaf) {
    try {
      $existingPointer = Get-Content -LiteralPath $currentPointer -Raw | ConvertFrom-Json
      if ($existingPointer.currentVersion -and
          $existingPointer.currentVersion -ne $AppVersion) {
        $previousVersion = [string]$existingPointer.currentVersion
      }
    } catch {
      throw "Existing current.json is invalid; refusing to replace the active version."
    }
  }
  if ($previousVersion) {
    New-MonarchPendingUpdate `
      -InstallRoot $appRoot `
      -Layout $layout `
      -PreviousVersion $previousVersion `
      -CandidateVersion $AppVersion `
      -CandidateRuntimeVersion $RuntimeVersion `
      -CandidateBackendEnvironment $BackendEnvironment `
      -CandidateDataSchemaVersion $DataSchemaVersion | Out-Null
  } else {
    $schemaPath = Join-Path $appRoot "data-schema.json"
    $schemaState = Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json
    if ([int]$schemaState.dataSchemaVersion -ne $DataSchemaVersion) {
      $existingData = @(Get-ChildItem -LiteralPath $layout.dataRoot -Force -ErrorAction SilentlyContinue)
      if ($existingData.Count -gt 0) {
        throw "Existing data needs a migration before schema $DataSchemaVersion can be activated."
      }
      Write-MonarchAtomicJson -Path $schemaPath -Value ([ordered]@{
        schemaVersion = 1
        dataSchemaVersion = $DataSchemaVersion
        updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
      })
    }
    Set-MonarchCurrentVersion `
      -InstallRoot $appRoot `
      -CurrentVersion $AppVersion
  }

  Write-Host ""
  Write-Host "Monarch offline installation completed." -ForegroundColor Green
  Write-Host "Launcher: $(Join-Path $appRoot 'Monarch.exe')"
  Write-Host "No npm, pip, winget or package registry was used on this computer."
} finally {
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
  }
}
