param(
  [string]$SourceRoot = "",
  [string]$OutputDirectory = "",
  [switch]$InstallCompiler
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = if ($SourceRoot) {
  [System.IO.Path]::GetFullPath($SourceRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $installerRoot ".."))
}
$output = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $installerRoot "out"
}

if (-not (Test-Path -LiteralPath (Join-Path $root "package.json") -PathType Leaf)) {
  throw "Invalid Monarch source root: $root"
}

& (Join-Path $root "scripts\build-launcher.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Monarch launcher build failed."
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
$definition = Join-Path $installerRoot "Monarch.iss"
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
