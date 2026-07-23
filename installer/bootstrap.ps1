param(
  [string]$InstallDirectory = "",
  [string]$InstallRoot = "",
  [string]$AppVersion = "0.2.3.4",
  [string]$RuntimeVersion = "2026.07.1",
  [string]$BackendEnvironment = "backend-0.1.5",
  [int]$DataSchemaVersion = 1,
  [int]$MinimumReadableDataSchema = 1,
  [int]$MaximumReadableDataSchema = 1,
  [int]$MinimumModelCatalogSchema = 1,
  [int]$MaximumModelCatalogSchema = 1,
  [string]$PayloadRoot = "",
  [switch]$CpuOnly,
  [switch]$SkipOscar,
  [switch]$SkipSecurity,
  [switch]$InstallSmallModel,
  [switch]$InstallVoiceStt,
  [switch]$InstallVoiceTts,
  [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = if ($InstallDirectory) {
  [System.IO.Path]::GetFullPath($InstallDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))
}
$appRoot = if ($InstallRoot) {
  [System.IO.Path]::GetFullPath($InstallRoot)
} else {
  $root
}
$installerLogRoot = Join-Path $appRoot "installer-logs"
try {
  New-Item -ItemType Directory -Path $installerLogRoot -Force | Out-Null
  $installerLogStamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $installerLogPath = Join-Path $installerLogRoot "bootstrap-$AppVersion-$installerLogStamp.log"
  Start-Transcript -LiteralPath $installerLogPath -Force | Out-Null
  Write-Host "Installer log: $installerLogPath"
} catch {
  Write-Warning "Unable to start installer transcript: $($_.Exception.Message)"
}

if ($env:OS -ne "Windows_NT") {
  throw "Monarch installer supports Windows only."
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Monarch requires 64-bit Windows."
}
$windowsVersionKey = Get-ItemProperty `
  -LiteralPath "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$windowsMajorProperty = $windowsVersionKey.PSObject.Properties["CurrentMajorVersionNumber"]
$windowsMajor = if ($windowsMajorProperty) {
  [int]$windowsMajorProperty.Value
} else {
  [Environment]::OSVersion.Version.Major
}
if ($windowsMajor -lt 10) {
  throw "Monarch requires Windows 10 or Windows 11 (64-bit)."
}
$windowsBuildProperty = $windowsVersionKey.PSObject.Properties["CurrentBuildNumber"]
$windowsBuild = if ($windowsBuildProperty) { $windowsBuildProperty.Value } else { "unknown" }
Write-Host "Windows 10/11 x64 ready (build $windowsBuild)"
if (-not (Test-Path -LiteralPath (Join-Path $root "package.json") -PathType Leaf)) {
  throw "Monarch source root is invalid: $root"
}

. (Join-Path $root "installer\layout.ps1")
$layout = if ($InstallRoot) {
  Initialize-MonarchInstallLayout `
    -InstallRoot $appRoot `
    -VersionRoot $root `
    -AppVersion $AppVersion `
    -RuntimeVersion $RuntimeVersion `
    -BackendEnvironment $BackendEnvironment `
    -PayloadRoot $PayloadRoot
} else {
  foreach ($relativeDirectory in @(
    "artifacts\generated",
    "data\local",
    "logs",
    "runtime",
    "secrets",
    "tmp"
  )) {
    New-Item -ItemType Directory -Path (Join-Path $root $relativeDirectory) -Force | Out-Null
  }
  [ordered]@{ payloadRoot = $root }
}
if ($InstallRoot) {
  $env:MONARCH_CONFIG_ROOT = [string]$layout.configRoot
  $env:MONARCH_DATA_ROOT = [string]$layout.dataRoot
  $env:MONARCH_LOGS_ROOT = [string]$layout.logsRoot
  $oscarConfigDirectory = Join-Path $layout.configRoot "config\oscar"
  $oscarConfigPath = Join-Path $oscarConfigDirectory ".env"
  if (-not (Test-Path -LiteralPath $oscarConfigPath -PathType Leaf)) {
    New-Item -ItemType Directory -Path $oscarConfigDirectory -Force | Out-Null
    $legacyOscarConfig = Join-Path $root "oscar\.env"
    $oscarConfigSource = if (Test-Path -LiteralPath $legacyOscarConfig -PathType Leaf) {
      $legacyOscarConfig
    } else {
      Join-Path $root "oscar\.env.example"
    }
    Copy-Item -LiteralPath $oscarConfigSource -Destination $oscarConfigPath
  }
}

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor DarkYellow
}

function Assert-NativeSuccess {
  param([Parameter(Mandatory = $true)][string]$Operation)
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

function Refresh-ProcessPath {
  param([string[]]$Prepend = @())

  $segments = New-Object System.Collections.Generic.List[string]
  $seen = New-Object System.Collections.Generic.HashSet[string](
    [StringComparer]::OrdinalIgnoreCase
  )
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")

  foreach ($pathValue in @($Prepend) + @($env:PATH, $userPath, $machinePath)) {
    if (-not $pathValue) {
      continue
    }
    foreach ($segment in ([string]$pathValue -split ";")) {
      $trimmed = $segment.Trim()
      if ($trimmed -and $seen.Add($trimmed)) {
        $segments.Add($trimmed)
      }
    }
  }
  $env:PATH = [string]::Join(";", $segments)
}

function Get-Python311RegistryCandidates {
  $registryRoots = @(
    "Registry::HKEY_CURRENT_USER\Software\Python\PythonCore",
    "Registry::HKEY_LOCAL_MACHINE\Software\Python\PythonCore",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Python\PythonCore"
  )

  foreach ($registryRoot in $registryRoots) {
    if (-not (Test-Path -LiteralPath $registryRoot)) {
      continue
    }
    foreach ($versionKey in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
      if ($versionKey.PSChildName -notmatch '^3\.11(?:-|$)') {
        continue
      }
      $installPathKey = "$($versionKey.PSPath)\InstallPath"
      if (-not (Test-Path -LiteralPath $installPathKey)) {
        continue
      }
      $installPath = Get-Item -LiteralPath $installPathKey
      $properties = Get-ItemProperty -LiteralPath $installPathKey
      $executableProperty = $properties.PSObject.Properties["ExecutablePath"]
      if ($executableProperty -and $executableProperty.Value) {
        $executableProperty.Value
      }
      $defaultPath = $installPath.GetValue("")
      if ($defaultPath) {
        Join-Path ([string]$defaultPath) "python.exe"
      }
    }
  }
}

function Resolve-Python311 {
  $launcherCandidates = @()
  $pathLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($pathLauncher) {
    $launcherCandidates += $pathLauncher.Source
  }
  $launcherCandidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Launcher\py.exe"),
    (Join-Path $env:WINDIR "py.exe")
  )

  foreach ($launcher in $launcherCandidates | Select-Object -Unique) {
    if (-not $launcher -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
      continue
    }
    try {
      $resolvedOutput = @(& $launcher -3.11 -c "import sys; print(sys.executable)" 2>$null)
      $resolveExitCode = $LASTEXITCODE
      $resolved = $resolvedOutput | Select-Object -First 1
      if ($resolveExitCode -eq 0 -and $resolved -and
          (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($resolved)
      }
    } catch {
    }
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
    (Join-Path $env:ProgramFiles "Python311\python.exe")
  )
  $candidates += @(Get-Python311RegistryCandidates)
  $pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pathPython) {
    $candidates += $pathPython.Source
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      continue
    }
    try {
      $versionOutput = @(& $candidate -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null)
      $versionExitCode = $LASTEXITCODE
      $version = $versionOutput | Select-Object -First 1
      if ($versionExitCode -eq 0 -and $version -eq "3.11") {
        return [System.IO.Path]::GetFullPath($candidate)
      }
    } catch {
    }
  }
  return $null
}

function Install-Python311 {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Python 3.11 is missing and winget is unavailable. Install Python 3.11, then rerun the installer."
  }
  Write-Step "Installing Python 3.11 for the current user"
  & $winget.Source install --id Python.Python.3.11 --exact --source winget --silent --scope user `
    --accept-package-agreements --accept-source-agreements --disable-interactivity
  Assert-NativeSuccess "Python 3.11 installation"
}

