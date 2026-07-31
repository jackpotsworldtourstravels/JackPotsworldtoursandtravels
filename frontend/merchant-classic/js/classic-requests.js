'use strict';
/* Classic — My Requests: the full lifecycle list, plus the detail view and the
   three actions a merchant can take on a row (submit a draft, cancel, pay).
   ===========================================================================
   One table for every request whatever its stage, filtered by status, because
   an operator tracking a booking does not think in terms of which screen it
   lives on. Payments has its own screen too, but it is the same rows narrowed
   to the money stages — both go through the same endpoints. */

let clRequestRows = [];

function clInitRequests() {
  $('cl-requests').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>My Requests</h1>
        <p>Every booking and service request raised by your account.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn cl-btn-primary" id="clReqNew">New enquiry</button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clReqStatus">Status</label>
          <select id="clReqStatus" data-cl-status-filter>
            <option value="">All statuses</option>
            ${MERCHANT_REQUEST_STATUSES.map(s => `<option value="${s}">${clLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <label for="clReqSearch">Find</label>
          <input type="search" id="clReqSearch" placeholder="Request no. or item">
        </div>
        <div class="cl-field" style="min-width:0;">
          <label>&nbsp;</label>
          <button type="button" class="cl-btn" id="clReqRefresh">Refresh</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Request no.</th><th>Item</th><th>Type</th><th>Status</th>
              <th class="cl-num">Amount</th><th>Travel date</th><th>Created</th>
              <th class="cl-actions">Actions</th>
            </tr></thead>
            <tbody id="clReqBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager">
        <span class="cl-pager-info" id="clReqCount">—</span>
      </div>
    </div>`;

  /* Booking now starts at the enquiry, not at a search: a request can only be
     raised against an enquiry our team has already answered. */
  $('clReqNew').addEventListener('click', () => clGo('enquiry'));
  $('clReqRefresh').addEventListener('click', () => clLoadRequests());
  $('clReqStatus').addEventListener('change', () => clLoadRequests());
  $('clReqSearch').addEventListener('input', () => clRenderRequestRows());

  return clLoadRequests();
}

async function clLoadRequests() {
  const body = $('clReqBody');
  body.innerHTML = clLoadingRow(8, 'Loading requests…');
  const status = $('clReqStatus').value;
  const params = { page_size: 100 };
  if (status) params.status = status;

  try {
    const data = await MerchantApi.listRequests(params);
    clRequestRows = data.items || [];
    clRenderRequestRows();
  } catch (err) {
    body.innerHTML = clEmptyRow(8, clError(err, 'Failed to load requests.'));
    $('clReqCount').textContent = '—';
  }
}

/* The text box narrows what is already loaded rather than re-querying: the API
   has no free-text filter for requests, and re-fetching per keystroke would be
   both slower and wrong. */
function clRenderRequestRows() {
  const body = $('clReqBody');
  const q = $('clReqSearch').value.trim().toLowerCase();
  const rows = q
    ? clRequestRows.filter(r => `${r.request_number || ''} ${r.title || ''}`.toLowerCase().includes(q))
    : clRequestRows;

  body.innerHTML = rows.length
    ? rows.map(clRequestRow).join('')
    : clEmptyRow(8, q ? 'No requests match that search.' : 'No requests yet.');
  $('clReqCount').textContent = `${rows.length} request${rows.length === 1 ? '' : 's'}`
    + (q && rows.length !== clRequestRows.length ? ` (filtered from ${clRequestRows.length})` : '');

  body.querySelectorAll('[data-cl-view]').forEach(b =>
    b.addEventListener('click', () => clOpenRequestDetail(b.dataset.clView)));
  body.querySelectorAll('[data-cl-submit]').forEach(b =>
    b.addEventListener('click', () => clSubmitDraft(b.dataset.clSubmit)));
  body.querySelectorAll('[data-cl-cancel]').forEach(b =>
    b.addEventListener('click', () => clCancelRequest(b.dataset.clCancel)));
  body.querySelectorAll('[data-cl-pay]').forEach(b =>
    b.addEventListener('click', () => {
      const r = clRequestRows.find(x => String(x.id) === b.dataset.clPay);
      if (r) clOpenPayModal(r);
    }));
}

/* On a booking, `total_amount` is what the merchant owes. On a cancellation it
   is the refund *due back to them*, and on a reschedule it is the amount
   payable for the move — the same column, three different meanings. Left bare
   it reads as a bill, so the direction is spelled out rather than inferred. */
function clRequestAmount(r) {
  /* A Classic Tours booking is settled outside the portal (CR-2), so it has no
     amount and never will. "₹0" or "Awaiting amount" would both read as a
     figure still to come. */
  if (r.workflow === 'classic_tours') return '<span class="cl-kpi-sub">Not payable here</span>';
  const amount = money(r.total_amount);
  if (!(Number(r.total_amount) > 0)) return amount;
  if (r.request_type === 'cancellation') return `${amount}<div class="cl-kpi-sub">refund due</div>`;
  if (r.request_type === 'date_change') return `${amount}<div class="cl-kpi-sub">payable</div>`;
  return amount;
}

function clRequestRow(r) {
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
    <td>${escapeHtml(r.title || '—')}</td>
    <td class="cl-nowrap">${escapeHtml(clLabel(r.request_type || r.travel_type || '—'))}</td>
    <td>${clTag(r.status, r.status_label)}</td>
    <td class="cl-num">${clRequestAmount(r)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.created_at))}</td>
    <td class="cl-actions">${clRequestActions(r)}</td>
  </tr>`;
}

/* Actions are driven by status, mirroring what the backend will actually
   accept — offering a button the API rejects is worse than not offering it. */
function clRequestActions(r) {
  const out = [`<button type="button" class="cl-btn cl-btn-sm" data-cl-view="${r.id}">View</button>`];
  if (r.status === 'draft') {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-submit="${r.id}">Submit</button>`);
  }
  if (r.status === 'payment_pending') {
    /* record_payment rejects amount <= 0 with a 400, so an unpriced row can only
       fail. Say so instead of offering a button that cannot work. */
    out.push(Number(r.total_amount) > 0
      ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-pay="${r.id}">Pay</button>`
      : `<span class="cl-tag">Awaiting amount</span>`);
  }
  /* A cancellation or reschedule request is withdrawn, not cancelled — and only
     from the Service Requests screen, whose endpoint refuses once an operator
     has claimed it. This generic Cancel would skip that check and tell nobody,
     so it is not offered on those rows; the backend refuses it too. */
  const isChangeRequest = r.request_type === 'cancellation' || r.request_type === 'date_change';
  if (!isChangeRequest && ['draft', 'pending_approval', 'approved', 'payment_pending'].includes(r.status)) {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-danger" data-cl-cancel="${r.id}">Cancel</button>`);
  }
  return out.join('');
}

