#!/bin/bash
##############################################
# WhatsToot — سكريبت النشر على VPS
#
# الاستخدام:
#   chmod +x deploy.sh
#   sudo bash deploy.sh
#
# يقوم هذا السكريبت بـ:
#   1. تثبيت متطلبات النظام
#   2. إعداد المشروع
#   3. إعداد Nginx
#   4. إعداد خدمات systemd
#   5. ضبط الصلاحيات
#
# ⚠️ يجب تشغيله كـ root أو بـ sudo
##############################################

set -e

# =============================================
# ⚙️ إعدادات النشر — عدّل حسب حاجتك
# =============================================
APP_DIR="/var/www/whatstoot"
APP_USER="www-data"
APP_GROUP="www-data"
DOMAIN="whatstoot.example.com"  # ← غيّر هذا بدومينك
# تحديد إصدار PHP تلقائياً حسب نظام التشغيل إذا لم يتم تمريره كمتغير بيئة
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [ "$ID" = "ubuntu" ] && [ "$VERSION_ID" = "24.04" ]; then
        DEFAULT_PHP="8.3"
    elif [ "$ID" = "debian" ] && [ "$VERSION_ID" = "12" ]; then
        DEFAULT_PHP="8.2"
    else
        DEFAULT_PHP="8.1"
    fi
else
    DEFAULT_PHP="8.1"
fi

PHP_VERSION="${PHP_VERSION:-$DEFAULT_PHP}"               # ← تم التحديد تلقائياً (يمكنك تجاوزه بتمرير قيمة)

# =============================================
# ألوان المخرجات
# =============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error()   { echo -e "${RED}❌ $1${NC}"; }
log_step()    { echo -e "\n${BLUE}═══════════════════════════════════════${NC}"; echo -e "${BLUE}📌 $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════${NC}"; }

# =============================================
# فحص المستخدم
# =============================================
if [ "$EUID" -ne 0 ]; then
    log_error "يجب تشغيل هذا السكريبت كـ root (sudo bash deploy.sh)"
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🚀 WhatsToot — بدء النشر على VPS      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  📁 مسار التثبيت: $APP_DIR"
echo "  🌐 الدومين: $DOMAIN"
echo "  🐘 PHP Version: $PHP_VERSION"
echo ""

read -p "هل تريد المتابعة؟ (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_info "تم الإلغاء."
    exit 0
fi

# =============================================
# 1. تحديث النظام وتثبيت المتطلبات
# =============================================
log_step "1. تثبيت متطلبات النظام"

apt update -y
apt install -y \
    nginx \
    php${PHP_VERSION}-fpm \
    php${PHP_VERSION}-cli \
    php${PHP_VERSION}-sqlite3 \
    php${PHP_VERSION}-curl \
    php${PHP_VERSION}-mbstring \
    php${PHP_VERSION}-xml \
    php${PHP_VERSION}-fileinfo \
    curl \
    git \
    unzip \
    sqlite3 \
    libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 libasound2t64

log_success "تم تثبيت حزم PHP و Nginx"

# Node.js (v18 LTS أو أحدث)
if ! command -v node &> /dev/null; then
    log_info "تثبيت Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt install -y nodejs
fi
log_success "Node.js $(node -v)"

# Composer
if ! command -v composer &> /dev/null; then
    log_info "تثبيت Composer..."
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
fi
log_success "Composer $(composer --version --no-ansi 2>/dev/null | head -1)"

# =============================================
# 2. إعداد مجلد المشروع
# =============================================
log_step "2. إعداد مجلد المشروع"

if [ ! -d "$APP_DIR" ]; then
    mkdir -p "$APP_DIR"
    log_info "تم إنشاء المجلد: $APP_DIR"
    log_warning "يجب نسخ ملفات المشروع إلى $APP_DIR"
    log_info "استخدم أحد الطرق:"
    log_info "  git clone <repo_url> $APP_DIR"
    log_info "  scp -r ./whatstoot/* user@vps:$APP_DIR/"
    log_info "  rsync -avz ./whatstoot/ user@vps:$APP_DIR/"
