/* Admin — Booking Operations: the post-approval desk
   ==================================================
   What happens to a booking after it has been approved — who is working it,
   what the airline called it, and what the desk wrote down. The API for all of
   this has existed since M1 (routers/booking_ops.py); this is its first UI.

   DELIBERATELY DISJOINT FROM THE APPROVAL QUEUE
   That queue ends the moment a booking is approved and this desk begins there,
   so a booking is on exactly one of them at a time and cannot be worked twice
   by two people who each think it is theirs. The one exception is the All
   Bookings tab, which is a register rather than a queue — see below.

   THE TABS
     All Bookings   every booking at every stage, including the ones this desk
                    has no work on: drafts, requests still awaiting approval,
                    completed and cancelled. Reads /api/requests, not the queue
                    endpoint, because the queue deliberately only knows about
                    the four post-approval stages.
     To Book        approved and paid for but not yet ticketed — the desk's
                    actual work. See the note on BO_TABS for why this spans
                    three statuses rather than one.
     Ticket Issued  ticketed, not yet completed.

   There is no Awaiting Payment tab and no Paid tab. Those rows have not gone
   anywhere — they are in To Book, where the work on them is, and in All
   Bookings, where everything is.

   EVERY ROW HAS AN ACTION, AND EVERY ROW HAS VIEW DETAILS
   The primary action follows the status: work it, issue the ticket, complete
   it. A booking with nothing for this desk to do — a draft, one still with the
   Approval Queue, one already closed — gets View Details alone, which is an
   answer rather than a dead end. View Details is offered on every row either
   way, so "what is actually in this booking" is never more than one click from
   anywhere on the screen.

   ENDPOINTS — all pre-existing
     GET  /api/admin/bookings/queue           the two work tabs
     GET  /api/admin/bookings/queue/counts    tab counts
     GET  /api/admin/bookings/operators       who a booking can be assigned to
     POST /api/admin/bookings/{id}/assign     assign / unassign
     PUT  /api/admin/bookings/{id}/references PNR, ticket number, airline ref
     GET/POST /api/admin/bookings/{id}/notes  staff-only internal notes
     POST /api/admin/requests/{id}/issue-ticket | /complete   lifecycle
     GET  /api/requests?request_type=booking  the All Bookings register

   Loaded after admin.js and reuses its API_BASE, authHeaders, escapeHtml,
   fmtDate, fmtDateTime, rowsSkeleton, plus openBookingReview from
   admin-bookings.js and the shared toast/confirm components. */

/* Post-approval statuses that still owe the desk work. `approved` and
   `payment_pending` are both here because ticket_service.approve_request walks
   Approved -> Payment Pending in a single step — a booking never rests at
   Approved, so a To Book tab defined as that status alone would always be
   empty. `paid` is here because a paid booking still has to be placed with the
   airline. What they have in common, and what the tab means, is "settled with
   us, not yet ticketed". */
const BO_TO_BOOK = ['approved', 'payment_pending', 'paid'];

const BO_TABS = [
  {
    id: 'all', label: 'All Bookings',
    /* Not the queue endpoint: that one only knows the four post-approval
       stages by design, and this tab's whole point is the ones outside them. */
    load: () => boFetchAllBookings(),
    empty: 'No bookings yet.',
  },
  {
    id: 'to-book', label: 'To Book',
    load: () => boFetchQueue(null).then(rows => rows.filter(r => BO_TO_BOOK.includes(r.status))),
    empty: 'Nothing waiting to be booked.',
  },
  {
    id: 'ticketed', label: 'Ticket Issued',
    load: () => boFetchQueue('ticket_issued'),
    empty: 'No tickets issued yet.',
  },
];

const BO_BADGE = {
  draft: 'read', pending_approval: 'pending', in_review: 'pending',
  approved: 'refunded', payment_pending: 'pending', paid: 'refunded',
  ticket_issued: 'confirmed', completed: 'confirmed',
  cancelled: 'cancelled', rejected: 'cancelled',
};

let boTab = 'all';
let boRows = [];
let boWired = false;
let boSearchTimer = null;
let boOperators = null;

/* ------------------------------------------------------------------ data */