function Assert-ElectronRuntime {
  param([Parameter(Mandatory = $true)][string]$Root)

  $electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw "Electron installation is incomplete: $electron is missing. Check npm proxy or download settings and rerun the installer."
  }
  $electronProcess = Start-Process -FilePath $electron -ArgumentList "--version" `
    -Wait -PassThru -NoNewWindow
  if ($electronProcess.ExitCode -ne 0) {
    throw "Electron runtime validation failed with exit code $($electronProcess.ExitCode)."
  }
  $electronVersionFile = Join-Path $Root "node_modules\electron\dist\version"
  $electronVersion = if (Test-Path -LiteralPath $electronVersionFile -PathType Leaf) {
    (Get-Content -LiteralPath $electronVersionFile -Raw).Trim()
  } else {
    $null
  }
  if (-not $electronVersion) {
    throw "Electron runtime validation returned no version."
  }
  Write-Host "Electron ready: $electronVersion"
}

function Install-ElectronRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
  if (Test-Path -LiteralPath $electron -PathType Leaf) {
    return
  }
  $electronInstaller = Join-Path $Root "node_modules\electron\install.js"
  if (-not (Test-Path -LiteralPath $electronInstaller -PathType Leaf)) {
    throw "Electron package installer is missing: $electronInstaller"
  }

  Write-Step "Installing Electron desktop runtime"
  $previousPlatform = $env:ELECTRON_INSTALL_PLATFORM
  $previousArchitecture = $env:ELECTRON_INSTALL_ARCH
  try {
    $env:ELECTRON_INSTALL_PLATFORM = "win32"
    $env:ELECTRON_INSTALL_ARCH = "x64"
    & $Node $electronInstaller
    Assert-NativeSuccess "Electron runtime installation"
  } finally {
    $env:ELECTRON_INSTALL_PLATFORM = $previousPlatform
    $env:ELECTRON_INSTALL_ARCH = $previousArchitecture
  }
}

function Ensure-Venv {
  param(
    [Parameter(Mandatory = $true)][string]$Python,
    [Parameter(Mandatory = $true)][string]$Venv
  )
  $venvPython = Join-Path $Venv "Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    & $Python -m venv $Venv
    Assert-NativeSuccess "Python virtual environment creation"
  }
}

Set-Location $root

Write-Step "Preparing isolated Node.js runtime"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\ensure-node.ps1") `
  -Install -Quiet
