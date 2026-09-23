/**
 * AlertService - نظام التنبيهات الإدارية الفورية عبر البريد الإلكتروني
 * 
 * يرسل إشعارات عاجلة للمسؤول عند:
 * 1. حاجة واتساب لمسح رمز QR جديد.
 * 2. انقطاع اتصال واتساب غير المتوقع.
 * 3. حدوث أخطاء حرجة متكررة.
 */

const nodemailer = require('nodemailer');
const config = require('./config');
const db = require('./database');

class AlertService {
    /**
     * @param {import('./logger')} logger 
     */
    constructor(logger) {
        this.logger = logger;
        this.transporter = null;
        this.lastAlertTimes = new Map();
        this.DEBOUNCE_MS = 30 * 60 * 1000; // 30 دقيقة بين نفس نوع التنبيه

        this._initTransporter();
    }

    _initTransporter() {
        try {
            const user = config.ALERT_SMTP_USER || 'asd86064@gmail.com';
            const pass = config.ALERT_SMTP_PASS || 'tqxrbosjrlabhcbt';
            const host = (config.ALERT_SMTP_HOST || 'smtp.gmail.com').trim();
            const port = parseInt(config.ALERT_SMTP_PORT || '465', 10);
            const isGmail = host.toLowerCase().includes('gmail');

            if (isGmail) {
                // خدمة Gmail الرسمية تستخدم منفذ 465 المباشر (SSL) لتفادي أخطاء حظر VPS (421 Server busy)
                this.transporter = nodemailer.createTransport({
                    service: 'gmail',
                    name: 'whatstoot.app',
                    auth: { user, pass }
                });
            } else {
                this.transporter = nodemailer.createTransport({
                    host,
                    port,
                    secure: port === 465,
                    name: 'whatstoot.app',
                    auth: { user, pass },
                    tls: {
                        rejectUnauthorized: false
                    }
                });
            }
        } catch (e) {
            console.error('❌ [AlertService] فشل تهيئة خادم البريد:', e.message);
        }
    }

    /**
     * الحصول على البريد المستلم الحالي (من قاعدة البيانات أو الإعدادات)
     */
    getRecipientEmail() {
        try {
            const dbVal = db.getSetting('alert_email_to');
            if (dbVal && dbVal.trim()) return dbVal.trim();
        } catch (e) {}

        return (config.ALERT_EMAIL_TO || 'musta.ishag@gmail.com').trim();
    }

    /**
     * تحديث البريد المستلم
     */
    setRecipientEmail(email) {
        if (!email || !email.includes('@')) {
            throw new Error('البريد الإلكتروني غير صحيح');
        }
        db.saveSetting('alert_email_to', email.trim());
        return email.trim();
    }

    /**
     * فحص منع التكرار
     */
    _canSend(alertType) {
        const last = this.lastAlertTimes.get(alertType) || 0;
        const now = Date.now();
        if (now - last < this.DEBOUNCE_MS) {
            return false;
        }
        return true;
    }

    _markSent(alertType) {
        this.lastAlertTimes.set(alertType, Date.now());
    }

