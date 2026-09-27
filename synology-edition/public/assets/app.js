/**
 * WhatsToot Dashboard — JavaScript
 * 
 * Auto-refresh, filtering, search, and toast notifications
 */

// =============================================
// Configuration
// =============================================
const API_BASE = '/api';
const REFRESH_INTERVAL = 15000; // 15 seconds (reduced load thanks to real-time SSE)

let currentFilter = 'all';
let lastUploadId = 0;
let refreshTimer = null;
let currentUploadsList = [];
let currentLightboxIndex = -1;
let currentRotation = 0;
let allLoadedGroups = [];

// =============================================
// Initialization
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    setupSSE();
    refreshData();
    startAutoRefresh();
    setupSearch();
    setupFilterTabs();
});

// =============================================
// Data Fetching
// =============================================

async function refreshData() {
    try {
        await Promise.all([
            loadStats(),
            loadUploads(),
            loadBotStatus(),
            loadHealthStatus()
        ]);
    } catch (error) {
        console.error('Refresh error:', error);
    }
}

async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const data = await res.json();

        if (data.success) {
            animateNumber('todayUploads', data.stats.today_uploads);
            animateNumber('totalUploads', data.stats.total_uploads);
            animateNumber('uniqueWO', data.stats.unique_wo);
            animateNumber('pendingCount', data.stats.pending);
            animateNumber('unsortedCount', data.stats.unsorted);
            animateNumber('duplicateCount', data.stats.duplicates);
        }
    } catch (e) {
        console.error('Stats error:', e);
    }
}

async function loadUploads() {
    try {
        const searchVal = document.getElementById('searchInput')?.value || '';
        let url = `${API_BASE}/uploads?limit=50`;

        if (searchVal) url += `&wo=${encodeURIComponent(searchVal)}`;
        if (currentFilter !== 'all') url += `&status=${currentFilter}`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.success) {
            renderUploads(data.uploads);

            // Check for new uploads
            if (data.uploads.length > 0 && data.uploads[0].id > lastUploadId && lastUploadId > 0) {
                showToast(`📸 رفع جديد: ${data.uploads[0].file_name}`, 'success');
            }
            if (data.uploads.length > 0) {
                lastUploadId = data.uploads[0].id;
            }
        }
    } catch (e) {
        console.error('Uploads error:', e);
    }
}

let wasDisconnected = false;
let lastBotState = null; // 'connected' | 'qr' | 'offline'
let lastQrData = null;   // cache last QR to avoid flickering

async function loadBotStatus() {
    try {
        const res = await fetch(`${API_BASE}/bot-status`);
        const data = await res.json();

        const badge = document.getElementById('botStatusBadge');
        const dot = badge.querySelector('.status-dot');
        const text = badge.querySelector('.status-text');

        let newState = 'offline';

        if (data.success && data.whatsapp_ready) {
            newState = 'connected';
        } else if (data.success && data.has_qr) {
            newState = 'qr';
        }

        // تحديث البانرات فقط عند تغيّر الحالة
        if (newState !== lastBotState) {
            document.getElementById('waBannerConnected').style.display = 'none';
            document.getElementById('waBannerQR').style.display = 'none';
            document.getElementById('waBannerOffline').style.display = 'none';

            if (newState === 'connected') {
                dot.className = 'status-dot online';
                text.textContent = 'متصل';
                document.getElementById('waBannerConnected').style.display = 'flex';

                if (wasDisconnected) {
                    showToast('✅ تم الاتصال بواتساب بنجاح!', 'success');
                    wasDisconnected = false;
                }
                setTimeout(() => {
                    document.getElementById('waBannerConnected').style.display = 'none';
                }, 5000);

                setRefreshSpeed('normal');
                lastQrData = null;

            } else if (newState === 'qr') {
                dot.className = 'status-dot offline';
                text.textContent = 'بانتظار QR';
                document.getElementById('waBannerQR').style.display = 'block';
                wasDisconnected = true;
                setRefreshSpeed('fast');

            } else {
                dot.className = 'status-dot offline';
                text.textContent = 'غير متصل';
                document.getElementById('waBannerOffline').style.display = 'flex';
                wasDisconnected = true;
                setRefreshSpeed('fast');
            }

            lastBotState = newState;
        }

        // جلب QR فقط عند الحاجة — وتحديث الصورة فقط إذا تغيّرت البيانات
        if (newState === 'qr') {
            try {
                const qrRes = await fetch(`${API_BASE}/qr`);
                const qrData = await qrRes.json();
                if (qrData.success && qrData.qr && qrData.qr !== lastQrData) {
                    document.getElementById('waQrImage').src = qrData.qr;
                    lastQrData = qrData.qr;
                }
            } catch (e) {
                console.error('QR fetch error:', e);
            }
        }

    } catch (e) {
        if (lastBotState !== 'error') {
            const badge = document.getElementById('botStatusBadge');
            badge.querySelector('.status-dot').className = 'status-dot offline';
            badge.querySelector('.status-text').textContent = 'غير متصل';
            document.getElementById('waBannerConnected').style.display = 'none';
            document.getElementById('waBannerQR').style.display = 'none';
            document.getElementById('waBannerOffline').style.display = 'flex';
            wasDisconnected = true;
            lastBotState = 'error';
            setRefreshSpeed('fast');
        }
    }
}

