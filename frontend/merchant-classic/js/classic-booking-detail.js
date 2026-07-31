'use strict';
/* Classic — Booking Request Details (Phase 3).
   ===========================================================================
   A dedicated page, not another modal. A booking request carries an itinerary,
   a contact, a party and a full status timeline — that is more than a dialog
   should hold, and it is something a merchant wants to link to, refresh, and
   read side by side with an email from our desk.

   The existing request modal in classic-requests.js still handles every OTHER
   request type (cancellations, refunds, ancillaries). Only bookings come here,
   so nothing that already worked was taken away.

   NO DOCUMENTS PANEL. There was one, and it went with the upload controls on
   the Booking Request screen — documents are no longer part of the Classic
   merchant workflow, so a permanently empty table telling merchants to "open it
   from Ticket Enquiry to add documents" would be an instruction they could not
   follow. The `documents` key is still on the payload and the Admin still has
   its verification screen, so nothing has to be rebuilt if they return.

   ONE CALL, NO NEW ENDPOINT
   GET /api/requests/{id} already returns request + timeline + actions +
   payments. This page is a renderer over that payload; it invents no API of
   its own. */

let clDetailRequestId = null;
let clDetailData = null;

/* Entry point used by row actions elsewhere: remembers which request to show,
   then routes here. */
function clOpenBookingDetail(requestId) {
  clDetailRequestId = requestId;
  clLoaded.delete('booking-detail');
  clGo('booking-detail');
}

async function clInitBookingDetail() {
  const root = $('cl-booking-detail');
  if (!clDetailRequestId) {
    root.innerHTML = `
      <div class="cl-page-head"><div>
        <h1>Booking Request Details</h1>
        <p>Open a booking from My Requests to see it here.</p>
      </div></div>
      <div class="cl-panel"><div class="cl-panel-body">
        <button type="button" class="cl-btn cl-btn-primary" id="clBdToRequests">Go to My Requests</button>
      </div></div>`;
    $('clBdToRequests').addEventListener('click', () => clGo('requests'));
    return;
  }

  root.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">Loading booking…</div></div>`;
  try {
    clDetailData = await MerchantApi.getRequest(clDetailRequestId);
  } catch (err) {
    root.innerHTML = `
      <div class="cl-page-head"><div><h1>Booking Request Details</h1></div></div>
      <div class="cl-panel"><div class="cl-panel-body">
        <div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Could not load this booking.'))}</div>
      </div></div>`;
    return;
  }
  clRenderBookingDetail();
}

