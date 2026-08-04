'use strict';
/* Merchant Portal — Request History. GET /api/requests + GET /api/requests/{id}
   (API_CONTRACT.md — existing, live). The detail view drives its action buttons entirely from
   the server's `actions` list (docs/API_CONTRACT.md's ActionOption) rather than hardcoding a
   status -> button map here, so it never drifts from app/services/lifecycle.py's state
   machine. "Pay" is the one exception: paying isn't a status transition, it's a separate
   endpoint the merchant calls while status is Payment Pending. */

function initRequestHistoryFilters() {
  ['rhStatusFilter', 'rhFromDate', 'rhToDate'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => loadRequestHistory());
  });
}
let rhFiltersWired = false;

function rhRow(r) {
  const d = r.details || {};
  return `
    <tr>
      <td>${escapeHtml(r.booking_reference || '—')}</td>
      <td>${escapeHtml(r.request_number)}</td>
      <td>${r.passengers?.length ? escapeHtml(r.passengers.map(p => `${p.first_name} ${p.last_name}`).join(', ')) : '—'}</td>
      <td style="text-transform:capitalize">${escapeHtml(r.travel_type || '—')}</td>
      <td>${escapeHtml(d.destination_city || d.destination || '—')}</td>
      <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}</td>
      <td><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></td>
      <td>${fmtDate(r.created_at)}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-rh-view="${r.id}">View</button></td>
    </tr>`;
}

async function loadRequestHistory() {
  if (!rhFiltersWired) { initRequestHistoryFilters(); rhFiltersWired = true; }
  const tbody = document.querySelector('#rhTable tbody');
  tbody.innerHTML = rowsSkeleton();
  const params = {
    request_type: 'booking',
    status: document.getElementById('rhStatusFilter').value || undefined,
    date_from: document.getElementById('rhFromDate').value || undefined,
    date_to: document.getElementById('rhToDate').value || undefined,
    page_size: 50,
  };
  try {
    const { data } = await axios.get(`${API_BASE}/api/requests`, { headers: partnerAuthHeaders(), params });
    tbody.innerHTML = data.items.length ? data.items.map(rhRow).join('') : '<tr><td colspan="9" class="empty-state">No requests found.</td></tr>';
    tbody.querySelectorAll('[data-rh-view]').forEach(b => b.addEventListener('click', () => openBookingDetailModal(b.dataset.rhView)));
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Failed to load request history.</td></tr>';
  }
}