Assert-NativeSuccess "Node.js runtime setup"

$nodeVersion = (Get-Content -LiteralPath (Join-Path $root ".node-version") -Raw).Trim()
$nodeDirectory = Join-Path $root ".tools\node-v$nodeVersion-win-x64"
$node = Join-Path $nodeDirectory "node.exe"
$npm = Join-Path $nodeDirectory "npm.cmd"
if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or
    -not (Test-Path -LiteralPath $npm -PathType Leaf)) {
  throw "Project Node.js runtime is incomplete: $nodeDirectory"
}
$env:PATH = "$nodeDirectory;$env:PATH"

Write-Step "Installing Monarch application dependencies"
& $npm ci --no-audit --no-fund --include=dev --ignore-scripts=false --platform=win32 --arch=x64
Assert-NativeSuccess "Monarch dependency installation"
Install-ElectronRuntime -Node $node -Root $root
Assert-ElectronRuntime -Root $root

$runtimeBundle = Join-Path $root "dist\monarch-server.mjs"
if (-not (Test-Path -LiteralPath $runtimeBundle -PathType Leaf)) {
  throw "Packaged Monarch runtime is missing: $runtimeBundle"
}
& $node --check $runtimeBundle
Assert-NativeSuccess "Packaged Monarch runtime validation"
Write-Host "Packaged runtime ready: $runtimeBundle"

