param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$ModelsRoot,
  [ValidateSet('gemma4-fast', 'gemma4-balanced')][string]$Tier = 'gemma4-fast'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Get-Item -LiteralPath $SourcePath
if ($source.PSIsContainer -or $source.Length -lt 1048576) { throw 'Expected an existing Vision GGUF adapter.' }
$expectedNames = if ($Tier -eq 'gemma4-fast') {
  @('mmproj-BF16_E2B.gguf', 'mmproj-F16-gemma_4-E2B.gguf')
} else {
  @('mmproj-BF16_12B.gguf', 'mmproj-gemma-4-12B-it-f16.gguf')
}
if ($source.Name -notin $expectedNames) { throw 'Adapter filename does not match the selected model tier.' }
$stream = [System.IO.File]::OpenRead($source.FullName)
try {
  $header = New-Object byte[] 4
  if ($stream.Read($header, 0, 4) -ne 4 -or [System.Text.Encoding]::ASCII.GetString($header) -ne 'GGUF') {
    throw 'Invalid Vision adapter GGUF header.'
  }
} finally { $stream.Dispose() }
$models = [System.IO.Path]::GetFullPath($ModelsRoot).TrimEnd('\')
$destinationRoot = Join-Path $models 'gemma_models\vision_other'
$destination = Join-Path $destinationRoot $expectedNames[0]
$digest = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$imported = $false
if (Test-Path -LiteralPath $destination) {
  if ((Get-Item -LiteralPath $destination).Length -ne $source.Length -or
      (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
    throw 'A different adapter already exists; it was preserved.'
  }
} else {
  $null = [System.IO.Directory]::CreateDirectory($destinationRoot)
  $staging = $destination + '.import-' + [guid]::NewGuid().ToString('N')
  [System.IO.File]::Copy($source.FullName, $staging, $false)
  if ((Get-Item -LiteralPath $staging).Length -ne $source.Length -or
      (Get-FileHash -LiteralPath $staging -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
    throw "Adapter copy verification failed. Staging file preserved: $staging"
  }
  [System.IO.File]::Move($staging, $destination)
  $imported = $true
}
[ordered]@{ tier = $Tier; path = $destination; bytes = $source.Length; sha256 = $digest; imported = $imported } | ConvertTo-Json
