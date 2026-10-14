# Prepares a hosted Windows runner the way a Monarch development machine is
# laid out, so the source suite runs against the same fixtures:
# - the Electron binary (Electron 42 no longer downloads it during npm ci);
# - Oscar's backend virtual environment;
# - .test-tmp as a junction to the Astra scratch root on drive D:.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
  & npx --no-install install-electron
  if ($LASTEXITCODE -ne 0) { throw "install-electron failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\electron\dist\electron.exe'))) {
  throw 'Electron binary is missing after install-electron'
}

# Oscar's backend environment from the exact offline-payload lock.
$oscarVenv = Join-Path $root 'oscar\.venv'
if (-not (Test-Path -LiteralPath (Join-Path $oscarVenv 'Scripts\python.exe'))) {
  & python -m venv $oscarVenv
  if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE" }
}
& (Join-Path $oscarVenv 'Scripts\python.exe') -m pip install --disable-pip-version-check --no-deps -r (Join-Path $root 'oscar\requirements-runtime-lock.txt')
if ($LASTEXITCODE -ne 0) { throw "Oscar runtime install failed with exit code $LASTEXITCODE" }

$scratch = 'D:\Monarch-test-tmp-astra-v3'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$link = Join-Path $root '.test-tmp'
if (-not (Test-Path -LiteralPath $link)) {
  New-Item -ItemType Junction -Path $link -Target $scratch | Out-Null
}
Write-Output "CI test environment ready: Electron binary, Oscar runtime and .test-tmp -> $scratch"
