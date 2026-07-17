param(
  [string]$Version = "22.23.1",
  [switch]$Install,
  [switch]$Quiet,
  [switch]$StrictActive,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Command
)

$ErrorActionPreference = "Stop"
$RequiredVersion = [version]"22.12.0"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ToolsRoot = Join-Path $RepoRoot ".tools"
$InstallDir = Join-Path $ToolsRoot "node-v$Version-win-x64"
$LocalNode = Join-Path $InstallDir "node.exe"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-NodeVersion([string]$NodeExe) {
  try {
    $raw = & $NodeExe -p "process.versions.node" 2>$null
    if (-not $raw) { return $null }
    return [version]($raw | Select-Object -First 1)
  } catch {
    return $null
  }
}

function Test-NodeOk([string]$NodeExe) {
  $version = Get-NodeVersion $NodeExe
  return $version -ne $null -and $version -ge $RequiredVersion -and $version.Major -lt 25
}

function Invoke-WithNode([string]$NodeDir, [string[]]$Args) {
  if ($Args.Count -gt 0 -and ($Args[0] -eq "--" -or $Args[0] -eq "")) {
    $Args = @($Args | Select-Object -Skip 1)
  }
  if ($Args.Count -eq 0) {
    return
  }

  $env:PATH = "$NodeDir;$env:PATH"
  $exe = $Args[0]
  $rest = @($Args | Select-Object -Skip 1)
  & $exe @rest
  exit $LASTEXITCODE
}

$activeNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$activeNode = if ($activeNodeCommand) { $activeNodeCommand.Source } else { $null }
if ($activeNode -and (Test-NodeOk $activeNode)) {
  $activeVersion = Get-NodeVersion $activeNode
  if (-not $Quiet) {
    Write-Host "Node OK: v$activeVersion ($activeNode)"
  }
  Invoke-WithNode (Split-Path $activeNode -Parent) $Command
  exit 0
}

if ($Install -and -not (Test-Path $LocalNode)) {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $archive = Join-Path $ToolsRoot "node-v$Version-win-x64.zip"
  $url = "https://nodejs.org/dist/v$Version/node-v$Version-win-x64.zip"
  Write-Host "Downloading Node v$Version..."
  Invoke-WebRequest -Uri $url -OutFile $archive
  $tmp = Join-Path $ToolsRoot "node-v$Version-win-x64.tmp"
  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  Expand-Archive -LiteralPath $archive -DestinationPath $tmp -Force
  $expanded = Join-Path $tmp "node-v$Version-win-x64"
  if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  Move-Item -LiteralPath $expanded -Destination $InstallDir
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Remove-Item -LiteralPath $archive -Force
}

if (Test-NodeOk $LocalNode) {
  $localVersion = Get-NodeVersion $LocalNode
  $nodeDir = Split-Path $LocalNode -Parent
  if (-not $Quiet) {
    Write-Host "Project Node ready: v$localVersion ($LocalNode)"
  }
  if ($Install -and $Command.Count -eq 0) {
    if (-not $Quiet) {
      Write-Host "Use npm run node:exec -- <command> to run project commands with this Node."
    }
    exit 0
  }
  Invoke-WithNode $nodeDir $Command
  if (-not $Quiet) {
    if ($activeNode) {
      $activeVersion = Get-NodeVersion $activeNode
      Write-Warning "Active Node on PATH is v$activeVersion at $activeNode. Use npm run node:exec -- <command> or put $nodeDir first in PATH for Monarch commands."
    } else {
      Write-Warning "Node is not on PATH. Use npm run node:exec -- <command> or put $nodeDir first in PATH for Monarch commands."
    }
  }
  if ($StrictActive) {
    if ($activeNode) {
      $activeVersion = Get-NodeVersion $activeNode
      Write-Error "Active Node is v$activeVersion at $activeNode. Use npm run node:exec -- <command> or put $nodeDir first in PATH."
    } else {
      Write-Error "Node is not on PATH. Use npm run node:exec -- <command> or put $nodeDir first in PATH."
    }
    exit 1
  }
  exit 0
}

if ($activeNode) {
  $activeVersion = Get-NodeVersion $activeNode
  Write-Error "Node v$activeVersion is too old for Monarch. Required: >=22.12.0 <25. Run `npm run node:install`."
} else {
  Write-Error "Node is missing. Run `npm run node:install`."
}
exit 1
