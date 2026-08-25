param(
    [string]$ModelsRoot = "",
    [string]$Repository = "Xenova/multilingual-e5-small"
)

$ErrorActionPreference = "Stop"
$OscarRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Python = Join-Path $OscarRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Oscar Python runtime is missing: $Python. Run .\scripts\install.ps1 first."
}

if (-not $ModelsRoot) {
    $ModelsRoot = if ($env:MONARCH_MODELS_ROOT) {
        $env:MONARCH_MODELS_ROOT
    } else {
        Join-Path 'E:\' 'MonarchData\models'
    }
}

$ResolvedModelsRoot = [System.IO.Path]::GetFullPath($ModelsRoot)
$Drive = [System.IO.Path]::GetPathRoot($ResolvedModelsRoot).TrimEnd("\").ToUpperInvariant()
if ($Drive -notin @("E:", "D:")) {
    throw "Memory model downloads are allowed only on E: or D:. Resolved destination: $ResolvedModelsRoot"
}

$Destination = Join-Path $ResolvedModelsRoot "memory\multilingual-e5-small"
$HfCache = Join-Path $ResolvedModelsRoot ".hf-cache"
New-Item -ItemType Directory -Force -Path $Destination, $HfCache | Out-Null

$previousHfHome = $env:HF_HOME
$previousHfXet = $env:HF_HUB_DISABLE_XET
try {
    $env:HF_HOME = $HfCache
    $env:HF_HUB_DISABLE_XET = "1"
    @'
import sys
from pathlib import Path

try:
    from huggingface_hub import snapshot_download
except ImportError as exc:
    raise SystemExit("huggingface_hub is required in oscar/.venv for this developer setup script") from exc

repository = sys.argv[1]
destination = Path(sys.argv[2])
snapshot_download(
    repo_id=repository,
    local_dir=destination,
    allow_patterns=[
        "config.json",
        "tokenizer_config.json",
        "sentencepiece.bpe.model",
        "onnx/model_quantized.onnx",
    ],
)
required = [
    destination / "config.json",
    destination / "sentencepiece.bpe.model",
    destination / "onnx" / "model_quantized.onnx",
]
missing = [str(path) for path in required if not path.is_file()]
if missing:
    raise SystemExit(f"Memory model download is incomplete: {missing}")
total = sum(path.stat().st_size for path in destination.rglob("*") if path.is_file())
if total > 250 * 1024 * 1024:
    raise SystemExit(f"Memory model exceeds the 250 MB product budget: {total} bytes")
print(f"Memory model ready at {destination} ({total / 1024 / 1024:.2f} MiB)")
'@ | & $Python - $Repository $Destination
    if ($LASTEXITCODE -ne 0) { throw "Memory model download failed with exit code $LASTEXITCODE" }
} finally {
    $env:HF_HOME = $previousHfHome
    $env:HF_HUB_DISABLE_XET = $previousHfXet
}
