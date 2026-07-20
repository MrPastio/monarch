param(
  [long] $MaxSourceBytes = 5242880,
  [int] $Top = 20,
  [switch] $Json
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$rootForUri = $root.Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$blockedDirectoryPatterns = @(
  '^\.git($|/)',
  '^\.agents($|/)',
  '^\.codex($|/)',
  '^\.tools($|/)',
  '^node_modules($|/)',
  '^showcase/[^/]+/node_modules($|/)',
  '^showcase/[^/]+/out($|/)',
  '^output($|/)',
  '^vendor($|/)',
  '^runtime($|/)',
  '^installer/out($|/)',
  '^logs($|/)',
  '^secrets($|/)',
  '^marketing-site($|/)',
  '^data/local($|/)',
  '^artifacts/generated($|/)',
  '^LLM models($|/)',
  '^models($|/)',
  '^local-models($|/)',
  '^runtime-models($|/)',
  '^llama-runtime($|/)',
  '^hf-runtime($|/)',
  '^voice-runtime($|/)',
  '^oscar/\.venv($|/)',
  '^oscar/frontend/node_modules($|/)',
  '^oscar/frontend/dist($|/)',
  '^oscar/data($|/)',
  '^oscar/model($|/)',
  '^oscar/model-small($|/)',
  '^oscar/runtime($|/)',
  '^oscar/Oscar\.exe\.WebView2($|/)',
  '^oscar/desktop/webview2_pkg($|/)',
  '^security/\.venv($|/)',
  '^security/data($|/)',
  '^security/logs($|/)'
)

$blockedFilePatterns = @(
  '^(AI_HANDOFF|agent_notes|ORIGINAL_REQUEST|MARK_ALFA_FINDINGS|design-qa)\.md$',
  '(^|/)\.env(\..*)?$',
  '(^|/)__pycache__/',
  '\.pyc$',
  '\.pyo$',
  '\.gguf$',
  '\.safetensors$',
  '\.sqlite3?$',
  '\.db$',
  '\.bin$',
  '\.exe$',
  '\.dll$',
  '\.pyd$',
  '\.zip$',
  '\.7z$',
  '\.rar$',
  '\.tar\.gz$',
  '\.lib$',
  '\.tlb$',
  '\.winmd$',
  '\.onnx$'
)

function Get-RelativePath([string] $Path) {
  $rootUri = New-Object System.Uri($rootForUri)
  $pathUri = New-Object System.Uri($Path)
  $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString())
  return $relative.Replace('\', '/')
}

function Test-BlockedPath([string] $RelativePath) {
  foreach ($pattern in $blockedDirectoryPatterns) {
    if ($RelativePath -match $pattern) {
      return $true
    }
  }
  foreach ($pattern in $blockedFilePatterns) {
    if ($RelativePath -match $pattern) {
      return $true
    }
  }
  return $false
}

function Test-SensitiveSourceName([string] $RelativePath) {
  if ($RelativePath -eq 'oscar/scripts/token.ps1') {
    return $false
  }
  return $RelativePath -match '(^|/)(secret|secrets|token|tokens|key|keys|credential|credentials|password|passwd)(\.|_|-|/|$)'
}

$included = New-Object System.Collections.Generic.List[object]
$excluded = New-Object System.Collections.Generic.List[object]
$violations = New-Object System.Collections.Generic.List[object]

Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
  $relative = Get-RelativePath $_.FullName
  $entry = [pscustomobject]@{
    path = $relative
    bytes = $_.Length
  }

  if (Test-BlockedPath $relative) {
    $excluded.Add($entry)
    return
  }

  $included.Add($entry)

  if ($_.Length -gt $MaxSourceBytes) {
    $violations.Add([pscustomobject]@{
      path = $relative
      bytes = $_.Length
      reason = "included file exceeds $MaxSourceBytes bytes"
    })
  }

  if (Test-SensitiveSourceName $relative) {
    $violations.Add([pscustomobject]@{
      path = $relative
      bytes = $_.Length
      reason = 'included file name looks sensitive'
    })
  }
}

$includedBytes = ($included | Measure-Object -Property bytes -Sum).Sum
$excludedBytes = ($excluded | Measure-Object -Property bytes -Sum).Sum
$summary = [pscustomobject]@{
  root = $root.Path
  included_files = $included.Count
  included_mb = [math]::Round(($includedBytes / 1MB), 2)
  excluded_files = $excluded.Count
  excluded_gb = [math]::Round(($excludedBytes / 1GB), 2)
  violations = $violations.Count
}

if ($Json) {
  [pscustomobject]@{
    summary = $summary
    violations = $violations
    largest_included = $included | Sort-Object bytes -Descending | Select-Object -First $Top
    largest_excluded = $excluded | Sort-Object bytes -Descending | Select-Object -First $Top
  } | ConvertTo-Json -Depth 5
} else {
  Write-Host 'Monarch upload dry-run'
  $summary | Format-List | Out-String | Write-Host
  if ($violations.Count -gt 0) {
    Write-Host 'Violations:'
    $violations | Sort-Object bytes -Descending | Format-Table -AutoSize | Out-String | Write-Host
  }
  Write-Host 'Largest included source candidates:'
  $included | Sort-Object bytes -Descending | Select-Object -First $Top | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host 'Largest excluded local/runtime files:'
  $excluded | Sort-Object bytes -Descending | Select-Object -First $Top | Format-Table -AutoSize | Out-String | Write-Host
}

if ($violations.Count -gt 0) {
  exit 2
}
