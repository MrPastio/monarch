param(
    [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root ".venv\Scripts\monarch_sec.exe"

if (-not (Test-Path $Exe)) {
    throw "Runtime is missing. Run .\scripts\setup_runtime.ps1 first."
}

$Bin = Join-Path $env:USERPROFILE ".monarch-security\bin"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

$Cmd = Join-Path $Bin "monarch_sec.cmd"
$CmdContent = @"
@echo off
"$Exe" %*
exit /b %ERRORLEVEL%
"@
Set-Content -Path $Cmd -Value $CmdContent -Encoding ASCII

$AliasCmd = Join-Path $Bin "monarch-security.cmd"
Set-Content -Path $AliasCmd -Value $CmdContent -Encoding ASCII

if (-not $NoPathUpdate) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @()
    if ($UserPath) {
        $Parts = $UserPath -split ";" | Where-Object { $_ }
    }
    if ($Parts -notcontains $Bin) {
        $NewPath = if ($UserPath) { "$UserPath;$Bin" } else { $Bin }
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
        Write-Output "Added to user PATH: $Bin"
        Write-Output "Open a new terminal, then run: monarch_sec"
    } else {
        Write-Output "User PATH already contains: $Bin"
    }
}

Write-Output "Installed command shim: $Cmd"
