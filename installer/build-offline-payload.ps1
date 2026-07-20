param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [string]$BuildRuntimeRoot = "",
  [string]$OutputDirectory = "",
  [string]$AppVersion = "0.1.5",
  [string]$RuntimeVersion = "2026.07.5",
  [string]$BackendEnvironment = "backend-0.1.5-offline3",
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd("\")
$buildRoot = if ($BuildRuntimeRoot) {
  [System.IO.Path]::GetFullPath($BuildRuntimeRoot).TrimEnd("\")
} else {
  $root
}
$output = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd("\")
} else {
  Join-Path $root "installer\offline-payload"
}
$markerName = ".monarch-offline-payload"
$markerPath = Join-Path $output $markerName

function Assert-NativeSuccess {
  param([Parameter(Mandatory = $true)][string]$Operation)
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Find-NodeExecutable {
  $toolsRoot = Join-Path $buildRoot ".tools"
  if (Test-Path -LiteralPath $toolsRoot -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $toolsRoot -Directory |
      Where-Object { $_.Name -match '^node-v\d+\.\d+\.\d+-win-x64$' } |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "node.exe" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  throw "Node.js 22 is required to build the offline runtime."
}

function Find-Python311 {
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($launcher) {
    $candidate = @(& $launcher.Source -3.11 -c "import sys; print(sys.executable)") |
      Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and
        $candidate -and
        (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }
  foreach ($name in @("python.exe", "python")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $command) {
      continue
    }
    $version = @(& $command.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')") |
      Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and $version -eq "3.11") {
      return $command.Source
    }
  }
  throw "Python 3.11 is required to assemble the offline Python runtime."
}

function Test-ExcludedRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [string[]]$ExcludedPrefixes = @(),
    [string[]]$ExcludedPatterns = @()
  )

  $normalized = $RelativePath.Replace("\", "/").TrimStart("/")
  foreach ($prefix in $ExcludedPrefixes) {
    $candidate = $prefix.Replace("\", "/").TrimStart("/").TrimEnd("/")
    if ($normalized.Equals($candidate, [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith("$candidate/", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  foreach ($pattern in $ExcludedPatterns) {
    if ($normalized -match $pattern) {
      return $true
    }
  }
  return $false
}

function Copy-FilteredTree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludedPrefixes = @(),
    [string[]]$ExcludedPatterns = @()
  )

  $sourcePath = [System.IO.Path]::GetFullPath($Source).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "Source directory is missing: $sourcePath"
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($file in @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force -File)) {
    $relative = $file.FullName.Substring($sourcePath.Length).TrimStart("\")
    if (Test-ExcludedRelativePath `
        -RelativePath $relative `
        -ExcludedPrefixes $ExcludedPrefixes `
        -ExcludedPatterns $ExcludedPatterns) {
      continue
    }
    $target = Join-Path $Destination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}

function Get-TreeRecord {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $records = New-Object System.Collections.Generic.List[string]
  $totalBytes = [long]0
  $files = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -File)
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($resolved.Length).TrimStart("\").Replace("\", "/")
    $hash = Get-Sha256Hex -Path $file.FullName
    $records.Add("$relative`0$($file.Length)`0$hash`n")
    $totalBytes += $file.Length
  }
  $sortedRecords = $records.ToArray()
  [System.Array]::Sort($sortedRecords, [StringComparer]::Ordinal)
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($sortedRecords -join ""))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $treeHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  return [ordered]@{
    sha256 = $treeHash
    files = $files.Count
    size = $totalBytes
  }
}

function Install-PythonTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Python,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Operation
  )

  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  & $Python -m pip install `
    --disable-pip-version-check `
    --no-input `
    --no-compile `
    --upgrade `
    --target $Target `
    @Arguments
  Assert-NativeSuccess $Operation
}

function Remove-PythonBytecode {
  param([Parameter(Mandatory = $true)][string]$Path)

  $target = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $insideGeneratedComponent = $false
  foreach ($generatedRoot in @($runtimeOutput, $environmentOutput)) {
    $boundary = [System.IO.Path]::GetFullPath($generatedRoot).TrimEnd("\") + "\"
    if (($target + "\").StartsWith(
      $boundary,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      $insideGeneratedComponent = $true
      break
    }
  }
  if (-not $insideGeneratedComponent) {
    throw "Refusing to clean Python bytecode outside the generated runtime or environment."
  }
  Get-ChildItem -LiteralPath $target -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
  Get-ChildItem -LiteralPath $target -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "__pycache__" } |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath (Join-Path $root "package.json") -PathType Leaf)) {
  throw "Invalid Monarch source root: $root"
}
if (-not (Test-Path -LiteralPath (Join-Path $root "dist\monarch-server.mjs") -PathType Leaf)) {
  throw "Build dist\monarch-server.mjs before assembling the offline payload."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "oscar\frontend\dist\index.html") -PathType Leaf)) {
  throw "Build the Oscar frontend before assembling the offline payload."
}
if (-not (Test-Path -LiteralPath (Join-Path $buildRoot "node_modules\electron\dist\electron.exe") -PathType Leaf)) {
  throw "Electron runtime is missing. Run npm ci on the build machine."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "Monarch.exe") -PathType Leaf)) {
  throw "Build Monarch.exe before assembling the offline payload."
}

if (Test-Path -LiteralPath $output) {
  if (-not $Force -or -not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Refusing to replace an unverified offline payload directory: $output"
  }
  Remove-Item -LiteralPath $output -Recurse -Force
}

$appOutput = Join-Path $output "app"
$runtimeOutput = Join-Path $output "runtime"
$environmentOutput = Join-Path $output "environment"
$pythonRuntime = Join-Path $runtimeOutput "python"
$commonSitePackages = Join-Path $environmentOutput "oscar\common"
$cpuSitePackages = Join-Path $environmentOutput "oscar\profiles\cpu"
$cudaSitePackages = Join-Path $environmentOutput "oscar\profiles\cuda"
$securitySitePackages = Join-Path $environmentOutput "security\site-packages"

New-Item -ItemType Directory -Path $output -Force | Out-Null
[System.IO.File]::WriteAllText(
  $markerPath,
  "Generated Monarch offline payload.`n",
  (New-Object System.Text.UTF8Encoding($false))
)

try {
  Write-Host "[offline] Copying runtime application files"
  Copy-FilteredTree `
    -Source $root `
    -Destination $appOutput `
    -ExcludedPrefixes @(
      ".git",
      ".agents",
      ".codex",
      ".tools",
      "node_modules",
      "tests",
      "docs",
      "showcase",
      "installer\offline-payload",
      "installer\out",
      "runtime",
      "logs",
      "secrets",
      "tmp",
      "data\local",
      "artifacts\generated",
      "oscar\.venv",
      "oscar\frontend\node_modules",
      "oscar\frontend\dist",
      "oscar\data",
      "oscar\logs",
      "security\.venv",
      "security\data",
      "security\logs",
      "AGENTS.md",
      "AI_HANDOFF.md",
      "agent_notes.md",
      "ORIGINAL_REQUEST.md",
      "MARK_ALFA_FINDINGS.md",
      "design-qa.md",
      "Monarch.exe"
    ) `
    -ExcludedPatterns @(
      '(^|/)(__pycache__|\.pytest_cache)(/|$)',
      '\.(pyc|pyo|pdb|ilk|user)$'
    )
  Copy-FilteredTree `
    -Source (Join-Path $root "oscar\frontend\dist") `
    -Destination (Join-Path $appOutput "oscar\frontend\dist")

  Write-Host "[offline] Copying Node and Electron runtimes"
  $node = Find-NodeExecutable
  $nodeVersion = @(& $node --version) | Select-Object -First 1
  Assert-NativeSuccess "Node.js version probe"
  $expectedNodeVersion = "v$((Get-Content -LiteralPath (Join-Path $root '.node-version') -Raw).Trim())"
  if ($nodeVersion -ne $expectedNodeVersion) {
    throw "Node runtime $nodeVersion does not match pinned $expectedNodeVersion."
  }
  New-Item -ItemType Directory -Path (Join-Path $runtimeOutput "node") -Force | Out-Null
  Copy-Item -LiteralPath $node -Destination (Join-Path $runtimeOutput "node\node.exe")
  Copy-FilteredTree `
    -Source (Join-Path $buildRoot "node_modules\electron\dist") `
    -Destination (Join-Path $runtimeOutput "electron")

  Write-Host "[offline] Copying portable Python 3.11 standard runtime"
  $python = Find-Python311
  $pythonVersion = @(& $python -c "import platform; print(platform.python_version())") |
    Select-Object -First 1
  Assert-NativeSuccess "Python version probe"
  $pythonBase = @(& $python -c "import sys; print(sys.base_prefix)") | Select-Object -First 1
  Assert-NativeSuccess "Python base prefix probe"
  Copy-FilteredTree `
    -Source $pythonBase `
    -Destination $pythonRuntime `
    -ExcludedPrefixes @(
      "Lib\site-packages",
      "Lib\test",
      "Lib\tests",
      "Lib\ensurepip",
      "Lib\idlelib",
      "Lib\tkinter",
      "Doc",
      "tcl",
      "Scripts",
      "include",
      "libs",
      "Tools"
    ) `
    -ExcludedPatterns @(
      '(^|/)__pycache__(/|$)',
      '\.(pyc|pyo|pdb|lib|exp|chm)$'
    )
  $stagedPython = Join-Path $pythonRuntime "python.exe"
  & $stagedPython -I -B -c "import ctypes, hashlib, json, sqlite3, ssl; print('portable-python-ok')"
  Assert-NativeSuccess "Portable Python runtime validation"

  Write-Host "[offline] Resolving Oscar common packages on the build machine"
  Install-PythonTarget `
    -Python $python `
    -Target $commonSitePackages `
    -Arguments @(
      "--only-binary=:all:",
      "-r",
      (Join-Path $root "oscar\requirements-runtime.txt")
    ) `
    -Operation "Oscar common runtime installation"

  Write-Host "[offline] Resolving llama.cpp CPU profile"
  Install-PythonTarget `
    -Python $python `
    -Target $cpuSitePackages `
    -Arguments @(
      "--no-deps",
      "--only-binary=llama-cpp-python",
      "--index-url",
      "https://abetlen.github.io/llama-cpp-python/whl/cpu",
      "llama-cpp-python==0.3.30"
    ) `
    -Operation "Oscar CPU llama.cpp installation"

  Write-Host "[offline] Resolving llama.cpp CUDA profile"
  Install-PythonTarget `
    -Python $python `
    -Target $cudaSitePackages `
    -Arguments @(
      "--no-deps",
      "--only-binary=llama-cpp-python",
      "--index-url",
      "https://abetlen.github.io/llama-cpp-python/whl/cu125",
      "llama-cpp-python==0.3.30"
    ) `
    -Operation "Oscar CUDA llama.cpp installation"
  Install-PythonTarget `
    -Python $python `
    -Target $cudaSitePackages `
    -Arguments @(
      "--no-deps",
      "--only-binary=:all:",
      "nvidia-cuda-runtime-cu12==12.5.82",
      "nvidia-cublas-cu12==12.5.3.2",
      "nvidia-nvjitlink-cu12==12.5.82"
    ) `
    -Operation "Oscar CUDA support library installation"

  Write-Host "[offline] Resolving Monarch Security packages"
  Install-PythonTarget `
    -Python $python `
    -Target $securitySitePackages `
    -Arguments @("--only-binary=:all:", "psutil==7.2.2") `
    -Operation "Monarch Security runtime installation"

  $previousPythonPath = $env:PYTHONPATH
  $previousPath = $env:PATH
  $previousDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
  try {
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $env:PYTHONPATH = "$commonSitePackages;$cpuSitePackages;$(Join-Path $root 'oscar\backend')"
    & $stagedPython -B -c "import fastapi, uvicorn, pydantic, httpx, llama_cpp, oscar_agent; print('oscar-offline-runtime-ok')"
    Assert-NativeSuccess "Offline Oscar CPU runtime validation"

    $env:PYTHONPATH = "$commonSitePackages;$cudaSitePackages;$(Join-Path $root 'oscar\backend')"
    $env:PATH = "$cudaSitePackages\nvidia\cublas\bin;$cudaSitePackages\nvidia\cuda_runtime\bin;$cudaSitePackages\nvidia\nvjitlink\bin;$previousPath"
    & $stagedPython -B -c "import llama_cpp; print('oscar-offline-cuda-runtime-ok')"
    Assert-NativeSuccess "Offline Oscar CUDA runtime validation"

    $env:PYTHONPATH = "$securitySitePackages;$(Join-Path $root 'security\src')"
    & $stagedPython -B -c "import psutil, monarch_security; print('security-offline-runtime-ok')"
    Assert-NativeSuccess "Offline Monarch Security runtime validation"
  } finally {
    $env:PYTHONPATH = $previousPythonPath
    $env:PATH = $previousPath
    $env:PYTHONDONTWRITEBYTECODE = $previousDontWriteBytecode
  }

  Remove-PythonBytecode -Path $runtimeOutput
  Remove-PythonBytecode -Path $environmentOutput

  Write-Host "[offline] Hashing exact payload trees"
  $launcherPath = Join-Path $root "Monarch.exe"
  $launcherFile = Get-Item -LiteralPath $launcherPath
  $manifest = [ordered]@{
    schemaVersion = 1
    kind = "offline"
    appVersion = $AppVersion
    runtimeVersion = $RuntimeVersion
    backendEnvironment = $BackendEnvironment
    createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    nodeVersion = $nodeVersion.TrimStart("v")
    pythonVersion = $pythonVersion
    electronVersion = (
      Get-Content -LiteralPath (Join-Path $runtimeOutput "electron\version") -Raw
    ).Trim()
    profiles = @("cpu", "cuda")
    components = [ordered]@{
      app = Get-TreeRecord -Path $appOutput
      runtime = Get-TreeRecord -Path $runtimeOutput
      environment = Get-TreeRecord -Path $environmentOutput
    }
    launcher = [ordered]@{
      fileName = "Monarch.exe"
      size = $launcherFile.Length
      sha256 = Get-Sha256Hex -Path $launcherPath
    }
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $output "payload-manifest.json"),
    ($manifest | ConvertTo-Json -Depth 8),
    (New-Object System.Text.UTF8Encoding($false))
  )
  Copy-Item -LiteralPath $launcherPath -Destination (Join-Path $output "Monarch.exe")

  $totalBytes = (
    Get-ChildItem -LiteralPath $output -Recurse -Force -File |
      Measure-Object -Property Length -Sum
  ).Sum
  Write-Host "[offline] Payload ready: $output"
  Write-Host "[offline] Total uncompressed: $([math]::Round($totalBytes / 1MB, 2)) MB"
} catch {
  Write-Error $_
  throw
}