function clRenderBookingDetail() {
  const data = clDetailData;
  const r = data.request || data;
  const d = r.details || {};
  const contact = d.contact || {};
  const timeline = data.timeline || [];
  const roundTrip = d.trip_type === 'round_trip';

  $('cl-booking-detail').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>${escapeHtml(r.request_number)}</h1>
        <p>${escapeHtml(r.title || 'Booking request')}${
          d.enquiry_reference ? ` · from enquiry <b class="cl-ref">${escapeHtml(d.enquiry_reference)}</b>` : ''}</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clBdBack">Back to My Requests</button>
        <button type="button" class="cl-btn cl-btn-sm" id="clBdRefresh">Refresh</button>
      </div>
    </div>

    <div class="cl-kpis">
      <div class="cl-kpi"><div class="cl-kpi-label">Status</div>
        <div class="cl-kpi-value">${escapeHtml(r.status_label || r.status)}</div>
        <div class="cl-kpi-sub">${escapeHtml(fmtDateTime(r.created_at))}</div></div>
      <div class="cl-kpi"><div class="cl-kpi-label">Amount</div>
        <div class="cl-kpi-value">${r.total_amount && Number(r.total_amount) > 0
          ? escapeHtml(money(r.total_amount)) : 'Awaiting amount'}</div>
        <div class="cl-kpi-sub">${d.enquiry_reference
          ? 'Confirmed by our team at approval' : ''}</div></div>
      <div class="cl-kpi"><div class="cl-kpi-label">Travellers</div>
        <div class="cl-kpi-value">${(r.passengers || []).length}</div>
        <div class="cl-kpi-sub">${escapeHtml(d.travel_class || '')}</div></div>
      <div class="cl-kpi"><div class="cl-kpi-label">Booking reference</div>
        <div class="cl-kpi-value cl-ref">${escapeHtml(r.booking_reference || '—')}</div>
        <div class="cl-kpi-sub">${d.enquiry_reference
          ? `From enquiry ${escapeHtml(d.enquiry_reference)}` : ''}</div></div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Journey</h2></div>
      <div class="cl-panel-body">
        <dl class="cl-dl">
          <div><dt>Trip type</dt><dd>${roundTrip ? 'Round Trip' : 'One Way'}</dd></div>
          <div><dt>From</dt><dd>${escapeHtml([d.origin_city, d.origin].filter(Boolean).join(' · ') || '—')}</dd></div>
          <div><dt>To</dt><dd>${escapeHtml([d.destination_city, d.destination].filter(Boolean).join(' · ') || '—')}</dd></div>
          <div><dt>Airline</dt><dd>${escapeHtml(d.airline || '—')}</dd></div>
          <div><dt>Flight number</dt><dd class="cl-ref">${escapeHtml(d.flight_number || '—')}</dd></div>
          <div><dt>Departure</dt><dd>${escapeHtml(fmtDate(r.travel_date))}${
            d.preferred_time ? ` · ${escapeHtml(clTimeLabel(d.preferred_time))}` : ''}</dd></div>
          ${roundTrip ? `<div><dt>Return</dt><dd>${escapeHtml(fmtDate(r.return_date))}${
            d.return_preferred_time ? ` · ${escapeHtml(clTimeLabel(d.return_preferred_time))}` : ''}</dd></div>` : ''}
          <div><dt>Travel class</dt><dd>${escapeHtml(d.travel_class || '—')}</dd></div>
          <div><dt>Route type</dt><dd>${d.international
            ? '<span class="cl-tag cl-tag-warn">International</span>'
            : '<span class="cl-tag">Domestic</span>'}</dd></div>
          ${r.pnr ? `<div><dt>PNR</dt><dd class="cl-ref">${escapeHtml(r.pnr)}</dd></div>` : ''}
          ${r.booking_reference ? `<div><dt>Booking ref</dt><dd class="cl-ref">${escapeHtml(r.booking_reference)}</dd></div>` : ''}
        </dl>
      </div>
      ${d.admin_response ? `<div class="cl-panel-note"><b>Our response:</b> ${escapeHtml(d.admin_response)}</div>` : ''}
      ${r.rejection_reason ? `<div class="cl-panel-note"><b>Reason:</b> ${escapeHtml(r.rejection_reason)}</div>` : ''}
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Contact</h2></div>
      <div class="cl-panel-body">
        ${contact.email || contact.phone ? `<dl class="cl-dl">
          <div><dt>Name</dt><dd>${escapeHtml(contact.name || '—')}</dd></div>
          <div><dt>Email</dt><dd>${escapeHtml(contact.email || '—')}</dd></div>
          <div><dt>Phone</dt><dd>${escapeHtml(contact.phone || '—')}</dd></div>
          <div><dt>Alternate</dt><dd>${escapeHtml(contact.alternate_phone || '—')}</dd></div>
        </dl>` : '<p class="cl-kpi-sub" style="margin:0;">No contact recorded on this booking.</p>'}
      </div>
      ${d.special_requests ? `<div class="cl-panel-note">
        <b>Special requests:</b> ${escapeHtml(d.special_requests)}</div>` : ''}
      ${r.remarks ? `<div class="cl-panel-note"><b>Remarks:</b> ${escapeHtml(r.remarks)}</div>` : ''}
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Passengers</h2></div>
      <div class="cl-table-wrap">
        <table class="cl-table">
          <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Gender</th><th>Date of birth</th>
            <th>Nationality</th><th>Passport</th><th>Expiry</th></tr></thead>
          <tbody>${(r.passengers || []).length ? r.passengers.map((p, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</td>
              <td>${escapeHtml(clLabel(p.passenger_type || 'adult'))}</td>
              <td>${escapeHtml(p.gender ? clLabel(p.gender) : '—')}</td>
              <td>${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
              <td>${escapeHtml(p.nationality || '—')}</td>
              <td>${escapeHtml(p.passport_number || '—')}</td>
              <td>${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
            </tr>`).join('') : clEmptyRow(8, 'No passengers recorded.')}</tbody>
        </table>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>Timeline</h2></div>
      <div class="cl-panel-body">
        <ol class="cl-timeline">${timeline.map(step => `
          <li class="cl-timeline-item${step.state === 'pending' ? ' pending' : ''}">
            <div class="cl-timeline-label">${escapeHtml(step.label || step.status)}</div>
            <div class="cl-timeline-meta">${
              step.at ? escapeHtml(fmtDateTime(step.at)) : 'Not yet'}${
              step.by ? ` · ${escapeHtml(step.by)}` : ''}</div>
            ${step.reason ? `<div class="cl-timeline-note">${escapeHtml(step.reason)}</div>` : ''}
            ${step.note ? `<div class="cl-timeline-note">${escapeHtml(step.note)}</div>` : ''}
          </li>`).join('')}</ol>
      </div>
    </div>`;

  $('clBdBack').addEventListener('click', () => clGo('requests'));
  $('clBdRefresh').addEventListener('click', () => {
    clLoaded.delete('booking-detail');
    clGo('booking-detail');
  });
}
