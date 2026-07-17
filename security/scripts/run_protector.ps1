param(
    [double]$Duration = 0,
    [switch]$NoLlm
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw "Runtime is missing. Run .\scripts\setup_runtime.ps1 first."
}

$ArgsList = @("-m", "monarch_security", "protect", "--duration", "$Duration")
if ($NoLlm) {
    $ArgsList += "--no-llm"
}

& $Python @ArgsList
