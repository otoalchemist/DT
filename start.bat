@echo off
cd /d "%~dp0"

node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit((major===20&&minor>=19)||(major===22&&minor>=12)||major>=24?0:1)" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Supported Node.js versions are 20.19+, 22.12+, or 24+.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

:: The launcher runs the development orchestrator, so explicitly retain its
:: dev-only dependencies even when NODE_ENV/npm omit settings request production.
:: npm install remains incremental and reconciles upgraded manifests.
echo Checking dependencies...
call npm run install:launcher
if errorlevel 1 (
    echo.
    echo ERROR: dependency installation failed. Use Node.js 20.19+, 22.12+, or 24+.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

:: Vite uses strict port binding and both servers report a clear error if their
:: configured port is already in use. Never terminate unrelated processes here.

start "Death & Taxes Bot" cmd /k "npm run dev"
timeout /t 6 /nobreak >nul
start http://localhost:5173
