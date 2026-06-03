# 🚀 دليل نشر WhatsToot على VPS

## 📋 المتطلبات

| المتطلب | الحد الأدنى |
|---------|-------------|
| نظام التشغيل | Ubuntu 20.04+ / Debian 11+ |
| RAM | 1 GB (يُفضل 2 GB) |
| التخزين | 10 GB+ |
| PHP | 8.1+ مع الإضافات: `pdo_sqlite`, `curl`, `mbstring`, `fileinfo`, `json` |
| Node.js | 18+ |
| Nginx | أي إصدار حديث |
| Composer | 2.x |

---

## ⚡ التثبيت السريع (أمر واحد)

```bash
# 1. انسخ المشروع للسيرفر
git clone <your-repo-url> /var/www/whatstoot

# 2. شغّل سكريبت النشر
cd /var/www/whatstoot
sudo bash deploy/deploy.sh
```

سيقوم سكريبت النشر بـ:
- تثبيت جميع المتطلبات (PHP, Node.js, Nginx, Composer)
- إعداد المجلدات والصلاحيات
- تثبيت التبعيات (`composer install`, `npm install`)
- إعداد Nginx وخدمات systemd
- إنشاء قاعدة البيانات

---

## 📝 التثبيت اليدوي (خطوة بخطوة)

### 1. تثبيت المتطلبات

```bash
# تحديث النظام
sudo apt update && sudo apt upgrade -y

# PHP 8.1 + الإضافات
sudo apt install -y php8.1-fpm php8.1-cli php8.1-sqlite3 php8.1-curl php8.1-mbstring php8.1-xml php8.1-fileinfo

# Nginx
sudo apt install -y nginx

# Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs

# Composer
curl -sS https://getcomposer.org/installer | sudo php -- --install-dir=/usr/local/bin --filename=composer

# أدوات إضافية
sudo apt install -y sqlite3 git unzip curl
```

### 2. نسخ المشروع

```bash
# عبر Git
git clone <your-repo-url> /var/www/whatstoot

# أو عبر SCP من جهازك المحلي
scp -r ./whatstoot/* user@your-vps:/var/www/whatstoot/

# أو عبر rsync (الأفضل للتحديثات)
rsync -avz --exclude='node_modules' --exclude='vendor' --exclude='.env' \
  ./whatstoot/ user@your-vps:/var/www/whatstoot/
```

### 3. تثبيت التبعيات

```bash
cd /var/www/whatstoot

# PHP (بدون dev dependencies)
composer install --no-dev --optimize-autoloader

# Node.js
cd node-bot
npm install --production
cd ..
```

### 4. إعداد ملف البيئة

```bash
# نسخ الملف النموذجي
cp .env.example .env

# تعديل الإعدادات
nano .env
```

**إعدادات مهمة يجب تعديلها:**

```env
# البيئة
APP_ENV=production
APP_URL=http://your-domain.com
APP_DEBUG=false

# التخزين
STORAGE_ENGINE=synology
SYNOLOGY_URL=https://your-nas.quickconnect.to
SYNOLOGY_USER=your_username
SYNOLOGY_PASS=your_password
SYNOLOGY_BASE_PATH="/path/to/work_orders"

# API Key — استخدم مفتاح عشوائي قوي
NODE_BOT_API_KEY=your_random_secure_key_here

# مسار PHP API (على VPS عبر Nginx)
PHP_API_URL=http://localhost/api
```

> ⚠️ **تأكد من تغيير `NODE_BOT_API_KEY` لقيمة عشوائية قوية:**
> ```bash
> openssl rand -hex 32
> ```

### 5. إنشاء المجلدات وقاعدة البيانات

```bash
# إنشاء المجلدات
mkdir -p storage/temp storage/logs database credentials

# إنشاء قاعدة البيانات
sqlite3 database/bot.sqlite < database/schema.sql
```

### 6. ضبط الصلاحيات

```bash
# المالك
sudo chown -R www-data:www-data /var/www/whatstoot

# مجلدات قابلة للكتابة
sudo chmod -R 775 storage/ database/

# ملفات حساسة
sudo chmod 600 .env
sudo chmod -R 600 credentials/
```

### 7. إعداد Nginx

```bash
# نسخ إعدادات Nginx
sudo cp deploy/nginx/whatstoot.conf /etc/nginx/sites-available/whatstoot

# تعديل الدومين (استبدل whatstoot.example.com بدومينك)
sudo nano /etc/nginx/sites-available/whatstoot

# تفعيل الموقع
sudo ln -s /etc/nginx/sites-available/whatstoot /etc/nginx/sites-enabled/

# إزالة الموقع الافتراضي (اختياري)
sudo rm -f /etc/nginx/sites-enabled/default

# فحص الإعدادات
sudo nginx -t

# إعادة تشغيل
sudo systemctl reload nginx
```

### 8. إعداد PHP-FPM

```bash
# زيادة حجم الرفع
sudo nano /etc/php/8.1/fpm/php.ini
```

عدّل القيم التالية:
```ini
upload_max_filesize = 50M
post_max_size = 50M
max_execution_time = 120
memory_limit = 256M
```

```bash
sudo systemctl restart php8.1-fpm
```

### 9. إعداد خدمات systemd

