FROM node:20-bookworm-slim

# ضبط متغيرات البيئة لمتصفح Chromium وبيئة العمل
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    TZ=Asia/Riyadh \
    DEBIAN_FRONTEND=noninteractive

# تثبيت Chromium والمكتبات الضرورية لتشغيله في بيئة headless ودعم الخطوط العربية والإنجليزية
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-kacst \
    fonts-freefont-ttf \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libxshmfence1 \
    libglu1-mesa \
    ca-certificates \
    git \
    python3 \
    make \
    g++ \
    tzdata \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# نسخ ملفات التبعيات وتثبيتها
COPY package*.json ./
RUN npm ci --omit=dev

# نسخ باقي ملفات المشروع
COPY . .

# إنشاء المجلدات الضرورية للتخزين المؤقت وقاعدة البيانات إذا لم تكن موجودة
RUN mkdir -p storage/temp storage/logs storage/backups database .wwebjs_auth

# فتح منفذ لوحة التحكم والـ API
EXPOSE 3000

# فحص صحة التطبيق دورياً
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/bot-status', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