function rhTimelineHtml(timeline) {
  return `<div class="rh-timeline">${timeline.map(s => `
    <div class="rh-timeline-step ${s.state}">
      <div class="rh-timeline-dot"></div>
      <div>
        <strong>${escapeHtml(s.label || '')}</strong>
        ${s.at ? `<div style="font-size:11.5px; color:var(--text-muted);">${fmtDateTime(s.at)}${s.by ? ' · ' + escapeHtml(s.by) : ''}</div>` : ''}
        ${s.reason ? `<div style="font-size:12px; color:var(--coral-dark); margin-top:2px;">Reason: ${escapeHtml(s.reason)}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function rhPassengerRow(p) {
  return `<tr>
    <td>${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</td>
    <td style="text-transform:capitalize">${escapeHtml(p.passenger_type)}</td>
    <td>${escapeHtml(p.passport_number || '—')}</td>
    <td>${p.seat_preference ? escapeHtml(p.seat_preference.replace(/_/g, ' ')) : '—'}</td>
    <td>${escapeHtml(p.meal_preference || '—')}</td>
  </tr>`;
}

const RH_ACTION_ENDPOINTS = {
  pending_approval: (id) => axios.post(`${API_BASE}/api/requests/${id}/submit`, {}, { headers: partnerAuthHeaders() }),
  cancelled: (id, reason) => axios.post(`${API_BASE}/api/requests/${id}/cancel`, { reason }, { headers: partnerAuthHeaders() }),
};

async function openBookingDetailModal(requestId) {
  const overlay = document.getElementById('bookingDetailModalOverlay');
  const body = document.getElementById('bookingDetailBody');
  overlay.classList.add('open');
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const { data } = await axios.get(`${API_BASE}/api/requests/${requestId}`, { headers: partnerAuthHeaders() });
    const r = data.request;
    const d = r.details || {};

    const actionButtons = data.actions.map(a => `
      <button type="button" class="btn ${a.to === 'cancelled' ? 'btn-ghost' : 'btn-coral'} btn-sm" data-rh-action="${a.to}">${escapeHtml(a.label)}</button>
    `).join('');
    const payButton = r.status === 'payment_pending'
      ? `<button type="button" class="btn btn-coral btn-sm" id="rhPayBtn">Pay ${money(r.total_amount)}</button>` : '';

    body.innerHTML = `
      <h2>${escapeHtml(r.request_number)}${r.pnr ? ' · PNR ' + escapeHtml(r.pnr) : ''}</h2>
      <div class="info-grid">
        <div class="info-item"><label>Status</label><div><span class="badge ${r.status}">${escapeHtml(r.status_label)}</span></div></div>
        <div class="info-item"><label>Travel Type</label><div style="text-transform:capitalize;">${escapeHtml(r.travel_type || '—')}</div></div>
        <div class="info-item"><label>Route</label><div>${escapeHtml(d.origin_city || d.origin || '—')} → ${escapeHtml(d.destination_city || d.destination || '—')}</div></div>
        <div class="info-item"><label>Travel Date</label><div>${r.travel_date ? fmtDate(r.travel_date) : '—'}</div></div>
        <div class="info-item"><label>Total Amount</label><div>${money(r.total_amount)}</div></div>
        <div class="info-item"><label>Ticket / Invoice #</label><div>${escapeHtml(r.ticket_number || '—')} / ${escapeHtml(r.invoice_number || '—')}</div></div>
        <div class="info-item"><label>Booked On</label><div>${fmtDateTime(r.created_at)}</div></div>
        <div class="info-item"><label>Remarks</label><div>${escapeHtml(r.remarks || '—')}</div></div>
      </div>

      <h2 style="font-size:14px;margin:18px 0 10px;">Passengers</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Passport</th><th>Seat</th><th>Meal</th></tr></thead>
        <tbody>${r.passengers.map(rhPassengerRow).join('') || '<tr><td colspan="5" class="empty-state">No passengers.</td></tr>'}</tbody></table></div>

      ${data.payments.length ? `
        <h2 style="font-size:14px;margin:18px 0 10px;">Payments</h2>
        <div class="table-wrap"><table><thead><tr><th>Amount</th><th>Method</th><th>Transaction ID</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${data.payments.map(p => `<tr><td>${money(p.amount)}</td><td>${escapeHtml(p.method || '—')}</td><td>${escapeHtml(p.transaction_id || '—')}</td><td><span class="badge ${p.status}">${escapeHtml(p.status)}</span></td><td>${p.paid_date ? fmtDateTime(p.paid_date) : '—'}</td></tr>`).join('')}</tbody></table></div>
      ` : ''}

      <h2 style="font-size:14px;margin:18px 0 10px;">Activity Timeline</h2>
      ${rhTimelineHtml(data.timeline)}

      <div class="modal-actions" style="margin-top:20px; flex-wrap:wrap;">
        ${payButton}
        ${actionButtons}
        <button type="button" class="btn btn-ghost" id="bookingDetailCloseBtn">Close</button>
      </div>
      <div class="msg" id="rhDetailMsg"></div>
    `;
    document.getElementById('bookingDetailCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
    document.getElementById('rhPayBtn')?.addEventListener('click', () => openPayModal(r));
    body.querySelectorAll('[data-rh-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const to = btn.dataset.rhAction;
        let reason;
        if (to === 'cancelled' && !confirm('Cancel this request? This cannot be undone.')) return;
        try {
          await RH_ACTION_ENDPOINTS[to](requestId, reason);
          overlay.classList.remove('open');
          loadedSections.delete('dashboard');
          showToast('Request updated.');
          loadRequestHistory();
        } catch (err) {
          document.getElementById('rhDetailMsg').textContent = err.response?.data?.detail || 'Action failed.';
          document.getElementById('rhDetailMsg').className = 'msg error';
        }
      });
    });
  } catch (err) {
    body.innerHTML = `<div class="empty-state">Failed to load request.</div><div class="modal-actions"><button type="button" class="btn btn-ghost" id="bookingDetailCloseBtn">Close</button></div>`;
    document.getElementById('bookingDetailCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
  }
}

function openPayModal(request) {
  const overlay = document.getElementById('bookingDetailModalOverlay');
  const body = document.getElementById('bookingDetailBody');
  body.innerHTML = `
    <h2>Pay for ${escapeHtml(request.request_number)}</h2>
    <div class="form-field" style="max-width:none;"><label>Amount</label><input id="payAmount" type="number" value="${request.total_amount}" step="0.01"></div>
    <div class="form-field" style="max-width:none;"><label>Payment Method</label>
      <select id="payMethod"><option value="bank_transfer">Bank Transfer</option><option value="upi">UPI</option><option value="card">Card</option><option value="wallet">Wallet</option></select>
    </div>
    <div class="form-field" style="max-width:none;"><label>Transaction ID (optional)</label><input id="payTxnId"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-coral" id="payConfirmBtn">Submit Payment</button>
      <button type="button" class="btn btn-ghost" id="payCancelBtn">Cancel</button>
    </div>
    <div class="msg" id="payMsg"></div>
  `;
  document.getElementById('payCancelBtn').addEventListener('click', () => openBookingDetailModal(request.id));
  document.getElementById('payConfirmBtn').addEventListener('click', async () => {
    const msg = document.getElementById('payMsg');
    try {
      await axios.post(`${API_BASE}/api/requests/${request.id}/pay`, {
        amount: Number(document.getElementById('payAmount').value),
        method: document.getElementById('payMethod').value,
        transaction_id: document.getElementById('payTxnId').value || undefined,
      }, { headers: partnerAuthHeaders() });
      overlay.classList.remove('open');
      loadedSections.delete('dashboard');
      showToast('Payment submitted — awaiting verification.');
      loadRequestHistory();
      /* This modal is reachable from Payments too (partner-payments.js), and that
         table would otherwise still show the row as unpaid until a re-navigation. */
      if (typeof loadPayments === 'function'
          && document.getElementById('section-payments')?.classList.contains('active')) {
        loadPayments();
      }
    } catch (err) {
      msg.textContent = err.response?.data?.detail || 'Payment failed.'; msg.className = 'msg error';
    }
  });
}
