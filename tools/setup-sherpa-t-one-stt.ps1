param(
  [string]$ModelsRoot,
  [string]$ArchivePath,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$modelId = 'sherpa-onnx-streaming-t-one-russian-2025-09-08'
$modelVersion = '2025-09-08'
$assetName = "$modelId.tar.bz2"
$sourceUri = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2'
$expectedSha256 = 'b9c907450e99a6e5049e279bf18368a17db0bdc5e63b7fa978943138debbe3ae'
$manifestName = 'monarch-model.json'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ModelsRoot)) {
  $ModelsRoot = Join-Path $workspaceRoot 'runtime\voice\models'
}

$modelsRootFull = [System.IO.Path]::GetFullPath($ModelsRoot)
$targetDirectory = Join-Path $modelsRootFull $modelId
$targetManifestPath = Join-Path $targetDirectory $manifestName

function Test-RequiredModelFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  return (Get-Item -LiteralPath $Path).Length -gt 0
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($stream)
    return -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Test-CurrentInstall {
  if (-not (Test-RequiredModelFile (Join-Path $targetDirectory 'model.onnx'))) {
    return $false
  }
  if (-not (Test-RequiredModelFile (Join-Path $targetDirectory 'tokens.txt'))) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $targetManifestPath -PathType Leaf)) {
    return $false
  }

  try {
    $manifest = Get-Content -LiteralPath $targetManifestPath -Raw | ConvertFrom-Json
    return (
      [int]$manifest.schemaVersion -eq 1 -and
      [string]$manifest.id -ceq $modelId -and
      [string]$manifest.version -ceq $modelVersion -and
      [string]$manifest.source -ceq $sourceUri -and
      [string]$manifest.archiveSha256 -ceq $expectedSha256
    )
  } catch {
    return $false
  }
}

if (-not $Force -and (Test-CurrentInstall)) {
  Write-Host "Sherpa T-one STT is already ready: $targetDirectory"
  exit 0
}

New-Item -ItemType Directory -Force -Path $modelsRootFull | Out-Null
$workDirectory = Join-Path $modelsRootFull ('.sherpa-t-one-setup-' + [guid]::NewGuid().ToString('N'))
$workArchivePath = Join-Path $workDirectory $assetName
$extractDirectory = Join-Path $workDirectory 'extract'
$backupDirectory = Join-Path $workDirectory 'previous-model'

try {
  New-Item -ItemType Directory -Path $workDirectory, $extractDirectory | Out-Null

  if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
    [Net.ServicePointManager]::SecurityProtocol = (
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    )
    Write-Host "Downloading official sherpa-onnx asset: $sourceUri"
    Invoke-WebRequest `
      -Uri $sourceUri `
      -OutFile $workArchivePath `
      -UseBasicParsing `
      -MaximumRedirection 5 `
      -TimeoutSec 600
  } else {
    $sourceArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
    if (-not (Test-Path -LiteralPath $sourceArchivePath -PathType Leaf)) {
      throw "Local archive does not exist: $sourceArchivePath"
    }
    Copy-Item -LiteralPath $sourceArchivePath -Destination $workArchivePath
  }

  $actualSha256 = Get-FileSha256 $workArchivePath
  if (-not [string]::Equals($actualSha256, $expectedSha256, [StringComparison]::Ordinal)) {
    throw "SHA256 mismatch for $assetName. Expected $expectedSha256, got $actualSha256. Extraction was not started."
  }

  $tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $tarCommand) {
    $tarCommand = Get-Command tar -ErrorAction SilentlyContinue
  }
  if (-not $tarCommand) {
    throw 'tar.exe is required to extract the verified .tar.bz2 archive.'
  }
  $tarExecutable = $tarCommand.Source

  $archiveEntries = @(& $tarExecutable '-tf' $workArchivePath 2>&1)
  if ($LASTEXITCODE -ne 0 -or $archiveEntries.Count -eq 0) {
    throw "The verified archive could not be listed by tar.exe (exit code $LASTEXITCODE)."
  }

  foreach ($rawEntry in $archiveEntries) {
    $entry = ([string]$rawEntry).Trim().Replace('\', '/')
    while ($entry.StartsWith('./', [StringComparison]::Ordinal)) {
      $entry = $entry.Substring(2)
    }
    if ([string]::IsNullOrWhiteSpace($entry)) {
      continue
    }

    $segments = $entry.Split('/')
    $isUnsafe = (
      $entry.StartsWith('/', [StringComparison]::Ordinal) -or
      $entry -match '^[A-Za-z]:' -or
      $segments -contains '..'
    )
    $isExpectedRoot = (
      $entry -ceq $modelId -or
      $entry.StartsWith("$modelId/", [StringComparison]::Ordinal)
    )
    if ($isUnsafe -or -not $isExpectedRoot) {
      throw "Archive contains an unexpected path: $entry"
    }
  }

  & $tarExecutable '-xjf' $workArchivePath '-C' $extractDirectory | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "tar.exe failed to extract the verified archive (exit code $LASTEXITCODE)."
  }

  $stagedModelDirectory = Join-Path $extractDirectory $modelId
  $stagedModelPath = Join-Path $stagedModelDirectory 'model.onnx'
  $stagedTokensPath = Join-Path $stagedModelDirectory 'tokens.txt'
  if (-not (Test-RequiredModelFile $stagedModelPath)) {
    throw "Verified archive is missing a non-empty model.onnx: $stagedModelPath"
  }
  if (-not (Test-RequiredModelFile $stagedTokensPath)) {
    throw "Verified archive is missing a non-empty tokens.txt: $stagedTokensPath"
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    id = $modelId
    version = $modelVersion
    source = $sourceUri
    archiveSha256 = $expectedSha256
    files = [ordered]@{
      model = 'model.onnx'
      tokens = 'tokens.txt'
    }
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 3
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText(
    (Join-Path $stagedModelDirectory $manifestName),
    $manifestJson + [Environment]::NewLine,
    $utf8WithoutBom
  )

  $existingInstallMoved = $false
  try {
    if (Test-Path -LiteralPath $targetDirectory) {
      Move-Item -LiteralPath $targetDirectory -Destination $backupDirectory
      $existingInstallMoved = $true
    }
    Move-Item -LiteralPath $stagedModelDirectory -Destination $targetDirectory
  } catch {
    $deploymentError = $_
    if ($existingInstallMoved -and
        -not (Test-Path -LiteralPath $targetDirectory) -and
        (Test-Path -LiteralPath $backupDirectory)) {
      Move-Item -LiteralPath $backupDirectory -Destination $targetDirectory
    }
    throw $deploymentError
  }

  Write-Host "Sherpa T-one STT installed: $targetDirectory"
  Write-Host "Verified SHA256: $expectedSha256"
} finally {
  if (Test-Path -LiteralPath $workDirectory) {
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
  }
}
