/**
 * WorkOrderExtractor - استخراج أرقام أوامر العمل من النصوص
 * بديل لـ src/WorkOrderExtractor.php
 */

const config = require('./config');

class WorkOrderExtractor {
    constructor(digits = null) {
        this.digits = digits || config.WORK_ORDER_DIGITS || 9;
        this.pattern = new RegExp(`(?<!\\d)(\\d{${this.digits}})(?!\\d)`);
        this.patternGlobal = new RegExp(`(?<!\\d)(\\d{${this.digits}})(?!\\d)`, 'g');
        this.exactPattern = new RegExp(`^\\d{${this.digits}}$`);
    }

    /**
     * استخراج رقم أمر عمل من نص
     * @param {string} text
     * @returns {string|null}
     */
    extract(text) {
        if (!text || !text.trim()) return null;
        const match = text.match(this.pattern);
        return match ? match[1] : null;
    }

    /**
     * استخراج جميع أرقام أوامر العمل من نص
     * @param {string} text
     * @returns {string[]}
     */
    extractAll(text) {
        if (!text || !text.trim()) return [];
        const matches = [];
        let match;
        // Reset lastIndex for global regex
        const regex = new RegExp(this.patternGlobal.source, 'g');
        while ((match = regex.exec(text)) !== null) {
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
     * التحقق من أن النص هو رقم أمر عمل فقط
     */
    isWorkOrderOnly(text) {
        return this.exactPattern.test(text.trim());
    }
}

module.exports = WorkOrderExtractor;
