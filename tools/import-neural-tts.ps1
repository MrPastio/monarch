param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$SourceVoiceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$source = [IO.Path]::GetFullPath($SourceVoiceRoot).TrimEnd('\')
$layout = Get-Content -LiteralPath (Join-Path $install 'install-layout.json') -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath([string]$layout.installRoot).TrimEnd('\') -ne $install) {
  throw 'The layout belongs to another installation.'
}
$payload = [IO.Path]::GetFullPath([string]$layout.payloadRoot).TrimEnd('\')
$models = [IO.Path]::GetFullPath([string]$layout.modelsRoot).TrimEnd('\')
$runtime = Join-Path $payload 'runtimes\voice\neural'
$packages = Join-Path $runtime 'python-packages'
$model = Join-Path $models 'voice\qwen3-tts-0.6b-base'
$marker = Join-Path $runtime 'monarch-neural-tts.json'
$python = Join-Path ([string]$layout.runtimeRoot) 'python\python.exe'
$sourcePackages = Join-Path $source '.venv\Lib\site-packages'
$sourceModel = Join-Path $source 'models\qwen3-tts-0.6b-base'
foreach ($required in @($python, (Join-Path $sourcePackages 'qwen_tts\__init__.py'),
  (Join-Path $sourcePackages 'torch\__init__.py'), (Join-Path $sourceModel 'model.safetensors'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required Voice component missing: $required" }
}
if (-not $runtime.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase) -or
    -not $model.StartsWith($models + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Voice destinations must remain inside the declared payload/model roots.'
}
if ((Test-Path -LiteralPath $marker) -or (Test-Path -LiteralPath $packages) -or (Test-Path -LiteralPath $model)) {
  throw 'Voice components already exist. They have been preserved; inspect them before another import.'
}
New-Item -ItemType Directory -Path $runtime,$model | Out-Null
$log = Join-Path $runtime 'import.log'

function Copy-VoiceTree {
  param([string]$From, [string]$To)
  & robocopy.exe $From $To /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NP /NFL /NDL /XD .cache __pycache__ /XF '*.pyc' "/LOG+:$log" | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Voice copy failed ($LASTEXITCODE). Partial files are retained for inspection; no ready marker was published." }
}

Copy-VoiceTree $sourcePackages $packages
Copy-VoiceTree $sourceModel $model
$expectedModel = (Get-FileHash -LiteralPath (Join-Path $sourceModel 'model.safetensors') -Algorithm SHA256).Hash
$actualModel = (Get-FileHash -LiteralPath (Join-Path $model 'model.safetensors') -Algorithm SHA256).Hash
if ($expectedModel -cne $actualModel) { throw 'Copied Qwen TTS model hash mismatch.' }

$probe = @'
import json
from importlib.metadata import version
import torch, qwen_tts, faster_qwen3_tts, sounddevice
expected = {'torch':'2.11.0+cu128','qwen-tts':'0.1.1','faster-qwen3-tts':'0.3.0','sounddevice':'0.5.5'}
actual = {name:version(name) for name in expected}
assert actual == expected, actual
assert torch.cuda.is_available(), 'CUDA unavailable for the existing neural voice'
print(json.dumps({'ok':True,'versions':actual,'cuda':True}))
'@
$oldPythonPath=$env:PYTHONPATH; $oldTemp=$env:TEMP; $oldTmp=$env:TMP
$oldPyc=$env:PYTHONDONTWRITEBYTECODE; $oldHf=$env:HF_HUB_OFFLINE
try {
  $temp = Join-Path $runtime 'tmp'
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  $env:PYTHONPATH=$packages; $env:TEMP=$temp; $env:TMP=$temp
  $env:PYTHONDONTWRITEBYTECODE='1'; $env:HF_HUB_OFFLINE='1'
  $probeLines = @(& $python -B -c $probe 2>&1)
  $probeLines | Out-File -LiteralPath (Join-Path $runtime 'import-probe.log') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'The imported Voice packages failed the actual packaged Python probe. No ready marker published.' }
  $probeResult = ($probeLines | Where-Object { [string]$_ -match '^\{"ok":' } | Select-Object -Last 1) | ConvertFrom-Json
} finally {
  $env:PYTHONPATH=$oldPythonPath; $env:TEMP=$oldTemp; $env:TMP=$oldTmp
  $env:PYTHONDONTWRITEBYTECODE=$oldPyc; $env:HF_HUB_OFFLINE=$oldHf
}
$manifest = [ordered]@{
  schemaVersion=1; id='monarch-neural-tts'; pythonVersion='3.11'; packages=$probeResult.versions
  modelId='qwen3-tts-0.6b-base'; modelSha256=$actualModel.ToLowerInvariant()
  installationRoot=$install; importedAt=[DateTime]::UtcNow.ToString('o')
  source='explicit-owner-local-runtime-import'; cudaProbe=$true
}
[IO.File]::WriteAllText($marker, ($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Host "Neural Voice imported and verified: $runtime"
