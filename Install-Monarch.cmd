@echo off
setlocal
set "ROOT=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%installer\bootstrap.ps1"
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo Monarch installation failed with exit code %RESULT%.
  pause
  exit /b %RESULT%
)

echo.
echo Monarch is ready. Start it with Monarch.exe.
pause