// ── Adaptive Refresh Speed ──
let currentSpeed = 'normal';

function setRefreshSpeed(speed) {
    if (speed === currentSpeed) return;
    currentSpeed = speed;
    clearInterval(refreshTimer);
    const interval = speed === 'fast' ? 3000 : REFRESH_INTERVAL;
    refreshTimer = setInterval(refreshData, interval);
}

// ── Disconnect WhatsApp ──
async function disconnectWhatsApp() {
    if (!confirm('هل أنت متأكد من قطع اتصال واتساب؟\nسيتم إنشاء QR Code جديد لإعادة الربط.')) return;

    try {
        const res = await fetch(`${API_BASE}/disconnect`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('🔌 تم قطع الاتصال بنجاح', 'success');
            lastBotState = null; // force re-render
            loadBotStatus();
        } else {
            showToast(data.message || 'فشل قطع الاتصال', 'error');
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', 'error');
    }
}

async function loadLogs() {
    try {
        const res = await fetch(`${API_BASE}/logs`);
        const data = await res.json();

        const logsEl = document.getElementById('logsContent');
        if (data.success && data.logs) {
            logsEl.textContent = data.logs || 'لا توجد سجلات';
            // Auto-scroll to bottom
            logsEl.scrollTop = logsEl.scrollHeight;
        } else {
            logsEl.textContent = 'لا توجد سجلات';
        }
    } catch (e) {
        document.getElementById('logsContent').textContent = 'خطأ في تحميل السجلات';
    }
}

// =============================================
// Rendering
// =============================================

function renderUploads(uploads) {
    const tbody = document.getElementById('uploadsBody');
    const countEl = document.getElementById('tableCount');

    currentUploadsList = uploads;
    countEl.textContent = `${uploads.length} نتيجة`;

    if (uploads.length === 0) {
        tbody.innerHTML = `
            <tr class="empty-row">
                <td colspan="8">
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                            <polyline points="13 2 13 9 20 9"></polyline>
                        </svg>
                        <p>لا توجد نتائج</p>
                    </div>
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = uploads.map((u, index) => {
        const statusMap = {
            'completed': { label: 'مكتمل', class: 'badge-completed' },
            'pending':   { label: 'معلّق', class: 'badge-pending' },
            'waiting':   { label: 'بانتظار', class: 'badge-waiting' },
            'duplicate': { label: 'مكرر', class: 'badge-duplicate' },
            'failed':    { label: 'فشل', class: 'badge-failed' },
        };

        const status = statusMap[u.status] || { label: u.status, class: '' };
        const time = formatTime(u.uploaded_at);
        const driveLink = u.drive_url
            ? `<a href="${escapeHtml(u.drive_url)}" target="_blank" class="drive-link">فتح ↗</a>`
            : '<span style="color:var(--text-muted)">—</span>';

        const isImage = u.status === 'completed' && u.drive_id;
        const isVideoFile = isImage && /\.(mp4|3gp|mov|avi|mkv|webm)$/i.test(u.file_name);
        let thumbHtml;
        if (isImage) {
            if (isVideoFile) {
                thumbHtml = `<div class="thumb-cell thumb-video" onclick="openLightboxIndex(${index})"><div class="thumb-play">▶</div></div>`;
            } else {
                thumbHtml = `<div class="thumb-cell" onclick="openLightboxIndex(${index})"><img src="/api/image-thumb/${u.id}?size=small" alt="معاينة" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\'thumb-placeholder\'>🖼</span>'"></div>`;
            }
        } else {
            thumbHtml = '<span class="thumb-placeholder">—</span>';
        }

        return `
            <tr>
                <td data-label="معاينة">${thumbHtml}</td>
                <td data-label="أمر العمل"><span class="wo-number">${escapeHtml(u.work_order)}</span></td>
                <td data-label="اسم الملف"><span class="file-name" title="${escapeHtml(u.file_name)}">${escapeHtml(u.file_name)}</span></td>
                <td data-label="المجموعة"><span class="group-name" title="${escapeHtml(u.group_name || '')}">${escapeHtml(u.group_name || '—')}</span></td>
                <td data-label="المرسل">${escapeHtml(u.sender || '—')}</td>
                <td data-label="الحالة"><span class="badge ${status.class}">${status.label}</span></td>
                <td data-label="الوقت" class="time-cell">${time}</td>
                <td data-label="رابط التخزين">${driveLink}</td>
            </tr>`;
    }).join('');
}

