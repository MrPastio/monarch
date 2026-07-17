$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$securityRoot = Join-Path $root "security"

$python = $env:MONARCH_SECURITY_PYTHON
if (-not $python) {
  $securityVenv = Join-Path $securityRoot ".venv\Scripts\python.exe"
  $oscarVenv = Join-Path $root "oscar\.venv\Scripts\python.exe"
  if (Test-Path $securityVenv) {
    $python = $securityVenv
  } elseif (Test-Path $oscarVenv) {
    $python = $oscarVenv
  } else {
    $python = "python"
  }
}

$env:PYTHONPATH = Join-Path $securityRoot "src"
& $python -m pytest (Join-Path $securityRoot "tests") -q
