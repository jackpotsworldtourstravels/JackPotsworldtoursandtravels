/* Admin — Booking Operations (CR-2, over the M1/M2 backend)
   =========================================================
   The desk that works a booking *after* it is approved: who is handling it,
   what the airline said, the tickets that came back, and the two lifecycle
   moves that end the job.

   WHY THIS EXISTS NOW
   M1 and M2 shipped this entire backend — the queue, assignment, references,
   internal notes, ticket upload, merchant delivery — and no portal ever
   rendered any of it. CR-2 made that unavoidable: on the Classic Tours track
   there is no payment step, so "Manager Approved -> upload the tickets -> Ticket
   Issued" is the whole remaining workflow and it had no screen at all.

   TWO WORKFLOWS, ONE QUEUE
   A `classic_tours` booking never passes Payment Pending or Paid — the desk
   books it externally, attaches the files and marks it issued. A `standard`
   booking still waits for money. The row's own `workflow` field decides which
   next action is offered, rather than this file re-deriving the rule.

   ENDPOINTS (all pre-existing)
     GET    /api/admin/bookings/queue                  the list
     GET    /api/admin/bookings/queue/counts           tab badges
     GET    /api/admin/bookings/operators              assignees + their load
     POST   /api/admin/bookings/{id}/assign            assign / unassign
     PUT    /api/admin/bookings/{id}/references        PNR, ticket no., airline ref
     GET/POST /api/admin/bookings/{id}/notes           internal notes (staff-only)
     POST   /api/requests/{id}/documents               attach a ticket file
     GET    /api/requests/{id}/documents               what is attached
     POST   /api/admin/requests/{id}/issue-ticket      mark Ticket Issued
     POST   /api/admin/requests/{id}/complete          mark Completed

   Loaded after admin.js and reuses its helpers (API_BASE, authHeaders,
   escapeHtml, fmtDate, fmtDateTime, rowsSkeleton, loadedSections) plus the
   shared toast/confirmDialog components. Nothing here restates them. */

const OPS_TABS = [
  { stage: 'approved', label: 'To book' },
  { stage: 'payment_pending', label: 'Awaiting payment' },
  { stage: 'paid', label: 'Paid' },
  { stage: 'ticket_issued', label: 'Ticket issued' },
];

const OPS_BADGE = {
  approved: 'pending', payment_pending: 'pending',
  paid: 'confirmed', ticket_issued: 'confirmed', completed: 'confirmed',
};

let opsStage = 'approved';
let opsPage = 1;
let opsSearch = '';
let opsAssign = '';
let opsSearchTimer = null;
let opsFiltersWired = false;
let opsOperators = null;
let opsCurrent = null;
/* Returned by trapFocus() while the work modal is open. */
let opsReleaseFocus = null;

function opsSelf() {
  const raw = localStorage.getItem('jwt_user_id');
  return raw ? Number(raw) : null;
}

function opsErr(err, fallback) {
  return err.response?.data?.detail || fallback || 'Something went wrong.';
}

