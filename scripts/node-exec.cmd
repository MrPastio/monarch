@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set /p NODE_VERSION=<"%SCRIPT_DIR%..\.node-version"
for %%I in ("%SCRIPT_DIR%..\.tools\node-v%NODE_VERSION%-win-x64") do set "NODE_DIR=%%~fI"

powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ensure-node.ps1" -Install -Quiet
if errorlevel 1 exit /b %errorlevel%

set "PATH=%NODE_DIR%;%PATH%"
if "%~1"=="" (
  "%NODE_DIR%\node.exe" -v
  exit /b %errorlevel%
)

call %*
exit /b %errorlevel%
