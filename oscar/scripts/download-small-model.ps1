param(
    [string]$ModelId = "HuggingFaceTB/SmolLM2-360M-Instruct",
    [string]$Destination = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Oscar Python runtime is missing: $Python. Run .\scripts\install.ps1 first."
}

if (-not $Destination) {
    $Destination = Join-Path $Root "model-small"
}

$env:HF_HUB_DISABLE_XET = "1"

@'
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

model_id = sys.argv[1]
destination = Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)

snapshot_download(
    repo_id=model_id,
    local_dir=destination,
    ignore_patterns=[
        "*.gguf",
        "*.onnx",
        "*.tflite",
        "onnx/*",
        "openvino/*",
    ],
)
print(f"Downloaded {model_id} to {destination}")
'@ | & $Python - $ModelId $Destination
