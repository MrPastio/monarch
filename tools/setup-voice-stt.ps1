param(
  [string]$ModelsRoot,
  [string]$RuntimeRoot,
  [string]$PythonExe,
  [string]$SherpaArchivePath,
  [string]$VoskModelArchivePath,
  [string]$FfmpegArchivePath,
  [string]$PipWheelPath,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ModelsRoot)) { $ModelsRoot = Join-Path $workspaceRoot 'runtime\voice\models' }
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Join-Path $workspaceRoot 'runtime\voice\one-shot' }
if ([string]::IsNullOrWhiteSpace($PythonExe)) {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
  if (-not $python) { throw 'Python is required for Voice STT setup.' }
  $PythonExe = $python.Source
}

$sherpaArguments = @{ ModelsRoot = $ModelsRoot; Force = $Force }
if (-not [string]::IsNullOrWhiteSpace($SherpaArchivePath)) { $sherpaArguments.ArchivePath = $SherpaArchivePath }
& (Join-Path $PSScriptRoot 'setup-sherpa-t-one-stt.ps1') @sherpaArguments
if ($LASTEXITCODE -ne 0) { throw "Sherpa T-one setup failed with exit code $LASTEXITCODE." }

$voskArguments = @{
  PythonExe = $PythonExe
  ModelsRoot = $ModelsRoot
  RuntimeRoot = $RuntimeRoot
  Force = $Force
}
if (-not [string]::IsNullOrWhiteSpace($VoskModelArchivePath)) { $voskArguments.ModelArchivePath = $VoskModelArchivePath }
if (-not [string]::IsNullOrWhiteSpace($FfmpegArchivePath)) { $voskArguments.FfmpegArchivePath = $FfmpegArchivePath }
if (-not [string]::IsNullOrWhiteSpace($PipWheelPath)) { $voskArguments.PipWheelPath = $PipWheelPath }
& (Join-Path $PSScriptRoot 'setup-vosk-telegram-stt.ps1') @voskArguments
if ($LASTEXITCODE -ne 0) { throw "Vosk one-shot setup failed with exit code $LASTEXITCODE." }

Write-Host 'Voice STT is ready: T-one streaming plus Vosk/FFmpeg one-shot.'