else
    log_success "مجلد المشروع موجود: $APP_DIR"
fi

# إنشاء المجلدات المطلوبة
mkdir -p "$APP_DIR/storage/temp"
mkdir -p "$APP_DIR/storage/logs"
mkdir -p "$APP_DIR/database"
mkdir -p "$APP_DIR/credentials"
mkdir -p "$APP_DIR/node-bot/.wwebjs_auth"
mkdir -p "$APP_DIR/node-bot/.wwebjs_cache"
log_success "تم إنشاء المجلدات المطلوبة"

# =============================================
# 3. تثبيت التبعيات
# =============================================
log_step "3. تثبيت التبعيات"

if [ -f "$APP_DIR/composer.json" ]; then
    cd "$APP_DIR"
    composer install --no-dev --optimize-autoloader --no-interaction
    log_success "تم تثبيت تبعيات PHP (Composer)"
fi

if [ -f "$APP_DIR/node-bot/package.json" ]; then
    cd "$APP_DIR/node-bot"
    # تحديد مسار تحميل متصفح Puppeteer داخل المشروع لتفادي مشاكل الصلاحيات
    PUPPETEER_CACHE_DIR="$APP_DIR/node-bot/.wwebjs_cache/puppeteer" npm install --production
    log_success "تم تثبيت تبعيات Node.js (npm)"
fi

# =============================================
# 4. إعداد ملف البيئة
# =============================================
log_step "4. إعداد ملف البيئة"

if [ ! -f "$APP_DIR/.env" ]; then
    if [ -f "$APP_DIR/.env.example" ]; then
        cp "$APP_DIR/.env.example" "$APP_DIR/.env"
        log_success "تم إنشاء .env من .env.example"
        log_warning "⚠️  يجب تعديل ملف .env بإعداداتك الفعلية!"
        log_info "  nano $APP_DIR/.env"
    else
        log_error "ملف .env.example غير موجود!"
    fi
else
    log_success "ملف .env موجود"
fi

# =============================================
# 5. إعداد قاعدة البيانات
# =============================================
log_step "5. إعداد قاعدة البيانات"

if [ -f "$APP_DIR/database/schema.sql" ]; then
    sqlite3 "$APP_DIR/database/bot.sqlite" < "$APP_DIR/database/schema.sql"
    log_success "تم تطبيق schema على قاعدة البيانات"
fi

# =============================================
# 6. ضبط الصلاحيات
# =============================================
log_step "6. ضبط صلاحيات الملفات"

chown -R $APP_USER:$APP_GROUP "$APP_DIR"

# مجلدات قابلة للكتابة
chmod -R 775 "$APP_DIR/storage"
chmod -R 775 "$APP_DIR/database"
chmod -R 775 "$APP_DIR/node-bot/.wwebjs_auth" 2>/dev/null || true
chmod -R 775 "$APP_DIR/node-bot/.wwebjs_cache" 2>/dev/null || true

# ملفات حساسة — القراءة فقط للمالك
chmod 600 "$APP_DIR/.env" 2>/dev/null || true
chmod -R 600 "$APP_DIR/credentials/"* 2>/dev/null || true

# سكريبتات قابلة للتنفيذ
chmod +x "$APP_DIR/start-bot.sh" 2>/dev/null || true
chmod +x "$APP_DIR/deploy/deploy.sh" 2>/dev/null || true

log_success "تم ضبط الصلاحيات"

# =============================================
# 7. إعداد Nginx
# =============================================
log_step "7. إعداد Nginx"

