/**
 * WorkOrderExtractor - استخراج أرقام أوامر العمل من النصوص
 * يدعم:
 * 1. أوامر العمل العادية (افتراضياً 9 أرقام)
 * 2. أوامر عمل الطوارئ (10 أرقام وتبدأ دائماً بالرقم 4)
 */

const config = require('./config');

class WorkOrderExtractor {
    constructor(digits = null) {
        this.digits = digits || config.WORK_ORDER_DIGITS || 9;
        // نمط الطوارئ: 10 أرقام تبدأ بـ 4
        this.emergencyPattern = /(?<!\d)(4\d{9})(?!\d)/;
        this.emergencyPatternGlobal = /(?<!\d)(4\d{9})(?!\d)/g;
        this.emergencyExactPattern = /^4\d{9}$/;

        // النمط العادي
        this.normalPattern = new RegExp(`(?<!\\d)(\\d{${this.digits}})(?!\\d)`);
        this.normalPatternGlobal = new RegExp(`(?<!\\d)(\\d{${this.digits}})(?!\\d)`, 'g');
        this.normalExactPattern = new RegExp(`^\\d{${this.digits}}$`);

        // نمط مدمج للبحث السريع (الطوارئ أولاً لضمان عدم اقتطاع أول 9 أرقام من رقم الطوارئ)
        this.combinedPattern = new RegExp(`(?<!\\d)(?:(4\\d{9})|(\\d{${this.digits}}))(?!\\d)`);
        this.combinedPatternGlobal = new RegExp(`(?<!\\d)(?:(4\\d{9})|(\\d{${this.digits}}))(?!\\d)`, 'g');
    }

    /**
     * تحويل الأرقام العربية والفارسية إلى أرقام قياسية إنجليزية
     * @param {string} str
     * @returns {string}
     */
    static normalizeDigits(str) {
        if (!str) return '';
        return String(str)
            .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
            .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
    }

    /**
     * استخراج رقم أمر عمل من نص (طوارئ أو عادي)
     * @param {string} text
     * @returns {string|null}
     */
    extract(text) {
        if (!text) return null;
        const normalized = WorkOrderExtractor.normalizeDigits(text);
        if (!normalized.trim()) return null;

        // فحص الطوارئ أولاً (10 أرقام تبدأ بـ 4)
        const emMatch = normalized.match(this.emergencyPattern);
        if (emMatch) return emMatch[1];

        // ثم فحص الأوامر العادية
        const normalMatch = normalized.match(this.normalPattern);
        return normalMatch ? normalMatch[1] : null;
    }

    /**
     * استخراج جميع أرقام أوامر العمل من نص
     * @param {string} text
     * @returns {string[]}
     */
    extractAll(text) {
        if (!text) return [];
        const normalized = WorkOrderExtractor.normalizeDigits(text);
        if (!normalized.trim()) return [];
        const matches = [];
        let match;

        // الطوارئ أولاً
        const emRegex = new RegExp(this.emergencyPatternGlobal.source, 'g');
        while ((match = emRegex.exec(normalized)) !== null) {
            if (!matches.includes(match[1])) {
                matches.push(match[1]);
            }
        }

        // ثم العادية
        const normalRegex = new RegExp(this.normalPatternGlobal.source, 'g');
        while ((match = normalRegex.exec(normalized)) !== null) {
            if (!matches.includes(match[1])) {
                matches.push(match[1]);
            }
        }

        return matches;
    }

    /**
     * التحقق من أن النص يحتوي رقم أمر عمل
     */
    hasWorkOrder(text) {
        return this.extract(text) !== null;
    }

    /**
     * التحقق من أن النص هو رقم أمر عمل فقط (عادي أو طوارئ)
     */
    isWorkOrderOnly(text) {
        if (!text) return false;
        const clean = WorkOrderExtractor.normalizeDigits(text).trim();
        return this.emergencyExactPattern.test(clean) || this.normalExactPattern.test(clean);
    }

    /**
     * التحقق مما إذا كان رقم أمر العمل يخص الطوارئ (10 أرقام ويبدأ بـ 4)
     * @param {string} wo
     * @returns {boolean}
     */
    static isEmergency(wo) {
        if (!wo) return false;
        const clean = WorkOrderExtractor.normalizeDigits(wo).trim();
        return /^4\d{9}$/.test(clean);
    }

    isEmergency(wo) {
        return WorkOrderExtractor.isEmergency(wo);
    }
}

module.exports = WorkOrderExtractor;
