#!/bin/bash
##############################################
# WhatsToot Bot — تشغيل (Linux)
#
# الاستخدام: bash start-bot.sh
##############################################

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🤖 WhatsToot Bot v2.0 — Starting...   ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# =============================================
# فحص المتطلبات
# =============================================

echo "📋 فحص المتطلبات..."

# Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js غير مثبت!"
    echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "   sudo apt install -y nodejs"
    exit 1
fi
echo "  ✅ Node.js $(node -v)"

# Node.js dependencies
if [ ! -d "node_modules" ]; then
    echo "⚠️  node_modules غير موجود. جاري تثبيت التبعيات..."
    npm install --production
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
# تشغيل التطبيق
# =============================================
echo "🚀 تشغيل WhatsToot Bot..."
node server.js