/* ------------------------------------------------------------------ detail */

/* Routes by request type rather than being replaced outright: a booking now
   has a page of its own (itinerary, contact, documents, timeline — too much
   for a dialog), while cancellations, refunds and ancillaries keep the modal
   that already served them well. Every existing caller keeps working, because
   the decision is made here rather than at each of the six call sites. */
async function clOpenRequestDetail(id) {
  clOpenModal('Request details', '<p><span class="cl-spin"></span> Loading…</p>', '');
  try {
    const data = await MerchantApi.getRequest(id);
    const r = data.request || data;

    if (r.request_type === 'booking') {
      clCloseModal();
      clDetailRequestId = id;
      clDetailData = data;          // already fetched; no second round trip
      clLoaded.add('booking-detail');
      clGo('booking-detail');
      return clRenderBookingDetail();
    }
    const passengers = r.passengers || data.passengers || [];
    const history = r.status_history || data.status_history || [];
    const d = r.travel_details || r.details || {};

    $('clModalTitle').textContent = `Request ${r.request_number || ''}`;
    $('clModalBody').innerHTML = `
      <dl class="cl-dl" style="margin-bottom:14px;">
        <div><dt>Status</dt><dd>${clTag(r.status)}</dd></div>
        <div><dt>Item</dt><dd>${escapeHtml(r.title || '—')}</dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(clLabel(r.request_type || r.travel_type || '—'))}</dd></div>
        <div><dt>Total amount</dt><dd>${money(r.total_amount)}</dd></div>
        <div><dt>Travel date</dt><dd>${escapeHtml(fmtDate(r.travel_date))}</dd></div>
        <div><dt>Created</dt><dd>${escapeHtml(fmtDateTime(r.created_at))}</dd></div>
        ${r.pnr ? `<div><dt>PNR</dt><dd class="cl-ref">${escapeHtml(r.pnr)}</dd></div>` : ''}
        ${r.ticket_number ? `<div><dt>Ticket no.</dt><dd class="cl-ref">${escapeHtml(r.ticket_number)}</dd></div>` : ''}
      </dl>

      ${clDetailFacts(d)}

      <h3 style="font-size:12px;margin:14px 0 6px;">Passengers (${passengers.length})</h3>
      <div class="cl-table-wrap"><table class="cl-table">
        <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Passport</th><th>Seat</th><th>Meal</th></tr></thead>
        <tbody>${passengers.length ? passengers.map((p, i) => `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' ') || '—')}</td>
          <td>${escapeHtml(clLabel(p.passenger_type || 'adult'))}</td>
          <td class="cl-ref">${escapeHtml(p.passport_number || '—')}</td>
          <td>${escapeHtml(clLabel(p.seat_preference) || '—')}</td>
          <td>${escapeHtml(clLabel(p.meal_preference) || '—')}</td>
        </tr>`).join('') : clEmptyRow(6, 'No passengers recorded.')}</tbody>
      </table></div>

      ${history.length ? `
        <h3 style="font-size:12px;margin:14px 0 6px;">Status history</h3>
        <div class="cl-table-wrap"><table class="cl-table">
          <thead><tr><th>Status</th><th>When</th><th>Note</th></tr></thead>
          <tbody>${history.map(h => `<tr>
            <td>${clTag(h.status || h.to_status)}</td>
            <td class="cl-nowrap">${escapeHtml(fmtDateTime(h.at || h.changed_at || h.timestamp))}</td>
            <td>${escapeHtml(h.remarks || h.note || '—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : ''}`;

    const foot = [];
    if (r.status === 'draft') {
      foot.push(`<button type="button" class="cl-btn cl-btn-primary" data-cl-modal-submit="${r.id}">Submit for approval</button>`);
    }
    if (r.status === 'payment_pending' && Number(r.total_amount) > 0) {
      foot.push(`<button type="button" class="cl-btn cl-btn-primary" data-cl-modal-pay="${r.id}">Record payment</button>`);
    }
    foot.push('<button type="button" class="cl-btn" data-cl-modal-close>Close</button>');
    $('clModalFoot').innerHTML = foot.join('');

    $('clModalFoot').querySelector('[data-cl-modal-close]')?.addEventListener('click', clCloseModal);
    $('clModalFoot').querySelector('[data-cl-modal-submit]')?.addEventListener('click', () => {
      clCloseModal(); clSubmitDraft(r.id);
    });
    $('clModalFoot').querySelector('[data-cl-modal-pay]')?.addEventListener('click', () => {
      clCloseModal(); clOpenPayModal(r);
    });
  } catch (err) {
    $('clModalBody').innerHTML = `<div class="cl-msg cl-msg-err" style="margin-top:0">${
      escapeHtml(clError(err, 'Could not load this request.'))}</div>`;
    $('clModalFoot').innerHTML = '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>';
  }
}

