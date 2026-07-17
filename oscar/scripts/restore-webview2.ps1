$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DestDir = Join-Path $Root "desktop"

Write-Host "Creating desktop folder if needed..."
if (-not (Test-Path -Path $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir -Force
}

$PackageUrl = "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2207.122"
$TempZip = Join-Path $env:TEMP "webview2.zip"

Write-Host "Downloading Microsoft.Web.WebView2 NuGet package..."
Invoke-WebRequest -Uri $PackageUrl -OutFile $TempZip -UseBasicParsing

Write-Host "Extracting libraries to $DestDir..."
$TempExtract = Join-Path $env:TEMP "webview2_extract"
if (Test-Path -Path $TempExtract) {
    Remove-Item -Recurse -Force $TempExtract
}
New-Item -ItemType Directory -Path $TempExtract -Force

Expand-Archive -Path $TempZip -DestinationPath $TempExtract -Force

# Copy core DLLs
Copy-Item -Path (Join-Path $TempExtract "lib\net45\Microsoft.Web.WebView2.Core.dll") -Destination $DestDir -Force
Copy-Item -Path (Join-Path $TempExtract "lib\net45\Microsoft.Web.WebView2.WinForms.dll") -Destination $DestDir -Force
Copy-Item -Path (Join-Path $TempExtract "lib\net45\Microsoft.Web.WebView2.Wpf.dll") -Destination $DestDir -Force

# Copy native loader (x64)
Copy-Item -Path (Join-Path $TempExtract "build\native\x64\WebView2Loader.dll") -Destination $DestDir -Force

# Clean up
Remove-Item -Recurse -Force $TempExtract
Remove-Item -Force $TempZip

Write-Host "WebView2 libraries successfully restored to $DestDir"