// ── Mobile Drawer Navigation ──
function toggleMobileMenu() {
    const drawer = document.getElementById('mobileDrawer');
    if (!drawer) return;
    if (drawer.classList.contains('active')) {
        closeMobileMenu();
    } else {
        openMobileMenu();
    }
}

function openMobileMenu() {
    const drawer = document.getElementById('mobileDrawer');
    const backdrop = document.getElementById('drawerBackdrop');
    if (drawer) drawer.classList.add('active');
    if (backdrop) backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
    const drawer = document.getElementById('mobileDrawer');
    const backdrop = document.getElementById('drawerBackdrop');
    if (drawer) drawer.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
    document.body.style.overflow = '';
}

// =============================================
// Search & Filters
// =============================================

function setupSearch() {
    const input = document.getElementById('searchInput');
    let debounceTimer;

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            loadUploads();
        }, 400);
    });
}

function setupFilterTabs() {
    const tabs = document.querySelectorAll('.tab');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.filter;
            loadUploads();
        });
    });
}

// =============================================
// Auto Refresh
// =============================================

function startAutoRefresh() {
    refreshTimer = setInterval(refreshData, REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    clearInterval(refreshTimer);
}

// =============================================
// Utilities
// =============================================

function animateNumber(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const current = parseInt(el.textContent) || 0;
    if (current === target) return;

    const duration = 600;
    const steps = 30;
    const stepTime = duration / steps;
    const increment = (target - current) / steps;
    let step = 0;

    el.classList.add('counting');

    const timer = setInterval(() => {
        step++;
        if (step >= steps) {
            el.textContent = target.toLocaleString('ar-SA');
            el.classList.remove('counting');
            clearInterval(timer);
        } else {
            el.textContent = Math.round(current + (increment * step)).toLocaleString('ar-SA');
        }
    }, stepTime);
}

function formatTime(dateStr) {
    if (!dateStr) return '—';

    try {
        const date = new Date(dateStr.replace(' ', 'T'));
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);

        if (diffMins < 1) return 'الآن';
        if (diffMins < 60) return `${diffMins} دقيقة`;
        if (diffHours < 24) return `${diffHours} ساعة`;

        return date.toLocaleDateString('ar-SA', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// =============================================
// Toast Notifications
// =============================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// =============================================
// 🌓 Dark / Light Theme
// =============================================

function initTheme() {
    const savedTheme = localStorage.getItem('whatstoot_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('whatstoot_theme', newTheme);
    updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
        btn.innerHTML = theme === 'dark' ? '☀️' : '🌙';
        btn.title = theme === 'dark' ? 'التبديل إلى الوضع النهاري' : 'التبديل إلى الوضع الليلي';
    }
}

// =============================================
// ⚡ Real-Time SSE (Server-Sent Events)
// =============================================

function setupSSE() {
    try {
        const eventSource = new EventSource(`${API_BASE}/events`);

        eventSource.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === 'upload') {
                    loadStats();
                    loadUploads();
                    const actionWord = payload.data.action === 'uploaded' ? 'تم رفع' : 'في الانتظار';
                    showToast(`📸 ${actionWord}: ${payload.data.file_name} لأمر ${payload.data.work_order || 'غير مصنف'}`, 'success');
                } else if (payload.type === 'bot_status' || payload.type === 'qr') {
                    loadBotStatus();
                }
            } catch (e) {
                // Ignore json parse error
            }
        };

        eventSource.onerror = () => {
            // Reconnection handled automatically by browser
        };
    } catch (e) {
        console.log('SSE not supported or failed to initialize');
    }
}

