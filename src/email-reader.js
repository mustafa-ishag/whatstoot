/**
 * EmailReader - قراءة البريد الإلكتروني وإرسال المرفقات عبر واتساب
 * 
 * يقرأ رسائل البريد من IMAP، يستخرج المرفقات (صور + PDF)،
 * يدمج الصور في ملف PDF واحد، ويرسل جميع ملفات PDF عبر واتساب.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./database');
class EmailReader {
    constructor(bot, logger, uploader = null) {
        this.bot = bot;
        this.uploader = uploader;
        this.logger = logger;
        this.isRunning = false;
        this.checkInterval = null;
        this.stats = {
            emailsProcessed: 0,
            pdfsSent: 0,
            errors: 0,
            lastCheck: null,
            lastError: null,
        };

        // رقم واتساب الافتراضي للإرسال
        this.whatsappNumber = config.EMAIL_WHATSAPP_NUMBER;

        // تعبير نمطي لاستخراج رقم أمر العمل من موضوع الرسالة
        this.woPattern = new RegExp(`(?<!\\d)\\d{${config.WORK_ORDER_DIGITS}}(?!\\d)`);

        // مسار الملفات المؤقتة
        this.tempPath = path.join(config.TEMP_PATH, 'email');
        if (!fs.existsSync(this.tempPath)) {
            fs.mkdirSync(this.tempPath, { recursive: true });
        }
    }

    /**
     * بدء الفحص الدوري للبريد
     */
    start(intervalMs = null) {
        if (this.isRunning) {
            console.log('📧 Email Reader is already running');
            return;
        }

        const interval = intervalMs || (config.EMAIL_CHECK_INTERVAL * 1000);

        this.isRunning = true;
        console.log(`📧 Email Reader started — checking every ${interval / 1000}s`);
        this.logger.info(`Email Reader started — interval: ${interval / 1000}s, target: ${this.whatsappNumber}`);

        // أول فحص فوري
        this.checkEmails().catch(err => {
            console.error('❌ Email check error:', err.message);
            this.stats.errors++;
            this.stats.lastError = err.message;
        });

        // فحص دوري
        this.checkInterval = setInterval(() => {
            this.checkEmails().catch(err => {
                console.error('❌ Email check error:', err.message);
                this.stats.errors++;
                this.stats.lastError = err.message;
            });
        }, interval);
    }

    /**
     * إيقاف الفحص الدوري
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.isRunning = false;
        console.log('📧 Email Reader stopped');
        this.logger.info('Email Reader stopped');
    }

    /**
     * فحص البريد — الدالة الرئيسية
     */
    async checkEmails() {
        if (!this.bot.isClientReady) {
            console.log('📧 ⏳ واتساب غير جاهز — تأجيل فحص البريد');
            return;
        }

        const client = new ImapFlow({
            host: config.EMAIL_IMAP_HOST,
            port: config.EMAIL_IMAP_PORT,
            secure: true,
            auth: {
                user: config.EMAIL_USER,
                pass: config.EMAIL_PASS,
            },
            tls: {
                rejectUnauthorized: false, // قبول شهادات SSL الذاتية
            },
            logger: {
                debug: () => {},
                info: (msg) => console.log(`📧 IMAP: ${msg.msg}`),
                warn: (msg) => console.warn(`📧 IMAP ⚠️: ${msg.msg}`),
                error: (msg) => console.error(`📧 IMAP ❌: ${msg.msg}`),
            },
        });

        try {
            await client.connect();
            console.log('📧 ✅ اتصال IMAP ناجح');

            // فتح صندوق الوارد
            const lock = await client.getMailboxLock('INBOX');

            try {
                // البحث عن الرسائل غير المقروءة
                const messages = await client.search({ seen: false });

                if (messages.length === 0) {
                    console.log('📧 لا توجد رسائل جديدة');
                    this.stats.lastCheck = new Date().toISOString();
                    return;
                }

                console.log(`📧 📬 وُجدت ${messages.length} رسالة جديدة`);

                // معالجة كل رسالة
                for (const uid of messages) {
                    try {
                        await this._processEmail(client, uid);
                        this.stats.emailsProcessed++;
                    } catch (err) {
                        console.error(`❌ خطأ في معالجة الرسالة ${uid}:`, err.message);
                        this.logger.error(`Email processing error (UID ${uid}): ${err.message}`);
                        this.stats.errors++;
                        this.stats.lastError = err.message;
                    }
                }

            } finally {
                lock.release();
            }

            this.stats.lastCheck = new Date().toISOString();

        } catch (err) {
            const detail = err.responseText || err.responseStatus || err.code || '';
            console.error(`❌ خطأ في اتصال IMAP: ${err.message}`);
            if (detail) console.error(`   📋 التفاصيل: ${detail}`);
            console.error(`   🔧 Host: ${config.EMAIL_IMAP_HOST}:${config.EMAIL_IMAP_PORT}`);
            console.error(`   👤 User: ${config.EMAIL_USER}`);
            this.logger.error(`IMAP error: ${err.message} | ${detail} | Host: ${config.EMAIL_IMAP_HOST}`);
            this.stats.errors++;
            this.stats.lastError = `${err.message} ${detail}`.trim();
            throw err;
        } finally {
            try {
                await client.logout();
            } catch (e) {
                // تجاهل أخطاء تسجيل الخروج
            }
        }
    }

    /**
     * معالجة رسالة بريد واحدة
     */
    async _processEmail(client, uid) {
        // جلب محتوى الرسالة
        const download = await client.download(uid, undefined, { uid: true });
        
        // تعليم الرسالة كمقروءة مبكراً جداً لمنع تكرار الإرسال في حال حدوث تأخير أو خطأ في واتساب
        try {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (e) {
            console.error('📧 ⚠️ خطأ أثناء تعليم الرسالة كمقروءة:', e.message);
        }

        const parsed = await simpleParser(download.content);

        const subject = parsed.subject || 'بدون موضوع';
        const from = parsed.from?.text || 'Unknown';

        console.log(`\n📧 ══════════════════════════════════════`);
        console.log(`📧 📩 رسالة من: ${from}`);
        console.log(`📧 📋 الموضوع: ${subject}`);

        // استخراج رقم أمر العمل من الموضوع
        const woMatch = subject.match(this.woPattern);
        const workOrder = woMatch ? woMatch[0] : null;

        if (workOrder) {
            console.log(`📧 🎯 رقم أمر العمل: ${workOrder}`);
        } else {
            console.log(`📧 ⚠️ لم يُعثر على رقم أمر عمل في الموضوع`);
        }

        // استخراج المرفقات
        const attachments = parsed.attachments || [];
        if (attachments.length === 0) {
            console.log('📧 ⏩ لا توجد مرفقات — تخطي');
            return;
        }

        console.log(`📧 📎 عدد المرفقات: ${attachments.length}`);

        // تصنيف المرفقات: صور و PDFs
        const images = [];
        const pdfs = [];

        for (const att of attachments) {
            const mime = (att.contentType || '').toLowerCase();
            const filename = att.filename || `attachment_${Date.now()}`;

            if (mime.startsWith('image/')) {
                images.push({ data: att.content, mime, filename });
                console.log(`📧   🖼 صورة: ${filename} (${this._formatSize(att.size)})`);
            } else if (mime === 'application/pdf') {
                pdfs.push({ data: att.content, filename });
                console.log(`📧   📄 PDF: ${filename} (${this._formatSize(att.size)})`);
            } else {
                console.log(`📧   ⏩ تجاهل: ${filename} (${mime})`);
            }
        }

        // قائمة ملفات PDF النهائية للإرسال
        const pdfFilesToSend = [];

        // 1. حفظ ملفات PDF المرفقة مباشرة
        for (const pdf of pdfs) {
            const pdfName = workOrder
                ? `${workOrder}_${this._sanitizeFilename(pdf.filename)}`
                : pdf.filename;
            const pdfPath = path.join(this.tempPath, pdfName);
            fs.writeFileSync(pdfPath, pdf.data);
            pdfFilesToSend.push({ path: pdfPath, name: pdfName });
        }

        // 2. دمج الصور في ملف PDF واحد
        if (images.length > 0) {
            try {
                const imagesPdfName = workOrder
                    ? `${workOrder}_images.pdf`
                    : `images_${Date.now()}.pdf`;
                const imagesPdfPath = path.join(this.tempPath, imagesPdfName);

                await this._mergeImagesToPdf(images, imagesPdfPath);
                pdfFilesToSend.push({ path: imagesPdfPath, name: imagesPdfName });

                console.log(`📧 ✅ تم دمج ${images.length} صورة في: ${imagesPdfName}`);
            } catch (err) {
                console.error('📧 ❌ خطأ في دمج الصور:', err.message);
                this.logger.error(`Image merge error: ${err.message}`);
            }
        }

        // 3. إرسال ملفات PDF عبر واتساب
        if (pdfFilesToSend.length > 0) {
            await this._sendPdfsViaWhatsApp(pdfFilesToSend, workOrder, subject);
        } else {
            console.log('📧 ⚠️ لا توجد ملفات PDF للإرسال');
        }

        // 4. أرشفة الملفات في Synology Drive
        if (workOrder && pdfFilesToSend.length > 0 && this.uploader) {
            await this._archiveToSynology(pdfFilesToSend, workOrder);
        }

        // 5. حذف الملفات المؤقتة
        for (const file of pdfFilesToSend) {
            this._safeUnlink(file.path);
        }

        console.log(`📧 ══════════════════════════════════════\n`);
    }

    /**
     * دمج مجموعة صور في ملف PDF واحد
     */
    async _mergeImagesToPdf(images, outputPath) {
        const pdfDoc = await PDFDocument.create();

        for (const img of images) {
            try {
                let embeddedImage;
                const mime = img.mime.toLowerCase();

                if (mime.includes('png')) {
                    embeddedImage = await pdfDoc.embedPng(img.data);
                } else if (mime.includes('jpeg') || mime.includes('jpg')) {
                    embeddedImage = await pdfDoc.embedJpg(img.data);
                } else {
                    // محاولة تحويل الصور الأخرى كـ JPEG
                    // pdf-lib يدعم فقط PNG و JPEG مباشرة
                    console.log(`📧   ⚠️ نوع صورة غير مدعوم مباشرة: ${mime} — محاولة كـ JPEG`);
                    try {
                        embeddedImage = await pdfDoc.embedJpg(img.data);
                    } catch (e) {
                        console.log(`📧   ❌ تعذر دمج الصورة: ${img.filename}`);
                        continue;
                    }
                }

                // إنشاء صفحة بحجم الصورة
                const { width, height } = embeddedImage.scale(1);

                // تحديد حجم الصفحة — A4 أو حجم الصورة أيهما أكبر
                const pageWidth = Math.max(width, 595);  // A4 width
                const pageHeight = Math.max(height, 842); // A4 height

                const page = pdfDoc.addPage([pageWidth, pageHeight]);

                // رسم الصورة في منتصف الصفحة
                const scale = Math.min(
                    (pageWidth - 40) / width,
                    (pageHeight - 40) / height,
                    1 // لا تكبّر أكثر من الحجم الأصلي
                );

                const scaledWidth = width * scale;
                const scaledHeight = height * scale;

                page.drawImage(embeddedImage, {
                    x: (pageWidth - scaledWidth) / 2,
                    y: (pageHeight - scaledHeight) / 2,
                    width: scaledWidth,
                    height: scaledHeight,
                });

            } catch (err) {
                console.error(`📧 ❌ خطأ في دمج صورة ${img.filename}:`, err.message);
            }
        }

        const pdfBytes = await pdfDoc.save();
        fs.writeFileSync(outputPath, pdfBytes);
    }

    /**
     * إرسال ملفات PDF عبر واتساب
     */
    async _sendPdfsViaWhatsApp(pdfFiles, workOrder, subject) {
        // تحديد جهة الإرسال (مجموعة أو رقم)
        let target = db.getSetting('email_whatsapp_target') || this.whatsappNumber;
        let chatId = target;

        if (!target.includes('@g.us')) {
            // تنسيق رقم الواتساب إذا لم يكن مجموعة
            let number = target.replace(/[^0-9]/g, '');
            if (number.startsWith('05')) {
                number = '966' + number.substring(1);
            }
            chatId = `${number}@c.us`;
        }

        // فاصل تزييني
        const separator = `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;

        // رسالة تعريفية
        const intro = workOrder
            ? `${separator}\n🟢 *إسناد جديد*\n${separator}\n\n📋 *${subject}*\n📎 عدد الملفات: ${pdfFiles.length}`
            : `${separator}\n🟢 *إسناد جديد*\n${separator}\n\n📋 *${subject}*\n📎 عدد الملفات: ${pdfFiles.length}`;

        try {
            await this.bot.client.sendMessage(chatId, intro);
            console.log(`📧 📨 رسالة تعريفية مُرسلة إلى ${target}`);
        } catch (err) {
            console.error('📧 ❌ خطأ إرسال رسالة تعريفية:', err.message);
        }

        // إرسال كل ملف PDF
        const { MessageMedia } = require('whatsapp-web.js');

        for (const file of pdfFiles) {
            try {
                const pdfData = fs.readFileSync(file.path);
                const base64 = pdfData.toString('base64');

                const media = new MessageMedia(
                    'application/pdf',
                    base64,
                    file.name
                );

                // كابشن بسيط — اسم الملف فقط
                const caption = `📄 ${file.name}`;

                await this.bot.client.sendMessage(chatId, media, { caption });
                console.log(`📧 ✅ تم إرسال: ${file.name}`);
                this.stats.pdfsSent++;

                // تأخير بسيط بين الملفات
                await this._sleep(2000);

            } catch (err) {
                console.error(`📧 ❌ خطأ إرسال ${file.name}:`, err.message);
                this.logger.error(`WhatsApp send error for ${file.name}: ${err.message}`);
                this.stats.errors++;
            }
        }

        this.logger.info(`Sent ${pdfFiles.length} PDF(s) for WO ${workOrder || 'N/A'} to ${target}`);
    }

    /**
     * أرشفة ملفات PDF في Synology Drive داخل مجلد أمر العمل
     */
    async _archiveToSynology(pdfFiles, workOrder) {
        console.log(`📧 📁 جاري أرشفة ${pdfFiles.length} ملف في Synology...`);

        try {
            // إنشاء/الحصول على مجلد أمر العمل مع مجلد فرعي "email"
            const folderPath = await this.uploader.getOrCreateFolder(workOrder, 'email');
            console.log(`📧 📂 مجلد الأرشفة: ${folderPath}`);

            let archived = 0;
            for (const file of pdfFiles) {
                try {
                    if (!fs.existsSync(file.path)) {
                        console.log(`📧 ⚠️ الملف غير موجود للأرشفة: ${file.name}`);
                        continue;
                    }

                    await this.uploader.upload(file.path, folderPath, file.name);
                    archived++;
                    console.log(`📧 ✅ تم أرشفة: ${file.name}`);
                } catch (err) {
                    console.error(`📧 ❌ خطأ أرشفة ${file.name}:`, err.message);
                    this.logger.error(`Archive error for ${file.name}: ${err.message}`);
                }
            }

            if (archived > 0) {
                this.logger.info(`Archived ${archived}/${pdfFiles.length} file(s) for WO ${workOrder} to Synology`);
                console.log(`📧 ✅ تم أرشفة ${archived} من ${pdfFiles.length} ملف في Synology`);
            }
        } catch (err) {
            console.error(`📧 ❌ خطأ في أرشفة أمر العمل ${workOrder}:`, err.message);
            this.logger.error(`Archive folder error for WO ${workOrder}: ${err.message}`);
            // لا نرمي الخطأ — الأرشفة اختيارية ولا تمنع باقي العمليات
        }
    }

    /**
     * حذف ملف بأمان
     */
    _safeUnlink(filePath) {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
            // تجاهل
        }
    }

    /**
     * تنظيف اسم الملف
     */
    _sanitizeFilename(name) {
        return name.replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    /**
     * تنسيق حجم الملف
     */
    _formatSize(bytes) {
        if (!bytes) return '? bytes';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * تأخير
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * حالة القارئ
     */
    getStatus() {
        return {
            enabled: config.EMAIL_ENABLED,
            running: this.isRunning,
            target_number: db.getSetting('email_whatsapp_target') || this.whatsappNumber,
            email_account: config.EMAIL_USER,
            imap_host: config.EMAIL_IMAP_HOST,
            check_interval: config.EMAIL_CHECK_INTERVAL,
            stats: this.stats,
        };
    }
}

module.exports = EmailReader;