/* Travel details vary per type; render whatever the row actually carries rather
   than assuming a flight-shaped record. */
function clDetailFacts(d) {
  const pairs = [
    ['Airline', d.airline], ['Flight', d.flight_number],
    ['Origin', d.origin_city || d.origin], ['Destination', d.destination_city || d.destination],
    ['Departs', d.departure_time ? fmtDateTime(d.departure_time) : null],
    ['Arrives', d.arrival_time ? fmtDateTime(d.arrival_time) : null],
    ['Cabin', clLabel(d.cabin_class) || null], ['Hotel', d.hotel_name],
    ['Room', d.room_type], ['Nights', d.nights],
    ['Cruise', d.cruise_name], ['Cruise line', d.cruise_line],
    ['Package', d.package_name], ['Baggage', d.baggage_kg ? `${d.baggage_kg} kg` : null],
  ].filter(([, v]) => v != null && v !== '');
  if (!pairs.length) return '';
  return `<h3 style="font-size:12px;margin:0 0 6px;">Itinerary</h3>
    <dl class="cl-dl">${pairs.map(([k, v]) =>
      `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}</dl>`;
}

/* ----------------------------------------------------------------- actions */

async function clSubmitDraft(id) {
  if (!await clConfirm('Submit this draft for approval? You will not be able to edit the passengers afterwards.', 'Submit')) return;
  try {
    await MerchantApi.submitRequest(id);
    clInvalidate('dashboard', 'payments', 'reports', 'service-request');
    await clLoadRequests();
    clRefreshIfVisible('payments');
    clLoadUnreadCount();
  } catch (err) {
    clOpenModal('Could not submit',
      `<div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Submission failed.'))}</div>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  }
}

async function clCancelRequest(id) {
  const row = clRequestRows.find(r => String(r.id) === String(id));
  clOpenModal('Cancel request', `
    <p style="margin:0 0 11px;font-size:12.5px;">
      Cancelling <b class="cl-ref">${escapeHtml(row?.request_number || '')}</b>. This cannot be undone.
    </p>
    <div class="cl-field">
      <label for="clCancelReason">Reason<span class="cl-req">*</span></label>
      <textarea id="clCancelReason" placeholder="Why is this being cancelled?"></textarea>
    </div>
    <div class="cl-msg" id="clCancelMsg"></div>`,
    `<button type="button" class="cl-btn" data-cl-cancel-abort>Keep it</button>
     <button type="button" class="cl-btn cl-btn-danger" data-cl-cancel-go>Cancel request</button>`);

  $('clModalFoot').querySelector('[data-cl-cancel-abort]').addEventListener('click', clCloseModal);
  $('clModalFoot').querySelector('[data-cl-cancel-go]').addEventListener('click', async () => {
    const reason = $('clCancelReason').value.trim();
    const msg = $('clCancelMsg');
    if (!reason) return clMsg(msg, 'Enter a reason.', 'err');
    try {
      await MerchantApi.cancelRequest(id, reason);
      clCloseModal();
      clInvalidate('dashboard', 'payments', 'reports', 'service-request');
      await clLoadRequests();
      clRefreshIfVisible('payments');
    } catch (err) {
      clMsg(msg, clError(err, 'Cancellation failed.'), 'err');
    }
  });
}
