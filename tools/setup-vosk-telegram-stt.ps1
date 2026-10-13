param(
  [Parameter(Mandatory = $true)][string]$PythonExe,
  [Parameter(Mandatory = $true)][string]$ModelsRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [string]$ModelArchivePath,
  [string]$FfmpegArchivePath,
  [string]$PipWheelPath,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$modelId = 'vosk-model-small-ru-0.22'
$modelUri = 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip'
$modelSha256 = '961d5ff98a17f4aa6de69864d0aa71fa5bac682301d2b5d17a3f24c5c99a46d4'
$ffmpegId = 'ffmpeg-8.1.1-essentials_build'
$ffmpegUri = 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip'
$ffmpegSha256 = '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541'
$ffmpegExeSha256 = '228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb'
$modelCoreSha256 = '36d67b53dc90d96ea48097f9e17e7c5937689ad76cb8bed25091317bbaf25919'
$voskDllSha256 = '9331c2f6a32cf77141af27c9750e79532718f51bbc2e3cea3c60f14ca4251e4e'
$voskVersion = '0.3.45'
$pipVersion = '25.3'
$pipAssetName = "pip-$pipVersion-py3-none-any.whl"
$pipUri = "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/$pipAssetName"
$pipSha256 = '9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd'
$manifestName = 'monarch-voice-stt.json'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$modelsRootFull = [IO.Path]::GetFullPath($ModelsRoot)
$runtimeRootFull = [IO.Path]::GetFullPath($RuntimeRoot)
$pythonFull = [IO.Path]::GetFullPath($PythonExe)
$targetModel = Join-Path $modelsRootFull $modelId
$targetPackages = Join-Path $runtimeRootFull 'python-packages'
$targetFfmpegRoot = Join-Path $runtimeRootFull $ffmpegId
$targetFfmpeg = Join-Path $targetFfmpegRoot 'bin\ffmpeg.exe'
$targetManifest = Join-Path $runtimeRootFull $manifestName

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Test-NonEmptyFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (
    (Test-Path -LiteralPath $Path -PathType Leaf) -and
    (Get-Item -LiteralPath $Path).Length -gt 0
  )
}

