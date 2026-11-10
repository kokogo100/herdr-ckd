@echo off
setlocal
cd /d "%~dp0"
set "HERDR_APP_ROOT=%~dp0"
if not exist "dist\src\ui-server.js" (
  echo [Herdr CKD] Building TypeScript sources...
  call npm run build
)
if "%~1"=="--verify-only" (
  node "dist\src\ui-server.js" %*
  exit /b %ERRORLEVEL%
)
start "" /b node "dist\src\ui-server.js" %*
