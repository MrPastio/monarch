param(
  [switch]$SkipModelDownload
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$voiceRoot = Join-Path $workspaceRoot 'runtime\voice'
$venvRoot = Join-Path $voiceRoot '.venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$modelRoot = Join-Path $voiceRoot 'models\qwen3-tts-0.6b-base'
$tempRoot = Join-Path $voiceRoot 'tmp'
$pipCache = Join-Path $voiceRoot 'pip-cache'
$hfHome = Join-Path $voiceRoot 'hf-cache'
$voiceReferences = @(
  (Join-Path $workspaceRoot 'assets\voice\oscar-reference.wav'),
  (Join-Path $workspaceRoot 'assets\voice\oscar-clear-reference.wav'),
  (Join-Path $workspaceRoot 'assets\voice\aurora-reference.wav')
)

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  throw 'Для realtime Qwen3-TTS нужна NVIDIA GPU с актуальным драйвером.'
}

foreach ($voiceReference in $voiceReferences) {
  if (-not (Test-Path -LiteralPath $voiceReference)) {
    throw "В репозитории отсутствует синтетический эталон голоса: $voiceReference"
  }
}

New-Item -ItemType Directory -Force -Path $voiceRoot, $tempRoot, $pipCache, $hfHome | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:PIP_CACHE_DIR = $pipCache
$env:HF_HOME = $hfHome
$env:HF_HUB_CACHE = Join-Path $hfHome 'hub'
$env:HUGGINGFACE_HUB_CACHE = $env:HF_HUB_CACHE

if (-not (Test-Path -LiteralPath $venvPython)) {
  $bootstrapPython = Join-Path $workspaceRoot 'oscar\.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $bootstrapPython)) {
    $bootstrapPython = (Get-Command python -ErrorAction Stop).Source
  }
  & $bootstrapPython -m venv $venvRoot
}

& $venvPython -m pip install --upgrade pip wheel 'setuptools<82'
& $venvPython -m pip install --upgrade --force-reinstall `
  'torch==2.11.0+cu128' `
  'torchaudio==2.11.0+cu128' `
  --index-url 'https://download.pytorch.org/whl/cu128'
& $venvPython -m pip install --upgrade `
  'qwen-tts==0.1.1' `
  'faster-qwen3-tts==0.3.0' `
  'sounddevice==0.5.5'

if (-not $SkipModelDownload) {
  $hfCli = Join-Path $venvRoot 'Scripts\hf.exe'
  & $hfCli download 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' --local-dir $modelRoot
}

& $venvPython -c "import torch; assert torch.cuda.is_available(), 'CUDA unavailable'; print(f'Qwen3-TTS runtime ready: {torch.cuda.get_device_name(0)} / {torch.__version__}')"
Write-Host "Model: $modelRoot"
Write-Host 'Monarch прогреет CUDA-графы автоматически при следующем запуске Desktop.'
