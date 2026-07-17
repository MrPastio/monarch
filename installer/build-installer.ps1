param(
  [string]$SourceRoot = "",
  [string]$OutputDirectory = "",
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

try {
  if (-not (Test-Path -LiteralPath (Join-Path $root "package.json") -PathType Leaf)) {
    throw "Invalid Monarch source root: $root"
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

  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $definition = Join-Path $root "installer\Monarch.iss"
  & $iscc "/DSourceRoot=$root" "/DOutputDir=$output" $definition
  if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed."
  }

  $setup = Join-Path $output "Monarch-Setup.exe"
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw "Installer output is missing: $setup"
  }
  $hash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash
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
