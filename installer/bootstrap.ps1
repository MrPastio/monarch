param(
  [string]$InstallDirectory = "",
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

if ($env:OS -ne "Windows_NT") {
  throw "Monarch installer supports Windows only."
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Monarch requires 64-bit Windows."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "package.json") -PathType Leaf)) {
  throw "Monarch source root is invalid: $root"
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

function Resolve-Python311 {
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($launcher) {
    try {
      $resolved = & $launcher.Source -3.11 -c "import sys; print(sys.executable)" 2>$null |
        Select-Object -First 1
      if ($LASTEXITCODE -eq 0 -and $resolved -and
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
  $pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pathPython) {
    $candidates += $pathPython.Source
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      continue
    }
    try {
      $version = & $candidate -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null |
        Select-Object -First 1
      if ($LASTEXITCODE -eq 0 -and $version -eq "3.11") {
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
  & $winget.Source install --id Python.Python.3.11 --exact --silent --scope user `
    --accept-package-agreements --accept-source-agreements --disable-interactivity
  Assert-NativeSuccess "Python 3.11 installation"
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

Write-Step "Preparing isolated Node.js runtime"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\ensure-node.ps1") `
  -Install -Quiet
Assert-NativeSuccess "Node.js runtime setup"

$nodeVersion = (Get-Content -LiteralPath (Join-Path $root ".node-version") -Raw).Trim()
$nodeDirectory = Join-Path $root ".tools\node-v$nodeVersion-win-x64"
$npm = Join-Path $nodeDirectory "npm.cmd"
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
  throw "Project npm runtime is missing: $npm"
}
$env:PATH = "$nodeDirectory;$env:PATH"

Write-Step "Installing Monarch application dependencies"
& $npm ci --no-audit --no-fund
Assert-NativeSuccess "Monarch dependency installation"

$python = Resolve-Python311
if (-not $python) {
  Install-Python311
  $python = Resolve-Python311
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
  & $npm --prefix (Join-Path $root "oscar\frontend") ci --no-audit --no-fund
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

Write-Step "Building Monarch launcher"
& (Join-Path $root "scripts\build-launcher.ps1")
Assert-NativeSuccess "Monarch launcher build"

$manifest = [ordered]@{
  schemaVersion = 1
  installedAt = [DateTimeOffset]::UtcNow.ToString("o")
  installRoot = $root
  nodeVersion = $nodeVersion
  python = $python
  oscar = -not $SkipOscar
  security = -not $SkipSecurity
  voiceStt = [bool]$InstallVoiceStt
  voiceTts = [bool]$InstallVoiceTts
  smallModel = [bool]$InstallSmallModel
}
$manifestPath = Join-Path $root "runtime\install-manifest.json"
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host ""
Write-Host "Monarch installation completed." -ForegroundColor Green
Write-Host "Launcher: $(Join-Path $root 'Monarch.exe')"
if (-not $NonInteractive) {
  Write-Host "Models are local, optional assets and are never committed to Git."
}
