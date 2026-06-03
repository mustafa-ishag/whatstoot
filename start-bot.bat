@echo off
echo WhatsToot Bot - Starting...
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed!
    echo Please download and install from: https://nodejs.org/
    pause
    exit /b 1
)

:: Start Node.js WhatsApp Bot
echo Starting WhatsApp Bot (Node.js)...
pushd "%~dp0node-bot"
start "WhatsToot - WhatsApp Bot" cmd /k "node server.js"
popd

:: Wait a moment
timeout /t 3 /nobreak >nul

:: Start PHP Queue Worker
echo Starting Queue Worker (PHP)...
set "PHP_BIN=php"
if exist "C:\xampp\php\php.exe" (
    set "PHP_BIN=C:\xampp\php\php.exe"
)
pushd "%~dp0"
start "WhatsToot - Queue Worker" cmd /k ""%PHP_BIN%" worker.php"
popd

echo.
echo Bot started successfully!
echo.
echo Dashboard: http://localhost/whatstoot/public/
echo Node API:  http://localhost:3000/status
echo.
echo Press any key to close...
pause >nul
