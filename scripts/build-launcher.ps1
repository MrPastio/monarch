$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$source = Join-Path $root 'tools\launcher\MonarchLauncher.cs'
$output = Join-Path $root 'Monarch.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $compiler)) {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}

if (-not (Test-Path $compiler)) {
  throw 'Could not find the .NET Framework C# compiler.'
}

& $compiler `
  /nologo `
  /target:winexe `
  /out:$output `
  /win32icon:"$(Join-Path $root 'assets\icon.ico')" `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll `
  /reference:System.Windows.Forms.dll `
  $source

Write-Host "Built $output"
