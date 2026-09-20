/**
 * WhatsToot — مستعرض أوامر العمل (Synology)
 * High-Speed Gallery, Multimedia Viewer (Images, Video, PDF), Multi-selection, Streaming ZIP, and Fast Lightbox
 */

let allWorkOrders = [];
let currentWorkOrder = null;
let currentFiles = [];
let displayedFiles = [];
let currentFilter = 'all';
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
        else if (e.key === 'ArrowRight') prevMedia();
        else if (e.key === 'ArrowLeft') nextMedia();
    });

    // فحص إذا كان الرابط يحتوي على أمر عمل محدد في الـ hash (#wo=...)
    const hash = window.location.hash;
    if (hash && hash.startsWith('#wo=')) {
        const wo = hash.replace('#wo=', '').trim();
        if (wo) openWorkOrder(wo);
    }
});

// ── تحديد نوع الملف ──
function getFileType(fileName) {
    if (!fileName) return 'image';
    const ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return 'image';
    return 'other';
}

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
                    <span class="wo-badge">${wo.file_count || 0} ملف</span>
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

// ── البحث والتصفية في أوامر العمل ──
let searchTimeout = null;
let currentDateFilter = 'all';

function filterByDate(range, btn) {
    currentDateFilter = range || 'all';
    document.querySelectorAll('.date-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    applyFilters();
}

function handleSearch(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        applyFilters();
    }, 200);
}

function applyFilters() {
    let filtered = [...allWorkOrders];
    const now = new Date();

    if (currentDateFilter === 'today') {
        const todayStr = now.toISOString().slice(0, 10);
        filtered = filtered.filter(wo => wo.last_activity && wo.last_activity.startsWith(todayStr));
    } else if (currentDateFilter === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        filtered = filtered.filter(wo => wo.last_activity && new Date(wo.last_activity) >= weekAgo);
    }

    const q = (document.getElementById('woSearchInput')?.value || '').trim().toLowerCase();
    if (q) {
        filtered = filtered.filter(wo => String(wo.work_order).toLowerCase().includes(q));
    }

    renderWorkOrders(filtered);
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
            displayedFiles = [];
            updateFilterCounters();
            document.getElementById('currentWoCountBadge').textContent = '0 ملف';
            return;
        }

        currentFiles = data.files;
        updateFilterCounters();
        filterMedia('all', true);
    } catch (e) {
        if (loading) loading.style.display = 'none';
        if (empty) {
            empty.style.display = 'block';
            empty.querySelector('h3').textContent = 'تعذر استعراض ملفات أمر العمل';
            empty.querySelector('p').textContent = e.message;
        }
    }
}

// ── تحديث عدادات الفلاتر ──
function updateFilterCounters() {
    const counts = { all: currentFiles.length, image: 0, video: 0, pdf: 0 };
    currentFiles.forEach(f => {
        const type = getFileType(f.file_name);
        if (counts[type] !== undefined) {
            counts[type]++;
        }
    });

    const cAll = document.getElementById('countFilterAll');
    const cImg = document.getElementById('countFilterImage');
    const cVid = document.getElementById('countFilterVideo');
    const cPdf = document.getElementById('countFilterPdf');

    if (cAll) cAll.textContent = counts.all;
    if (cImg) cImg.textContent = counts.image;
    if (cVid) cVid.textContent = counts.video;
    if (cPdf) cPdf.textContent = counts.pdf;

    const countBadge = document.getElementById('currentWoCountBadge');
    if (countBadge) countBadge.textContent = `${counts.all} ملف`;
}

// ── تصفية الوسائط (الكل / صور / فيديو / PDF) ──
function filterMedia(type, shouldRender = true) {
    currentFilter = type || 'all';

    // تحديث الأزرار
    document.querySelectorAll('.media-filter-btn').forEach(btn => btn.classList.remove('active'));
    const targetId = 'tabFilter' + currentFilter.charAt(0).toUpperCase() + currentFilter.slice(1);
    const activeBtn = document.getElementById(targetId);
    if (activeBtn) activeBtn.classList.add('active');

    if (currentFilter === 'all') {
        displayedFiles = [...currentFiles];
    } else {
        displayedFiles = currentFiles.filter(f => getFileType(f.file_name) === currentFilter);
    }

    if (shouldRender) {
        renderGallery(displayedFiles);
    }
}

