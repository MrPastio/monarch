# VM-only preparation for the Security emergency acceptance test.
# Existing directories and registered executors are never replaced.
param(
  [Parameter(Mandatory = $true)][string]$PythonPath,
  [Parameter(Mandatory = $true)][string]$TestRoot,
  [switch]$ConfirmIsolatedWindowsVm
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ConfirmIsolatedWindowsVm) { throw 'Confirm an isolated, disposable Windows VM before preparation.' }
$machine = Get-CimInstance Win32_ComputerSystem
if ("$($machine.Manufacturer) $($machine.Model)" -notmatch 'VirtualBox|VMware|Virtual Machine|QEMU|KVM') {
  throw 'Emergency acceptance preparation is restricted to a Windows VM.'
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script elevated.' }
$source = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$securitySource = Join-Path $source 'security'
if ($TestRoot -notmatch '^[A-Za-z]:\\' -or $TestRoot -match '(?:^|\\)\.\.(?:\\|$)' -or ($TestRoot.Length -gt 2 -and $TestRoot.Substring(2).Contains(':'))) {
  throw 'TestRoot must be an absolute local directory without parent traversal or alternate streams.'
}
$TestRoot = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
if ($TestRoot -eq [IO.Path]::GetPathRoot($TestRoot).TrimEnd('\')) { throw 'TestRoot cannot be a volume root.' }
if (Test-Path -LiteralPath $TestRoot) { throw "TestRoot already exists; choose a new test directory: $TestRoot" }
$cursor = [IO.DirectoryInfo][IO.Path]::GetDirectoryName($TestRoot)
while ($null -ne $cursor) {
  if ($cursor.Exists -and ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "TestRoot ancestor is a reparse point: $($cursor.FullName)"
  }
  $cursor = $cursor.Parent
}
if (Get-ScheduledTask -TaskName 'MonarchSecurityResponseExecutor' -ErrorAction SilentlyContinue) {
  throw 'An executor is already registered; use a fresh test VM.'
}
$PythonPath = (Get-Item -LiteralPath $PythonPath -ErrorAction Stop).FullName
$pythonSource = Split-Path -Parent $PythonPath
if ((Split-Path -Leaf $PythonPath) -ne 'python.exe' -or (Test-Path -LiteralPath (Join-Path $pythonSource 'pyvenv.cfg'))) {
  throw 'Supply a standalone Python distribution, not a virtualenv or a launcher.'
}
foreach ($inputRoot in @($pythonSource, (Join-Path $securitySource 'src\monarch_security'))) {
  foreach ($inputItem in @(Get-Item -LiteralPath $inputRoot) + @(Get-ChildItem -LiteralPath $inputRoot -Recurse -Force)) {
    if (($inputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Input reparse point: $($inputItem.FullName)" }
  }
}
foreach ($required in @('src\monarch_security', 'run_monarch_security.py')) {
  if (-not (Test-Path -LiteralPath (Join-Path $securitySource $required))) { throw "Security source is missing: $required" }
}
$testConfig = Join-Path $PSScriptRoot 'emergency-test.toml'
if (-not (Test-Path -LiteralPath $testConfig)) { throw 'Isolated emergency-test.toml is missing.' }
$TargetRoot = Join-Path $TestRoot 'runtime'
$DataRoot = Join-Path $TestRoot 'data'
$LogsRoot = Join-Path $TestRoot 'logs'

# Protected parent prevents a medium-integrity user from replacing the runtime.
New-Item -ItemType Directory -Path $TestRoot | Out-Null
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$testUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [Security.AccessControl.PropagationFlags]::None
$acl.SetOwner($admins)
foreach ($sid in @($admins, $system)) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $none, 'Allow')))
}
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($testUser, 'ReadAndExecute', $inherit, $none, 'Allow')))
Set-Acl -LiteralPath $TestRoot -AclObject $acl
New-Item -ItemType Directory -Path $TargetRoot, $DataRoot, $LogsRoot | Out-Null
foreach ($writableRoot in @($DataRoot, $LogsRoot)) {
  $dataAcl = Get-Acl -LiteralPath $writableRoot
  $dataAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($testUser, 'FullControl', $inherit, $none, 'Allow')))
  Set-Acl -LiteralPath $writableRoot -AclObject $dataAcl
}

New-Item -ItemType Directory -Path (Join-Path $TargetRoot 'src'), (Join-Path $TargetRoot 'config') | Out-Null
robocopy $pythonSource (Join-Path $TargetRoot 'python') /E /XJ /XD __pycache__ /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Python runtime copy failed: $LASTEXITCODE" }
robocopy (Join-Path $securitySource 'src\monarch_security') (Join-Path $TargetRoot 'src\monarch_security') /E /XD __pycache__ /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Source copy failed: $LASTEXITCODE" }
Copy-Item -LiteralPath $testConfig -Destination (Join-Path $TargetRoot 'config\monarch_security.toml')
Copy-Item -LiteralPath (Join-Path $securitySource 'run_monarch_security.py') -Destination $TargetRoot
# Copied items inherit the protected ACL; make ownership explicit.
foreach ($runtimeItem in @(Get-Item -LiteralPath $TargetRoot) + @(Get-ChildItem -LiteralPath $TargetRoot -Recurse -Force)) {
  if (($runtimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Runtime reparse point: $($runtimeItem.FullName)" }
  $itemAcl = Get-Acl -LiteralPath $runtimeItem.FullName
  $itemAcl.SetOwner($admins)
  Set-Acl -LiteralPath $runtimeItem.FullName -AclObject $itemAcl
}

$env:MONARCH_DATA_ROOT = ''
$env:MONARCH_LOGS_ROOT = ''
$env:MONARCH_SECURITY_SITE_PACKAGES = ''
$env:MONARCH_SECURITY_DATA_ROOT = $DataRoot
$env:MONARCH_SECURITY_LOGS_ROOT = $LogsRoot
$env:PYTHONPATH = ''
$PythonPath = Join-Path $TargetRoot 'python\python.exe'
& $PythonPath -B (Join-Path $TargetRoot 'run_monarch_security.py') --config (Join-Path $TargetRoot 'config\monarch_security.toml') response-service-install --confirm-service-install
if ($LASTEXITCODE -ne 0) { throw "Executor install failed: $LASTEXITCODE" }
[pscustomobject]@{ TestRoot = $TestRoot; RuntimeRoot = $TargetRoot; DataRoot = $DataRoot; LogsRoot = $LogsRoot }