function Get-Archive {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$LocalPath
  )
  if ([string]::IsNullOrWhiteSpace($LocalPath)) {
    [Net.ServicePointManager]::SecurityProtocol = (
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    )
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing `
      -MaximumRedirection 5 -TimeoutSec 900
  } else {
    $source = [IO.Path]::GetFullPath($LocalPath)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Local archive does not exist: $source"
    }
    Copy-Item -LiteralPath $source -Destination $Destination
  }
  $actual = Get-FileSha256 $Destination
  if (-not [string]::Equals($actual, $ExpectedSha256, [StringComparison]::Ordinal)) {
    throw "SHA256 mismatch for $(Split-Path -Leaf $Destination). Expected $ExpectedSha256, got $actual. Extraction was not started."
  }
}

function Expand-VerifiedZip {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedRoot
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    if ($zip.Entries.Count -eq 0) { throw 'Verified ZIP archive is empty.' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      $segments = $name.Split('/')
      if ($name.StartsWith('/', [StringComparison]::Ordinal) -or
          $name -match '^[A-Za-z]:' -or
          $segments -contains '..' -or
          -not ($name -ceq "$ExpectedRoot/" -or $name.StartsWith("$ExpectedRoot/", [StringComparison]::Ordinal))) {
        throw "Archive contains an unexpected path: $name"
      }
    }
  } finally {
    $zip.Dispose()
  }
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
}

function Test-CurrentInstall {
  if (-not (Test-NonEmptyFile (Join-Path $targetModel 'am\final.mdl')) -or
      -not (Test-NonEmptyFile (Join-Path $targetModel 'conf\model.conf')) -or
      -not (Test-NonEmptyFile $targetFfmpeg) -or
      -not (Test-Path -LiteralPath (Join-Path $targetPackages 'vosk\__init__.py') -PathType Leaf) -or
      -not (Test-Path -LiteralPath $targetManifest -PathType Leaf)) {
    return $false
  }
  try {
    $manifest = Get-Content -LiteralPath $targetManifest -Raw | ConvertFrom-Json
    return (
      [int]$manifest.schemaVersion -eq 1 -and
      [string]$manifest.model.id -ceq $modelId -and
      [string]$manifest.model.archiveSha256 -ceq $modelSha256 -and
      [string]$manifest.ffmpeg.id -ceq $ffmpegId -and
      [string]$manifest.ffmpeg.archiveSha256 -ceq $ffmpegSha256 -and
      [string]$manifest.python.package -ceq "vosk==$voskVersion" -and
      (Get-FileSha256 (Join-Path $targetModel 'am\final.mdl')) -ceq $modelCoreSha256 -and
      (Get-FileSha256 $targetFfmpeg) -ceq $ffmpegExeSha256 -and
      (Get-FileSha256 (Join-Path $targetPackages 'vosk\libvosk.dll')) -ceq $voskDllSha256
    )
  } catch {
    return $false
  }
}

if (-not (Test-NonEmptyFile $pythonFull)) {
  throw "Python executable does not exist: $pythonFull"
}
if (-not $Force -and (Test-CurrentInstall)) {
  Write-Host "Telegram/Vosk one-shot STT is already ready: $runtimeRootFull"
  exit 0
}

New-Item -ItemType Directory -Path $modelsRootFull,$runtimeRootFull -Force | Out-Null
$work = Join-Path $runtimeRootFull ('.vosk-telegram-setup-' + [guid]::NewGuid().ToString('N'))
$modelZip = Join-Path $work "$modelId.zip"
$ffmpegZip = Join-Path $work "$ffmpegId.zip"
$pipWheel = Join-Path $work $pipAssetName
$modelExtract = Join-Path $work 'model-extract'
$ffmpegExtract = Join-Path $work 'ffmpeg-extract'
$stagedPackages = Join-Path $work 'python-packages'
$backupModel = Join-Path $work 'previous-model'
$backupPackages = Join-Path $work 'previous-python-packages'
$backupFfmpeg = Join-Path $work 'previous-ffmpeg'
$backupManifest = Join-Path $work 'previous-manifest.json'

try {
  New-Item -ItemType Directory -Path $work,$modelExtract,$ffmpegExtract,$stagedPackages | Out-Null
  Write-Host 'Acquiring pinned Russian Vosk model.'
  Get-Archive -Uri $modelUri -ExpectedSha256 $modelSha256 -Destination $modelZip -LocalPath $ModelArchivePath
  Expand-VerifiedZip -Archive $modelZip -Destination $modelExtract -ExpectedRoot $modelId
  $stagedModel = Join-Path $modelExtract $modelId
  if (-not (Test-NonEmptyFile (Join-Path $stagedModel 'am\final.mdl')) -or
      -not (Test-NonEmptyFile (Join-Path $stagedModel 'conf\model.conf'))) {
    throw 'Verified Vosk archive is missing its required model files.'
  }
  if ((Get-FileSha256 (Join-Path $stagedModel 'am\final.mdl')) -ne $modelCoreSha256) {
    throw 'Verified Vosk archive produced an unexpected acoustic-model component.'
  }

  Write-Host 'Acquiring pinned local FFmpeg decoder.'
  Get-Archive -Uri $ffmpegUri -ExpectedSha256 $ffmpegSha256 -Destination $ffmpegZip -LocalPath $FfmpegArchivePath
  Expand-VerifiedZip -Archive $ffmpegZip -Destination $ffmpegExtract -ExpectedRoot $ffmpegId
  $stagedFfmpegRoot = Join-Path $ffmpegExtract $ffmpegId
  $stagedFfmpeg = Join-Path $stagedFfmpegRoot 'bin\ffmpeg.exe'
  if (-not (Test-NonEmptyFile $stagedFfmpeg) -or
      -not (Test-NonEmptyFile (Join-Path $stagedFfmpegRoot 'LICENSE'))) {
    throw 'Verified FFmpeg archive is missing ffmpeg.exe or its license.'
  }
  if ((Get-FileSha256 $stagedFfmpeg) -ne $ffmpegExeSha256) {
    throw 'Verified FFmpeg archive produced an unexpected executable component.'
  }
  $versionOutput = @(& $stagedFfmpeg -version 2>&1)
  if ($LASTEXITCODE -ne 0 -or ($versionOutput -join "`n") -notmatch '^ffmpeg version 8\.1\.1') {
    throw 'Verified FFmpeg executable failed its version probe.'
  }

  Write-Host "Acquiring pinned ephemeral pip $pipVersion runner."
  Get-Archive -Uri $pipUri -ExpectedSha256 $pipSha256 -Destination $pipWheel -LocalPath $PipWheelPath

  Write-Host "Installing vosk==$voskVersion into the isolated Voice runtime."
  $pipTemp = Join-Path $work 'pip-temp'
  $pipCache = Join-Path $work 'pip-cache'
  New-Item -ItemType Directory -Path $pipTemp,$pipCache | Out-Null
  $previousTemp = $env:TEMP; $previousTmp = $env:TMP; $previousPipCache = $env:PIP_CACHE_DIR
  $previousPythonPath = $env:PYTHONPATH
  try {
    $env:TEMP = $pipTemp; $env:TMP = $pipTemp; $env:PIP_CACHE_DIR = $pipCache
    # Portable packaged Python intentionally has no installed pip. Execute the
    # pinned wheel directly from PYTHONPATH, without mutating the shared runtime.
    $env:PYTHONPATH = $pipWheel
    & $pythonFull -B -m pip install --disable-pip-version-check --no-input --no-compile `
      --upgrade --only-binary=vosk,cffi,charset-normalizer `
      --constraint (Join-Path $workspaceRoot 'oscar\requirements-runtime-lock.txt') `
      --target $stagedPackages "vosk==$voskVersion"
    if ($LASTEXITCODE -ne 0) { throw "Vosk package installation failed with exit code $LASTEXITCODE." }
  } finally {
    $env:TEMP = $previousTemp; $env:TMP = $previousTmp; $env:PIP_CACHE_DIR = $previousPipCache
    $env:PYTHONPATH = $previousPythonPath
  }
  if ((Get-FileSha256 (Join-Path $stagedPackages 'vosk\libvosk.dll')) -ne $voskDllSha256) {
    throw 'Pinned Vosk wheel produced an unexpected native runtime component.'
  }
  $previousPythonPath = $env:PYTHONPATH
  try {
    $env:PYTHONPATH = $stagedPackages
    & $pythonFull -B -c "import vosk; print('vosk-runtime-ok')"
    if ($LASTEXITCODE -ne 0) { throw 'Isolated Vosk import probe failed.' }
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    model = [ordered]@{ id = $modelId; source = $modelUri; archiveSha256 = $modelSha256; coreSha256 = $modelCoreSha256; license = 'Apache-2.0' }
    ffmpeg = [ordered]@{ id = $ffmpegId; source = $ffmpegUri; archiveSha256 = $ffmpegSha256; executableSha256 = $ffmpegExeSha256; license = 'GPL-3.0' }
    python = [ordered]@{
      package = "vosk==$voskVersion"
      nativeSha256 = $voskDllSha256
      relativePackagesRoot = 'python-packages'
      installer = [ordered]@{ package = "pip==$pipVersion"; wheelSha256 = $pipSha256; persisted = $false }
    }
  }
  $stagedManifest = Join-Path $work $manifestName
  [IO.File]::WriteAllText(
    $stagedManifest,
    ($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )

  $movedModel = $false; $movedPackages = $false; $movedFfmpeg = $false; $movedManifest = $false
  try {
    if (Test-Path -LiteralPath $targetModel) { Move-Item -LiteralPath $targetModel -Destination $backupModel; $movedModel = $true }
    if (Test-Path -LiteralPath $targetPackages) { Move-Item -LiteralPath $targetPackages -Destination $backupPackages; $movedPackages = $true }
    if (Test-Path -LiteralPath $targetFfmpegRoot) { Move-Item -LiteralPath $targetFfmpegRoot -Destination $backupFfmpeg; $movedFfmpeg = $true }
    if (Test-Path -LiteralPath $targetManifest) { Move-Item -LiteralPath $targetManifest -Destination $backupManifest; $movedManifest = $true }
    Move-Item -LiteralPath $stagedModel -Destination $targetModel
    Move-Item -LiteralPath $stagedPackages -Destination $targetPackages
    Move-Item -LiteralPath $stagedFfmpegRoot -Destination $targetFfmpegRoot
    Move-Item -LiteralPath $stagedManifest -Destination $targetManifest
  } catch {
    Remove-Item -LiteralPath $targetModel,$targetPackages,$targetFfmpegRoot,$targetManifest -Recurse -Force -ErrorAction SilentlyContinue
    if ($movedModel) { Move-Item -LiteralPath $backupModel -Destination $targetModel }
    if ($movedPackages) { Move-Item -LiteralPath $backupPackages -Destination $targetPackages }
    if ($movedFfmpeg) { Move-Item -LiteralPath $backupFfmpeg -Destination $targetFfmpegRoot }
    if ($movedManifest) { Move-Item -LiteralPath $backupManifest -Destination $targetManifest }
    throw
  }

  Write-Host "Telegram/Vosk one-shot STT installed: $runtimeRootFull"
  Write-Host "Model: $targetModel"
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
