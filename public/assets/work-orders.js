/**
 * WhatsToot — مستعرض أوامر العمل (Synology)
 * High-Speed Gallery, Multi-selection, Streaming ZIP, and Fast Lightbox
 */

let allWorkOrders = [];
let currentWorkOrder = null;
let currentFiles = [];
let selectedFileIds = new Set();
let currentLightboxIndex = 0;
let currentRotation = 0;
let isMoveAllMode = false;

// ── تهيئة الصفحة ──
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    loadWorkOrders();

    // دعم مفاتيح الكيبورد في Lightbox
    window.addEventListener('keydown', (e) => {
        const lb = document.getElementById('fastLightbox');
        if (!lb || !lb.classList.contains('active')) return;

        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowRight') prevImage();
        else if (e.key === 'ArrowLeft') nextImage();
    });

    // فحص إذا كان الرابط يحتوي على أمر عمل محدد في الـ hash (#wo=...)
    const hash = window.location.hash;
    if (hash && hash.startsWith('#wo=')) {
        const wo = hash.replace('#wo=', '').trim();
        if (wo) openWorkOrder(wo);
    }
});

// ── الثيم (Dark/Light) ──
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeBtn(savedTheme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeBtn(next);
}

function updateThemeBtn(theme) {
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

// ── جلب قائمة أوامر العمل ──
async function loadWorkOrders(forceSync = false) {
    const loading = document.getElementById('woListLoading');
    const empty = document.getElementById('woListEmpty');
    const grid = document.getElementById('woGrid');

    if (loading) loading.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (grid) grid.innerHTML = '';

    try {
        const url = `/api/work-orders?limit=200${forceSync ? '&sync=1' : ''}`;
        const res = await fetch(url);
        const data = await res.json();

        if (loading) loading.style.display = 'none';

        if (!data.success || !data.work_orders || data.work_orders.length === 0) {
            if (empty) empty.style.display = 'block';
            allWorkOrders = [];
            return;
        }

        allWorkOrders = data.work_orders;
        renderWorkOrders(allWorkOrders);
    } catch (e) {
        if (loading) loading.style.display = 'none';
        if (empty) {
            empty.style.display = 'block';
            empty.querySelector('h3').textContent = 'تعذر تحميل أوامر العمل';
            empty.querySelector('p').textContent = e.message;
        }
    }
}

function syncSynology() {
    const btn = document.getElementById('syncBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ جاري المزامنة...';
    }
    loadWorkOrders(true).finally(() => {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔄 تحديث من سينولجي';
        }
    });
}

// ── عرض أوامر العمل ──
function renderWorkOrders(orders) {
    const grid = document.getElementById('woGrid');
    const empty = document.getElementById('woListEmpty');
    if (!grid) return;

    grid.innerHTML = '';

    if (!orders || orders.length === 0) {
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    orders.forEach(wo => {
        const card = document.createElement('div');
        card.className = 'wo-card';
        card.onclick = () => openWorkOrder(wo.work_order);

        // صورة الغلاف إن وجدت
        let previewHtml = '';
        if (wo.preview_upload_id) {
            previewHtml = `
                <div class="wo-card-preview">
                    <img src="/api/image-thumb/${wo.preview_upload_id}?size=small" alt="${wo.work_order}" loading="lazy" onerror="this.parentElement.style.display='none'">
                </div>
            `;
        }

        const dateStr = wo.last_activity ? formatDate(wo.last_activity) : 'غير محدد';
        const sourceLabel = wo.source === 'both' ? 'سينولجي + قاعدة البيانات' : (wo.source === 'synology' ? 'سينولجي' : 'قاعدة البيانات');

        card.innerHTML = `
            <div>
                <div class="wo-card-header">
                    <div class="wo-number">
                        <span style="color: var(--blue);">📁</span>
                        <span>${wo.work_order}</span>
                    </div>
                    <span class="wo-badge">${wo.file_count || 0} صورة</span>
                </div>
                ${previewHtml}
                <div class="wo-card-meta">
                    <div class="wo-meta-row">
                        <span>🕒 آخر نشاط:</span>
                        <strong style="color: var(--text-primary);">${dateStr}</strong>
                    </div>
                    <div class="wo-meta-row">
                        <span>💾 المصدر:</span>
                        <span>${sourceLabel}</span>
                    </div>
                </div>
            </div>
            <div style="display: flex; justify-content: flex-end;">
                <span class="btn btn-sm" style="background: var(--blue-soft); color: var(--blue); border-radius: 6px; font-weight: bold; pointer-events: none;">فتح المجلد ←</span>
            </div>
        `;

        grid.appendChild(card);
    });
}

// ── البحث في أوامر العمل ──
let searchTimeout = null;
function handleSearch(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        const q = (query || '').trim().toLowerCase();
        if (!q) {
            renderWorkOrders(allWorkOrders);
            return;
        }
        const filtered = allWorkOrders.filter(wo => String(wo.work_order).toLowerCase().includes(q));
        renderWorkOrders(filtered);
    }, 200);
}