    /**
     * إرسال تنبيه QR Code لواتساب
     */
    async sendQrAlert(qrDataUrl = null) {
        if (!this._canSend('qr')) {
            console.log('⏳ [AlertService] تم تجاهل إرسال تنبيه QR لتفادي التكرار');
            return;
        }

        const to = this.getRecipientEmail();
        const subject = '🚨 تنبيه WhatsToot: واتساب يحتاج مسح كود QR جديد!';
        
        let attachments = [];
        let qrImgHtml = '';
        if (qrDataUrl && qrDataUrl.startsWith('data:image/')) {
            attachments.push({
                filename: 'whatsapp-qr.png',
                path: qrDataUrl,
                cid: 'whatsappqrimage'
            });
            qrImgHtml = `
                <div style="text-align: center; margin: 20px 0;">
                    <p style="font-size: 14px; color: #555;">امسح الكود التالي بجوالك فوراً:</p>
                    <img src="cid:whatsappqrimage" alt="WhatsApp QR" style="width: 250px; height: 250px; border: 1px solid #ccc; border-radius: 8px; padding: 10px; background: #fff;" />
                </div>
            `;
        }

        const html = `
            <div dir="rtl" style="font-family: Arial, sans-serif; background-color: #f4f6f9; padding: 24px;">
                <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08);">
                    <div style="background: #ef4444; color: #ffffff; padding: 20px; text-align: center;">
                        <h2 style="margin: 0; font-size: 22px;">🚨 تنبيه انقطاع جلسة واتساب</h2>
                    </div>
                    <div style="padding: 24px; color: #333333; line-height: 1.6;">
                        <p style="font-size: 16px; font-weight: bold;">مرحباً،</p>
                        <p>نظام <strong>WhatsToot</strong> في خادمك يحتاج إلى إعادة ربط واتساب عبر مسح رمز الاستجابة السريعة (QR Code).</p>
                        ${qrImgHtml}
                        <div style="background: #fef2f2; border-right: 4px solid #ef4444; padding: 14px; margin: 20px 0; border-radius: 4px;">
                            <p style="margin: 0; color: #991b1b; font-size: 14px;">يرجى الدخول إلى لوحة التحكم ومسح الرمز لضمان استمرار استقبال الصور والرسائل دون انقطاع.</p>
                        </div>
                        <p style="font-size: 13px; color: #777;">تم إرسال هذا التنبيه تلقائياً في: ${new Date().toLocaleString('ar-SA')}</p>
                    </div>
                </div>
            </div>
        `;

        const result = await this._sendMail({ to, subject, html, attachments });
        if (result && result.success) {
            this._markSent('qr');
        }
        return result;
    }

    /**
     * إرسال تنبيه بانقطاع اتصال واتساب
     */
    async sendDisconnectAlert(reason = 'غير محدد') {
        if (!this._canSend('disconnect')) return;

        const to = this.getRecipientEmail();
        const subject = '⚠️ تنبيه: انقطاع اتصال واتساب في نظام WhatsToot';

        const html = `
            <div dir="rtl" style="font-family: Arial, sans-serif; background-color: #f4f6f9; padding: 24px;">
                <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08);">
                    <div style="background: #f59e0b; color: #ffffff; padding: 20px; text-align: center;">
                        <h2 style="margin: 0; font-size: 22px;">⚠️ انقطاع اتصال واتساب</h2>
                    </div>
                    <div style="padding: 24px; color: #333333; line-height: 1.6;">
                        <p>تم رصد انقطاع في جلسة واتساب.</p>
                        <p><strong>سبب الانقطاع:</strong> <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${reason}</code></p>
                        <p>سيقوم النظام بمحاولة إعادة الاتصال تلقائياً، وإذا تطلب الأمر رمز QR فسيتم إشعارك فوراً.</p>
                        <p style="font-size: 13px; color: #777; margin-top: 20px;">الوقت: ${new Date().toLocaleString('ar-SA')}</p>
                    </div>
                </div>
            </div>
        `;

        const result = await this._sendMail({ to, subject, html });
        if (result && result.success) {
            this._markSent('disconnect');
        }
        return result;
    }

    /**
     * إرسال تنبيه خطأ حرج
     */
    async sendCriticalErrorAlert(title, errorMsg) {
        const alertKey = `error_${title}`;
        if (!this._canSend(alertKey)) return;

        const to = this.getRecipientEmail();
        const subject = `❌ خطأ حرج في WhatsToot: ${title}`;

        const html = `
            <div dir="rtl" style="font-family: Arial, sans-serif; background-color: #f4f6f9; padding: 24px;">
                <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08);">
                    <div style="background: #dc2626; color: #ffffff; padding: 20px; text-align: center;">
                        <h2 style="margin: 0; font-size: 22px;">❌ خطأ حرج في النظام</h2>
                    </div>
                    <div style="padding: 24px; color: #333333; line-height: 1.6;">
                        <p><strong>عنوان الخطأ:</strong> ${title}</p>
                        <pre style="background: #1e293b; color: #f8fafc; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; direction: ltr;">${errorMsg}</pre>
                        <p style="font-size: 13px; color: #777;">الوقت: ${new Date().toLocaleString('ar-SA')}</p>
                    </div>
                </div>
            </div>
        `;

        const result = await this._sendMail({ to, subject, html });
        if (result && result.success) {
            this._markSent(alertKey);
        }
        return result;
    }