NGINX_CONF="$APP_DIR/deploy/nginx/whatstoot.conf"
if [ -f "$NGINX_CONF" ]; then
    # تحديث المسارات والدومين في الملف
    sed -i "s|/var/www/whatstoot|$APP_DIR|g" "$NGINX_CONF"
    sed -i "s|whatstoot.example.com|$DOMAIN|g" "$NGINX_CONF"
    sed -i "s|php8.1-fpm|php${PHP_VERSION}-fpm|g" "$NGINX_CONF"

    cp "$NGINX_CONF" /etc/nginx/sites-available/whatstoot
    ln -sf /etc/nginx/sites-available/whatstoot /etc/nginx/sites-enabled/whatstoot

    # إزالة الموقع الافتراضي إذا كان موجوداً
    rm -f /etc/nginx/sites-enabled/default

    # فحص الإعدادات
    if nginx -t; then
        systemctl reload nginx
        log_success "تم إعداد Nginx بنجاح"
    else
        log_error "خطأ في إعدادات Nginx!"
    fi
else
    log_warning "ملف إعدادات Nginx غير موجود: $NGINX_CONF"
fi

# =============================================
# 8. إعداد خدمات systemd
# =============================================
log_step "8. إعداد خدمات systemd"

SYSTEMD_DIR="$APP_DIR/deploy/systemd"

for SERVICE_FILE in whatstoot-bot.service whatstoot-worker.service; do
    if [ -f "$SYSTEMD_DIR/$SERVICE_FILE" ]; then
        # تحديث المسارات
        sed -i "s|/var/www/whatstoot|$APP_DIR|g" "$SYSTEMD_DIR/$SERVICE_FILE"
        
        cp "$SYSTEMD_DIR/$SERVICE_FILE" /etc/systemd/system/
        log_success "تم نسخ $SERVICE_FILE"
    fi
done

systemctl daemon-reload

# تفعيل الخدمات
systemctl enable whatstoot-bot
systemctl enable whatstoot-worker
log_success "تم تفعيل الخدمات"

# تشغيل الخدمات
systemctl start whatstoot-bot
systemctl start whatstoot-worker
log_success "تم تشغيل الخدمات"

# =============================================
# 9. إعداد PHP-FPM
# =============================================
log_step "9. إعداد PHP-FPM"

# زيادة حجم الملف المرفوع في php.ini
PHP_INI="/etc/php/${PHP_VERSION}/fpm/php.ini"
if [ -f "$PHP_INI" ]; then
    sed -i 's/upload_max_filesize = .*/upload_max_filesize = 50M/' "$PHP_INI"
    sed -i 's/post_max_size = .*/post_max_size = 50M/' "$PHP_INI"
    sed -i 's/max_execution_time = .*/max_execution_time = 120/' "$PHP_INI"
    sed -i 's/memory_limit = .*/memory_limit = 256M/' "$PHP_INI"
    systemctl restart php${PHP_VERSION}-fpm
    log_success "تم تحديث إعدادات PHP-FPM"
fi

# =============================================
# 🎉 انتهاء النشر
# =============================================
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🎉 تم النشر بنجاح!                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  🌐 الموقع: http://$DOMAIN"
echo "║  📁 المسار: $APP_DIR"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

log_info "الخطوات التالية:"
echo "  1. عدّل ملف .env بإعداداتك:"
echo "     sudo nano $APP_DIR/.env"
echo ""
echo "  2. (اختياري) إعداد SSL مع Let's Encrypt:"
echo "     sudo apt install certbot python3-certbot-nginx"
echo "     sudo certbot --nginx -d $DOMAIN"
echo ""
echo "  3. مراقبة الخدمات:"
echo "     sudo systemctl status whatstoot-bot"
echo "     sudo systemctl status whatstoot-worker"
echo "     sudo journalctl -u whatstoot-bot -f"
echo ""
echo "  4. إعادة تشغيل الخدمات بعد تعديل .env:"
echo "     sudo systemctl restart whatstoot-bot"
echo "     sudo systemctl restart whatstoot-worker"
echo ""
