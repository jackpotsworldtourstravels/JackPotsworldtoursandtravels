/* Admin — Tour Package Enquiries
   ================================
   The Contact Us page's "Enquire about dates" queue (Phase 2 Bug 3). A public
   submission's queue, not a merchant's — see app.models_v2.TourPackageEnquiry.
   Built the same way as admin-gaming-enquiries.js but as ONE queue (the Gaming
   screen's four status buckets are a gaming-specific layout, not a requirement
   here), with an audit-history panel in the detail modal.

   ENDPOINTS:
     GET   /api/admin/tour-package-enquiries              list (paged, filterable)
     GET   /api/admin/tour-package-enquiries/counts       dashboard/badge figures
     GET   /api/admin/tour-package-enquiries/{id}         detail
     GET   /api/admin/tour-package-enquiries/{id}/history audit trail
     PATCH /api/admin/tour-package-enquiries/{id}         status / assignment / notes

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, PAGE_SIZE, renderPagination), enqSelf
   (admin-enquiries.js) and the shared toast. Nothing here restates them. */

const TPE_STATUS_LABELS = {
  NEW: 'New', ASSIGNED: 'Assigned', CONTACTED: 'Contacted',
  QUOTE_SENT: 'Quote Sent', CONVERTED: 'Converted', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};
const TPE_STATUS_BADGE = {
  NEW: 'pending', ASSIGNED: 'refunded', CONTACTED: 'refunded', QUOTE_SENT: 'refunded',
  CONVERTED: 'confirmed', CLOSED: 'confirmed', CANCELLED: 'cancelled',
};
const tpeStatusLabel = s => TPE_STATUS_LABELS[s] || s;

let tpePage = 1;
let tpeSearchTimer = null;
let tpeFiltersWired = false;

function updateTourPackageNavBadge(count) {
  const badge = document.getElementById('tpeNavBadge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
}

async function refreshTourPackageBadge() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/tour-package-enquiries/counts`, { headers: authHeaders() });
    updateTourPackageNavBadge(data.open || 0);
  } catch (err) { /* a badge is not worth surfacing an error for */ }
}

function wireTpeFilters() {
  if (tpeFiltersWired) return;
  tpeFiltersWired = true;
  document.getElementById('tpeStatusFilter').addEventListener('change', () => loadTourPackageEnquiries(1));
  document.getElementById('tpeSearch').addEventListener('input', () => {
    clearTimeout(tpeSearchTimer);
    tpeSearchTimer = setTimeout(() => loadTourPackageEnquiries(1), 350);
  });
  document.getElementById('tpeRefreshBtn').addEventListener('click', () => loadTourPackageEnquiries(tpePage));
  document.getElementById('tpeTable').addEventListener('click', e => {
    const btn = e.target.closest('[data-tpe-open]');
    if (btn) openTourPackageDetail(btn.dataset.tpeOpen);
  });
}

async function loadTourPackageEnquiries(page = tpePage) {
  wireTpeFilters();
  tpePage = page;
  const tbody = document.querySelector('#tpeTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(5)}</td></tr>`;
  const status = document.getElementById('tpeStatusFilter').value;
  const search = document.getElementById('tpeSearch').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/tour-package-enquiries`, {
      headers: authHeaders(),
      params: { status: status || undefined, search: search || undefined, page, page_size: PAGE_SIZE },
    });
    document.getElementById('tpeQueueSummary').textContent =
      `${data.total} enquir${data.total === 1 ? 'y' : 'ies'}`;
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No tour package enquiries match this filter.</td></tr>`;
    } else {
      tbody.innerHTML = data.items.map(r => `
        <tr>
          <td><strong>${escapeHtml(r.enquiry_reference)}</strong></td>
          <td>
            <div>${escapeHtml(r.customer_name)}</div>
            <div class="cell-sub">${escapeHtml(r.mobile_number)}</div>
          </td>
          <td class="jp-truncate" title="${escapeHtml(r.package_name)}">${escapeHtml(r.package_name)}</td>
          <td>${r.preferred_travel_date ? escapeHtml(r.preferred_travel_date) : '<span style="color:var(--text-muted);">Flexible</span>'}</td>
          <td><span class="badge ${TPE_STATUS_BADGE[r.status] || 'pending'}">${escapeHtml(tpeStatusLabel(r.status))}</span></td>
          <td>${r.assigned_admin_name ? escapeHtml(r.assigned_admin_name) : '<span style="color:var(--text-muted);">Unassigned</span>'}</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-tpe-open="${r.id}">View</button></td>
        </tr>`).join('');
    }
    renderPagination('tpePagination', data.page, data.total_pages, data.total, loadTourPackageEnquiries);
    refreshTourPackageBadge();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load tour package enquiries.</td></tr>`;
  }
}

function tpeDetailRow(label, value) {
  return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span>
          <span class="detail-value">${value}</span></div>`;
}