/* Two endpoints, two row shapes, one table. Normalised here so nothing below
   has to ask which tab it is rendering — a row is a row. */
function boNormaliseQueueItem(r) {
  return {
    /* Only the queue endpoint knows about operator assignment. The flag lets a
       row say "nobody is working this" when that is a fact, and "—" when it is
       simply not something this tab was told. */
    from_queue: true,
    id: r.id,
    request_number: r.request_number,
    booking_reference: r.booking_reference,
    title: r.title,
    status: r.status,
    status_label: r.status_label,
    merchant_name: r.merchant_name,
    passengers: r.passengers,
    lead_passenger: r.lead_passenger,
    travel_date: r.travel_date,
    total_amount: r.total_amount,
    pnr: r.pnr,
    ticket_number: r.ticket_number,
    assigned_admin: r.assigned_admin,
    assigned_to: r.assigned_to,
    age_hours: r.age_hours,
    created_at: r.created_at,
  };
}

function boNormaliseRequest(r) {
  return {
    from_queue: false,
    id: r.id,
    request_number: r.request_number,
    booking_reference: r.booking_reference,
    title: r.title,
    status: r.status,
    status_label: r.status_label,
    merchant_name: r.merchant_name,
    passengers: (r.passengers || []).length,
    lead_passenger: r.passengers && r.passengers.length
      ? `${r.passengers[0].first_name || ''} ${r.passengers[0].last_name || ''}`.trim()
      : null,
    travel_date: r.travel_date,
    total_amount: r.total_amount,
    pnr: r.pnr,
    ticket_number: r.ticket_number,
    /* /api/requests does not carry the assignment — that is a Booking
       Operations concept and lives on the queue endpoint. Left null rather
       than guessed, so the Operator column reads "—" instead of "Unassigned"
       for a booking that may well be assigned. */
    assigned_admin: null,
    assigned_to: null,
    age_hours: null,
    created_at: r.created_at,
  };
}

async function boFetchQueue(stage) {
  const assign = document.getElementById('boAssignFilter').value;
  const params = { page: 1, page_size: 100 };
  if (stage) params.stage = stage;
  if (assign === 'unassigned') params.unassigned = true;
  if (assign === 'mine' && crSelf()) params.assigned_to = crSelf();
  const search = document.getElementById('boSearch').value.trim();
  if (search) params.search = search;

  const { data } = await axios.get(`${API_BASE}/api/admin/bookings/queue`,
    { headers: authHeaders(), params });
  return (data.items || []).map(boNormaliseQueueItem);
}

async function boFetchAllBookings() {
  const { data } = await axios.get(`${API_BASE}/api/requests`, {
    headers: authHeaders(),
    params: {
      request_type: 'booking', page: 1, page_size: 100,
      search: document.getElementById('boSearch').value.trim() || undefined,
    },
  });
  return (data.items || []).map(boNormaliseRequest);
}

/* ---------------------------------------------------------------- render */

function boTabStrip(counts) {
  const strip = document.getElementById('boTabs');
  strip.innerHTML = BO_TABS.map(t => {
    const n = counts ? counts[t.id] : undefined;
    return `<button type="button" role="tab" class="bo-tab${t.id === boTab ? ' active' : ''}"
      aria-selected="${t.id === boTab}" data-bo-tab="${t.id}">${escapeHtml(t.label)}${
      n === undefined ? '' : ` <span class="bo-tab-count">(${n})</span>`}</button>`;
  }).join('');
  strip.querySelectorAll('[data-bo-tab]').forEach(b =>
    b.addEventListener('click', () => { boTab = b.dataset.boTab; loadBookingOps(); }));
}

/* Counts come from the queue's own grouped endpoint rather than from the rows
   on screen: a tab showing 100 of 340 must not label itself "(100)". All
   Bookings has no such endpoint, so it carries no count rather than a wrong
   one. */
