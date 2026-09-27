/**
 * DuplicateChecker - فحص تكرار الصور
 * 
 * يحسب SHA256 hash للصور ويفحص قاعدة البيانات
 * بديل لـ src/DuplicateChecker.php
 */

const crypto = require('crypto');
const fs = require('fs');
const db = require('./database');

class DuplicateChecker {
    /**
     * حساب hash لملف
     */
    hashFile(filePath) {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    /**
     * حساب hash من بيانات binary (Buffer)
     */
    hashData(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    /**
     * فحص إذا كانت الصورة مكررة
     */
    isDuplicate(hash, workOrder = null) {
        return db.isDuplicate(hash, workOrder);
    }

    /**
     * فحص ملف إذا كان مكرراً
     */
    isFileDuplicate(filePath, workOrder = null) {
        const hash = this.hashFile(filePath);
        return this.isDuplicate(hash, workOrder);
    }
}

module.exports = DuplicateChecker;