// ── فتح مجلد أمر العمل ──
async function openWorkOrder(wo) {
    currentWorkOrder = String(wo);
    window.location.hash = `wo=${currentWorkOrder}`;

    document.getElementById('viewWorkOrdersList').style.display = 'none';
    const detailView = document.getElementById('viewWorkOrderDetail');
    detailView.style.display = 'block';

    document.getElementById('currentWoNumber').textContent = currentWorkOrder;
    document.getElementById('currentWoCountBadge').textContent = '...';

    const loading = document.getElementById('galleryLoading');
    const empty = document.getElementById('galleryEmpty');
    const grid = document.getElementById('galleryGrid');

    if (loading) loading.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (grid) grid.innerHTML = '';
    clearSelection();

    try {
        const res = await fetch(`/api/work-orders/${encodeURIComponent(currentWorkOrder)}`);
        const data = await res.json();

        if (loading) loading.style.display = 'none';

        if (!data.success || !data.files || data.files.length === 0) {
            if (empty) empty.style.display = 'block';
            currentFiles = [];
            document.getElementById('currentWoCountBadge').textContent = '0 صورة';
            return;
        }

        currentFiles = data.files;
        document.getElementById('currentWoCountBadge').textContent = `${currentFiles.length} صورة`;
        renderGallery(currentFiles);
    } catch (e) {
        if (loading) loading.style.display = 'none';
        if (empty) {
            empty.style.display = 'block';
            empty.querySelector('h3').textContent = 'تعذر استعراض صور أمر العمل';
            empty.querySelector('p').textContent = e.message;
        }
    }
}

// ── الرجوع لقائمة أوامر العمل ──
function backToList() {
    window.location.hash = '';
    currentWorkOrder = null;
    currentFiles = [];
    clearSelection();
    document.getElementById('viewWorkOrderDetail').style.display = 'none';
    document.getElementById('viewWorkOrdersList').style.display = 'block';
}

