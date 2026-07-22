param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$LauncherVersion = "1.0.0"
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
$current = Join-Path $root "Monarch.exe"
$next = Join-Path $root "Monarch.next.exe"
$previous = Join-Path $root "Monarch.previous.exe"
$failed = Join-Path $root "Monarch.failed.exe"

if (-not (Test-Path -LiteralPath $next -PathType Leaf)) {
  throw "Staged Monarch launcher is missing."
}

function Invoke-LauncherSelfTest {
  param([Parameter(Mandatory = $true)][string]$Path)
  $process = Start-Process `
    -FilePath $Path `
    -ArgumentList "--self-test" `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    throw "Launcher self-test failed with exit code $($process.ExitCode)."
  }
}

Invoke-LauncherSelfTest -Path $next
New-Item -ItemType Directory -Path $root -Force | Out-Null
Remove-Item -LiteralPath $failed -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $current -PathType Leaf) {
  Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
  [System.IO.File]::Replace($next, $current, $previous, $true)
} else {
  [System.IO.File]::Move($next, $current)
}

try {
  Invoke-LauncherSelfTest -Path $current
} catch {
  if (Test-Path -LiteralPath $previous -PathType Leaf) {
    [System.IO.File]::Replace($previous, $current, $failed, $true)
  }
  throw
}

. (Join-Path $PSScriptRoot "layout.ps1")
Write-MonarchAtomicJson `
  -Path (Join-Path $root "launcher-version.json") `
  -Value ([ordered]@{
    schemaVersion = 1
    version = $LauncherVersion
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  })
