param(
  [string]$SourceRoot = "",
  [string]$OutputDirectory = "",
  [string]$AppVersion = "0.1.5",
  [string]$RuntimeVersion = "2026.07.5",
  [string]$BackendEnvironment = "backend-0.1.5-offline4",
  [int]$DataSchemaVersion = 1,
  [int]$MinimumReadableDataSchema = 1,
  [int]$MaximumReadableDataSchema = 1,
  [int]$MinimumModelCatalogSchema = 1,
  [int]$MaximumModelCatalogSchema = 1,
  [switch]$InstallCompiler
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $installerRoot ".."))
$root = if ($SourceRoot) {
  [System.IO.Path]::GetFullPath($SourceRoot)
} else {
  $projectRoot
}
$output = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $installerRoot "out"
}
$temporarySource = $null

function Test-PrivateSource {
  param([Parameter(Mandatory = $true)][string]$Path)
  foreach ($relativePath in @(
    ".agents",
    ".codex",
    "AI_HANDOFF.md",
    "agent_notes.md",
    "ORIGINAL_REQUEST.md",
    "MARK_ALFA_FINDINGS.md",
    "design-qa.md"
  )) {
    if (Test-Path -LiteralPath (Join-Path $Path $relativePath)) {
      return $true
    }
  }
  return $false
}

if ($SourceRoot -and (Test-PrivateSource $root)) {
  throw "Refusing to package an unfiltered source tree: $root. Build from a public snapshot."
}

if (-not $SourceRoot -and (Test-PrivateSource $root)) {
  $driveRoot = [System.IO.Path]::GetPathRoot($projectRoot)
  $temporarySource = Join-Path $driveRoot ("Monarch-installer-source-" + [guid]::NewGuid().ToString("N"))
  & (Join-Path $projectRoot "scripts\export-public.ps1") -Destination $temporarySource
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create a clean installer source snapshot."
  }
  $root = $temporarySource
}

function Find-Iscc {
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  foreach ($candidate in @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }
  return $null
}