// ── عرض شبكة الصور (Gallery Grid) ──
function renderGallery(files) {
    const grid = document.getElementById('galleryGrid');
    if (!grid) return;
    grid.innerHTML = '';

    files.forEach((file, index) => {
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.id = `gallery-card-${index}`;

        // تحديد رابط المعاينة والتحميل
        const thumbUrl = file.thumb_url || (file.id ? `/api/image-thumb/${file.id}` : `/api/synology/thumb?path=${encodeURIComponent(file.drive_id)}`);
        const downloadUrl = file.download_url || `/api/synology/download?path=${encodeURIComponent(file.drive_id)}&name=${encodeURIComponent(file.file_name)}`;

        const dateStr = file.uploaded_at ? formatDate(file.uploaded_at) : '';
        const senderStr = file.sender ? `من: ${file.sender}` : (file.group_name ? `مجموعة: ${file.group_name}` : '');

        card.innerHTML = `
            <div class="gallery-thumb-wrap" onclick="openLightbox(${index})">
                <div class="gallery-checkbox" onclick="toggleSelectFile(event, ${index})" title="تحديد الصورة" id="chk-${index}"></div>
                <img src="${thumbUrl}" alt="${file.file_name}" loading="lazy" decoding="async">
            </div>
            <div class="gallery-info">
                <span class="gallery-filename" title="${file.file_name}">${file.file_name}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${dateStr}</span>
                ${senderStr ? `<span style="font-size: 0.75rem; color: var(--text-secondary);">${senderStr}</span>` : ''}
            </div>
            <div class="gallery-actions">
                <button class="btn btn-sm btn-ghost" onclick="openLightbox(${index})" style="font-size: 0.8rem; padding: 4px 8px; color: var(--blue);">🔍 تكبير</button>
                <a href="${downloadUrl}" class="btn btn-sm btn-ghost" style="font-size: 0.8rem; padding: 4px 8px; color: var(--green); text-decoration: none;" download="${file.file_name}">⬇️ تحميل</a>
            </div>
        `;

        grid.appendChild(card);
    });
}

// ── إدارة التحديد المتعدد (Selection) ──
function toggleSelectFile(e, index) {
    e.stopPropagation();
    const chk = document.getElementById(`chk-${index}`);
    const card = document.getElementById(`gallery-card-${index}`);
    const file = currentFiles[index];
    if (!file) return;

    const fileId = file.id || file.file_name;

    if (selectedFileIds.has(fileId)) {
        selectedFileIds.delete(fileId);
        if (chk) chk.classList.remove('checked');
        if (card) card.classList.remove('selected');
    } else {
        selectedFileIds.add(fileId);
        if (chk) chk.classList.add('checked');
        if (card) card.classList.add('selected');
    }

    updateFloatingActionBar();
}

function toggleSelectAll() {
    const btn = document.getElementById('btnSelectAll');
    if (selectedFileIds.size === currentFiles.length) {
        clearSelection();
        if (btn) btn.textContent = '☑️ تحديد الكل';
    } else {
        selectedFileIds.clear();
        currentFiles.forEach((file, index) => {
            const fileId = file.id || file.file_name;
            selectedFileIds.add(fileId);
            const chk = document.getElementById(`chk-${index}`);
            const card = document.getElementById(`gallery-card-${index}`);
            if (chk) chk.classList.add('checked');
            if (card) card.classList.add('selected');
        });
        if (btn) btn.textContent = '❌ إلغاء تحديد الكل';
        updateFloatingActionBar();
    }
}

function clearSelection() {
    selectedFileIds.clear();
    document.querySelectorAll('.gallery-checkbox').forEach(el => el.classList.remove('checked'));
    document.querySelectorAll('.gallery-card').forEach(el => el.classList.remove('selected'));
    const btn = document.getElementById('btnSelectAll');
    if (btn) btn.textContent = '☑️ تحديد الكل';
    updateFloatingActionBar();
}

function updateFloatingActionBar() {
    const bar = document.getElementById('floatingActionBar');
    const text = document.getElementById('selectedCountText');
    if (!bar) return;

    if (selectedFileIds.size > 0) {
        bar.classList.add('active');
        if (text) text.textContent = `تم تحديد ${selectedFileIds.size} صورة`;
    } else {
        bar.classList.remove('active');
    }
}

// ── تحميل كملف مضغوط (ZIP) ──
function downloadAllZip() {
    if (!currentWorkOrder) return;
    const btn = document.getElementById('btnDownloadAllZip');
    if (btn) {
        btn.textContent = '⏳ جاري الضغط...';
        btn.disabled = true;
    }

    // فتح رابط التحميل المباشر للـ ZIP التدفقي
    window.location.href = `/api/work-orders/${encodeURIComponent(currentWorkOrder)}/zip`;

    setTimeout(() => {
        if (btn) {
            btn.textContent = '📥 تحميل الكل (ZIP)';
            btn.disabled = false;
        }
    }, 3000);
}

