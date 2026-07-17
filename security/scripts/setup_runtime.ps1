param(
    [switch]$WithLlm,
    [switch]$WithHf,
    [switch]$WithTui,
    [switch]$WithDev,
    [switch]$InstallCommand,
    [switch]$AsService,
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv"

function Assert-CommandSuccess {
    param([Parameter(Mandatory = $true)][string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path $Venv)) {
    if (-not $PythonExe) {
        $PythonExe = (& py -3.11 -c "import sys; print(sys.executable)" | Select-Object -First 1)
    }
    if (-not $PythonExe -or -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        throw "Python 3.11 is required to create the Monarch Security runtime."
    }
    & $PythonExe -m venv $Venv
    Assert-CommandSuccess "Monarch Security virtual environment creation"
}

$Python = Join-Path $Venv "Scripts\python.exe"
& $Python -m pip install --upgrade pip
Assert-CommandSuccess "Monarch Security pip upgrade"
& $Python -m pip install -e "$Root[process]"
Assert-CommandSuccess "Monarch Security runtime installation"

if ($WithDev) {
    & $Python -m pip install -e "$Root[dev]"
    Assert-CommandSuccess "Monarch Security development dependencies"
}

if ($WithLlm) {
    & $Python -m pip install -e "$Root[llm]"
    Assert-CommandSuccess "Monarch Security LLM dependencies"
}

if ($WithHf) {
    & $Python -m pip install -e "$Root[hf]"
    Assert-CommandSuccess "Monarch Security Hugging Face dependencies"
}

if ($WithTui) {
    & $Python -m pip install -e "$Root[tui]"
    Assert-CommandSuccess "Monarch Security TUI dependencies"
}

if ($InstallCommand) {
    & (Join-Path $PSScriptRoot "install_command.ps1")
}

function Assert-ServicePathHardened {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $Acl = Get-Acl -LiteralPath $Resolved
    $UnsafeIdentities = @(
        "Everyone",
        "BUILTIN\Users",
        "NT AUTHORITY\Authenticated Users",
        "Authenticated Users",
        "Users"
    )
    $WriteRights = [System.Security.AccessControl.FileSystemRights]::Write `
        -bor [System.Security.AccessControl.FileSystemRights]::Modify `
        -bor [System.Security.AccessControl.FileSystemRights]::FullControl `
        -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles `
        -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories `
        -bor [System.Security.AccessControl.FileSystemRights]::WriteData `
        -bor [System.Security.AccessControl.FileSystemRights]::AppendData `
        -bor [System.Security.AccessControl.FileSystemRights]::Delete `
        -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions `
        -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership

    foreach ($Rule in $Acl.Access) {
        if ($Rule.AccessControlType -ne "Allow") {
            continue
        }
        $Identity = [string]$Rule.IdentityReference
        $GrantsWrite = (($Rule.FileSystemRights -band $WriteRights) -ne 0)
        if ($GrantsWrite -and ($UnsafeIdentities -contains $Identity)) {
            throw "Refusing -AsService: $Resolved grants write-like access to $Identity. Move Monarch Security to an admin-owned directory or harden ACLs before installing a SYSTEM task."
        }
    }
}

if ($AsService) {
    $TaskName = "MonarchSecurityProtector"
    Assert-ServicePathHardened -Path $Root
    Assert-ServicePathHardened -Path $Venv
    $Action = New-ScheduledTaskAction -Execute "$Venv\Scripts\python.exe" -Argument "-m monarch_security start --no-llm" -WorkingDirectory $Root
    $Trigger = New-ScheduledTaskTrigger -AtStartup
    $Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Force
    Write-Host "Service $TaskName installed and will run as SYSTEM on startup."
}

& $Python -m monarch_security diagnose
Assert-CommandSuccess "Monarch Security diagnostics"
