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

& $VenvPython -m pip install -r requirements.txt
Assert-CommandSuccess "Oscar Python dependency installation"

if (-not $CpuOnly) {
    # Keep llama.cpp on the NVIDIA GPU without requiring a machine-wide CUDA
    # Toolkit. The 12.5 wheel is compatible with newer NVIDIA drivers.
    & $VenvPython -m pip install --force-reinstall --no-cache-dir --no-deps `
        llama-cpp-python==0.3.30 `
        --index-url https://abetlen.github.io/llama-cpp-python/whl/cu125
    Assert-CommandSuccess "Oscar CUDA llama.cpp installation"
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

if (-not (Test-Path -LiteralPath (Join-Path $Root ".env"))) {
    Copy-Item -LiteralPath (Join-Path $Root ".env.example") -Destination (Join-Path $Root ".env")
}

Write-Host "Installed. Backend: .\scripts\backend.ps1  Frontend: .\scripts\frontend.ps1"