// =============================================
// 📊 Export to CSV
// =============================================

function exportToCSV() {
    const searchVal = document.getElementById('searchInput')?.value || '';
    let url = `${API_BASE}/export-csv?`;
    if (searchVal) url += `wo=${encodeURIComponent(searchVal)}&`;
    if (currentFilter !== 'all') url += `status=${currentFilter}`;
    window.location.href = url;
}

// =============================================
// Settings Modal Logic (مع حل مشكلة اختفاء المجموعات)
// =============================================

async function openSettingsModal() {
    document.getElementById('settingsModal').classList.add('active');
    
    try {
        const res = await fetch(`${API_BASE}/settings`);
        const data = await res.json();
        
        let currentTarget = '';
        if (data.success && data.settings && data.settings.email_whatsapp_target) {
            currentTarget = data.settings.email_whatsapp_target;
        }

        const groupSelect = document.getElementById('emailTargetGroup');
        groupSelect.innerHTML = '<option value="">جاري تحميل المجموعات...</option>';
        
        const groupsRes = await fetch(`${API_BASE}/groups`);
        const groupsData = await groupsRes.json();
        
        if (groupsData.success && groupsData.groups && groupsData.groups.length > 0) {
            allLoadedGroups = groupsData.groups;
            renderGroupOptions(allLoadedGroups, currentTarget);
            
            const notice = document.getElementById('groupsStatusNotice');
            if (notice) {
                notice.textContent = groupsData.is_live 
                    ? `✅ تم العثور على ${groupsData.groups.length} مجموعة (مباشرة من واتساب)`
                    : `💾 تم تحميل ${groupsData.groups.length} مجموعة مسجلة في النظام`;
            }
        } else {
            allLoadedGroups = [];
            groupSelect.innerHTML = '<option value="">لم يتم العثور على أي مجموعات</option>';
        }

        // تحديد الحالة الأولية
        if (currentTarget && currentTarget.includes('@g.us')) {
            document.querySelector('input[name="emailTargetType"][value="group"]').checked = true;
            toggleEmailTargetType();
            groupSelect.value = currentTarget;
        } else {
            document.querySelector('input[name="emailTargetType"][value="number"]').checked = true;
            toggleEmailTargetType();
            document.getElementById('emailTargetNumber').value = currentTarget || '';
        }

        // جلب إعدادات التنبيهات الإدارية
        try {
            const alertRes = await fetch(`${API_BASE}/alert/settings`);
            const alertData = await alertRes.json();
            if (alertData.success && alertData.alert_email_to) {
                const alertInput = document.getElementById('alertEmailInput');
                if (alertInput) alertInput.value = alertData.alert_email_to;
            }
        } catch (e) {}

    } catch (e) {
        showToast('خطأ في تحميل الإعدادات', 'error');
        console.error(e);
    }
}


function renderGroupOptions(groups, selectedId = '') {
    const groupSelect = document.getElementById('emailTargetGroup');
    if (!groupSelect) return;

    if (groups.length === 0) {
        groupSelect.innerHTML = '<option value="">لا توجد مجموعات مطابقة للبحث</option>';
        return;
    }

    let html = '<option value="">-- اختر مجموعة --</option>';
    let foundSelected = false;

    groups.forEach(g => {
        const isSelected = (g.id === selectedId);
        if (isSelected) foundSelected = true;
        const countText = g.participant_count > 0 ? ` (${g.participant_count} عضو)` : '';
        html += `<option value="${escapeHtml(g.id)}" ${isSelected ? 'selected' : ''}>${escapeHtml(g.name)}${countText}</option>`;
    });

    if (selectedId && !foundSelected && selectedId.includes('@g.us')) {
        html += `<option value="${escapeHtml(selectedId)}" selected>المجموعة المحددة حالياً (${escapeHtml(selectedId.split('@')[0])})</option>`;
    }

    groupSelect.innerHTML = html;
}

function filterGroupOptions() {
    const searchInput = document.getElementById('groupSearchInput');
    const query = (searchInput?.value || '').toLowerCase().trim();
    const groupSelect = document.getElementById('emailTargetGroup');
    const currentVal = groupSelect?.value || '';

    if (!query) {
        renderGroupOptions(allLoadedGroups, currentVal);
        return;
    }

    const filtered = allLoadedGroups.filter(g => 
        (g.name && g.name.toLowerCase().includes(query)) || 
        (g.id && g.id.toLowerCase().includes(query))
    );

    renderGroupOptions(filtered, currentVal);
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.remove('active');
}

