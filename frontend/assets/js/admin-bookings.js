/* Admin — Booking review from the Approval Queue
   =========================================================
   The Approval Queue could always approve or reject a booking; what it could
   not do was let an admin *look* at one first. Approving a request without
   seeing who is flying, on what, and on whose word, is signing a form nobody
   read. This is that form: everything the merchant submitted, in one modal,
   read-only.

   WHAT IT SHOWS, AND WHY ALL OF IT
   Booking reference, merchant, and the enquiry reference the booking came from
   — the three identifiers an admin needs to answer a phone call about it.
   Then the itinerary the desk already agreed to (trip type, route, dates,
   airline, flight, class), the party size, and then every passenger in full:
   name, gender, date of birth, type, nationality, passport details where the
   merchant supplied them, and their seat and meal preferences. The booking's
   contact and special requests sit alongside, and the lifecycle timeline
   closes it out so the reviewer can see when it was raised and submitted
   before deciding.

   READ-ONLY BY CONSTRUCTION. There is not an input on this modal. Approve and
   Reject stay on the queue row where they always were — this screen exists to
   inform that decision, not to duplicate it, and an admin editing a merchant's
   passenger list mid-approval is not a workflow anyone asked for.

   DOCUMENTS ARE NO LONGER PART OF THE MERCHANT FLOW. The upload UI was removed
   from the Classic Booking Request screen, so an enquiry-led booking arrives
   with no attachments and this modal renders no Documents section for one. The
   verification controls are still here and still work, shown only when a
   booking actually carries files, so the API and the admin's ability to act on
   them survive intact for whenever documents come back.

   DELIBERATELY NOT A NEW SCREEN. The queue, its filters, and its approve/reject
   endpoints are untouched — this adds one Review button that opens a modal over
   the existing overlay markup.

   Endpoints, both pre-existing:
     GET  /api/requests/{id}                  booking + passengers + timeline
     POST /api/admin/documents/{id}/verify    document.verify

   Loaded after admin.js and reuses its API_BASE, authHeaders, escapeHtml,
   fmtDate, fmtDateTime and rowsSkeleton. */

const ADM_DOC_TONE = { verified: 'confirmed', rejected: 'cancelled', pending: 'pending' };
const ADM_DOC_LABEL = {
  passport: 'Passport', visa: 'Visa', photo_id: 'Photo ID', ticket: 'Ticket', other: 'Other',
};

/* Bytes below a kilobyte are shown as bytes: rounding them to "0 KB" reads as a
   failed upload rather than a small file — and on this screen that would be a
   reviewer's first impression of a document they are about to verify. */
function admFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* 'payment_pending' -> 'Payment Pending'. The API sends enum values for the
   small fields (gender, passenger type, seat preference) and a ready-made
   label only for status, so these get title-cased here rather than being
   printed raw at a reviewer. */