async function downloadSelectedZip() {
    if (!currentWorkOrder || selectedFileIds.size === 0) return;

    // إذا كانت صورة واحدة فقط، نحملها مباشرة
    if (selectedFileIds.size === 1) {
        const fileId = Array.from(selectedFileIds)[0];
        const file = currentFiles.find(f => (f.id || f.file_name) === fileId);
        if (file) {
            const downloadUrl = file.download_url || `/api/synology/download?path=${encodeURIComponent(file.drive_id)}&name=${encodeURIComponent(file.file_name)}`;
            window.location.href = downloadUrl;
            return;
        }
    }

    // تحميل مجموعة صور في ZIP
    try {
        const res = await fetch(`/api/work-orders/${encodeURIComponent(currentWorkOrder)}/download-selected-zip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: Array.from(selectedFileIds) })
        });

        if (!res.ok) throw new Error('فشل إنشاء ملف الـ ZIP');

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `WO_${currentWorkOrder}_selected_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    } catch (e) {
        alert(`حدث خطأ أثناء تحميل الملفات: ${e.message}`);
    }
}

// ── نافذة النقل (Move Modal) ──
function openMoveModal(isAll = false) {
    isMoveAllMode = isAll;
    const modal = document.getElementById('moveModal');
    const title = document.getElementById('moveModalTitle');
    const desc = document.getElementById('moveModalDesc');
    const input = document.getElementById('targetWoInput');
    const progress = document.getElementById('moveProgress');

    if (!modal) return;
    if (progress) progress.style.display = 'none';
    if (input) input.value = '';

    if (isAll) {
        title.textContent = `📦 نقل كل صور أمر العمل (${currentWorkOrder})`;
        desc.textContent = `سيتم نقل كافة الصور (${currentFiles.length} صورة) إلى أمر عمل جديد في سينولجي وقاعدة البيانات.`;
    } else {
        title.textContent = `📦 نقل الصور المحددة (${selectedFileIds.size} صورة)`;
        desc.textContent = `سيتم نقل الصور المحددة من أمر العمل (${currentWorkOrder}) إلى أمر عمل جديد.`;
    }

    modal.classList.add('active');
    if (input) input.focus();
}

function closeMoveModal() {
    const modal = document.getElementById('moveModal');
    if (modal) modal.classList.remove('active');
}

async function executeMove() {
    const input = document.getElementById('targetWoInput');
    const targetWo = input ? input.value.trim() : '';

    if (!targetWo) {
        alert('يرجى إدخال رقم أمر العمل الجديد');
        return;
    }

    if (targetWo === currentWorkOrder) {
        alert('رقم أمر العمل الجديد مطابق لرقم أمر العمل الحالي!');
        return;
    }

    const progress = document.getElementById('moveProgress');
    const btnConfirm = document.getElementById('btnConfirmMove');
    const btnCancel = document.getElementById('btnCancelMove');

    if (progress) progress.style.display = 'block';
    if (btnConfirm) btnConfirm.disabled = true;
    if (btnCancel) btnCancel.disabled = true;

    try {
        const bodyData = {
            from_wo: currentWorkOrder,
            to_wo: targetWo,
            all: isMoveAllMode,
            file_ids: isMoveAllMode ? null : Array.from(selectedFileIds),
        };

        const res = await fetch('/api/work-orders/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'فشل النقل');

        alert(data.message || 'تم نقل الملفات بنجاح!');
        closeMoveModal();

        // إعادة تحميل القائمة أو الانتقال إلى أمر العمل الجديد
        if (isMoveAllMode) {
            backToList();
            loadWorkOrders(true);
        } else {
            openWorkOrder(currentWorkOrder);
        }
    } catch (e) {
        alert(`خطأ: ${e.message}`);
    } finally {
        if (progress) progress.style.display = 'none';
        if (btnConfirm) btnConfirm.disabled = false;
        if (btnCancel) btnCancel.disabled = false;
    }
}

// ── Lightbox فائق السرعة (Fast Lightbox) ──
function openLightbox(index) {
    if (!currentFiles || currentFiles.length === 0) return;
    currentLightboxIndex = index;
    currentRotation = 0;

    const lb = document.getElementById('fastLightbox');
    if (!lb) return;

    lb.classList.add('active');
    updateLightboxContent();
}

function closeLightbox() {
    const lb = document.getElementById('fastLightbox');
    if (lb) lb.classList.remove('active');
}

function updateLightboxContent() {
    const file = currentFiles[currentLightboxIndex];
    if (!file) return;

    const img = document.getElementById('lbImage');
    const nameEl = document.getElementById('lbFileName');
    const counterEl = document.getElementById('lbCounter');

    if (nameEl) nameEl.textContent = file.file_name;
    if (counterEl) counterEl.textContent = `(${currentLightboxIndex + 1} من ${currentFiles.length})`;

    // سرعة فائقة: عرض المصغّر المحفوظ فورياً (0ms) ثم تبديل الصورة الكاملة بسلاسة
    const thumbUrl = file.thumb_url || (file.id ? `/api/image-thumb/${file.id}?size=large` : `/api/synology/thumb?path=${encodeURIComponent(file.drive_id)}&size=large`);
    const fullUrl = file.full_url || (file.id ? `/api/image-full/${file.id}` : `/api/synology/full?path=${encodeURIComponent(file.drive_id)}`);

    if (img) {
        img.src = thumbUrl;
        img.style.transform = `rotate(${currentRotation}deg)`;

        // جلب الصورة بالحجم الكامل في الخلفية وتبديلها فور انتهائها
        const fullImg = new Image();
        fullImg.src = fullUrl;
        fullImg.onload = () => {
            if (currentLightboxIndex === currentFiles.indexOf(file)) {
                img.src = fullUrl;
            }
        };
    }

    // التحميل المسبق (Preload) للصورة التالية والسابقة لتكون فورية عند النقر
    preloadAdjacentImages();
}

function preloadAdjacentImages() {
    const nextIdx = (currentLightboxIndex + 1) % currentFiles.length;
    const prevIdx = (currentLightboxIndex - 1 + currentFiles.length) % currentFiles.length;

    [nextIdx, prevIdx].forEach(idx => {
        const file = currentFiles[idx];
        if (file) {
            const pre = new Image();
            pre.src = file.thumb_url || (file.id ? `/api/image-thumb/${file.id}?size=large` : `/api/synology/thumb?path=${encodeURIComponent(file.drive_id)}&size=large`);
        }
    });
}

function nextImage(e) {
    if (e) e.stopPropagation();
    currentLightboxIndex = (currentLightboxIndex + 1) % currentFiles.length;
    currentRotation = 0;
    updateLightboxContent();
}

function prevImage(e) {
    if (e) e.stopPropagation();
    currentLightboxIndex = (currentLightboxIndex - 1 + currentFiles.length) % currentFiles.length;
    currentRotation = 0;
    updateLightboxContent();
}

function rotateLightbox() {
    currentRotation = (currentRotation + 90) % 360;
    const img = document.getElementById('lbImage');
    if (img) img.style.transform = `rotate(${currentRotation}deg)`;
}

function downloadCurrentLightboxImage() {
    const file = currentFiles[currentLightboxIndex];
    if (!file) return;
    const downloadUrl = file.download_url || `/api/synology/download?path=${encodeURIComponent(file.drive_id)}&name=${encodeURIComponent(file.file_name)}`;
    window.location.href = downloadUrl;
}

function handleLightboxClick(e) {
    if (e.target.id === 'fastLightbox' || e.target.classList.contains('lightbox-stage')) {
        closeLightbox();
    }
}

// ── أدوات مساعدة ──
function formatDate(dateString) {
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('ar-SA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateString;
    }
}