$python = Resolve-Python311
if (-not $python) {
  Install-Python311
  Refresh-ProcessPath -Prepend @($nodeDirectory)
  for ($attempt = 0; $attempt -lt 10 -and -not $python; $attempt += 1) {
    if ($attempt -gt 0) {
      Start-Sleep -Milliseconds 500
    }
    $python = Resolve-Python311
  }
}
if (-not $python) {
  throw "Python 3.11 installation completed, but the interpreter could not be located."
}
Write-Host "Python ready: $python"

if (-not $SkipOscar) {
  Write-Step "Installing Oscar local AI runtime"
  Ensure-Venv -Python $python -Venv (Join-Path $root "oscar\.venv")
  $oscarArguments = @{
    PythonExe = $python
    SkipFrontendInstall = $true
  }
  $hasNvidia = [bool](Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)
  if ($CpuOnly -or -not $hasNvidia) {
    $oscarArguments.CpuOnly = $true
  }
  & (Join-Path $root "oscar\scripts\install.ps1") @oscarArguments
  Assert-NativeSuccess "Oscar runtime installation"

  Write-Step "Building Oscar frontend"
  & $npm --prefix (Join-Path $root "oscar\frontend") ci --no-audit --no-fund `
    --include=dev --ignore-scripts=false --platform=win32 --arch=x64
  Assert-NativeSuccess "Oscar frontend dependency installation"
  & $npm --prefix (Join-Path $root "oscar\frontend") run build
  Assert-NativeSuccess "Oscar frontend build"
}

if (-not $SkipSecurity) {
  Write-Step "Installing Monarch Security runtime"
  Ensure-Venv -Python $python -Venv (Join-Path $root "security\.venv")
  & (Join-Path $root "security\scripts\setup_runtime.ps1") -PythonExe $python
  Assert-NativeSuccess "Monarch Security runtime installation"
}

if ($InstallSmallModel) {
  Write-Step "Installing the optional small Oscar model"
  & (Join-Path $root "oscar\scripts\download-small-model.ps1")
  Assert-NativeSuccess "Small model installation"
}

if ($InstallVoiceStt) {
  Write-Step "Installing verified Voice STT model"
  & (Join-Path $root "tools\setup-sherpa-t-one-stt.ps1")
  Assert-NativeSuccess "Voice STT model installation"
}

if ($InstallVoiceTts) {
  Write-Step "Installing optional NVIDIA Voice TTS runtime"
  & (Join-Path $root "tools\setup-neural-tts.ps1")
  Assert-NativeSuccess "Voice TTS runtime installation"
}

$manifest = [ordered]@{
  schemaVersion = 1
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
  versionRoot = $root
  payloadRoot = $layout.payloadRoot
  nodeVersion = $nodeVersion
  python = $python
  oscar = -not $SkipOscar
  security = -not $SkipSecurity
  voiceStt = [bool]$InstallVoiceStt
  voiceTts = [bool]$InstallVoiceTts
  smallModel = [bool]$InstallSmallModel
}
$manifestPath = Join-Path $appRoot "install-manifest.json"
Write-MonarchAtomicJson -Path $manifestPath -Value $manifest
if ($InstallRoot) {
  Write-MonarchVersionDescriptor `
    -VersionRoot $root `
    -AppVersion $AppVersion `
    -RuntimeVersion $RuntimeVersion `
    -BackendEnvironment $BackendEnvironment `
    -DataSchemaVersion $DataSchemaVersion `
    -MinimumReadableDataSchema $MinimumReadableDataSchema `
    -MaximumReadableDataSchema $MaximumReadableDataSchema `
    -MinimumModelCatalogSchema $MinimumModelCatalogSchema `
    -MaximumModelCatalogSchema $MaximumModelCatalogSchema | Out-Null

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
        throw "Existing data needs a bootstrap migration before schema $DataSchemaVersion can be activated."
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
}

Write-Host ""
Write-Host "Monarch installation completed." -ForegroundColor Green
Write-Host "Launcher: $(Join-Path $appRoot 'Monarch.exe')"
if (-not $NonInteractive) {
  Write-Host "Models are local, optional assets and are never committed to Git."
}
