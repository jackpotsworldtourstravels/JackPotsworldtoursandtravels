/* Admin — Gaming Tour Enquiries
   ===============================
   A public submission's queue, not a merchant's. See
   app.models_v2.GamingTourEnquiry for why this is not shaped like the
   Booking Enquiries screen next to it in the sidebar: there is no merchant,
   no wallet, no credit limit and no quotation binding a fare to a booking —
   any platform admin may see and work any row.

   ENDPOINTS:
     GET   /api/admin/gaming-tour-enquiries              list (paged, filterable)
     GET   /api/admin/gaming-tour-enquiries/{id}          detail
     PATCH /api/admin/gaming-tour-enquiries/{id}          status / assignment / notes

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDateTime, rowsSkeleton, navigateToSection, PAGE_SIZE,
   renderPagination) plus the shared toast component. Nothing here restates
   them. */

const GT_STATUS_LABELS = {
  NEW: 'New', ASSIGNED: 'Assigned', CONTACTED: 'Contacted',
  QUOTE_PREPARED: 'Quote Prepared', CUSTOMER_CONFIRMED: 'Customer Confirmed',
  BOOKING_CREATED: 'Booking Created', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
const GT_STATUS_BADGE = {
  NEW: 'pending', ASSIGNED: 'refunded', CONTACTED: 'refunded', QUOTE_PREPARED: 'refunded',
  CUSTOMER_CONFIRMED: 'confirmed', BOOKING_CREATED: 'confirmed', COMPLETED: 'confirmed',
  CANCELLED: 'cancelled',
};
const gtStatusLabel = s => GT_STATUS_LABELS[s] || s;

let gtPage = 1;
let gtSearchTimer = null;
let gtFiltersWired = false;

function updateGamingTourNavBadge(count) {
  const badge = document.getElementById('gtNavBadge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
}

function gtRoute(r) {
  return `<div>${escapeHtml(r.from_airport)} → ${escapeHtml(r.to_airport)}</div>`;
}

function wireGtFilters() {
  if (gtFiltersWired) return;
  gtFiltersWired = true;
  document.getElementById('gtStatusFilter').addEventListener('change', () => loadGamingTourEnquiries(1));
  document.getElementById('gtSearch').addEventListener('input', () => {
    clearTimeout(gtSearchTimer);
    gtSearchTimer = setTimeout(() => loadGamingTourEnquiries(1), 350);
  });
  document.getElementById('gtRefreshBtn').addEventListener('click', () => loadGamingTourEnquiries(gtPage));
  document.getElementById('gtTable').addEventListener('click', e => {
    const btn = e.target.closest('[data-gt-open]');
    if (btn) openGamingTourDetail(btn.dataset.gtOpen);
  });
}

async function loadGamingTourEnquiries(page = gtPage) {
  wireGtFilters();
  gtPage = page;
  const tbody = document.querySelector('#gtTable tbody');
  tbody.innerHTML = `<tr><td colspan="10">${rowsSkeleton(5)}</td></tr>`;
  const status = document.getElementById('gtStatusFilter').value;
  const search = document.getElementById('gtSearch').value;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/gaming-tour-enquiries`, {
      headers: authHeaders(),
      params: { status: status || undefined, search: search || undefined, page, page_size: PAGE_SIZE },
    });
    document.getElementById('gtQueueSummary').textContent =
      `${data.total} enquir${data.total === 1 ? 'y' : 'ies'}`;
    if (!data.items.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No gaming tour enquiries match this filter.</td></tr>`;
    } else {
      tbody.innerHTML = data.items.map(r => `
        <tr>
          <td><strong>${escapeHtml(r.enquiry_reference)}</strong></td>
          <td>
            <div>${escapeHtml(r.customer_name)}</div>
            <div class="cell-sub">${escapeHtml(r.mobile_number)}</div>
          </td>
          <td>${gtRoute(r)}</td>
          <td>${fmtDateTime(r.travel_datetime)}</td>
          <td class="num">${r.number_of_nights}</td>
          <td class="jp-truncate" title="${escapeHtml(r.casino_type)}">${escapeHtml(r.casino_type)}</td>
          <td><span class="badge ${GT_STATUS_BADGE[r.status] || 'pending'}">${escapeHtml(gtStatusLabel(r.status))}</span></td>
          <td>${r.assigned_admin_name ? escapeHtml(r.assigned_admin_name) : '<span style="color:var(--text-muted);">Unassigned</span>'}</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-gt-open="${r.id}">View</button></td>
        </tr>`).join('');
    }
    renderPagination('gtPagination', data.page, data.total_pages, data.total, loadGamingTourEnquiries);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">Failed to load gaming tour enquiries.</td></tr>`;
  }
}

function gtDetailRow(label, value) {
  return `<div class="detail-item"><span class="detail-label">${escapeHtml(label)}</span>
          <span class="detail-value">${value}</span></div>`;
}

