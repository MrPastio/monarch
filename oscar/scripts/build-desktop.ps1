$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Source = Join-Path $Root "desktop\OscarDesktop.cs"
$Output = Join-Path $Root "Oscar.exe"
$WebViewCore = Join-Path $Root "desktop\Microsoft.Web.WebView2.Core.dll"
$WebViewWinForms = Join-Path $Root "desktop\Microsoft.Web.WebView2.WinForms.dll"
$WebViewLoader = Join-Path $Root "desktop\WebView2Loader.dll"
$Compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path -LiteralPath $Compiler)) {
    $Compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}

if (-not (Test-Path -LiteralPath $Compiler)) {
    throw "C# compiler was not found. Build on Windows with .NET Framework csc.exe available."
}

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Desktop source was not found: $Source"
}

& $Compiler `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /codepage:65001 `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    /reference:$WebViewCore `
    /reference:$WebViewWinForms `
    /out:$Output `
    $Source

Copy-Item -LiteralPath $WebViewCore -Destination $Root -Force
Copy-Item -LiteralPath $WebViewWinForms -Destination $Root -Force
Copy-Item -LiteralPath $WebViewLoader -Destination $Root -Force

Write-Host "Built desktop app: $Output"
