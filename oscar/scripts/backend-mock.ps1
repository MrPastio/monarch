$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Port = if ($env:OSCAR_PORT) { [int]$env:OSCAR_PORT } else { 7861 }

. (Join-Path $PSScriptRoot "token.ps1")

Set-Location $Root
$env:PYTHONPATH = Join-Path $Root "backend"
$env:OSCAR_API_TOKEN = Ensure-OscarApiToken -OscarRoot $Root
$env:OSCAR_MOCK_MODEL = "1"
$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True,max_split_size_mb:128"
$env:TOKENIZERS_PARALLELISM = "false"

& $Python -m uvicorn oscar_agent.main:app --host 127.0.0.1 --port $Port
