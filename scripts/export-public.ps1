param(
  [string]$Destination = "",
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Resolve-Path (Join-Path $PSScriptRoot "..")).Path)
if (-not $Destination) {
  $Destination = Join-Path ([System.IO.Path]::GetPathRoot($root)) "Monarch-public"
}
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$markerName = ".monarch-public-snapshot"

if ($destinationPath -eq $root -or $destinationPath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "Public export must be outside the Monarch source tree."
}

if (Test-Path -LiteralPath $destinationPath) {
  $marker = Join-Path $destinationPath $markerName
  if (-not $Force -or -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    throw "Destination exists. Refusing to replace it without -Force and the snapshot marker: $destinationPath"
  }
  $resolvedDestination = (Resolve-Path -LiteralPath $destinationPath).Path
  if ($resolvedDestination -eq $root -or
      $resolvedDestination.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a destination inside the source tree."
  }
  Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
}

$excludedPatterns = @(
  '^\.agents/',
  '^\.codex/',
  '^AGENTS\.md$',
  '^AI_HANDOFF\.md$',
  '^agent_notes\.md$',
  '^ORIGINAL_REQUEST\.md$',
  '^MARK_ALFA_FINDINGS\.md$',
  '^design-qa\.md$',
  '^docs/(10_REPAIR_PLAN_[^/]+|CONTROL_PLANE_ARCHITECTURE_AUDIT_[^/]+|TECH_AUDIT_[^/]+|TECH_REVIEW_[^/]+|WORK_CHECKPOINT_[^/]+)$',
  '^docs/debug/',
  '^docs/.+/qa/',
  '^docs/security-rebuild/[^/]+/audit/',
  '^docs/astra/STRUCTURAL_PROGRESS\.md$',
  '^docs/oscar/PORT_PROGRESS\.md$',
  '^oscar/OSCAR_FIX_LOG\.md$'
)

function Test-PublicPath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $normalized = $RelativePath.Replace("\", "/")
  foreach ($pattern in $excludedPatterns) {
    if ($normalized -match $pattern) {
      return $false
    }
  }
  return $true
}

$tracked = @(& git -C $root ls-files)
if ($LASTEXITCODE -ne 0 -or $tracked.Count -eq 0) {
  throw "Could not read the tracked source boundary."
}

$staging = "$destinationPath.staging-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $staging | Out-Null

try {
  $copied = 0
  foreach ($relativePath in $tracked) {
    $normalized = $relativePath.Replace("\", "/")
    if (-not (Test-PublicPath $normalized)) {
      continue
    }
    $source = Join-Path $root $relativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Tracked source file is missing: $relativePath"
    }
    $target = Join-Path $staging $relativePath
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
    $copied += 1
  }

  Set-Content -LiteralPath (Join-Path $staging $markerName) -Value "Monarch public snapshot" -Encoding ASCII

  $textExtensions = @(
    ".cjs", ".cmd", ".css", ".html", ".ini", ".iss", ".js", ".json", ".md",
    ".mjs", ".ps1", ".py", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"
  )
  $forbiddenContent = @(
    ('C:' + '\\Users\\' + 'anton'),
    ('E:' + '\\' + 'Monarch'),
    ('E:' + '/' + 'Monarch'),
    'gh[pousr]_[A-Za-z0-9_]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'sk-[A-Za-z0-9]{20,}',
    'AIza[0-9A-Za-z_-]{20,}',
    'xox[baprs]-[A-Za-z0-9-]{20,}',
    '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
  )
  $allowedFixtureContent = @{
    'tests/agent/agent-loop-regressions.test.ts' = @(
      ('E:' + '/Monarch/nested/requested.txt'),
      ('E:' + '/Monarch/requested.txt'),
      ('github' + '_pat_1234567890abcdef1234')
    )
    'tests/agent/context-compiler.test.ts' = @(
      ('gh' + 'p_abcdefghijklmnopqrstuvwxyz')
    )
  }
  $violations = New-Object System.Collections.Generic.List[string]

  Get-ChildItem -LiteralPath $staging -Recurse -Force -File | ForEach-Object {
    $relative = $_.FullName.Substring($staging.Length).TrimStart("\").Replace("\", "/")
    if (($_.Name -match '^\.env($|\.)' -and $_.Name -ne ".env.example") -or
        $_.Name -match '\.(sqlite3?|db|gguf|safetensors|onnx|pyd|dll|exe)$') {
      $violations.Add("${relative}: forbidden file type or name")
      return
    }
    if ($textExtensions -notcontains $_.Extension.ToLowerInvariant()) {
      return
    }
    $content = Get-Content -LiteralPath $_.FullName -Raw
    if ($allowedFixtureContent.ContainsKey($relative)) {
      foreach ($fixture in $allowedFixtureContent[$relative]) {
        $content = $content.Replace($fixture, '')
      }
    }
    foreach ($pattern in $forbiddenContent) {
      if ($content -match $pattern) {
        $violations.Add("${relative}: matched forbidden content pattern $pattern")
      }
    }
  }

  if ($violations.Count -gt 0) {
    throw "Public export validation failed:`n$($violations -join [Environment]::NewLine)"
  }

  Move-Item -LiteralPath $staging -Destination $destinationPath
  $totalBytes = (
    Get-ChildItem -LiteralPath $destinationPath -Recurse -Force -File |
      Measure-Object -Property Length -Sum
  ).Sum
  Write-Host "Public snapshot ready: $destinationPath"
  Write-Host "Files: $copied"
  Write-Host "Size: $([math]::Round($totalBytes / 1MB, 2)) MB"
} catch {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  throw
}