function opsAge(hours) {
  if (hours == null) return '—';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/* ------------------------------------------------------------------ list */

function opsRenderTabs(counts) {
  document.getElementById('opsTabs').innerHTML = OPS_TABS.map(t => {
    const n = counts ? Number(counts[t.stage] || 0) : null;
    return `<button type="button" class="ops-tab${t.stage === opsStage ? ' active' : ''}"
              role="tab" aria-selected="${t.stage === opsStage}" data-ops-tab="${t.stage}">
              ${escapeHtml(t.label)}${n ? `<span class="ops-tab-count">${n}</span>` : ''}
            </button>`;
  }).join('');
  document.querySelectorAll('[data-ops-tab]').forEach(b => {
    b.addEventListener('click', () => {
      opsStage = b.dataset.opsTab;
      opsPage = 1;
      loadBookingOps();
    });
  });
}

async function opsLoadCounts() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/queue/counts`, { headers: authHeaders() });
    opsRenderTabs(data);
    const badge = document.getElementById('opsNavBadge');
    if (badge) {
      /* The badge counts what nobody is working — the number a desk lead acts
         on. "Total in the queue" would be permanently large and permanently
         ignored. */
      const n = Number(data.unassigned || 0);
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.hidden = !n;
    }
  } catch { /* a failed badge must never block the queue */ }
}

function opsWireFilters() {
  if (opsFiltersWired) return;
  opsFiltersWired = true;
  document.getElementById('opsRefreshBtn').addEventListener('click', () => loadBookingOps());
  document.getElementById('opsSearch').addEventListener('input', e => {
    clearTimeout(opsSearchTimer);
    const v = e.target.value;
    opsSearchTimer = setTimeout(() => { opsSearch = v.trim(); opsPage = 1; loadBookingOps(); }, 250);
  });
  document.getElementById('opsAssignFilter').addEventListener('change', e => {
    opsAssign = e.target.value;
    opsPage = 1;
    loadBookingOps();
  });
}

async function loadBookingOps() {
  opsWireFilters();
  opsRenderTabs();
  opsLoadCounts();

  const body = document.querySelector('#opsTable tbody');
  body.innerHTML = `<tr><td colspan="8">${rowsSkeleton(4)}</td></tr>`;

  const params = new URLSearchParams({ stage: opsStage, page: opsPage, page_size: '20' });
  if (opsSearch) params.set('search', opsSearch);
  if (opsAssign === 'unassigned') params.set('unassigned', 'true');
  if (opsAssign === 'mine' && opsSelf()) params.set('assigned_to', String(opsSelf()));

  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/queue?${params}`, { headers: authHeaders() });
    const rows = data.items || [];
    body.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td>
          <div><strong>${escapeHtml(r.request_number)}</strong></div>
          <div style="font-size:11.5px;color:var(--text-muted);">
            ${escapeHtml(r.booking_reference || '')}${r.pnr ? ` · PNR ${escapeHtml(r.pnr)}` : ''}
          </div>
          ${r.workflow === 'classic_tours'
            ? '<span class="badge read" style="margin-top:4px;">Classic Tours · no payment</span>' : ''}
        </td>
        <td>${escapeHtml(r.merchant_name || '—')}</td>
        <td>${r.passengers}${r.lead_passenger ? `<div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(r.lead_passenger)}</div>` : ''}</td>
        <td>${escapeHtml(fmtDate(r.travel_date))}</td>
        <td><span class="badge ${OPS_BADGE[r.status] || ''}">${escapeHtml(r.status_label)}</span>
          ${r.has_ticket_documents ? '<div style="font-size:11.5px;color:var(--text-muted);">tickets attached</div>' : ''}</td>
        <td>${r.assigned_to ? escapeHtml(r.assigned_to) : '<span style="color:var(--text-muted);">Unassigned</span>'}</td>
        <td>${escapeHtml(opsAge(r.age_hours))}</td>
        <td><button type="button" class="btn btn-navy btn-sm" data-ops-open="${r.id}">Work</button></td>
      </tr>`).join('')
      : `<tr><td colspan="8" class="empty-state">Nothing at this stage.</td></tr>`;

    body.querySelectorAll('[data-ops-open]').forEach(b => {
      b.addEventListener('click', () => opsOpenWork(Number(b.dataset.opsOpen)));
    });
    opsRenderPagination(data.page || opsPage, data.total_pages || 1, data.total || rows.length);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state">${escapeHtml(opsErr(err, 'Could not load the queue.'))}</td></tr>`;
  }
}

function opsRenderPagination(page, totalPages, total) {
  const el = document.getElementById('opsPagination');
  if (totalPages <= 1) { el.innerHTML = `<span>${total} booking${total === 1 ? '' : 's'}</span>`; return; }
  el.innerHTML = `
    <span>${total} bookings · page ${page} of ${totalPages}</span>
    <button type="button" class="btn btn-ghost btn-sm" id="opsPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-ghost btn-sm" id="opsNext" ${page >= totalPages ? 'disabled' : ''}>Next</button>`;
  document.getElementById('opsPrev')?.addEventListener('click', () => { opsPage = page - 1; loadBookingOps(); });
  document.getElementById('opsNext')?.addEventListener('click', () => { opsPage = page + 1; loadBookingOps(); });
}

/* ------------------------------------------------------------ work modal */

function opsCloseWork() {
  document.getElementById('opsWorkOverlay').classList.remove('open');
  document.getElementById('opsWorkBody').innerHTML = '';
  opsCurrent = null;
  /* Back to the Work button that opened it. */
  opsReleaseFocus?.();
  opsReleaseFocus = null;
}