function tpeHistoryHtml(entries) {
  if (!entries || !entries.length) {
    return '<p style="color:var(--text-muted); font-size:13px;">No changes recorded yet.</p>';
  }
  return `<ul class="tpe-history" style="list-style:none; padding:0; margin:0;">` +
    entries.map(e => {
      const who = e.actor_name ? escapeHtml(e.actor_name) : 'System';
      const transition = (e.from_status && e.to_status)
        ? ` — ${escapeHtml(tpeStatusLabel(e.from_status))} → ${escapeHtml(tpeStatusLabel(e.to_status))}` : '';
      return `<li style="padding:6px 0; border-bottom:1px solid var(--border, #eee);">
        <div style="font-size:13px;"><strong>${who}</strong>${transition}</div>
        <div style="font-size:12px; color:var(--text-muted);">${fmtDateTime(e.at)}${e.description ? ' · ' + escapeHtml(e.description) : ''}</div>
      </li>`;
    }).join('') + `</ul>`;
}

async function openTourPackageDetail(id) {
  const overlay = document.getElementById('tpeModalOverlay');
  const body = document.getElementById('tpeModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Tour Package Enquiry</h2><div>${rowsSkeleton(4)}</div>`;
  wireTpeModalChrome(overlay);

  let r;
  try {
    const res = await axios.get(`${API_BASE}/api/admin/tour-package-enquiries/${id}`, { headers: authHeaders() });
    r = res.data;
  } catch (err) {
    body.innerHTML = `<h2>Tour Package Enquiry</h2>
      <div class="msg error">${escapeHtml(err.response?.data?.detail || 'Could not load this enquiry.')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-tpe-close type="button">Close</button></div>`;
    return;
  }

  const statusOptions = Object.keys(TPE_STATUS_LABELS)
    .map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${escapeHtml(tpeStatusLabel(s))}</option>`)
    .join('');

  body.innerHTML = `
    <h2>Tour Package Enquiry ${escapeHtml(r.enquiry_reference)}</h2>
    <p class="modal-sub">${fmtDateTime(r.created_at)}</p>

    <div class="detail-grid">
      ${tpeDetailRow('Status', `<span class="badge ${TPE_STATUS_BADGE[r.status] || 'pending'}">${escapeHtml(tpeStatusLabel(r.status))}</span>`)}
      ${tpeDetailRow('Name', escapeHtml(r.customer_name))}
      ${tpeDetailRow('Email', `<a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>`)}
      ${tpeDetailRow('Mobile', `<a href="tel:${escapeHtml(r.mobile_number)}">${escapeHtml(r.mobile_number)}</a>`)}
      ${tpeDetailRow('Package', escapeHtml(r.package_name))}
      ${tpeDetailRow('Preferred Travel Date', r.preferred_travel_date ? escapeHtml(r.preferred_travel_date) : 'Flexible')}
      ${tpeDetailRow('Travellers', r.number_of_travellers != null ? String(r.number_of_travellers) : 'Not specified')}
    </div>

    <div class="form-field" style="max-width:none;">
      <label>Customer Message</label>
      <p style="white-space:pre-wrap; border-left:3px solid var(--brand, #FF4D4D); padding-left:12px; margin:4px 0 0;">${escapeHtml(r.message)}</p>
    </div>

    <div class="form-field" style="max-width:none;">
      <label for="tpeStatusSelect">Status</label>
      <select id="tpeStatusSelect" class="status-select">${statusOptions}</select>
    </div>
    <div class="form-field" style="max-width:none;">
      <label>Assigned Admin</label>
      <div style="display:flex; align-items:center; gap:10px;">
        <span id="tpeAssignedName">${r.assigned_admin_name ? escapeHtml(r.assigned_admin_name) : 'Unassigned'}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="tpeAssignMeBtn">Assign to me</button>
      </div>
    </div>
    <div class="form-field" style="max-width:none;">
      <label for="tpeNotes">Internal Notes</label>
      <textarea id="tpeNotes" rows="3" placeholder="What was said, when, and what happens next. Never shown to the customer.">${escapeHtml(r.admin_notes || '')}</textarea>
    </div>
    <div class="msg" id="tpeSaveMsg"></div>

    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-tpe-close>Close</button>
      <button type="button" class="btn btn-navy" id="tpeSaveBtn">Save</button>
    </div>

    <div class="form-field" style="max-width:none; margin-top:18px;">
      <label>History</label>
      <div id="tpeHistory">${rowsSkeleton(2)}</div>
    </div>`;

  wireTpeModalChrome(overlay);
  document.getElementById('tpeAssignMeBtn').addEventListener('click', () => {
    document.getElementById('tpeAssignedName').textContent = '(assigning to you on Save)';
    body.dataset.tpeAssignSelf = '1';
  });
  document.getElementById('tpeSaveBtn').addEventListener('click', () => saveTpeDetail(id));
  loadTpeHistory(id);
}

async function loadTpeHistory(id) {
  const el = document.getElementById('tpeHistory');
  if (!el) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/tour-package-enquiries/${id}/history`, { headers: authHeaders() });
    el.innerHTML = tpeHistoryHtml(data);
  } catch (err) {
    el.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Could not load history.</p>';
  }
}