```bash
# نسخ ملفات الخدمات
sudo cp deploy/systemd/whatstoot-bot.service /etc/systemd/system/
sudo cp deploy/systemd/whatstoot-worker.service /etc/systemd/system/

# إعادة تحميل systemd
sudo systemctl daemon-reload

# تفعيل التشغيل التلقائي عند الإقلاع
sudo systemctl enable whatstoot-bot
sudo systemctl enable whatstoot-worker

# تشغيل الخدمات
sudo systemctl start whatstoot-bot
sudo systemctl start whatstoot-worker
```

---

## 🔒 إعداد SSL (HTTPS)

```bash
# تثبيت Certbot
sudo apt install -y certbot python3-certbot-nginx

# الحصول على شهادة SSL
sudo certbot --nginx -d your-domain.com

# التجديد التلقائي (يضاف تلقائياً)
sudo certbot renew --dry-run
```

بعد تفعيل SSL، حدّث ملف `.env`:
```env
APP_URL=https://your-domain.com
```

---

## 📊 مراقبة الخدمات

### حالة الخدمات

```bash
# حالة بوت واتساب
sudo systemctl status whatstoot-bot

# حالة PHP Worker
sudo systemctl status whatstoot-worker

# حالة Nginx
sudo systemctl status nginx
```

### السجلات

```bash
# سجلات بوت واتساب (مباشر)
sudo journalctl -u whatstoot-bot -f

# سجلات PHP Worker (مباشر)
sudo journalctl -u whatstoot-worker -f

# سجلات Nginx
sudo tail -f /var/log/nginx/whatstoot_error.log

# سجلات التطبيق
tail -f /var/www/whatstoot/storage/logs/$(date +%Y-%m-%d).log
```

### إعادة التشغيل

```bash
# إعادة تشغيل كل الخدمات
sudo systemctl restart whatstoot-bot
sudo systemctl restart whatstoot-worker

# إعادة تشغيل بعد تعديل .env
sudo systemctl restart whatstoot-bot whatstoot-worker
```

---

## 🔄 التحديث

```bash
cd /var/www/whatstoot

# سحب آخر التحديثات
git pull origin main

# تحديث التبعيات
composer install --no-dev --optimize-autoloader
cd node-bot && npm install --production && cd ..

# ضبط الصلاحيات
sudo chown -R www-data:www-data .

# إعادة تشغيل الخدمات
sudo systemctl restart whatstoot-bot whatstoot-worker
```

---

## 🛠️ استكشاف الأخطاء

### البوت لا يبدأ

```bash
# تحقق من السجلات
sudo journalctl -u whatstoot-bot -n 50

# تشغيل يدوي للتصحيح
cd /var/www/whatstoot/node-bot
sudo -u www-data node server.js
```

### PHP API لا يعمل

```bash
# تحقق من PHP-FPM
sudo systemctl status php8.1-fpm

# تحقق من Nginx
sudo nginx -t
sudo systemctl status nginx

# اختبار PHP
php -r "echo 'PHP works';"
```

### أخطاء الصلاحيات

```bash
# إعادة ضبط الصلاحيات
sudo chown -R www-data:www-data /var/www/whatstoot
sudo chmod -R 775 /var/www/whatstoot/storage
sudo chmod -R 775 /var/www/whatstoot/database
```

### قاعدة البيانات مقفلة (SQLite Lock)

```bash
# تحقق من عدم وجود عمليات عالقة
fuser /var/www/whatstoot/database/bot.sqlite

# إعادة تعيين قفل WAL
sqlite3 /var/www/whatstoot/database/bot.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
```

---

## 📁 هيكل المشروع على VPS

```
/var/www/whatstoot/
├── api/                    # PHP API endpoints
├── config/                 # إعدادات التطبيق
├── credentials/            # ملفات المصادقة (600)
├── database/               # قاعدة بيانات SQLite (775)
├── deploy/                 # ملفات النشر
│   ├── nginx/              # إعدادات Nginx
│   ├── systemd/            # خدمات systemd
│   └── deploy.sh           # سكريبت النشر
├── node-bot/               # بوت واتساب (Node.js)
├── public/                 # Document Root (Nginx)
│   ├── assets/             # CSS + JS
│   ├── index.php           # لوحة التحكم
│   └── api-proxy.php       # وسيط API
├── src/                    # كلاسات PHP
├── storage/                # ملفات مؤقتة وسجلات (775)
├── vendor/                 # تبعيات Composer
├── .env                    # إعدادات البيئة (600)
├── start-bot.sh            # تشغيل يدوي
└── worker.php              # معالج الطابور
```

---

## 🔐 ملاحظات أمنية

1. **لا ترفع `.env` لـ Git** — يحتوي بيانات حساسة
2. **استخدم API Key قوي** — `openssl rand -hex 32`
3. **فعّل SSL** — Let's Encrypt مجاني
4. **أغلق المنافذ** — فقط 80, 443, و22 (SSH)
5. **حدّث النظام** — `sudo apt update && sudo apt upgrade`
6. **Firewall** — فعّل UFW:
   ```bash
   sudo ufw allow ssh
   sudo ufw allow 'Nginx Full'
   sudo ufw enable
   ```
