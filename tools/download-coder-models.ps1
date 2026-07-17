param(
  [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
if (-not $Destination) {
  $Destination = Join-Path $workspaceRoot 'runtime\coder\models'
}
$hf = Join-Path $workspaceRoot 'oscar\.venv\Scripts\hf.exe'
if (-not (Test-Path -LiteralPath $hf -PathType Leaf)) {
  throw "Hugging Face CLI not found at $hf"
}

$drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($Destination).TrimEnd(':\'))
if ($drive.Free -lt 36GB) {
  throw "Coder models need at least 36 GB free on $($drive.Name):; available: $([math]::Round($drive.Free / 1GB, 1)) GB"
}

$workspaceDrive = [System.IO.Path]::GetPathRoot($workspaceRoot)
$dataRoot = Join-Path $workspaceDrive 'MonarchData'
$env:HF_HOME = Join-Path $dataRoot 'HuggingFace'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:HF_HUB_DISABLE_XET = '1'
$env:HF_HUB_ENABLE_HF_TRANSFER = '0'
$env:HF_HUB_DOWNLOAD_TIMEOUT = '60'
$env:HF_HUB_ETAG_TIMEOUT = '30'
$env:XDG_CACHE_HOME = Join-Path $dataRoot 'Cache'
$env:TEMP = Join-Path $workspaceRoot 'tmp'
$env:TMP = $env:TEMP

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
New-Item -ItemType Directory -Path $env:HF_HOME -Force | Out-Null
New-Item -ItemType Directory -Path $env:HUGGINGFACE_HUB_CACHE -Force | Out-Null
New-Item -ItemType Directory -Path $env:XDG_CACHE_HOME -Force | Out-Null
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null

$models = @(
  @{
    Repo = 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF'
    File = 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'
    Directory = 'qwen3-coder-30b-a3b-instruct'
    Bytes = 18556689568
  },
  @{
    Repo = 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF'
    File = 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf'
    Directory = 'deepseek-coder-v2-lite-instruct'
    Bytes = 10364416768
  }
)

foreach ($model in $models) {
  $localDirectory = Join-Path $Destination $model.Directory
  $target = Join-Path $localDirectory $model.File
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $stream = [System.IO.File]::OpenRead($target)
    try {
      $header = New-Object byte[] 4
      [void]$stream.Read($header, 0, 4)
    } finally {
      $stream.Dispose()
    }
    $length = (Get-Item -LiteralPath $target).Length
    if ([System.Text.Encoding]::ASCII.GetString($header) -eq 'GGUF' -and $length -eq $model.Bytes) {
      Write-Output "READY $target"
      continue
    }
    throw "Existing model is incomplete or invalid: $target ($length / $($model.Bytes) bytes)"
  }
  New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
  Write-Output "DOWNLOADING $($model.Repo) $($model.File)"
  & $hf download $model.Repo $model.File --local-dir $localDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "Hugging Face download failed for $($model.Repo)"
  }
  $stream = [System.IO.File]::OpenRead($target)
  try {
    $header = New-Object byte[] 4
    [void]$stream.Read($header, 0, 4)
  } finally {
    $stream.Dispose()
  }
  if ([System.Text.Encoding]::ASCII.GetString($header) -ne 'GGUF') {
    throw "Downloaded file is not a valid GGUF: $target"
  }
  $length = (Get-Item -LiteralPath $target).Length
  if ($length -ne $model.Bytes) {
    throw "Downloaded model has an unexpected size: $target ($length / $($model.Bytes) bytes)"
  }
  Write-Output "READY $target"
}

Write-Output 'CODER MODELS READY'