async function saveTpeDetail(id) {
  const body = document.getElementById('tpeModalBody');
  const msg = document.getElementById('tpeSaveMsg');
  const saveBtn = document.getElementById('tpeSaveBtn');
  const payload = {
    status: document.getElementById('tpeStatusSelect').value,
    admin_notes: document.getElementById('tpeNotes').value,
  };
  if (body.dataset.tpeAssignSelf === '1') {
    payload.assigned_admin_id = enqSelf();
  }
  saveBtn.disabled = true;
  msg.textContent = '';
  msg.className = 'msg';
  try {
    await axios.patch(`${API_BASE}/api/admin/tour-package-enquiries/${id}`, payload, { headers: authHeaders() });
    msg.textContent = 'Saved.';
    msg.className = 'msg success';
    if (typeof showToast === 'function') showToast('Tour package enquiry updated.');
    loadTourPackageEnquiries(tpePage);
    /* Re-open fresh rather than trust the local edit — the server may have
       moved NEW to ASSIGNED on its own when an admin was named without a
       status (tour_package_enquiry_service.update). */
    openTourPackageDetail(id);
  } catch (err) {
    msg.textContent = (err.response && err.response.data && err.response.data.detail) || 'Could not save changes.';
    msg.className = 'msg error';
  } finally {
    saveBtn.disabled = false;
  }
}

function wireTpeModalChrome(overlay) {
  if (overlay.dataset.tpeWired === '1') return;
  overlay.dataset.tpeWired = '1';
  const close = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('click', e => { if (e.target.closest('[data-tpe-close]')) close(); });
}
