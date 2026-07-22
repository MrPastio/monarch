param(
    [switch]$CpuOnly,
    [switch]$SkipTorch,
    [switch]$SkipFrontendInstall,
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

Set-Location $Root

function Assert-CommandSuccess {
    param([Parameter(Mandatory = $true)][string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $VenvPython)) {
    if (-not $PythonExe) {
        $PythonExe = (& py -3.11 -c "import sys; print(sys.executable)" | Select-Object -First 1)
    }
    if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        throw "Python 3.11 is required to create the Oscar runtime."
    }
    & $PythonExe -m venv .venv
    Assert-CommandSuccess "Oscar virtual environment creation"
}

& $VenvPython -m pip install --upgrade pip wheel setuptools
Assert-CommandSuccess "Oscar packaging tools installation"

if (-not $SkipTorch) {
    if ($CpuOnly) {
        & $VenvPython -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
    } else {
        & $VenvPython -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
    }
    Assert-CommandSuccess "Oscar PyTorch installation"
}

$FilteredRequirements = Join-Path $Root ".requirements-installer.tmp"
try {
    # llama-cpp-python publishes Windows wheels on its own index. Installing it
    # from PyPI first makes pip compile llama.cpp locally and then replace that
    # build with the GPU wheel, adding minutes and requiring Visual Studio.
    Get-Content -LiteralPath (Join-Path $Root "requirements.txt") |
        Where-Object { $_ -notmatch '^\s*llama-cpp-python(?:\s*[=<>!~].*)?\s*$' } |
        Set-Content -LiteralPath $FilteredRequirements -Encoding UTF8
    & $VenvPython -m pip install -r $FilteredRequirements
    Assert-CommandSuccess "Oscar Python dependency installation"
} finally {
    Remove-Item -LiteralPath $FilteredRequirements -Force -ErrorAction SilentlyContinue
}

$LlamaWheelIndex = if ($CpuOnly) {
    "https://abetlen.github.io/llama-cpp-python/whl/cpu"
} else {
    "https://abetlen.github.io/llama-cpp-python/whl/cu125"
}
& $VenvPython -m pip install --force-reinstall --no-cache-dir --no-deps `
    llama-cpp-python==0.3.30 `
    --index-url $LlamaWheelIndex `
    --only-binary llama-cpp-python
Assert-CommandSuccess "Oscar llama.cpp wheel installation"

if (-not $CpuOnly) {
    # Keep llama.cpp on the NVIDIA GPU without requiring a machine-wide CUDA
    # Toolkit. The 12.5 wheel is compatible with newer NVIDIA drivers.
    & $VenvPython -m pip install --no-cache-dir `
        nvidia-cuda-runtime-cu12==12.5.82 `
        nvidia-cublas-cu12==12.5.3.2 `
        nvidia-nvjitlink-cu12==12.5.82
    Assert-CommandSuccess "Oscar CUDA runtime installation"
}

if (-not $SkipFrontendInstall) {
    Push-Location (Join-Path $Root "frontend")
    try {
        npm install
        Assert-CommandSuccess "Oscar frontend dependency installation"
    } finally {
        Pop-Location
    }
}

$OscarEnvPath = if ($env:MONARCH_CONFIG_ROOT) {
    Join-Path $env:MONARCH_CONFIG_ROOT "config\oscar\.env"
} else {
    Join-Path $Root ".env"
}
if (-not (Test-Path -LiteralPath $OscarEnvPath)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $OscarEnvPath) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Root ".env.example") -Destination $OscarEnvPath
}

Write-Host "Installed. Backend: .\scripts\backend.ps1  Frontend: .\scripts\frontend.ps1"