async function boLoadCounts() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/queue/counts`,
      { headers: authHeaders() });
    const toBook = BO_TO_BOOK.reduce((n, s) => n + (data[s] || 0), 0);
    const badge = document.getElementById('boNavBadge');
    if (badge) {
      badge.textContent = toBook > 99 ? '99+' : String(toBook);
      badge.hidden = !toBook;
    }
    return { 'to-book': toBook, ticketed: data.ticket_issued || 0 };
  } catch {
    return null;
  }
}

/* The action that matches where the booking actually is. Everything gets View
   Details as well — a row that only says "nothing to do here" is a dead end,
   and the details are what an admin came to the screen for. */
function boActions(r) {
  /* The four post-approval stages are the ones this desk works. Everything
     else — a draft, one still with the Approval Queue, one already closed —
     has nothing for it to do, and gets View Details alone. */
  const workable = BO_TO_BOOK.includes(r.status) || r.status === 'ticket_issued';
  return [
    workable ? `<button class="btn btn-navy btn-sm" data-bo-work="${r.id}">Work booking</button>` : '',
    `<button class="btn btn-ghost btn-sm" data-bo-view="${r.id}">View Details</button>`,
  ].filter(Boolean).join(' ');
}

function boOperatorCell(r) {
  if (r.assigned_to) return escapeHtml(r.assigned_to);
  /* "Nobody is working this" and "this tab was not told" are different facts,
     and only one of them is a call to action. */
  return r.from_queue
    ? '<span class="cell-sub">Unassigned</span>'
    : '<span class="cell-sub">—</span>';
}

async function loadBookingOps() {
  if (!boWired) {
    boWired = true;
    document.getElementById('boRefreshBtn').addEventListener('click', () => loadBookingOps());
    document.getElementById('boAssignFilter').addEventListener('change', () => loadBookingOps());
    document.getElementById('boSearch').addEventListener('input', () => {
      clearTimeout(boSearchTimer);
      boSearchTimer = setTimeout(() => loadBookingOps(), 300);
    });
  }

  const tab = BO_TABS.find(t => t.id === boTab) || BO_TABS[0];
  const tbody = document.querySelector('#boTable tbody');
  boTabStrip(null);
  tbody.innerHTML = `<tr><td colspan="8">${rowsSkeleton(4)}</td></tr>`;

  /* The operator filter only means anything on the two queue tabs — /api/requests
     has no notion of an assignment — so it is disabled rather than silently
     ignored on All Bookings. */
  document.getElementById('boAssignFilter').disabled = boTab === 'all';

  const [rows, counts] = await Promise.all([
    tab.load().catch(() => null),
    boLoadCounts(),
  ]);
  boTabStrip(counts);

  if (rows === null) {
    boRows = [];
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Failed to load bookings.</td></tr>';
    document.getElementById('boQueueSummary').textContent = '';
    return;
  }

  boRows = rows;
  document.getElementById('boQueueSummary').textContent =
    `${rows.length} booking${rows.length === 1 ? '' : 's'}`;

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td><span class="mono">${escapeHtml(r.request_number)}</span>
          ${r.age_hours ? `<div class="cell-sub">${r.age_hours}h in queue</div>` : ''}</td>
      <td>${escapeHtml(r.merchant_name || '—')}</td>
      <td>${escapeHtml(r.title || '—')}
          <div class="cell-sub">${escapeHtml(r.booking_reference || '')}${
            r.pnr ? ` · PNR ${escapeHtml(r.pnr)}` : ''}</div></td>
      <td>${r.travel_date ? fmtDate(r.travel_date) : '—'}
          <div class="cell-sub">${r.passengers || 0} pax</div></td>
      <td>${crMoney(r.total_amount)}</td>
      <td>${boOperatorCell(r)}</td>
      <td><span class="badge ${BO_BADGE[r.status] || 'pending'}">${escapeHtml(r.status_label)}</span></td>
      <td style="white-space:nowrap;">${boActions(r)}</td>
    </tr>`).join('')
    : `<tr><td colspan="8" class="empty-state">${escapeHtml(tab.empty)}</td></tr>`;

  tbody.querySelectorAll('[data-bo-view]').forEach(b =>
    b.addEventListener('click', () => openBookingReview(b.dataset.boView)));
  tbody.querySelectorAll('[data-bo-work]').forEach(b =>
    b.addEventListener('click', () => openBookingOps(b.dataset.boWork)));
  document.getElementById('boPagination').innerHTML = '';
}

