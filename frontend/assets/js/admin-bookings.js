/* Admin — Booking review and document verification (Phase 3)
   =========================================================
   The Approval Queue could always approve or reject a booking; what it could
   not do was let an admin *look* at one first. Now that a booking carries
   passports and visas, approving without opening them would be signing off on
   paperwork nobody read.

   DELIBERATELY NOT A NEW SCREEN. The queue, its filters, and its approve/reject
   endpoints are untouched — this adds one Review button that opens a modal over
   the existing overlay markup. Verification is independent of the booking's own
   lifecycle: rejecting a document does not reject the booking, because the two
   are different decisions and an admin may well want a replacement file without
   sending the whole request back.

   Endpoints, both pre-existing or Phase 3:
     GET  /api/requests/{id}                  booking + passengers + documents
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

  /* Surfaced prominently: an international booking whose passports are not all
     verified is exactly the case an approving admin should hesitate over. */
  const intl = !!d.international;
  const paxCount = (r.passengers || []).length;
  const verifiedPassports = new Set(
    docs.filter(x => x.doc_type === 'passport' && x.verification_status === 'verified' && x.passenger_id)
      .map(x => x.passenger_id));
  const outstanding = intl ? paxCount - verifiedPassports.size : 0;

  body.innerHTML = `
    <h2>${escapeHtml(r.request_number)}</h2>
    <p class="modal-sub">
      ${escapeHtml(r.merchant_name || '')} · ${escapeHtml(r.title || '')}
      ${d.enquiry_reference ? ` · from ${escapeHtml(d.enquiry_reference)}` : ''}
    </p>

    ${intl ? `<div class="msg ${outstanding > 0 ? 'warn' : 'success'}">
      International booking — ${outstanding > 0
        ? `${outstanding} of ${paxCount} traveller${paxCount === 1 ? '' : 's'} still without a verified passport.`
        : 'every traveller has a verified passport.'}
    </div>` : ''}

    <div class="detail-grid">
      <div class="detail-item"><span class="detail-label">Status</span>
        <span class="detail-value"><span class="badge ${aqStatusBadgeClass(r.status)}">${escapeHtml(r.status_label || r.status)}</span></span></div>
      <div class="detail-item"><span class="detail-label">Route</span>
        <span class="detail-value">${escapeHtml([d.origin_city || d.origin, d.destination_city || d.destination].filter(Boolean).join(' → ') || '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Flight</span>
        <span class="detail-value">${escapeHtml([d.airline, d.flight_number].filter(Boolean).join(' ') || '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Departure</span>
        <span class="detail-value">${escapeHtml(r.travel_date ? fmtDate(r.travel_date) : '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Class</span>
        <span class="detail-value">${escapeHtml(d.travel_class || '—')}</span></div>
      <div class="detail-item"><span class="detail-label">Travellers</span>
        <span class="detail-value">${paxCount}</span></div>
      <div class="detail-item"><span class="detail-label">Contact</span>
        <span class="detail-value">${escapeHtml(contact.email || '—')}${contact.phone ? `<br>${escapeHtml(contact.phone)}` : ''}</span></div>
      <div class="detail-item"><span class="detail-label">Route type</span>
        <span class="detail-value">${intl ? 'International' : 'Domestic'}</span></div>
    </div>

    ${d.special_requests ? `<div class="detail-note"><strong>Special requests</strong><p>${escapeHtml(d.special_requests)}</p></div>` : ''}
    ${r.remarks ? `<div class="detail-note"><strong>Merchant remarks</strong><p>${escapeHtml(r.remarks)}</p></div>` : ''}

    <h3 style="font-size:13px;margin:18px 0 8px;">Passengers</h3>
    <div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Type</th><th>DOB</th><th>Nationality</th><th>Passport</th><th>Expiry</th>
    </tr></thead><tbody>
      ${(r.passengers || []).map(p => `<tr>
        <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</td>
        <td style="text-transform:capitalize">${escapeHtml(p.passenger_type || 'adult')}</td>
        <td>${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
        <td>${escapeHtml(p.nationality || '—')}</td>
        <td>${escapeHtml(p.passport_number || '—')}</td>
        <td>${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty-state">No passengers.</td></tr>'}
    </tbody></table></div>

    <h3 style="font-size:13px;margin:18px 0 8px;">Documents</h3>
    <div class="table-wrap"><table><thead><tr>
      <th>File</th><th>Type</th><th>For</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody id="admDocRows">
      ${docs.length ? docs.map(doc => `<tr>
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
      </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No documents attached.</td></tr>'}
    </tbody></table></div>

    <div class="msg" id="admReviewMsg"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-adm-close type="button">Close</button>
    </div>`;

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