function Find-Node {
  param([Parameter(Mandatory = $true)][string[]]$Roots)

  foreach ($candidateRoot in $Roots | Select-Object -Unique) {
    $toolsRoot = Join-Path $candidateRoot ".tools"
    if (-not (Test-Path -LiteralPath $toolsRoot -PathType Container)) {
      continue
    }
    $candidate = Get-ChildItem -LiteralPath $toolsRoot -Directory |
      Where-Object { $_.Name -match '^node-v\d+\.\d+\.\d+-win-x64$' } |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "node.exe" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $root "package.json") -PathType Leaf)) {
    throw "Invalid Monarch source root: $root"
  }

  $runtimeBuildRoot = if (
    Test-Path -LiteralPath (Join-Path $root "node_modules\esbuild") -PathType Container
  ) {
    $root
  } else {
    $projectRoot
  }
  $node = Find-Node -Roots @($runtimeBuildRoot, $root, $projectRoot)
  if (-not $node) {
    throw "Node.js is required to build the packaged Monarch runtime. Run npm ci with Node 22 first."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeBuildRoot "node_modules\esbuild") -PathType Container)) {
    throw "esbuild is required to build the packaged Monarch runtime. Run npm ci first."
  }
  $electronExecutable = Join-Path $runtimeBuildRoot "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
    $electronInstaller = Join-Path $runtimeBuildRoot "node_modules\electron\install.js"
    if (-not (Test-Path -LiteralPath $electronInstaller -PathType Leaf)) {
      throw "Electron package is missing. Run npm ci first."
    }
    $electronCache = Join-Path (Split-Path -Parent $runtimeBuildRoot) ".monarch-electron-cache"
    New-Item -ItemType Directory -Path $electronCache -Force | Out-Null
    $previousElectronCache = $env:ELECTRON_CACHE
    try {
      $env:ELECTRON_CACHE = $electronCache
      & $node $electronInstaller
      if ($LASTEXITCODE -ne 0) {
        throw "Electron runtime download failed with exit code $LASTEXITCODE."
      }
    } finally {
      $env:ELECTRON_CACHE = $previousElectronCache
    }
    if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
      throw "Electron runtime is still missing after package installation: $electronExecutable"
    }
  }
  $runtimeBundle = Join-Path $root "dist\monarch-server.mjs"
  $previousBundleOutput = $env:MONARCH_RUNTIME_BUNDLE_OUTPUT
  try {
    $env:MONARCH_RUNTIME_BUNDLE_OUTPUT = $runtimeBundle
    & $node (Join-Path $runtimeBuildRoot "scripts\build-runtime-bundle.mjs")
    if ($LASTEXITCODE -ne 0) {
      throw "Monarch runtime bundle build failed."
    }
  } finally {
    $env:MONARCH_RUNTIME_BUNDLE_OUTPUT = $previousBundleOutput
  }
  if (-not (Test-Path -LiteralPath $runtimeBundle -PathType Leaf)) {
    throw "Monarch runtime bundle is missing: $runtimeBundle"
  }

  $npmCli = Join-Path (Split-Path -Parent $node) "node_modules\npm\bin\npm-cli.js"
  if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) {
    throw "The pinned Node.js runtime does not include npm-cli.js: $npmCli"
  }
  & $node $npmCli --prefix (Join-Path $runtimeBuildRoot "oscar\frontend") run build
  if ($LASTEXITCODE -ne 0) {
    throw "Oscar frontend build failed."
  }
  $builtFrontendDist = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeBuildRoot "oscar\frontend\dist")
  ).TrimEnd("\")
  $frontendDist = [System.IO.Path]::GetFullPath(
    (Join-Path $root "oscar\frontend\dist")
  ).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $builtFrontendDist -PathType Container)) {
    throw "Oscar frontend output is missing: $builtFrontendDist"
  }
  if (-not $builtFrontendDist.Equals(
    $frontendDist,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    if (Test-Path -LiteralPath $frontendDist) {
      Remove-Item -LiteralPath $frontendDist -Recurse -Force
    }
    Copy-Item `
      -LiteralPath $builtFrontendDist `
      -Destination $frontendDist `
      -Recurse `
      -Force
  }

  & (Join-Path $root "scripts\build-launcher.ps1")
  if ($LASTEXITCODE -ne 0) {
    throw "Monarch launcher build failed."
  }

  $iscc = Find-Iscc
  if (-not $iscc -and $InstallCompiler) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
      throw "Inno Setup is missing and winget is unavailable."
    }
    & $winget.Source install --id JRSoftware.InnoSetup --exact --silent `
      --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
      throw "Inno Setup installation failed."
    }
    $iscc = Find-Iscc
  }
  if (-not $iscc) {
    throw "Inno Setup 6 is required. Rerun with -InstallCompiler."
  }

  & (Join-Path $root "installer\build-offline-payload.ps1") `
    -SourceRoot $root `
    -BuildRuntimeRoot $runtimeBuildRoot `
    -OutputDirectory (Join-Path $root "installer\offline-payload") `
    -AppVersion $AppVersion `
    -RuntimeVersion $RuntimeVersion `
    -BackendEnvironment $BackendEnvironment `
    -Force
  if ($LASTEXITCODE -ne 0) {
    throw "Monarch offline payload build failed."
  }

  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $definition = Join-Path $root "installer\Monarch.iss"
  & $iscc `
    "/DSourceRoot=$root" `
    "/DOutputDir=$output" `
    "/DAppVersion=$AppVersion" `
    "/DRuntimeVersion=$RuntimeVersion" `
    "/DBackendEnvironment=$BackendEnvironment" `
    "/DDataSchemaVersion=$DataSchemaVersion" `
    "/DMinimumReadableDataSchema=$MinimumReadableDataSchema" `
    "/DMaximumReadableDataSchema=$MaximumReadableDataSchema" `
    "/DMinimumModelCatalogSchema=$MinimumModelCatalogSchema" `
    "/DMaximumModelCatalogSchema=$MaximumModelCatalogSchema" `
    $definition
  if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed."
  }

  $setup = Join-Path $output "Monarch-Setup.exe"
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw "Installer output is missing: $setup"
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($setup)
  try {
    $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
  Write-Host "Built: $setup"
  Write-Host "SHA256: $hash"
} finally {
  if ($temporarySource -and (Test-Path -LiteralPath $temporarySource)) {
    $marker = Join-Path $temporarySource ".monarch-public-snapshot"
    $resolved = (Resolve-Path -LiteralPath $temporarySource).Path
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        -not $resolved.StartsWith(
          [System.IO.Path]::GetPathRoot($projectRoot),
          [StringComparison]::OrdinalIgnoreCase
        )) {
      throw "Refusing to clean an unverified temporary installer source: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
