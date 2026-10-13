# Authenticode signing for Monarch release binaries.
#
# Configuration comes only from the environment so no certificate material
# ever lands in the repository or build logs:
#   MONARCH_SIGN_MODE        none (default) | thumbprint | command
#   MONARCH_SIGN_REQUIRED    1 = fail the build when signing is not configured
#   MONARCH_SIGN_TIMESTAMP   RFC 3161 timestamp URL (default: DigiCert)
#   MONARCH_SIGN_DESCRIPTION signature description (default: Monarch)
#   thumbprint mode:
#     MONARCH_SIGN_CERT_SHA1 certificate thumbprint in CurrentUser\My or
#                            LocalMachine\My (hardware token, Certum
#                            SimplySign, SSL.com eSigner CKA all expose the
#                            certificate this way; the key never leaves it)
#   command mode:
#     MONARCH_SIGN_COMMAND   full command line with a literal {file}
#                            placeholder, e.g. Azure Artifact Signing
#                            (signtool /dlib) or SSL.com CodeSignTool.
# One publisher identity must be used for every release: SmartScreen
# reputation is bound to the certificate, not to the product name.

Set-StrictMode -Version Latest

function Find-MonarchSignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path -LiteralPath $kits -PathType Container)) { return $null }
  $candidate = Get-ChildItem -LiteralPath $kits -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  return $candidate
}

function Get-MonarchSigningConfig {
  $mode = if ($env:MONARCH_SIGN_MODE) { $env:MONARCH_SIGN_MODE.Trim().ToLowerInvariant() } else { "none" }
  $required = $env:MONARCH_SIGN_REQUIRED -eq "1"
  $timestamp = if ($env:MONARCH_SIGN_TIMESTAMP) { $env:MONARCH_SIGN_TIMESTAMP } else { "http://timestamp.digicert.com" }
  $description = if ($env:MONARCH_SIGN_DESCRIPTION) { $env:MONARCH_SIGN_DESCRIPTION } else { "Monarch" }

  $config = [ordered]@{
    enabled = $false
    mode = $mode
    signTool = $null
    thumbprint = $null
    command = $null
    timestamp = $timestamp
    description = $description
  }

  switch ($mode) {
    "none" { }
    "thumbprint" {
      $thumbprint = ([string]$env:MONARCH_SIGN_CERT_SHA1) -replace '[^0-9A-Fa-f]', ''
      if ($thumbprint.Length -ne 40) {
        throw "MONARCH_SIGN_CERT_SHA1 must be a 40-hex-digit certificate thumbprint."
      }
      $signTool = Find-MonarchSignTool
      if (-not $signTool) { throw "signtool.exe was not found. Install the Windows 10/11 SDK signing tools." }
      $config.enabled = $true
      $config.signTool = $signTool
      $config.thumbprint = $thumbprint.ToUpperInvariant()
    }
    "command" {
      $command = [string]$env:MONARCH_SIGN_COMMAND
      if (-not $command.Contains("{file}")) {
        throw "MONARCH_SIGN_COMMAND must contain a literal {file} placeholder."
      }
      $config.enabled = $true
      $config.command = $command
      $config.signTool = Find-MonarchSignTool
    }
    default { throw "Unsupported MONARCH_SIGN_MODE '$mode'. Use none, thumbprint or command." }
  }

  if ($required -and -not $config.enabled) {
    throw "Code signing is required for this build (MONARCH_SIGN_REQUIRED=1) but MONARCH_SIGN_MODE is not configured."
  }
  return [pscustomobject]$config
}

# signtool arguments without the file operand, used both directly and as the
# Inno Setup SignTool definition (where $f stands for the file).
function Get-MonarchSignToolArguments {
  param([Parameter(Mandatory = $true)]$Config)
  return @(
    "sign", "/fd", "SHA256", "/sha1", $Config.thumbprint,
    "/tr", $Config.timestamp, "/td", "SHA256",
    "/d", $Config.description
  )
}

function Invoke-MonarchSignFile {
  param(
    [Parameter(Mandatory = $true)]$Config,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not $Config.enabled) { return }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Cannot sign a missing file: $fullPath"
  }

  $attempt = 0
  while ($true) {
    $attempt += 1
    if ($Config.mode -eq "thumbprint") {
      $arguments = @(Get-MonarchSignToolArguments -Config $Config) + @($fullPath)
      & $Config.signTool @arguments | Out-Host
    } else {
      $commandLine = $Config.command.Replace("{file}", "`"$fullPath`"")
      & cmd.exe /d /s /c $commandLine | Out-Host
    }
    if ($LASTEXITCODE -eq 0) { break }
    # Timestamp services fail transiently; never retry forever.
    if ($attempt -ge 3) { throw "Signing failed after $attempt attempts: $fullPath" }
    Start-Sleep -Seconds (5 * $attempt)
  }
  Assert-MonarchSignature -Config $Config -Path $fullPath
}

function Assert-MonarchSignature {
  param(
    [Parameter(Mandatory = $true)]$Config,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not $Config.enabled) { return }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode signature is not valid for ${Path}: $($signature.Status) $($signature.StatusMessage)"
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Authenticode signature has no timestamp: $Path"
  }
  if ($Config.thumbprint -and
      $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $Config.thumbprint) {
    throw "File was signed by an unexpected certificate: $Path"
  }
}
