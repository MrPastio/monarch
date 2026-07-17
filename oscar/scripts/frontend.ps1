$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $Root "..")).Path
$Port = if ($env:OSCAR_PORT) { [int]$env:OSCAR_PORT } else { 7861 }

. (Join-Path $PSScriptRoot "token.ps1")

Set-Location (Join-Path $Root "frontend")
$NodeVersionPath = Join-Path $RepoRoot ".node-version"
if (Test-Path $NodeVersionPath) {
  $NodeVersion = (Get-Content -Raw $NodeVersionPath).Trim()
  $NodeDir = Join-Path $RepoRoot ".tools\node-v$NodeVersion-win-x64"
  if (Test-Path (Join-Path $NodeDir "node.exe")) {
    $env:PATH = "$NodeDir;$env:PATH"
  }
}
$env:VITE_API_BASE = if ($env:VITE_API_BASE) { $env:VITE_API_BASE } else { "http://127.0.0.1:$Port" }
$env:OSCAR_API_TOKEN = Ensure-OscarApiToken -OscarRoot $Root
npm run dev
