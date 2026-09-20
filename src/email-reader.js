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

        this.isChecking = false;
        this.failedUids = new Map();
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
        if (this.isChecking) {
            return;
        }

        if (!this.bot || !this.bot.isClientReady) {
            console.log('📧 ⏳ واتساب غير جاهز — تأجيل فحص البريد');
            return;
        }

        this.isChecking = true;

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
            this.isChecking = false;
        }
    }

    /**
     * معالجة رسالة بريد واحدة
     */
    async _processEmail(client, uid) {
        // جلب المحتوى الخام للرسالة كاملاً بشكل مضمون ومباشر
        const message = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!message || !message.source) {
            console.log(`📧 ⚠️ لم يتم العثور على محتوى الرسالة ${uid}`);
            return;
        }
        const parsed = await simpleParser(message.source);

        const subject = parsed.subject || 'بدون موضوع';
        const from = parsed.from?.text || 'Unknown';

        console.log(`\n📧 ══════════════════════════════════════`);
        console.log(`📧 📩 رسالة من: ${from}`);
        console.log(`📧 📋 الموضوع: ${subject}`);

        // استخراج رقم أمر العمل من الموضوع أو النص أو كود HTML
        let workOrder = null;
        const woMatchSubject = subject.match(this.woPattern);
        if (woMatchSubject) {
            workOrder = woMatchSubject[0];
        } else if (parsed.text) {
            const woMatchText = parsed.text.match(this.woPattern);
            if (woMatchText) workOrder = woMatchText[0];
        } else if (parsed.html) {
            const woMatchHtml = String(parsed.html).match(this.woPattern);
            if (woMatchHtml) workOrder = woMatchHtml[0];
        }

        if (workOrder) {
            console.log(`📧 🎯 رقم أمر العمل: ${workOrder}`);
        } else {
            console.log(`📧 ⚠️ لم يُعثر على رقم أمر عمل في الموضوع أو النص`);
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
            const filename = att.filename || (att.contentType?.params?.name) || `attachment_${Date.now()}`;
            const ext = path.extname(filename).toLowerCase();

            // التأكد من تحويل المحتوى إلى Buffer سليم
            let contentBuf = att.content;
            if (typeof contentBuf === 'string') {
                contentBuf = Buffer.from(contentBuf, 'base64');
            }

            // فحص هل المرفق PDF عبر: النوع المكتوب، الامتداد، أو البايتات السحرية (%PDF-)
            const hasPdfHeader = contentBuf && Buffer.isBuffer(contentBuf) && contentBuf.length >= 4 && contentBuf.subarray(0, 4).toString() === '%PDF';
            const isPdf = mime.includes('pdf') || ext === '.pdf' || hasPdfHeader;
            const isImage = mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext);

            if (isPdf) {
                pdfs.push({ data: contentBuf, filename });
                console.log(`📧   📄 PDF: ${filename} (${this._formatSize(att.size || contentBuf?.length)})`);
            } else if (isImage) {
                images.push({ data: contentBuf, mime: mime.startsWith('image/') ? mime : 'image/jpeg', filename });
                console.log(`📧   🖼 صورة: ${filename} (${this._formatSize(att.size || contentBuf?.length)})`);
            } else {
                console.log(`📧   ⏩ تجاهل: ${filename} (${mime})`);
            }
        }

        // إذا لم يُعثر على رقم أمر العمل، نفحص أسماء ملفات الـ PDF
        if (!workOrder && pdfs.length > 0) {
            for (const p of pdfs) {
                const m = p.filename.match(this.woPattern);
                if (m) {
                    workOrder = m[0];
                    console.log(`📧 🎯 تم استخراج رقم أمر العمل من اسم ملف الـ PDF: ${workOrder}`);
                    break;
                }
            }
        }

        // قائمة ملفات PDF النهائية للإرسال
        const pdfFilesToSend = [];

        // 1. حفظ ملفات PDF المرفقة الأصلية مباشرة
        for (const pdf of pdfs) {
            let cleanFilename = this._sanitizeFilename(pdf.filename);
            if (!cleanFilename.toLowerCase().endsWith('.pdf')) {
                cleanFilename += '.pdf';
            }
            const pdfName = workOrder && !cleanFilename.startsWith(workOrder)
                ? `${workOrder}_${cleanFilename}`
                : cleanFilename;
            const pdfPath = path.join(this.tempPath, pdfName);
            const pdfBuffer = Buffer.isBuffer(pdf.data) ? pdf.data : Buffer.from(pdf.data);
            fs.writeFileSync(pdfPath, pdfBuffer);
            pdfFilesToSend.push({ path: pdfPath, name: pdfName });
        }

        // 2. دمج الصور في ملف PDF واحد (بدون ضغط، بالأبعاد والجودة الأصلية)
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

        try {
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

            // تعليم الرسالة كمقروءة فقط بعد نجاح الإرسال والأرشفة
            try {
                await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
                this.failedUids.delete(uid);
            } catch (e) {
                console.error('📧 ⚠️ خطأ أثناء تعليم الرسالة كمقروءة:', e.message);
            }

        } catch (err) {
            const failCount = (this.failedUids.get(uid) || 0) + 1;
            this.failedUids.set(uid, failCount);
            if (failCount >= 3) {
                console.error(`📧 ⚠️ فشلت معالجة الرسالة ${uid} لـ 3 مرات متتالية — سيتم تعليمها كمقروءة لتفادي التكرار`);
                try {
                    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
                } catch (e) {}
                this.failedUids.delete(uid);
            }
            throw err;
        } finally {
            // 5. حذف الملفات المؤقتة دائماً
            for (const file of pdfFilesToSend) {
                this._safeUnlink(file.path);
            }
        }

        console.log(`📧 ══════════════════════════════════════\n`);
    }

    /**
     * دمج مجموعة صور في ملف PDF واحد بدون ضغط أو تقليل جودة (بالجودة والأبعاد الأصلية)
     */
    async _mergeImagesToPdf(images, outputPath) {
        const pdfDoc = await PDFDocument.create();

        for (const img of images) {
            try {
                let embeddedImage;
                const mime = (img.mime || '').toLowerCase();
                const isPng = mime.includes('png') || (img.filename && img.filename.toLowerCase().endsWith('.png'));

                if (isPng) {
                    try {
                        embeddedImage = await pdfDoc.embedPng(img.data);
                    } catch (pngErr) {
                        embeddedImage = await pdfDoc.embedJpg(img.data);
                    }
                } else {
                    try {
                        embeddedImage = await pdfDoc.embedJpg(img.data);
                    } catch (jpgErr) {
                        embeddedImage = await pdfDoc.embedPng(img.data);
                    }
                }

                // مقاسات الصورة الأصلية بالكامل بدون أي ضغط أو تقليص جودة
                const { width, height } = embeddedImage.scale(1);

                // حجم الصفحة مطابق لحجم الصورة تماماً
                const pageWidth = Math.max(width, 595);
                const pageHeight = Math.max(height, 842);

                const page = pdfDoc.addPage([pageWidth, pageHeight]);

                const scale = Math.min(
                    (pageWidth - 40) / width,
                    (pageHeight - 40) / height,
                    1
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
        if (!target) {
            console.log('📧 ⚠️ لم يتم تحديد جهة استقبال لإشعارات البريد (email_whatsapp_target)');
            return;
        }

        let chatId = target.trim();
        if (!chatId.includes('@g.us') && !chatId.includes('@c.us') && !chatId.includes('@lid')) {
            let number = chatId.replace(/[^0-9]/g, '');
            if (number.startsWith('05') && number.length === 10) {
                number = '966' + number.substring(1);
            } else if (number.startsWith('5') && number.length === 9) {
                number = '966' + number;
            }
            // استخدام @c.us مباشرة بدلاً من getNumberId الذي يُرجع @lid ويتسبب في فشل الإرسال
            chatId = `${number}@c.us`;
        }

        // فاصل تزييني
        const separator = `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;

        // رسالة تعريفية
        const intro = `${separator}\n🟢 *إسناد جديد*\n${separator}\n\n📋 *${subject}*\n📎 عدد الملفات: ${pdfFiles.length}`;

        try {
            await this.bot.sendMessage(chatId, intro);
            console.log(`📧 📨 رسالة تعريفية مُرسلة إلى ${target}`);
        } catch (err) {
            console.error('📧 ❌ خطأ إرسال رسالة تعريفية:', err.message);
            throw new Error(`فشل إرسال الرسالة التعريفية عبر واتساب: ${err.message}`);
        }

        let failedFiles = [];

        // إرسال كل ملف PDF عبر الدالة المحدثة والمحمية ضد أخطاء memoize
        for (const file of pdfFiles) {
            try {
                if (!fs.existsSync(file.path)) {
                    console.error(`📧 ❌ الملف غير موجود للإرسال: ${file.path}`);
                    failedFiles.push(file.name);
                    continue;
                }

                try {
                    await this.bot.sendMediaDocument(chatId, file.path, file.name);
                    console.log(`📧 ✅ تم إرسال: ${file.name}`);
                    this.stats.pdfsSent++;
                } catch (sendErr) {
                    console.warn(`📧 ⚠️ محاولة ثانية لإرسال ${file.name} بعد 3 ثوانٍ... السبب: ${sendErr.message}`);
                    await this._sleep(3000);
                    await this.bot.sendMediaDocument(chatId, file.path, file.name);
                    console.log(`📧 ✅ تم إرسال: ${file.name} (في المحاولة الثانية)`);
                    this.stats.pdfsSent++;
                }

                // تأخير بسيط بين الملفات لتجنب ضغط الخادم
                await this._sleep(2000);

            } catch (err) {
                console.error(`📧 ❌ خطأ إرسال ${file.name}:`, err.message);
                this.logger.error(`WhatsApp send error for ${file.name}: ${err.message}`);
                this.stats.errors++;
                failedFiles.push(file.name);
            }
        }

        if (failedFiles.length > 0) {
            throw new Error(`فشل إرسال ${failedFiles.length} ملف عبر واتساب: ${failedFiles.join(', ')}`);
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
        let clean = (name || '').replace(/^["']|["']$/g, '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
        if (!clean) clean = `attachment_${Date.now()}.pdf`;
        return clean;
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