// ── الرجوع لقائمة أوامر العمل ──
function backToList() {
    window.location.hash = '';
    currentWorkOrder = null;
    currentFiles = [];
    displayedFiles = [];
    clearSelection();
    document.getElementById('viewWorkOrderDetail').style.display = 'none';
    document.getElementById('viewWorkOrdersList').style.display = 'block';
}

// ── عرض شبكة الوسائط (Gallery Grid) ──
function renderGallery(files) {
    const grid = document.getElementById('galleryGrid');
    const empty = document.getElementById('galleryEmpty');
    if (!grid) return;
    grid.innerHTML = '';

    if (!files || files.length === 0) {
        if (empty) {
            empty.style.display = 'block';
            empty.querySelector('h3').textContent = 'لا توجد ملفات في هذا التصنيف';
            empty.querySelector('p').textContent = 'لم يتم العثور على أي ملفات مطابقة للفلتر المحدد';
        }
        return;
    }
    if (empty) empty.style.display = 'none';

    files.forEach((file, index) => {
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.id = `gallery-card-${index}`;

        const fileId = file.id || file.file_name;
        if (selectedFileIds.has(fileId)) {
            card.classList.add('selected');
        }

        const type = getFileType(file.file_name);
        const thumbUrl = file.thumb_url || (file.id ? `/api/image-thumb/${file.id}` : `/api/synology/thumb?path=${encodeURIComponent(file.drive_id)}`);
        const fullUrl = file.full_url || (file.id ? `/api/image-full/${file.id}` : `/api/synology/full?path=${encodeURIComponent(file.drive_id)}`);
        const downloadUrl = file.download_url || `/api/synology/download?path=${encodeURIComponent(file.drive_id)}&name=${encodeURIComponent(file.file_name)}`;

        const dateStr = file.uploaded_at ? formatDate(file.uploaded_at) : '';
        const senderStr = file.sender ? `من: ${file.sender}` : (file.group_name ? `مجموعة: ${file.group_name}` : '');

        let thumbHtml = '';
        let badgeHtml = '';

        if (type === 'image') {
            thumbHtml = `<img src="${thumbUrl}" alt="${file.file_name}" loading="lazy" decoding="async" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%23666\\' stroke-width=\\'2\\'><rect x=\\'3\\' y=\\'3\\' width=\\'18\\' height=\\'18\\' rx=\\'2\\'/><circle cx=\\'8.5\\' cy=\\'8.5\\' r=\\'1.5\\'/><path d=\\'M21 15l-5-5L5 21\\'/></svg>'">`;
            badgeHtml = `<span class="media-type-badge badge-image">🖼 صورة</span>`;
        } else if (type === 'video') {
            thumbHtml = `
                <div class="video-thumb-box">
                    <video src="${fullUrl}#t=0.5" preload="metadata" muted playsinline></video>
                    <div class="video-play-overlay">
                        <div class="video-play-icon">▶</div>
                    </div>
                </div>
            `;
            badgeHtml = `<span class="media-type-badge badge-video">🎬 فيديو</span>`;
        } else if (type === 'pdf') {
            thumbHtml = `
                <div class="pdf-thumb-box">
                    <div class="pdf-icon-large">📄</div>
                    <span style="font-weight: 800; font-size: 0.85rem; color: #ef4444; letter-spacing: 0.5px;">مستند PDF</span>
                </div>
            `;
            badgeHtml = `<span class="media-type-badge badge-pdf">📄 PDF</span>`;
        } else {
            const ext = file.file_name.split('.').pop().toUpperCase();
            thumbHtml = `
                <div class="pdf-thumb-box" style="background: linear-gradient(145deg, #18202f, #141724);">
                    <div class="pdf-icon-large" style="background: rgba(148,163,184,0.15); border-color: rgba(148,163,184,0.3); color: #94a3b8;">📁</div>
                    <span style="font-weight: 800; font-size: 0.85rem; color: #94a3b8;">${ext}</span>
                </div>
            `;
            badgeHtml = `<span class="media-type-badge" style="background: rgba(148,163,184,0.85); color: #fff;">${ext}</span>`;
        }

        const isChecked = selectedFileIds.has(fileId) ? 'checked' : '';

        card.innerHTML = `
            <div class="gallery-thumb-wrap" onclick="openLightbox(${index})">
                <div class="gallery-checkbox ${isChecked}" onclick="toggleSelectFile(event, ${index})" title="تحديد الملف" id="chk-${index}"></div>
                ${thumbHtml}
                ${badgeHtml}
            </div>
            <div class="gallery-info">
                <span class="gallery-filename" title="${file.file_name}">${file.file_name}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${dateStr}</span>
                ${senderStr ? `<span style="font-size: 0.75rem; color: var(--text-secondary);">${senderStr}</span>` : ''}
            </div>
            <div class="gallery-actions">
                <button class="btn btn-sm btn-ghost" onclick="openLightbox(${index})" style="font-size: 0.8rem; padding: 4px 8px; color: var(--blue);">🔍 استعراض</button>
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
    const file = displayedFiles[index];
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
    if (selectedFileIds.size === displayedFiles.length && displayedFiles.length > 0) {
        clearSelection();
        if (btn) btn.textContent = '☑️ تحديد الكل';
    } else {
        displayedFiles.forEach((file, index) => {
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
        if (text) text.textContent = `تم تحديد ${selectedFileIds.size} ملف`;
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

    // إذا كان ملف واحد فقط، نحمله مباشرة
    if (selectedFileIds.size === 1) {
        const fileId = Array.from(selectedFileIds)[0];
        const file = currentFiles.find(f => (f.id || f.file_name) === fileId);
        if (file) {
            const downloadUrl = file.download_url || `/api/synology/download?path=${encodeURIComponent(file.drive_id)}&name=${encodeURIComponent(file.file_name)}`;
            window.location.href = downloadUrl;
            return;
        }
    }

    // تحميل مجموعة ملفات في ZIP
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
        title.textContent = `📦 نقل كل ملفات أمر العمل (${currentWorkOrder})`;
        desc.textContent = `سيتم نقل كافة الملفات (${currentFiles.length} ملف) إلى أمر عمل جديد في سينولجي وقاعدة البيانات.`;
    } else {
        title.textContent = `📦 نقل الملفات المحددة (${selectedFileIds.size} ملف)`;
        desc.textContent = `سيتم نقل الملفات المحددة من أمر العمل (${currentWorkOrder}) إلى أمر عمل جديد.`;
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

// ── Lightbox فائق السرعة واستعراض الوسائط المتعددة (Fast Lightbox & Media Viewer) ──
function openLightbox(index) {
    if (!displayedFiles || displayedFiles.length === 0) return;
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

    // إيقاف أي فيديو قيد التشغيل وتفريغ iframe والصور
    const vid = document.getElementById('lbVideo');
    if (vid) {
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
    }
    const pdfFrame = document.getElementById('lbPdfFrame');
    if (pdfFrame) {
        pdfFrame.src = '';
    }
    const img = document.getElementById('lbImage');
    if (img) {
        img.src = '';
    }
}

function updateLightboxContent() {
    const file = displayedFiles[currentLightboxIndex];
    if (!file) return;

    const img = document.getElementById('lbImage');
    const vid = document.getElementById('lbVideo');
    const pdfWrap = document.getElementById('lbPdfWrapper');
    const pdfFrame = document.getElementById('lbPdfFrame');
    const nameEl = document.getElementById('lbFileName');
    const counterEl = document.getElementById('lbCounter');
    const badgeEl = document.getElementById('lbTypeBadge');
    const rotateBtn = document.getElementById('btnRotateLb');
    const newTabBtn = document.getElementById('btnOpenNewTab');

    if (nameEl) nameEl.textContent = file.file_name;
    if (counterEl) counterEl.textContent = `(${currentLightboxIndex + 1} من ${displayedFiles.length})`;

    const type = getFileType(file.file_name);
    const thumbUrl = file.thumb_url || (file.id ? `/api/image-thumb/${file.id}?size=large` : `/api/synology/thumb?path=${encodeURIComponent(file.drive_id)}&size=large`);
    const fullUrl = file.full_url || (file.id ? `/api/image-full/${file.id}` : `/api/synology/full?path=${encodeURIComponent(file.drive_id)}`);

    // إيقاف الفيديو السابق
    if (vid) {
        vid.pause();
        vid.removeAttribute('src');
        vid.style.display = 'none';
    }

    // إخفاء الـ PDF السابق
    if (pdfWrap) pdfWrap.style.display = 'none';
    if (pdfFrame) pdfFrame.src = '';

    // إخفاء الصورة مبدئياً
    if (img) {
        img.style.display = 'none';
        img.src = '';
    }

    // تحديث الشارة وأزرار التحكم حسب النوع
    if (type === 'image') {
        if (badgeEl) {
            badgeEl.className = 'media-type-badge badge-image';
            badgeEl.textContent = '🖼 صورة';
        }
        if (rotateBtn) rotateBtn.style.display = 'inline-block';
        if (newTabBtn) newTabBtn.style.display = 'none';

        if (img) {
            img.style.display = 'block';
            img.src = thumbUrl;
            img.style.transform = `rotate(${currentRotation}deg)`;

            const fullImg = new Image();
            fullImg.src = fullUrl;
            fullImg.onload = () => {
                if (currentLightboxIndex === displayedFiles.indexOf(file)) {
                    img.src = fullUrl;
                }
            };
        }

        preloadAdjacentImages();

    } else if (type === 'video') {
        if (badgeEl) {
            badgeEl.className = 'media-type-badge badge-video';
            badgeEl.textContent = '🎬 فيديو';
        }
        if (rotateBtn) rotateBtn.style.display = 'none';
        if (newTabBtn) {
            newTabBtn.style.display = 'inline-flex';
            newTabBtn.href = fullUrl;
        }

        if (vid) {
            vid.style.display = 'block';
            vid.src = fullUrl;
            vid.load();
            vid.play().catch(() => {});
        }

    } else if (type === 'pdf') {
        if (badgeEl) {
            badgeEl.className = 'media-type-badge badge-pdf';
            badgeEl.textContent = '📄 PDF';
        }
        if (rotateBtn) rotateBtn.style.display = 'none';
        if (newTabBtn) {
            newTabBtn.style.display = 'inline-flex';
            newTabBtn.href = fullUrl;
        }

        if (pdfWrap && pdfFrame) {
            pdfWrap.style.display = 'flex';
            pdfFrame.src = fullUrl;
        }

    } else {
        if (badgeEl) {
            badgeEl.className = 'media-type-badge';
            badgeEl.textContent = '📁 ملف';
        }
        if (rotateBtn) rotateBtn.style.display = 'none';
        if (newTabBtn) {
            newTabBtn.style.display = 'inline-flex';
            newTabBtn.href = fullUrl;
        }
    }
}

function preloadAdjacentImages() {
    const nextIdx = (currentLightboxIndex + 1) % displayedFiles.length;
    const prevIdx = (currentLightboxIndex - 1 + displayedFiles.length) % displayedFiles.length;

    [nextIdx, prevIdx].forEach(idx => {
        const file = displayedFiles[idx];
        if (file && getFileType(file.file_name) === 'image') {
            const pre = new Image();
            pre.src = file.thumb_url || (file.id ? `/api/image-thumb/${file.id}?size=large` : `/api/synology/thumb?path=${encodeURIComponent(file.drive_id)}&size=large`);
        }
    });
}

function nextMedia(e) {
    if (e) e.stopPropagation();
    if (!displayedFiles || displayedFiles.length === 0) return;
    currentLightboxIndex = (currentLightboxIndex + 1) % displayedFiles.length;
    currentRotation = 0;
    updateLightboxContent();
}

function prevMedia(e) {
    if (e) e.stopPropagation();
    if (!displayedFiles || displayedFiles.length === 0) return;
    currentLightboxIndex = (currentLightboxIndex - 1 + displayedFiles.length) % displayedFiles.length;
    currentRotation = 0;
    updateLightboxContent();
}

// توافقية مع الأسماء القديمة
const nextImage = nextMedia;
const prevImage = prevMedia;

function rotateLightbox() {
    currentRotation = (currentRotation + 90) % 360;
    const img = document.getElementById('lbImage');
    if (img) img.style.transform = `rotate(${currentRotation}deg)`;
}

function downloadCurrentLightboxMedia() {
    const file = displayedFiles[currentLightboxIndex];
    if (!file) return;
    const downloadUrl = file.download_url || `/api/synology/download?path=${encodeURIComponent(file.drive_id)}&name=${encodeURIComponent(file.file_name)}`;
    window.location.href = downloadUrl;
}

const downloadCurrentLightboxImage = downloadCurrentLightboxMedia;

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
