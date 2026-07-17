@echo off
set "ROOT=%~dp0"
set "PYTHON=%ROOT%.venv\Scripts\python.exe"
set "CONFIG=%ROOT%config\monarch_security.toml"
if not exist "%PYTHON%" (
  echo Runtime is missing. Run scripts\setup_runtime.ps1 first.
  exit /b 1
)
set "PYTHONPATH=%ROOT%src"
set "PYTHONUTF8=1"
"%PYTHON%" -m monarch_security --config "%CONFIG%" %*
exit /b %ERRORLEVEL%
