@echo off
chcp 65001 >nul 2>&1
title WhatsToot Bot v2.0

echo.
echo ╔══════════════════════════════════════════╗
echo ║   🤖 WhatsToot Bot v2.0 — Starting...   ║
echo ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM فحص Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js غير مثبت!
    echo    حمّل من: https://nodejs.org
    pause
    exit /b 1
)
echo   ✅ Node.js detected

REM تثبيت التبعيات إذا لزم
if not exist "node_modules" (
    echo ⚠️  جاري تثبيت التبعيات...
    npm install --production
)

REM إنشاء المجلدات
if not exist "storage\temp" mkdir storage\temp
if not exist "storage\logs" mkdir storage\logs
if not exist "database" mkdir database

echo.
echo 🚀 تشغيل WhatsToot Bot...
echo.

node server.js

pause