function toggleEmailTargetType() {
    const type = document.querySelector('input[name="emailTargetType"]:checked').value;
    if (type === 'number') {
        document.getElementById('emailTargetNumberContainer').style.display = 'block';
        document.getElementById('emailTargetGroupContainer').style.display = 'none';
    } else {
        document.getElementById('emailTargetNumberContainer').style.display = 'none';
        document.getElementById('emailTargetGroupContainer').style.display = 'block';
    }
}

async function saveSettings() {
    const type = document.querySelector('input[name="emailTargetType"]:checked').value;
    let target = '';
    
    if (type === 'number') {
        target = document.getElementById('emailTargetNumber').value.trim();
        if (!target) {
            showToast('الرجاء إدخال رقم الهاتف', 'error');
            return;
        }
    } else {
        target = document.getElementById('emailTargetGroup').value;
        if (!target) {
            showToast('الرجاء اختيار مجموعة', 'error');
            return;
        }
    }

    try {
        const res = await fetch(`${API_BASE}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'email_whatsapp_target', value: target })
        });
        
        const data = await res.json();

        // حفظ بريد التنبيهات الإدارية
        const alertEmail = (document.getElementById('alertEmailInput')?.value || '').trim();
        if (alertEmail) {
            await fetch(`${API_BASE}/alert/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: alertEmail })
            });
        }

        if (data.success) {
            showToast('تم حفظ الإعدادات بنجاح', 'success');
            closeSettingsModal();
        } else {
            showToast(data.message || 'فشل حفظ الإعدادات', 'error');
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', 'error');
        console.error(e);
    }
}