/* ----------------------------------------------------------- work dialog */

/* Loaded once and cached: the operator list changes when staff are onboarded,
   not while an admin works through a queue. */
async function boLoadOperators() {
  if (boOperators) return boOperators;
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/bookings/operators`,
      { headers: authHeaders() });
    boOperators = data || [];
  } catch {
    boOperators = [];
  }
  return boOperators;
}

async function openBookingOps(requestId) {
  const overlay = document.getElementById('boModalOverlay');
  const body = document.getElementById('boModalBody');
  overlay.classList.add('open');
  body.innerHTML = `<h2>Booking</h2><div>${rowsSkeleton(4)}</div>`;

  const row = boRows.find(r => String(r.id) === String(requestId));
  let notes = [];
  let operators = [];
  try {
    [notes, operators] = await Promise.all([
      axios.get(`${API_BASE}/api/admin/bookings/${requestId}/notes`, { headers: authHeaders() })
        .then(res => res.data).catch(() => []),
      boLoadOperators(),
    ]);
  } catch { /* the dialog still opens; the sections say what is missing */ }

  const canIssue = row && row.status === 'paid';
  const canComplete = row && row.status === 'ticket_issued';

  body.innerHTML = `
    <h2>${escapeHtml(row ? row.request_number : 'Booking')}</h2>
    <p class="modal-sub">${escapeHtml(row ? (row.merchant_name || '') : '')}${
      row && row.title ? ` · ${escapeHtml(row.title)}` : ''}</p>

    <div class="detail-grid">
      ${crDetailRow('Status', row
        ? `<span class="badge ${BO_BADGE[row.status] || 'pending'}">${escapeHtml(row.status_label)}</span>`
        : '—')}
      ${crDetailRow('Booking reference', escapeHtml(row?.booking_reference || '—'))}
      ${crDetailRow('Travel date', row?.travel_date ? fmtDate(row.travel_date) : '—')}
      ${crDetailRow('Passengers', String(row?.passengers ?? '—'))}
      ${crDetailRow('Amount', crMoney(row?.total_amount))}
      ${crDetailRow('Operator', escapeHtml(row?.assigned_to || 'Unassigned'))}
    </div>

    <div class="form-field" style="max-width:none;">
      <label for="boOperatorSelect">Assign to</label>
      <select id="boOperatorSelect" class="status-select" style="width:100%;">
        <option value="">Unassigned</option>
        ${operators.map(o => `<option value="${o.id}"${
          row && row.assigned_admin === o.id ? ' selected' : ''}>${escapeHtml(o.full_name)} — ${
          o.open_bookings} open</option>`).join('')}
      </select>
      <span class="cell-sub">Each operator's current load is shown, so the queue is not
        handed to whoever is at the top of the list.</span>
    </div>

    <div class="form-grid">
      <div class="form-field"><label for="boPnr">Airline PNR</label>
        <input type="text" id="boPnr" maxlength="20" value="${escapeHtml(row?.pnr || '')}"></div>
      <div class="form-field"><label for="boTicketNo">Ticket number</label>
        <input type="text" id="boTicketNo" maxlength="40" value="${escapeHtml(row?.ticket_number || '')}"></div>
      <div class="form-field"><label for="boAirlineRef">Airline reference</label>
        <input type="text" id="boAirlineRef" maxlength="120" placeholder="Tour code, group ref…"></div>
    </div>
    <span class="cell-sub">Only the fields you fill in are written, so saving a PNR cannot blank
      the ticket number. Recording a reference does not move the booking's status.</span>

    <h3 style="font-size:13px;margin:18px 0 8px;">Internal notes</h3>
    <p class="cell-sub" style="margin:-4px 0 8px;">Staff only. Never shown to the merchant, in any
      response — a merchant calling this endpoint gets a 403, not an empty list.</p>
    <div id="boNotesList">${notes.length ? notes.map(n => `
      <div class="detail-note">
        <strong>${escapeHtml(n.author_name || 'Operator')} · ${fmtDateTime(n.created_at)}${
          n.edited_at ? ' · edited' : ''}</strong>
        <p>${escapeHtml(n.body)}</p>
      </div>`).join('') : '<div class="empty-state">No notes on this booking.</div>'}</div>
    <div class="form-field" style="max-width:none;">
      <label for="boNoteInput">Add a note</label>
      <textarea id="boNoteInput" rows="2" style="width:100%;padding:10px 12px;border-radius:10px;border:1.5px solid var(--border-color);font-family:var(--ff);font-size:14px;"></textarea>
    </div>

    <div class="msg" id="boModalMsg"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" type="button" data-bo-close>Close</button>
      <button class="btn btn-ghost" type="button" id="boViewBtn">View Details</button>
      <button class="btn btn-navy" type="button" id="boSaveBtn">Save</button>
      ${canIssue ? '<button class="btn btn-coral" type="button" id="boIssueBtn">Issue ticket</button>' : ''}
      ${canComplete ? '<button class="btn btn-coral" type="button" id="boCompleteBtn">Mark completed</button>' : ''}
    </div>`;

  const close = () => overlay.classList.remove('open');
  const msg = document.getElementById('boModalMsg');
  const setMsg = (text, kind) => { msg.textContent = text; msg.className = `msg ${kind || ''}`; };

  body.querySelectorAll('[data-bo-close]').forEach(b => b.addEventListener('click', close));
  document.getElementById('boViewBtn').addEventListener('click', () => {
    close();
    openBookingReview(requestId);
  });

  document.getElementById('boSaveBtn').addEventListener('click', async () => {
    const btn = document.getElementById('boSaveBtn');
    btn.disabled = true;
    const pnr = document.getElementById('boPnr').value.trim();
    const ticket = document.getElementById('boTicketNo').value.trim();
    const airline = document.getElementById('boAirlineRef').value.trim();
    const note = document.getElementById('boNoteInput').value.trim();
    const operatorValue = document.getElementById('boOperatorSelect').value;
    const operatorId = operatorValue ? Number(operatorValue) : null;

    try {
      /* Sequential, not parallel: these are three different writes to the same
         booking, and a half-applied set is much harder to reason about than a
         failure that stops at the first thing that did not work. */
      if (operatorId !== (row ? row.assigned_admin : null)) {
        await axios.post(`${API_BASE}/api/admin/bookings/${requestId}/assign`,
          { operator_id: operatorId }, { headers: authHeaders() });
      }
      if (pnr || ticket || airline) {
        await axios.put(`${API_BASE}/api/admin/bookings/${requestId}/references`, {
          pnr: pnr || undefined,
          ticket_number: ticket || undefined,
          airline_reference: airline || undefined,
        }, { headers: authHeaders() });
      }
      if (note) {
        await axios.post(`${API_BASE}/api/admin/bookings/${requestId}/notes`,
          { body: note }, { headers: authHeaders() });
      }
      showToast('Booking updated.');
      close();
      loadBookingOps();
    } catch (err) {
      btn.disabled = false;
      setMsg(err.response?.data?.detail || 'Could not save those changes.', 'error');
    }
  });

  document.getElementById('boIssueBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Issue the ticket?',
      message: `${row.request_number} moves to Ticket Issued and the merchant is told. `
        + 'Record the airline PNR and ticket number first if you have them.',
      confirmText: 'Issue ticket',
    });
    if (!ok) return;
    await boLifecycle(requestId, 'issue-ticket', 'Ticket issued.', close, setMsg);
  });

  document.getElementById('boCompleteBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Mark this booking completed?',
      message: `${row.request_number} is closed. This is the end of the booking's lifecycle.`,
      confirmText: 'Mark completed',
    });
    if (!ok) return;
    await boLifecycle(requestId, 'complete', 'Booking completed.', close, setMsg);
  });
}

async function boLifecycle(requestId, action, toast, close, setMsg) {
  try {
    await axios.post(`${API_BASE}/api/admin/requests/${requestId}/${action}`, {},
      { headers: authHeaders() });
    showToast(toast);
    close();
    loadBookingOps();
    // Both counters move when a booking changes stage.
    if (loadedSections.has('reports')) loadReports();
  } catch (err) {
    setMsg(err.response?.data?.detail || 'Could not complete that action.', 'error');
  }
}
