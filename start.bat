@echo off
cd /d "%~dp0"

:: Install dependencies on first run (or after a clean clone)
if not exist "node_modules" (
    echo Installing dependencies, this may take a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. Make sure Node.js 20+ is installed.
        echo Download it from https://nodejs.org
        pause
        exit /b 1
    )
)

:: Free ports used by a previous run
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8787 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1

start "Death & Taxes Bot" cmd /k "npm run dev"
timeout /t 6 /nobreak >nul
start http://localhost:5173
