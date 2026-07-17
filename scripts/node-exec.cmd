@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set /p NODE_VERSION=<"%SCRIPT_DIR%..\.node-version"
set "NODE_DIR=%SCRIPT_DIR%..\.tools\node-v%NODE_VERSION%-win-x64"

powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ensure-node.ps1" -Install -Quiet
if errorlevel 1 exit /b %errorlevel%

set "PATH=%NODE_DIR%;%PATH%"
if "%~1"=="" (
  "%NODE_DIR%\node.exe" -v
  exit /b %errorlevel%
)

%*
exit /b %errorlevel%
