# Inno Setup SignTool entry point: signs one file with the environment
# configuration from code-signing.ps1 (retries, timestamp, verification).
param([Parameter(Mandatory = $true)][string]$Path)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "code-signing.ps1")
$config = Get-MonarchSigningConfig
if (-not $config.enabled) { throw "sign-file.ps1 was invoked without MONARCH_SIGN_MODE." }
Invoke-MonarchSignFile -Config $config -Path $Path
