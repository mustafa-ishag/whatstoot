#!/bin/bash
##############################################
# WhatsToot Bot — تشغيل يدوي (Linux)
#
# بديل start-bot.bat لنظام Linux
# للتشغيل كخدمة، استخدم systemd بدلاً من هذا السكريبت
#
# الاستخدام: bash start-bot.sh
##############################################

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🤖 WhatsToot Bot — Starting...        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# =============================================
# فحص المتطلبات
# =============================================

echo "📋 فحص المتطلبات..."

# Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js غير مثبت!"
    echo "   sudo apt install nodejs npm"
    exit 1
fi
echo "  ✅ Node.js $(node -v)"

# PHP
if ! command -v php &> /dev/null; then
    echo "❌ PHP غير مثبت!"
    echo "   sudo apt install php8.1-cli php8.1-sqlite3 php8.1-curl php8.1-mbstring"
    exit 1
fi
echo "  ✅ PHP $(php -v | head -1 | cut -d' ' -f2)"

# Composer dependencies
if [ ! -d "vendor" ]; then
    echo "⚠️  مجلد vendor غير موجود. جاري تثبيت التبعيات..."
    composer install --no-dev --optimize-autoloader
fi

# Node.js dependencies
if [ ! -d "node-bot/node_modules" ]; then
    echo "⚠️  node_modules غير موجود. جاري تثبيت التبعيات..."
    cd node-bot && npm install --production && cd ..
fi

# .env file
if [ ! -f ".env" ]; then
    echo "⚠️  ملف .env غير موجود. جاري النسخ من .env.example..."
    cp .env.example .env
    echo "   ⚠️  يجب تعديل .env بإعداداتك!"
fi

echo ""

# =============================================
# إنشاء المجلدات المطلوبة
# =============================================
mkdir -p storage/temp storage/logs database

# =============================================
# تشغيل Node.js WhatsApp Bot
# =============================================
echo "🚀 تشغيل WhatsApp Bot (Node.js)..."
cd node-bot
node server.js &
NODE_PID=$!
cd ..

# انتظار تهيئة Node.js
sleep 3

# =============================================
# تشغيل PHP Queue Worker
# =============================================
echo "🚀 تشغيل Queue Worker (PHP)..."
php worker.php &
WORKER_PID=$!

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ Bot started successfully!           ║"
echo "╠══════════════════════════════════════════╣"
echo "║   Node.js Bot PID: $NODE_PID"
echo "║   PHP Worker PID:  $WORKER_PID"
echo "║                                          ║"
echo "║   Node API: http://localhost:3000/status  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "اضغط Ctrl+C لإيقاف البوت..."

# =============================================
# معالجة إيقاف العمليات
# =============================================
cleanup() {
    echo ""
    echo "⏹️  إيقاف البوت..."
    kill $NODE_PID 2>/dev/null || true
    kill $WORKER_PID 2>/dev/null || true
    echo "✅ تم إيقاف جميع العمليات."
    exit 0
}

trap cleanup SIGINT SIGTERM

# انتظار حتى يتوقف أحد العمليتين
wait -n $NODE_PID $WORKER_PID 2>/dev/null

echo "⚠️  إحدى العمليات توقفت!"
cleanup
