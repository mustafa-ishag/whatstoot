# 🚀 WhatsToot Bot v2.0 — دليل النشر

## المتطلبات

- **Node.js 18+** (يُفضل 20 LTS)
- **VPS** مع Ubuntu 22.04+ أو أي توزيعة Linux

> **ملاحظة**: لم يعد المشروع يحتاج PHP أو Apache أو Nginx. كل شيء يعمل عبر Node.js.

---

## التثبيت السريع

### 1. تثبيت Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. نسخ المشروع

```bash
cd /opt
git clone https://github.com/YOUR_REPO/whatstoot.git
cd whatstoot
```

### 3. تثبيت التبعيات

```bash
npm install --production
```

### 4. إعداد ملف البيئة

```bash
cp .env.example .env
nano .env
```

عدّل الإعدادات التالية:
- `SYNOLOGY_URL` — رابط NAS
- `SYNOLOGY_USER` — اسم المستخدم
- `SYNOLOGY_PASS` — كلمة المرور
- `SYNOLOGY_BASE_PATH` — مسار المجلد الأساسي
- `PORT` — البورت (افتراضي 3000)

### 5. إنشاء المجلدات

```bash
mkdir -p storage/temp storage/logs database
```

### 6. التشغيل

```bash
node server.js
```

---

## النشر كخدمة (systemd)

### تشغيل سكريبت النشر التلقائي:

```bash
bash deploy/deploy.sh
```

### أو يدوياً:

```bash
sudo nano /etc/systemd/system/whatstoot.service
```

```ini
[Unit]
Description=WhatsToot Bot v2.0
After=network.target

[Service]
Type=simple
User=whatstoot
WorkingDirectory=/opt/whatstoot
ExecStart=/usr/bin/node /opt/whatstoot/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatstoot
sudo systemctl start whatstoot
```

---

## الأوامر المفيدة

| الأمر | الوصف |
|-------|-------|
| `systemctl status whatstoot` | حالة الخدمة |
| `journalctl -u whatstoot -f` | متابعة اللوقات |
| `systemctl restart whatstoot` | إعادة التشغيل |
| `systemctl stop whatstoot` | إيقاف |

---

## API Endpoints

| الرابط | الوصف |
|--------|-------|
| `GET /` | لوحة التحكم |
| `GET /api/stats` | إحصائيات |
| `GET /api/uploads` | قائمة الرفعات |
| `GET /api/settings` | الإعدادات |
| `POST /api/settings` | تحديث إعداد |
| `POST /api/reset-wo` | إعادة تعيين أمر عمل |
| `POST /api/move-images` | نقل صور |
| `GET /api/bot-status` | حالة البوت |
| `GET /api/groups` | المجموعات |
| `POST /api/send-message` | إرسال رسالة |
| `GET /api/logs` | سجل الأحداث |
| `GET /api/test-storage` | اختبار التخزين |

---

## البنية

```
whatstoot/
├── server.js            ← نقطة الدخول الرئيسية
├── package.json         ← التبعيات
├── .env                 ← الإعدادات
├── src/
│   ├── config.js        ← تحميل الإعدادات
│   ├── database.js      ← SQLite
│   ├── logger.js        ← تسجيل الأحداث
│   ├── synology-uploader.js  ← رفع لـ Synology NAS
│   ├── drive-uploader.js     ← رفع لـ Google Drive
│   ├── uploader-factory.js   ← اختيار محرك التخزين
│   ├── work-order-extractor.js ← استخراج أرقام أوامر العمل
│   ├── duplicate-checker.js    ← فحص التكرار
│   ├── message-context.js      ← سياق الرسائل
│   ├── image-processor.js      ← معالجة الصور
│   ├── queue-worker.js         ← معالج الطابور
│   ├── whatsapp-bot.js         ← بوت واتساب
│   └── api-routes.js           ← نقاط API
├── public/
│   ├── index.html       ← لوحة التحكم
│   └── assets/          ← CSS + JS
├── database/
│   ├── schema.sql       ← هيكل قاعدة البيانات
│   └── bot.sqlite       ← قاعدة البيانات
├── credentials/         ← ملفات المصادقة
├── storage/
│   ├── temp/            ← ملفات مؤقتة
│   └── logs/            ← سجلات يومية
└── deploy/
    └── deploy.sh        ← سكريبت النشر
```