async function testAlertEmail() {
    const btn = document.getElementById('btnTestAlert');
    const email = (document.getElementById('alertEmailInput')?.value || '').trim();
    if (!email || !email.includes('@')) {
        showToast('يرجى كتابة عنوان بريد إلكتروني صحيح أولاً', 'error');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ جاري الإرسال...';
    }

    try {
        const res = await fetch(`${API_BASE}/alert/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'تم إرسال بريد الاختبار بنجاح!', 'success');
        } else {
            showToast(data.message || 'فشل إرسال بريد الاختبار', 'error');
        }
    } catch (e) {
        showToast(`خطأ في الإرسال: ${e.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📧 تجربة الإرسال';
        }
    }
}

async function triggerManualBackup() {
    const btn = document.getElementById('btnManualBackup');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ جاري النسخ...';
    }

    try {
        const res = await fetch(`${API_BASE}/backup/create`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'تم إنشاء النسخة الاحتياطية بنجاح!', 'success');
        } else {
            showToast(data.message || 'فشل إنشاء النسخة الاحتياطية', 'error');
        }
    } catch (e) {
        showToast(`خطأ: ${e.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '💾 نسخ احتياطي فوري';
        }
    }
}

async function loadHealthStatus() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        if (!data.success) return;

        // 1. WhatsApp
        const dotWa = document.getElementById('dotWhatsApp');
        const textWa = document.getElementById('healthWhatsAppText');
        if (dotWa && textWa) {
            if (data.services.whatsapp.ready) {
                dotWa.className = 'health-indicator status-online';
                textWa.textContent = 'متصل وجاهز';
            } else if (data.services.whatsapp.has_qr) {
                dotWa.className = 'health-indicator status-warning';
                textWa.textContent = 'مطلوب مسح QR';
            } else {
                dotWa.className = 'health-indicator status-offline';
                textWa.textContent = 'غير متصل';
            }
        }

        // 2. Email Reader
        const dotEmail = document.getElementById('dotEmail');
        const textEmail = document.getElementById('healthEmailText');
        if (dotEmail && textEmail) {
            if (data.services.email_reader.running) {
                dotEmail.className = 'health-indicator status-online';
                textEmail.textContent = 'يعمل (Gmail IMAP)';
            } else if (data.services.email_reader.enabled) {
                dotEmail.className = 'health-indicator status-warning';
                textEmail.textContent = 'متوقف / جاري الاتصال';
            } else {
                dotEmail.className = 'health-indicator status-offline';
                textEmail.textContent = 'معطل';
            }
        }

        // 3. Synology
        const dotSyn = document.getElementById('dotSynology');
        const textSyn = document.getElementById('healthSynologyText');
        if (dotSyn && textSyn) {
            if (data.services.synology.ready) {
                dotSyn.className = 'health-indicator status-online';
                textSyn.textContent = 'متصل (QuickConnect)';
            } else {
                dotSyn.className = 'health-indicator status-warning';
                textSyn.textContent = 'جاري التهيئة...';
            }
        }

        // 4. Server Resources
        const textServer = document.getElementById('healthServerText');
        if (textServer && data.memory) {
            const uptimeHours = Math.floor(data.uptime_seconds / 3600);
            const uptimeMins = Math.floor((data.uptime_seconds % 3600) / 60);
            textServer.textContent = `RAM: ${data.memory.rss_mb} MB | التشغيل: ${uptimeHours}س ${uptimeMins}د`;
        }
    } catch (e) {
        // تجاهل
    }
}


// =============================================
// Lightbox (مع التنقل والتدوير والتحميل)
// =============================================

function openLightboxIndex(index) {
    if (index < 0 || index >= currentUploadsList.length) return;
    currentLightboxIndex = index;
    const item = currentUploadsList[index];
    const isVideo = /\.(mp4|3gp|mov|avi|mkv|webm)$/i.test(item.file_name);
    openLightbox(item.id, item.work_order, item.file_name, isVideo);
}

function openLightbox(uploadId, workOrder, fileName, isVideo = false) {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');
    const spinner = document.getElementById('lightboxSpinner');
    const info = document.getElementById('lightboxInfo');
    const downloadBtn = document.getElementById('lightboxDownloadBtn');
    const content = document.querySelector('.lightbox-content');

    const existingVideo = document.getElementById('lightboxVideo');
    if (existingVideo) existingVideo.remove();

    currentRotation = 0;
    img.style.transform = 'none';

    spinner.style.display = 'flex';
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (downloadBtn) {
        downloadBtn.href = `/api/image-full/${uploadId}`;
        downloadBtn.download = fileName || 'download';
    }

    if (isVideo) {
        img.style.display = 'none';
        const video = document.createElement('video');
        video.id = 'lightboxVideo';
        video.controls = true;
        video.autoplay = true;
        video.style.maxWidth = '90vw';
        video.style.maxHeight = '75vh';
        video.style.borderRadius = 'var(--radius)';
        video.style.boxShadow = '0 8px 40px rgba(0,0,0,0.5)';
        video.style.opacity = '0';
        video.style.transition = 'opacity 0.4s ease';
        video.src = `/api/image-full/${uploadId}`;
        video.onloadeddata = () => {
            spinner.style.display = 'none';
            video.style.opacity = '1';
        };
        video.onerror = () => {
            spinner.innerHTML = '<span style="color:var(--red)">❌ فشل تحميل الفيديو</span>';
        };
        content.insertBefore(video, info);
    } else {
        img.style.display = 'block';
        img.style.opacity = '0';
        img.src = `/api/image-full/${uploadId}`;
    }

    const icon = isVideo ? '🎬' : '🖼';
    info.innerHTML = `<span class="lightbox-wo">أمر عمل: ${escapeHtml(workOrder)}</span> <span class="lightbox-file">${icon} ${escapeHtml(fileName)}</span>`;
}

function prevLightboxImage(e) {
    if (e) e.stopPropagation();
    if (currentLightboxIndex > 0) {
        openLightboxIndex(currentLightboxIndex - 1);
    }
}

function nextLightboxImage(e) {
    if (e) e.stopPropagation();
    if (currentLightboxIndex < currentUploadsList.length - 1) {
        openLightboxIndex(currentLightboxIndex + 1);
    }
}

function rotateLightboxImage() {
    const img = document.getElementById('lightboxImage');
    if (!img || img.style.display === 'none') return;
    currentRotation = (currentRotation + 90) % 360;
    img.style.transform = `rotate(${currentRotation}deg)`;
}

function closeLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');
    const video = document.getElementById('lightboxVideo');

    overlay.classList.remove('active');
    document.body.style.overflow = '';

    setTimeout(() => {
        img.src = '';
        img.style.display = 'block';
        img.style.transform = 'none';
        if (video) {
            video.pause();
            video.remove();
        }
    }, 300);
}

// Keyboard shortcuts for Lightbox (Esc, Left, Right)
document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('lightboxOverlay');
    if (!overlay.classList.contains('active')) return;

    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') prevLightboxImage();
    if (e.key === 'ArrowLeft') nextLightboxImage();
});