async function opsLoadOperators() {
  if (opsOperators) return opsOperators;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/operators`, { headers: authHeaders() });
    opsOperators = data || [];
  } catch {
    opsOperators = [];
  }
  return opsOperators;
}

async function opsOpenWork(id) {
  const overlay = document.getElementById('opsWorkOverlay');
  document.getElementById('opsWorkBody').innerHTML = `<div class="empty-state" style="padding:40px;">Loading booking…</div>`;
  overlay.classList.add('open');
  /* Trapped from the moment it opens, and only once: opsOpenWork is called
     again after every save to re-render, and re-trapping would overwrite the
     stored "return focus here" with a control inside the dialog. */
  if (!opsReleaseFocus) opsReleaseFocus = trapFocus(document.getElementById('opsWorkBody'));

  try {
    /* Four reads, in parallel — the detail, the paperwork, the desk's notes and
       who could take it. They are independent, so serialising them would just
       be four round trips of latency on every open. */
    const [detail, docs, notes, operators] = await Promise.all([
      axios.get(`${API_BASE}/api/requests/${id}`, { headers: authHeaders() }).then(r => r.data),
      axios.get(`${API_BASE}/api/requests/${id}/documents`, { headers: authHeaders() }).then(r => r.data).catch(() => []),
      axios.get(`${API_BASE}/api/admin/bookings/${id}/notes`, { headers: authHeaders() }).then(r => r.data).catch(() => []),
      opsLoadOperators(),
    ]);
    opsCurrent = { id, detail, docs, notes, operators };
    opsRenderWork();
  } catch (err) {
    document.getElementById('opsWorkBody').innerHTML = `
      <div class="ops-modal-head"><h2 id="opsWorkTitle">Booking</h2>
        <button type="button" class="ops-modal-close" id="opsWorkClose" aria-label="Close" data-focus-trap-skip>&times;</button></div>
      <div class="msg error" style="padding:0 30px 30px;">${escapeHtml(opsErr(err, 'Could not load this booking.'))}</div>`;
    document.getElementById('opsWorkClose').addEventListener('click', opsCloseWork);
  }
}

function opsRenderWork() {
  const { id, detail, docs, notes, operators } = opsCurrent;
  const r = detail.request;
  const d = r.details || {};
  const classic = r.workflow === 'classic_tours';
  const tickets = (docs || []).filter(x => x.doc_type === 'ticket' || x.doc_type === 'other');
  const canIssue = r.status === (classic ? 'approved' : 'paid');
  const canComplete = r.status === 'ticket_issued';

  const cell = (label, value) => `
    <div class="detail-item"><span class="detail-label">${label}</span>
      <span class="detail-value">${value}</span></div>`;

  document.getElementById('opsWorkBody').innerHTML = `
    <div class="ops-modal-head">
      <h2 id="opsWorkTitle">${escapeHtml(r.request_number)}
        <span class="badge ${OPS_BADGE[r.status] || ''}">${escapeHtml(r.status_label)}</span>
        ${classic ? '<span class="badge read">Classic Tours</span>' : ''}
      </h2>
      <button type="button" class="ops-modal-close" id="opsWorkClose" aria-label="Close" data-focus-trap-skip>&times;</button>
    </div>

    <div class="ops-modal-body">
      ${classic ? `<div class="ops-hint">
        Approved by a manager. Book this on the trusted booking site, attach the issued
        ticket documents below, then mark it <strong>Ticket Issued</strong> — the merchant
        downloads them from that status. There is no payment step on this workflow.
      </div>` : ''}

      <div class="detail-grid">
        ${cell('Merchant', escapeHtml(r.merchant_name || '—'))}
        ${cell('Booking reference', escapeHtml(r.booking_reference || '—'))}
        ${cell('From enquiry', escapeHtml(d.enquiry_reference || '—'))}
        ${cell('Journey', escapeHtml([d.origin, d.destination].filter(Boolean).join(' → ') || r.title || '—'))}
        ${cell('Airline', escapeHtml([d.airline, d.flight_number].filter(Boolean).join(' ') || '—'))}
        ${cell('Departure', escapeHtml(fmtDate(r.travel_date)))}
        ${cell('Travellers', String((r.passengers || []).length))}
        ${cell('Contact', escapeHtml((d.contact || {}).phone || (d.contact || {}).email || '—'))}
      </div>

      <div class="ops-section">
        <h3>Assignment</h3>
        <div class="ops-row">
          <select id="opsAssignSelect" class="status-select" aria-label="Assign to operator">
            <option value="">Unassigned</option>
            ${(operators || []).map(o => `
              <option value="${o.id}">${escapeHtml(o.full_name)} · ${o.open_bookings} open</option>`).join('')}
          </select>
          <button type="button" class="btn btn-ghost btn-sm" id="opsAssignBtn">Save assignment</button>
        </div>
      </div>

      <div class="ops-section">
        <h3>Airline references</h3>
        <div class="ops-grid-3">
          <div class="form-field"><label for="opsPnr">PNR</label>
            <input id="opsPnr" value="${escapeHtml(r.pnr || '')}" placeholder="H4X9PQ"></div>
          <div class="form-field"><label for="opsTicketNo">Ticket number</label>
            <input id="opsTicketNo" value="${escapeHtml(r.ticket_number || '')}"></div>
          <div class="form-field"><label for="opsAirlineRef">Airline reference</label>
            <input id="opsAirlineRef" value="${escapeHtml(d.airline_reference || '')}"></div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="opsRefsBtn">Save references</button>
      </div>

      <div class="ops-section">
        <h3>Issued ticket documents</h3>
        <p class="ops-sub">PDF, JPEG, PNG or WebP. Attach as many as the airline sent — the
          merchant downloads all of them.</p>
        <div class="ops-row">
          <input type="file" id="opsTicketFiles" multiple accept="application/pdf,image/jpeg,image/png,image/webp">
          <button type="button" class="btn btn-navy btn-sm" id="opsUploadBtn">Upload</button>
        </div>
        <div class="msg" id="opsUploadMsg" aria-live="polite"></div>
        <div class="table-wrap" style="margin-top:12px;"><table><thead><tr>
          <th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th></th>
        </tr></thead><tbody>
          ${tickets.length ? tickets.map(t => `
            <tr>
              <td>${escapeHtml(t.original_filename)}</td>
              <td>${escapeHtml(t.doc_type)}</td>
              <td>${Math.max(1, Math.round((t.size_bytes || 0) / 1024))} KB</td>
              <td>${escapeHtml(fmtDateTime(t.created_at))}</td>
              <td><button type="button" class="btn btn-ghost btn-sm" data-ops-deldoc="${t.id}">Remove</button></td>
            </tr>`).join('')
            : '<tr><td colspan="5" class="empty-state">No tickets attached yet.</td></tr>'}
        </tbody></table></div>
      </div>

      <div class="ops-section">
        <h3>Internal notes <span class="ops-staff-only">staff only — never shown to the merchant</span></h3>
        <div class="ops-row">
          <input type="text" id="opsNoteBody" placeholder="What happened on this booking?">
          <button type="button" class="btn btn-ghost btn-sm" id="opsNoteBtn">Add note</button>
        </div>
        <div id="opsNotesList" style="margin-top:12px;">
          ${(notes || []).length ? notes.map(n => `
            <div class="ops-note">
              <div class="ops-note-body">${escapeHtml(n.body)}</div>
              <div class="ops-note-meta">${escapeHtml(n.author_name || 'Staff')} · ${escapeHtml(fmtDateTime(n.created_at))}</div>
            </div>`).join('')
            : '<p class="ops-sub">No notes yet.</p>'}
        </div>
      </div>

      <div class="ops-actions">
        ${canIssue ? `<button type="button" class="btn btn-coral" id="opsIssueBtn">Mark Ticket Issued</button>` : ''}
        ${canComplete ? `<button type="button" class="btn btn-coral" id="opsCompleteBtn">Mark Completed</button>` : ''}
        ${!canIssue && !canComplete
          ? `<span class="ops-sub">${classic
              ? 'Nothing to do here until a manager approves this booking.'
              : 'This booking is waiting on payment before a ticket can be issued.'}</span>`
          : ''}
        <div class="msg" id="opsActionMsg" aria-live="polite"></div>
      </div>
    </div>`;

  document.getElementById('opsWorkClose').addEventListener('click', opsCloseWork);
  if (r.assigned_admin) document.getElementById('opsAssignSelect').value = String(r.assigned_admin);

  /* The body was just replaced, so focus has fallen to <body>. Put it back on
     the first real control inside the still-trapped container. */
  const firstControl = document.getElementById('opsWorkBody').querySelector(
    'select, input, textarea, button:not([data-focus-trap-skip]), a[href]');
  if (firstControl) firstControl.focus();

  document.getElementById('opsAssignBtn').addEventListener('click', () => opsSaveAssignment(id));
  document.getElementById('opsRefsBtn').addEventListener('click', () => opsSaveReferences(id));
  document.getElementById('opsUploadBtn').addEventListener('click', () => opsUploadTickets(id));
  document.getElementById('opsNoteBtn').addEventListener('click', () => opsAddNote(id));
  document.getElementById('opsIssueBtn')?.addEventListener('click', () => opsLifecycle(id, 'issue-ticket'));
  document.getElementById('opsCompleteBtn')?.addEventListener('click', () => opsLifecycle(id, 'complete'));
  document.querySelectorAll('[data-ops-deldoc]').forEach(b => {
    b.addEventListener('click', () => opsDeleteDoc(id, Number(b.dataset.opsDeldoc)));
  });
}

async function opsSaveAssignment(id) {
  const raw = document.getElementById('opsAssignSelect').value;
  try {
    await axios.post(`${API_BASE}/api/admin/bookings/${id}/assign`,
      { operator_id: raw ? Number(raw) : null }, { headers: authHeaders() });
    showToast('Assignment saved.');
    opsOpenWork(id);
    loadBookingOps();
  } catch (err) {
    showToast(opsErr(err, 'Could not save the assignment.'), true);
  }
}

async function opsSaveReferences(id) {
  const payload = {
    pnr: document.getElementById('opsPnr').value.trim() || null,
    ticket_number: document.getElementById('opsTicketNo').value.trim() || null,
    airline_reference: document.getElementById('opsAirlineRef').value.trim() || null,
  };
  try {
    await axios.put(`${API_BASE}/api/admin/bookings/${id}/references`, payload, { headers: authHeaders() });
    showToast('References saved.');
    opsOpenWork(id);
    loadBookingOps();
  } catch (err) {
    showToast(opsErr(err, 'Could not save the references.'), true);
  }
}

async function opsUploadTickets(id) {
  const input = document.getElementById('opsTicketFiles');
  const msg = document.getElementById('opsUploadMsg');
  const files = [...(input.files || [])];
  if (!files.length) {
    msg.className = 'msg error';
    msg.textContent = 'Choose at least one file.';
    return;
  }

  const btn = document.getElementById('opsUploadBtn');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;

  /* One request per file, sequentially. The endpoint takes a single file, and
     firing them in parallel would race the same booking's document list — a
     desk uploading four e-tickets wants all four, not whichever three won. */
  const failed = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    form.append('doc_type', 'ticket');
    try {
      await axios.post(`${API_BASE}/api/requests/${id}/documents`, form, { headers: authHeaders() });
    } catch (err) {
      failed.push(`${file.name}: ${opsErr(err, 'upload failed')}`);
    }
  }

  btn.disabled = false;
  input.value = '';
  if (failed.length) {
    msg.className = 'msg error';
    msg.textContent = failed.join(' · ');
  } else {
    showToast(`${files.length} ticket document${files.length === 1 ? '' : 's'} attached.`);
  }
  opsOpenWork(id);
  loadBookingOps();
}

async function opsDeleteDoc(id, documentId) {
  if (!await confirmDialog({
    title: 'Remove this ticket?',
    message: 'The merchant will no longer be able to download it.',
    confirmText: 'Remove', danger: true,
  })) return;
  try {
    await axios.delete(`${API_BASE}/api/documents/${documentId}`, { headers: authHeaders() });
    showToast('Ticket removed.');
    opsOpenWork(id);
    loadBookingOps();
  } catch (err) {
    showToast(opsErr(err, 'Could not remove that file.'), true);
  }
}

async function opsAddNote(id) {
  const input = document.getElementById('opsNoteBody');
  const body = input.value.trim();
  if (!body) return;
  try {
    await axios.post(`${API_BASE}/api/admin/bookings/${id}/notes`, { body }, { headers: authHeaders() });
    input.value = '';
    opsOpenWork(id);
  } catch (err) {
    showToast(opsErr(err, 'Could not add that note.'), true);
  }
}

async function opsLifecycle(id, action) {
  const msg = document.getElementById('opsActionMsg');
  const label = action === 'issue-ticket' ? 'Mark this booking as Ticket Issued?' : 'Mark this booking Completed?';
  const detail = action === 'issue-ticket'
    ? 'The merchant is notified and can download the attached ticket documents.'
    : 'This closes the booking.';
  if (!await confirmDialog({ title: label, message: detail, confirmText: 'Confirm' })) return;

  msg.className = 'msg';
  msg.textContent = 'Working…';
  try {
    await axios.post(`${API_BASE}/api/admin/requests/${id}/${action}`, {}, { headers: authHeaders() });
    showToast(action === 'issue-ticket' ? 'Ticket issued.' : 'Booking completed.');
    opsCloseWork();
    loadBookingOps();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = opsErr(err, 'Could not complete that action.');
  }
}

document.getElementById('opsWorkOverlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('opsWorkOverlay')) opsCloseWork();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('opsWorkOverlay')?.classList.contains('open')) opsCloseWork();
});
