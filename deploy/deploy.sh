#!/bin/bash
##############################################
# WhatsToot Bot — VPS Deployment Script
#
# الاستخدام: bash deploy/deploy.sh
##############################################

set -e

APP_DIR="/opt/whatstoot"
APP_USER="whatstoot"
NODE_VERSION="20"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🚀 WhatsToot Bot v2.0 — Deployment    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# =============================================
# 1. تثبيت Node.js
# =============================================
if ! command -v node &> /dev/null; then
    echo "📦 تثبيت Node.js ${NODE_VERSION}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "✅ Node.js $(node -v)"

# =============================================
# 2. إنشاء مستخدم التطبيق
# =============================================
if ! id "$APP_USER" &>/dev/null; then
    echo "👤 إنشاء مستخدم ${APP_USER}..."
    sudo useradd -r -s /bin/false -d "$APP_DIR" "$APP_USER"
fi

# =============================================
# 3. إعداد المجلدات
# =============================================
echo "📁 إعداد المجلدات..."
sudo mkdir -p "$APP_DIR"
sudo cp -r . "$APP_DIR/"
sudo mkdir -p "$APP_DIR/storage/temp" "$APP_DIR/storage/logs" "$APP_DIR/database"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# =============================================
# 4. تثبيت التبعيات
# =============================================
echo "📦 تثبيت التبعيات..."
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --production

# =============================================
# 5. إعداد ملف .env
# =============================================
if [ ! -f "$APP_DIR/.env" ]; then
    sudo cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo "⚠️  يجب تعديل $APP_DIR/.env بإعداداتك!"
fi

# =============================================
# 6. إنشاء خدمة systemd
# =============================================
echo "🔧 إنشاء خدمة systemd..."
sudo tee /etc/systemd/system/whatstoot.service > /dev/null << EOF
[Unit]
Description=WhatsToot Bot v2.0
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(which node) ${APP_DIR}/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=whatstoot

# Security
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# =============================================
# 7. تفعيل وتشغيل الخدمة
# =============================================
echo "🚀 تشغيل الخدمة..."
sudo systemctl daemon-reload
sudo systemctl enable whatstoot
sudo systemctl restart whatstoot

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ Deployment Complete!               ║"
echo "╠══════════════════════════════════════════╣"
echo "║   📡 http://YOUR_VPS_IP:3000            ║"
echo "║                                          ║"
echo "║   أوامر مفيدة:                          ║"
echo "║   systemctl status whatstoot             ║"
echo "║   journalctl -u whatstoot -f             ║"
echo "║   systemctl restart whatstoot            ║"
echo "╚══════════════════════════════════════════╝"
echo ""
