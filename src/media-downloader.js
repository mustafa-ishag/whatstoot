/**
 * MediaDownloader - تحميل وفك تشفير ميديا واتساب مباشرة
 * 
 * يعمل كبديل لـ msg.downloadMedia() عند تعطل دوال Puppeteer الداخلية
 * يقوم بتحميل الملف المشفر من CDN واتساب وفكه باستخدام Node.js crypto
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// مفاتيح التوسيع حسب نوع الميديا (HKDF info)
const MEDIA_HKDF_INFO = {
    'image':    'WhatsApp Image Keys',
    'video':    'WhatsApp Video Keys',
    'audio':    'WhatsApp Audio Keys',
    'ptt':      'WhatsApp Audio Keys',
    'document': 'WhatsApp Document Keys',
    'sticker':  'WhatsApp Image Keys',
};

/**
 * HKDF - Key Derivation Function (RFC 5869)
 */
function hkdf(key, length, info) {
    const salt = Buffer.alloc(32, 0);
    const prk = crypto.createHmac('sha256', salt).update(key).digest();

    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    let i = 0;

    while (okm.length < length) {
        i++;
        const input = Buffer.concat([t, Buffer.from(info, 'utf8'), Buffer.from([i])]);
        t = crypto.createHmac('sha256', prk).update(input).digest();
        okm = Buffer.concat([okm, t]);
    }

    return okm.slice(0, length);
}

/**
 * تحميل ملف من URL
 */
function downloadFromUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const request = client.get(url, { timeout: 30000 }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadFromUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        request.on('error', reject);
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

/**
 * فك تشفير ميديا واتساب
 * 
 * @param {Buffer} encData - البيانات المشفرة
 * @param {Buffer} mediaKeyRaw - مفتاح الميديا (غير موسّع)
 * @param {string} mediaType - نوع الميديا (image, video, audio, document, sticker, ptt)
 * @returns {Buffer} البيانات المفكوكة
 */
function decryptMedia(encData, mediaKeyRaw, mediaType) {
    const info = MEDIA_HKDF_INFO[mediaType] || MEDIA_HKDF_INFO['image'];

    // توسيع المفتاح باستخدام HKDF
    const expandedKey = hkdf(mediaKeyRaw, 112, info);

    const iv = expandedKey.slice(0, 16);
    const cipherKey = expandedKey.slice(16, 48);
    // const macKey = expandedKey.slice(48, 80); // للتحقق من HMAC (اختياري)

    // فصل البيانات عن MAC (آخر 10 بايت)
    const file = encData.slice(0, encData.length - 10);
    // const mac = encData.slice(encData.length - 10);

    // فك التشفير AES-256-CBC
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    decipher.setAutoPadding(true);

    return Buffer.concat([decipher.update(file), decipher.final()]);
}

/**
 * تحميل وفك تشفير ميديا واتساب من بيانات الرسالة الخام
 * 
 * @param {object} msgData - بيانات الرسالة الخام (msg._data)
 * @returns {Promise<{data: string, mimetype: string, filename: string|null}|null>}
 */
async function downloadMediaDirect(msgData) {
    // استخراج البيانات المطلوبة
    const mediaKey = msgData.mediaKey;
    const directPath = msgData.directPath;
    const mimetype = msgData.mimetype;
    const type = msgData.type; // image, video, audio, document, sticker, ptt
    const filename = msgData.filename || null;

    if (!mediaKey || !directPath) {
        return null;
    }

    // بناء URL التحميل
    const url = `https://mmg.whatsapp.net${directPath}`;

    // تحميل الملف المشفر
    const encData = await downloadFromUrl(url);

    // فك ترميز مفتاح الميديا من base64
    const mediaKeyBuffer = Buffer.from(mediaKey, 'base64');

    // فك التشفير
    const decrypted = decryptMedia(encData, mediaKeyBuffer, type);

    // تحويل إلى base64
    const base64Data = decrypted.toString('base64');

    return {
        data: base64Data,
        mimetype: mimetype,
        filename: filename,
        filesize: decrypted.length,
    };
}

module.exports = { downloadMediaDirect };