function admLabel(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* '18:30' -> '6:30 PM'. Preferred times are stored as HH:MM strings on the
   enquiry and carried onto the booking verbatim. */
function admTimeLabel(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const admDash = v => (v === null || v === undefined || v === '' ? '—' : v);

let admReviewRequestId = null;

async function openBookingReview(requestId) {
  admReviewRequestId = requestId;
  const overlay = document.getElementById('bookingReviewModalOverlay');
  const body = document.getElementById('bookingReviewModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Booking request</h2><div>${rowsSkeleton(4)}</div>`;

  let data;
  try {
    data = (await axios.get(`${API_BASE}/api/requests/${requestId}`, { headers: authHeaders() })).data;
  } catch (err) {
    body.innerHTML = `<h2>Booking request</h2>
      <div class="msg error">${escapeHtml(err.response?.data?.detail || 'Could not load this booking.')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-adm-close>Close</button></div>`;
    body.querySelectorAll('[data-adm-close]').forEach(b =>
      b.addEventListener('click', () => overlay.classList.remove('open')));
    return;
  }
  renderBookingReview(data);
}

function admPassengerName(request, passengerId) {
  if (!passengerId) return 'Booking';
  const i = (request.passengers || []).findIndex(p => p.id === passengerId);
  if (i < 0) return '—';
  const p = request.passengers[i];
  return `${p.first_name} ${p.last_name}`.trim() || `Passenger ${i + 1}`;
}

function renderBookingReview(data) {
  const overlay = document.getElementById('bookingReviewModalOverlay');
  const body = document.getElementById('bookingReviewModalBody');
  const r = data.request || data;
  const d = r.details || {};
  const contact = d.contact || {};
  const docs = data.documents || [];
  const timeline = data.timeline || [];

  const intl = !!d.international;
  const roundTrip = d.trip_type === 'round_trip';
  const passengers = r.passengers || [];
  const paxCount = passengers.length;

  /* The party as the merchant described it on the enquiry, next to the party
     they actually entered. They are normally identical; when they are not, the
     enquiry was answered for a different number of people and that is precisely
     what a reviewer needs to notice before approving. */
  const declared = Number(d.passenger_count) || null;
  const mix = [
    d.adults ? `${d.adults} adult${d.adults === 1 ? '' : 's'}` : null,
    d.children ? `${d.children} child${d.children === 1 ? '' : 'ren'}` : null,
    d.infants ? `${d.infants} infant${d.infants === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ');

  const cell = (label, value) => `
      <div class="detail-item"><span class="detail-label">${label}</span>
        <span class="detail-value">${value}</span></div>`;

  body.innerHTML = `
    <h2>${escapeHtml(r.request_number)}</h2>
    <p class="modal-sub">
      ${escapeHtml(r.merchant_name || '')} · ${escapeHtml(r.title || '')}
      ${d.enquiry_reference ? ` · from ${escapeHtml(d.enquiry_reference)}` : ''}
    </p>

    <div class="detail-grid">
      ${cell('Status', `<span class="badge ${aqStatusBadgeClass(r.status)}">${
        escapeHtml(r.status_label || r.status)}</span>`)}
      ${cell('Booking reference', escapeHtml(admDash(r.booking_reference)))}
      ${cell('Merchant', escapeHtml(admDash(r.merchant_name)))}
      ${cell('Enquiry reference', escapeHtml(
        d.enquiry_reference || (d.direct_booking ? 'Direct booking — not quoted' : '—')))}
      ${cell('Trip type', tripTypeLabel(d.trip_type))}
      ${cell('Route', escapeHtml(admDash(
        [d.origin_city || d.origin, d.destination_city || d.destination].filter(Boolean).join(' → '))))}
      ${cell('Airline', escapeHtml(admDash(d.airline)))}
      ${cell('Flight number', escapeHtml(admDash(d.flight_number)))}
      ${cell('Departure', `${escapeHtml(r.travel_date ? fmtDate(r.travel_date) : '—')}${
        d.preferred_time ? ` · ${escapeHtml(admTimeLabel(d.preferred_time))}` : ''}`)}
      ${cell('Return', roundTrip
        ? `${escapeHtml(r.return_date ? fmtDate(r.return_date) : '—')}${
            d.return_preferred_time ? ` · ${escapeHtml(admTimeLabel(d.return_preferred_time))}` : ''}`
        : 'One way')}
      ${cell('Class', escapeHtml(admDash(d.travel_class)))}
      ${cell('Route type', intl ? 'International' : 'Domestic')}
      ${cell('Passengers', `${paxCount}${mix ? `<div class="cell-sub">${escapeHtml(mix)}</div>` : ''}${
        declared && declared !== paxCount
          ? `<div class="cell-sub">Enquiry was for ${declared}</div>` : ''}`)}
      ${cell('Raised by', `${escapeHtml(admDash(r.raised_by))}<div class="cell-sub">${
        escapeHtml(fmtDateTime(r.created_at))}</div>`)}
      ${cell('Contact', contact.email || contact.phone || contact.name
        ? `${escapeHtml(admDash(contact.name))}${
            contact.email ? `<div class="cell-sub">${escapeHtml(contact.email)}</div>` : ''}${
            contact.phone ? `<div class="cell-sub">${escapeHtml(contact.phone)}${
              contact.alternate_phone ? ` · ${escapeHtml(contact.alternate_phone)}` : ''}</div>` : ''}`
        : '—')}
    </div>

    ${d.special_requests ? `<div class="detail-note"><strong>Special requests</strong><p>${escapeHtml(d.special_requests)}</p></div>` : ''}
    ${r.remarks ? `<div class="detail-note"><strong>Merchant remarks</strong><p>${escapeHtml(r.remarks)}</p></div>` : ''}
    ${d.admin_response ? `<div class="detail-note"><strong>Our answer on the enquiry</strong><p>${escapeHtml(d.admin_response)}</p></div>` : ''}

    <h3 style="font-size:13px;margin:18px 0 8px;">Passengers (${paxCount})</h3>
    <div class="table-wrap"><table><thead><tr>
      <th>#</th><th>Name</th><th>Type</th><th>Gender</th><th>Date of birth</th>
      <th>Nationality</th><th>Passport</th><th>Expiry</th><th>Preferences</th>
    </tr></thead><tbody>
      ${passengers.map((p, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</td>
        <td>${escapeHtml(admLabel(p.passenger_type || 'adult'))}</td>
        <td>${escapeHtml(p.gender ? admLabel(p.gender) : '—')}</td>
        <td>${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
        <td>${escapeHtml(admDash(p.nationality))}</td>
        <td>${escapeHtml(admDash(p.passport_number))}${
          p.passport_issue_country
            ? `<div class="cell-sub">${escapeHtml(p.passport_issue_country)}${
                p.passport_issue_date ? ` · issued ${escapeHtml(fmtDate(p.passport_issue_date))}` : ''}</div>`
            : ''}</td>
        <td>${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
        <td>${escapeHtml([
          p.seat_preference ? `${admLabel(p.seat_preference)} seat` : null,
          p.meal_preference ? `${admLabel(p.meal_preference)} meal` : null,
        ].filter(Boolean).join(', ') || '—')}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty-state">No passengers.</td></tr>'}
    </tbody></table></div>

    ${docs.length ? `
      <h3 style="font-size:13px;margin:18px 0 8px;">Documents</h3>
      <div class="table-wrap"><table><thead><tr>
        <th>File</th><th>Type</th><th>For</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="admDocRows">
        ${docs.map(doc => `<tr>
          <td>${escapeHtml(doc.original_filename)}<div class="cell-sub">${admFileSize(doc.size_bytes)} · ${escapeHtml(doc.uploaded_by_name || '')}</div></td>
          <td>${escapeHtml(ADM_DOC_LABEL[doc.doc_type] || doc.doc_type)}</td>
          <td>${escapeHtml(admPassengerName(r, doc.passenger_id))}</td>
          <td><span class="badge ${ADM_DOC_TONE[doc.verification_status]}">${escapeHtml(doc.verification_label)}</span>
            ${doc.rejection_reason ? `<div class="cell-sub">${escapeHtml(doc.rejection_reason)}</div>` : ''}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-adm-doc-view="${doc.id}">View</button>
            ${doc.verification_status !== 'verified'
              ? `<button class="btn btn-navy btn-sm" data-adm-doc-ok="${doc.id}">Verify</button>` : ''}
            ${doc.verification_status !== 'rejected'
              ? `<button class="btn btn-danger btn-sm" data-adm-doc-no="${doc.id}">Reject</button>` : ''}
          </td>
        </tr>`).join('')}
      </tbody></table></div>` : ''}

    <h3 style="font-size:13px;margin:18px 0 8px;">Timeline</h3>
    <div class="timeline">
      ${timeline.length ? timeline.map(step => `
        <div class="timeline-item"${step.state === 'pending' ? ' style="opacity:.55;"' : ''}>
          <div class="timeline-dot"${step.state === 'pending'
            ? ' style="background:var(--border-color);"' : ''}></div>
          <div class="timeline-body">
            <div class="timeline-text">${escapeHtml(step.label || admLabel(step.status))}</div>
            <div class="timeline-time">${step.at ? escapeHtml(fmtDateTime(step.at)) : 'Not yet'}${
              step.by ? ` · ${escapeHtml(step.by)}` : ''}</div>
            ${step.reason ? `<div class="timeline-time">${escapeHtml(step.reason)}</div>` : ''}
            ${step.note ? `<div class="timeline-time">${escapeHtml(step.note)}</div>` : ''}
          </div>
        </div>`).join('') : '<div class="empty-state">No timeline recorded.</div>'}
    </div>

    <div class="msg" id="admReviewMsg"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-adm-close type="button">Close</button>
    </div>
    <p class="modal-sub" style="margin:10px 0 0;">
      Read-only. Approve and Reject stay on the queue row behind this dialog.
    </p>`;

  body.querySelectorAll('[data-adm-close]').forEach(b =>
    b.addEventListener('click', () => overlay.classList.remove('open')));
  body.querySelectorAll('[data-adm-doc-view]').forEach(b =>
    b.addEventListener('click', () => admViewDocument(b.dataset.admDocView)));
  body.querySelectorAll('[data-adm-doc-ok]').forEach(b =>
    b.addEventListener('click', () => admVerifyDocument(b.dataset.admDocOk, true)));
  body.querySelectorAll('[data-adm-doc-no]').forEach(b =>
    b.addEventListener('click', () => admVerifyDocument(b.dataset.admDocNo, false)));
}

/* Authenticated download, so the bytes are fetched with the bearer token and
   opened from an object URL rather than linked directly. */
async function admViewDocument(id) {
  try {
    const res = await axios.get(`${API_BASE}/api/documents/${id}/download`, {
      headers: authHeaders(), responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    const msg = document.getElementById('admReviewMsg');
    if (msg) { msg.textContent = 'Could not open that document.'; msg.className = 'msg error'; }
  }
}

async function admVerifyDocument(id, approved) {
  const msg = document.getElementById('admReviewMsg');
  let reason = null;

  if (!approved) {
    reason = await promptDialog({
      title: 'Reject this document?',
      message: 'The merchant sees this reason and can upload a replacement while the booking is a draft.',
      placeholder: 'e.g. Passport page is cut off',
      confirmText: 'Reject document',
    });
    if (!reason) return;
  } else {
    const ok = await confirmDialog({
      title: 'Verify this document?',
      message: 'It will show as verified to the merchant and to whoever approves this booking.',
      confirmText: 'Verify',
    });
    if (!ok) return;
  }

  try {
    await axios.post(`${API_BASE}/api/admin/documents/${id}/verify`,
      { approved, reason: reason || undefined }, { headers: authHeaders() });
    showToast(`Document ${approved ? 'verified' : 'rejected'}.`);
    openBookingReview(admReviewRequestId);   // reopen on fresh state
  } catch (err) {
    if (msg) {
      msg.textContent = err.response?.data?.detail || 'Could not record that decision.';
      msg.className = 'msg error';
    }
  }
}

/* A reason-capturing dialog, built on the same overlay/card markup as
   confirmDialog. Native prompt() is suppressed by the automated browser and
   cannot be driven during verification, which is why neither is used here. */
function promptDialog({ title = 'Reason', message = '', placeholder = '', confirmText = 'Confirm' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:440px;">
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p style="font-size:13.5px;color:var(--text-muted);margin:-6px 0 10px;">${escapeHtml(message)}</p>` : ''}
        <div class="form-field" style="max-width:none;">
          <input type="text" data-prompt-input placeholder="${escapeHtml(placeholder)}" maxlength="500">
        </div>
        <div class="msg" data-prompt-msg></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger" data-prompt-ok>${escapeHtml(confirmText)}</button>
          <button type="button" class="btn btn-ghost" data-prompt-cancel>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('[data-prompt-input]');
    const done = value => { overlay.remove(); resolve(value); };
    input.focus();
    overlay.querySelector('[data-prompt-ok]').addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) {
        overlay.querySelector('[data-prompt-msg]').textContent = 'A reason is required.';
        overlay.querySelector('[data-prompt-msg]').className = 'msg error';
        input.focus();
        return;
      }
      done(v);
    });
    overlay.querySelector('[data-prompt-cancel]').addEventListener('click', () => done(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
  });
}

/* An amount-capturing dialog, for the two places a booking's fare is set: at
   approval, and when correcting one that is already Payment Pending.

   WHY APPROVE CANNOT STAY A ONE-CLICK BUTTON
   Approval walks a booking to Payment Pending, and record_payment refuses an
   amount of 0 — so approving without a fare produced a booking the merchant was
   asked to pay and could not, with no way back (Payment Pending has no edge to
   Approved). The server now refuses it; this is the half that lets an admin
   supply the number instead of discovering the refusal.

   Resolves to {amount, reason} or null. `reason` is free text: the note on an
   approval, and the mandatory justification on a correction. */
function admAmountDialog({
  title = 'Amount', message = '', amountLabel = 'Amount (₹)', reasonLabel = 'Note',
  reasonPlaceholder = '', value = '', confirmText = 'Confirm', requireReason = false,
} = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:440px;">
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p style="font-size:13.5px;color:var(--text-muted);margin:-6px 0 10px;">${escapeHtml(message)}</p>` : ''}
        <div class="form-field" style="max-width:none;">
          <label for="admAmountInput">${escapeHtml(amountLabel)}</label>
          <input type="number" id="admAmountInput" min="0.01" step="0.01" value="${escapeHtml(String(value))}">
        </div>
        <div class="form-field" style="max-width:none;">
          <label for="admAmountReason">${escapeHtml(reasonLabel)}${requireReason ? ' *' : ''}</label>
          <input type="text" id="admAmountReason" maxlength="500" placeholder="${escapeHtml(reasonPlaceholder)}">
        </div>
        <div class="msg" data-amount-msg></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-coral" data-amount-ok>${escapeHtml(confirmText)}</button>
          <button type="button" class="btn btn-ghost" data-amount-cancel>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const amountInput = overlay.querySelector('#admAmountInput');
    const reasonInput = overlay.querySelector('#admAmountReason');
    const msg = overlay.querySelector('[data-amount-msg]');
    const done = result => { overlay.remove(); resolve(result); };
    const fail = (text, el) => { msg.textContent = text; msg.className = 'msg error'; el.focus(); };
    amountInput.focus();
    amountInput.select();

    overlay.querySelector('[data-amount-ok]').addEventListener('click', () => {
      const amount = Number(amountInput.value);
      /* Mirrors the server's own rule rather than guessing at it: the API
         refuses <= 0, so refusing here means the admin is told at the point of
         typing instead of after a round trip. */
      if (!amountInput.value.trim() || !Number.isFinite(amount) || amount <= 0) {
        return fail('Enter an amount greater than zero.', amountInput);
      }
      const reason = reasonInput.value.trim();
      if (requireReason && !reason) return fail('A reason is required.', reasonInput);
      done({ amount, reason: reason || null });
    });
    overlay.querySelector('[data-amount-cancel]').addEventListener('click', () => done(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
  });
}