async function openGamingTourDetail(id) {
  const overlay = document.getElementById('gtModalOverlay');
  const body = document.getElementById('gtModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Gaming Tour Enquiry</h2><div>${rowsSkeleton(4)}</div>`;
  wireGtModalChrome(overlay, body);

  let r;
  try {
    const res = await axios.get(`${API_BASE}/api/admin/gaming-tour-enquiries/${id}`, { headers: authHeaders() });
    r = res.data;
  } catch (err) {
    body.innerHTML = `<h2>Gaming Tour Enquiry</h2>
      <div class="msg error">${escapeHtml(err.response?.data?.detail || 'Could not load this enquiry.')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-gt-close type="button">Close</button></div>`;
    return;
  }

  const statusOptions = Object.keys(GT_STATUS_LABELS)
    .map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${escapeHtml(gtStatusLabel(s))}</option>`)
    .join('');

  body.innerHTML = `
    <h2>Gaming Tour Enquiry ${escapeHtml(r.enquiry_reference)}</h2>
    <p class="modal-sub">${fmtDateTime(r.created_at)}</p>

    <div class="detail-grid">
      ${gtDetailRow('Status', `<span class="badge ${GT_STATUS_BADGE[r.status] || 'pending'}">${escapeHtml(gtStatusLabel(r.status))}</span>`)}
      ${gtDetailRow('Name', escapeHtml(r.customer_name))}
      ${gtDetailRow('Email', `<a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>`)}
      ${gtDetailRow('Mobile', `<a href="tel:${escapeHtml(r.mobile_number)}">${escapeHtml(r.mobile_number)}</a>`)}
      ${gtDetailRow('From Airport', escapeHtml(r.from_airport))}
      ${gtDetailRow('To Airport', escapeHtml(r.to_airport))}
      ${gtDetailRow('Travel Date & Time', fmtDateTime(r.travel_datetime))}
      ${gtDetailRow('Nights', String(r.number_of_nights))}
      ${gtDetailRow('Casino Type', escapeHtml(r.casino_type))}
    </div>

    <div class="form-field" style="max-width:none;">
      <label for="gtStatusSelect">Status</label>
      <select id="gtStatusSelect" class="status-select">${statusOptions}</select>
    </div>
    <div class="form-field" style="max-width:none;">
      <label>Assigned Admin</label>
      <div style="display:flex; align-items:center; gap:10px;">
        <span id="gtAssignedName">${r.assigned_admin_name ? escapeHtml(r.assigned_admin_name) : 'Unassigned'}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="gtAssignMeBtn">Assign to me</button>
      </div>
    </div>
    <div class="form-field" style="max-width:none;">
      <label for="gtNotes">Admin Notes</label>
      <textarea id="gtNotes" rows="3" placeholder="What was said, when, and what happens next.">${escapeHtml(r.admin_notes || '')}</textarea>
    </div>
    <div class="msg" id="gtSaveMsg"></div>

    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-gt-close>Close</button>
      <!-- SEND QUOTE / CONVERT TO BOOKING are status shortcuts, not a second
           write path — each sets the one field Save also writes, pre-filled,
           so a desk that has already decided the outcome does not have to
           find the same value twice in the dropdown. Neither raises a real
           booking record: that is the booking flow's own job once the
           customer has actually confirmed by phone, not this queue's. -->
      <button type="button" class="btn btn-ghost" id="gtSendQuoteBtn">Send Quote</button>
      <button type="button" class="btn btn-ghost" id="gtConvertBtn">Convert To Booking</button>
      <button type="button" class="btn btn-navy" id="gtSaveBtn">Save</button>
    </div>`;

  wireGtModalChrome(overlay, body);
  document.getElementById('gtAssignMeBtn').addEventListener('click', () => {
    document.getElementById('gtAssignedName').textContent = '(assigning to you on Save)';
    body.dataset.gtAssignSelf = '1';
  });
  document.getElementById('gtSendQuoteBtn').addEventListener('click', () => {
    document.getElementById('gtStatusSelect').value = 'QUOTE_PREPARED';
    saveGtDetail(id, r);
  });
  document.getElementById('gtConvertBtn').addEventListener('click', () => {
    document.getElementById('gtStatusSelect').value = 'BOOKING_CREATED';
    saveGtDetail(id, r);
  });
  document.getElementById('gtSaveBtn').addEventListener('click', () => saveGtDetail(id, r));
}

async function saveGtDetail(id, current) {
  const body = document.getElementById('gtModalBody');
  const msg = document.getElementById('gtSaveMsg');
  const saveBtn = document.getElementById('gtSaveBtn');
  const payload = {
    status: document.getElementById('gtStatusSelect').value,
    admin_notes: document.getElementById('gtNotes').value,
  };
  if (body.dataset.gtAssignSelf === '1') {
    payload.assigned_admin_id = enqSelf();
  }
  saveBtn.disabled = true;
  msg.textContent = '';
  msg.className = 'msg';
  try {
    await axios.patch(`${API_BASE}/api/admin/gaming-tour-enquiries/${id}`, payload, { headers: authHeaders() });
    msg.textContent = 'Saved.';
    msg.className = 'msg success';
    if (typeof showToast === 'function') showToast('Gaming tour enquiry updated.');
    loadGamingTourEnquiries(gtPage);
    /* Re-open fresh rather than trust the local edit — the server may have
       moved NEW to ASSIGNED on its own when an admin was named without a
       status (gaming_tour_enquiry_service.update), and the panel should
       show what actually landed. */
    openGamingTourDetail(id);
  } catch (err) {
    msg.textContent = (err.response && err.response.data && err.response.data.detail) || 'Could not save changes.';
    msg.className = 'msg error';
  } finally {
    saveBtn.disabled = false;
  }
}

function wireGtModalChrome(overlay, body) {
  if (overlay.dataset.gtWired === '1') return;
  overlay.dataset.gtWired = '1';
  const close = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('click', e => { if (e.target.closest('[data-gt-close]')) close(); });
}
