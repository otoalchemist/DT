@echo off
cd /d "%~dp0"

:: Self-update from GitHub before anything starts, so the bot you launch is the current
:: one without re-downloading a ZIP and hand-copying data\ across. Runs BEFORE the app
:: because a Node process can't safely replace the code it's executing. Your data\ folder
:: (keystore, API key, settings) and .env are never touched, a git checkout is skipped,
:: and any failure — offline, GitHub down — leaves the current version in place and
:: continues. Set BOT_AUTO_UPDATE=off to disable.
::
:: BOT_UPDATE_FROM_LAUNCHER tells the updater that cmd.exe is executing THIS file, so a
:: change to it is staged rather than written underneath us — cmd.exe reads a batch file
:: incrementally by byte offset, so rewriting it mid-run makes the shell resume at a stale
:: offset in new bytes and execute garbage.
::
:: Written with a goto rather than a parenthesized if-block: inside a block, cmd.exe
:: substitutes %VAR% at parse time, which makes env-var handling there easy to get subtly
:: wrong. A flat sequence has no such ambiguity.
where node >nul 2>&1
if errorlevel 1 goto :skipupdate
set "BOT_UPDATE_FROM_LAUNCHER=1"
node scripts\update.mjs
set "BOT_UPDATE_FROM_LAUNCHER="
:skipupdate

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

:: Wait until the backend API (port 8787) is actually accepting connections before
:: opening the UI. The backend starts AFTER the shared build and does a network
:: round-trip before it listens, so a fixed delay often opened the dashboard too
:: early — its first API calls then hit a not-yet-listening backend and the Vite
:: proxy returned HTTP 500 until the backend caught up. Poll instead, up to ~60s.
echo Waiting for the backend to start...
set /a _tries=0
:waitbackend
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',8787); exit 0 } catch { exit 1 }" >nul 2>&1
if "%ERRORLEVEL%"=="0" goto backendready
set /a _tries+=1
if %_tries% GEQ 60 goto backendready
timeout /t 1 /nobreak >nul
goto waitbackend
:backendready
start http://localhost:5173