    /**
     * إرسال بريد تجريبي لاختبار الإعدادات
     */
    async sendTestAlert(targetEmail) {
        const to = targetEmail || this.getRecipientEmail();
        const subject = '✅ اختبار نظام التنبيهات — WhatsToot';

        const html = `
            <div dir="rtl" style="font-family: Arial, sans-serif; background-color: #f4f6f9; padding: 24px;">
                <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08);">
                    <div style="background: #10b981; color: #ffffff; padding: 20px; text-align: center;">
                        <h2 style="margin: 0; font-size: 22px;">✅ نجاح اختبار نظام التنبيهات</h2>
                    </div>
                    <div style="padding: 24px; color: #333333; line-height: 1.6;">
                        <p>تهانينا! نظام تنبيهات <strong>WhatsToot</strong> يعمل بنجاح عبر خادم Google SMTP.</p>
                        <p>تم ربط هذا البريد (<code>${to}</code>) لاستقبال التنبيهات الإدارية الحرجة وحالات انقطاع واتساب.</p>
                        <p style="font-size: 13px; color: #777; margin-top: 20px;">الوقت: ${new Date().toLocaleString('ar-SA')}</p>
                    </div>
                </div>
            </div>
        `;

        return this._sendMail({ to, subject, html });
    }

    /**
     * تنفيذ الإرسال الفعلي مع إعادة المحاولة ومعالجة أخطاء 421 المؤقتة
     */
    async _sendMail({ to, subject, html, attachments = [] }, retries = 2) {
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            if (!this.transporter) {
                this._initTransporter();
            }

            if (!this.transporter) {
                console.error('❌ [AlertService] خادم البريد غير مهيأ');
                return { success: false, message: 'خادم البريد غير مهيأ' };
            }

            try {
                const info = await this.transporter.sendMail({
                    from: `"WhatsToot Alerts" <${config.ALERT_SMTP_USER || 'asd86064@gmail.com'}>`,
                    to,
                    subject,
                    html,
                    attachments
                });

                console.log(`📧 [AlertService] تم إرسال تنبيه إلى: ${to} (MessageId: ${info.messageId})`);
                if (this.logger && typeof this.logger.info === 'function') {
                    this.logger.info(`Alert email sent to ${to}: ${subject}`);
                }

                return { success: true, messageId: info.messageId };
            } catch (e) {
                console.warn(`⚠️ [AlertService] محاولة إرسال التنبيه (${attempt}/${retries + 1}) فشلت: ${e.message}`);
                
                if (attempt <= retries) {
                    await new Promise(r => setTimeout(r, 2500 * attempt));
                    // إعادة التهيئة عبر direct SSL لمنفذ 465 في المحاولة التالية
                    try {
                        const user = config.ALERT_SMTP_USER || 'asd86064@gmail.com';
                        const pass = config.ALERT_SMTP_PASS || 'tqxrbosjrlabhcbt';
                        this.transporter = nodemailer.createTransport({
                            host: 'smtp.gmail.com',
                            port: 465,
                            secure: true,
                            name: 'whatstoot.app',
                            auth: { user, pass },
                            tls: { rejectUnauthorized: false }
                        });
                    } catch (reErr) {}
                    continue;
                }

                console.error('❌ [AlertService] فشل إرسال التنبيه بالبريد نهائياً:', e.message);
                if (this.logger && typeof this.logger.error === 'function') {
                    this.logger.error(`Failed to send alert email to ${to}: ${e.message}`);
                }
                return { success: false, message: e.message };
            }
        }
    }
}

module.exports = AlertService;
