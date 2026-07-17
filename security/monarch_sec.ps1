param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $Root
$PythonCandidates = @(
    $env:MONARCH_SECURITY_PYTHON,
    (Join-Path $Root ".venv\Scripts\python.exe"),
    (Join-Path $RepoRoot "oscar\.venv\Scripts\python.exe"),
    "python"
) | Where-Object { $_ -and $_.Trim() }
$Config = Join-Path $Root "config\monarch_security.toml"

$Python = $null
foreach ($Candidate in $PythonCandidates) {
    if ((Test-Path $Candidate) -or (Get-Command $Candidate -ErrorAction SilentlyContinue)) {
        $Python = $Candidate
        break
    }
}

if (-not $Python) {
    Write-Error "Runtime is missing. Run .\scripts\setup_runtime.ps1 first or set MONARCH_SECURITY_PYTHON."
    exit 1
}

$env:PYTHONPATH = Join-Path $Root "src"
$env:PYTHONUTF8 = "1"
& $Python -m monarch_security --config $Config @RemainingArgs
exit $LASTEXITCODE
