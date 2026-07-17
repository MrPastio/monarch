$ErrorActionPreference = "Stop"

$oscarRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectRoot = (Resolve-Path (Join-Path $oscarRoot "..")).Path
$python = $env:MONARCH_OSCAR_PYTHON

if (-not $python) {
  $venvPython = Join-Path $oscarRoot ".venv\Scripts\python.exe"
  if (Test-Path $venvPython) {
    $python = $venvPython
  } else {
    $python = "python"
  }
}

$env:PYTHONPATH = Join-Path $oscarRoot "backend"
& $python -m pytest (Join-Path $oscarRoot "backend\tests") -q
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
