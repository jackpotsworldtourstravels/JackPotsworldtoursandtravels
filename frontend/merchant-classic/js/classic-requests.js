'use strict';
/* Merchant Portal — My Requests: ACTIVE WORK ONLY.
   ===========================================================================
   This screen used to be every request the merchant had ever raised, at every
   stage, with a status filter over the lot. That made the one screen an
   operator opens all day mostly a list of things that need nothing: on a live
   account the finished bookings outnumber the open ones many times over, so the
   five rows that needed attention were buried under two hundred that did not.

   My Requests is now a WORKLIST. It shows only what is still moving — drafts,
   anything awaiting an approval or a fare, anything awaiting payment or its
   verification. Everything terminal (ticketed, completed, cancelled, rejected)
   lives on Booking History, which is built for looking things up rather than
   for working through them. See classic-history.js.

   HOW "ALL ACTIVE" IS FETCHED, AND WHY IT IS NOT ONE CALL
   ---------------------------------------------------------------------------
   `GET /api/requests` takes ONE status (`ticket_service.list_requests`). The
   easy implementation is to fetch a page unfiltered and drop the terminal rows
   in the browser — and it is wrong in a way that hides work: a merchant with
   2,600 requests would be shown the active ones among its 100 most recent, so
   an old booking stuck in Payment Pending simply would not appear. It is the
   same bug the search box had before it was moved server-side.

   So "All active" fires one scoped request PER ACTIVE STATUS, in parallel, and
   merges them. Every row is fetched by the server under its own filter, the
   count in the footer is the SUM OF THE SERVERS' OWN TOTALS, and nothing is
   inferred from a page. Choosing a single stage collapses back to one call.

   The other filters — search, travel-date range, request type — are passed to
   the server on every one of those calls, so the narrowing is the database's
   and not this file's. */

let clRequestRows = [];

/* The stages where something is still expected of somebody. `submitted` is in
   the list for completeness: the lifecycle can produce it, and a row nobody
   filters for is a row nobody sees. */
const CL_ACTIVE_STATUSES = [
  'draft', 'pending_approval', 'in_review', 'approved', 'payment_pending', 'paid',
];

const CL_REQ_PAGE_SIZE = 25;
/* Per-status ceiling when merging. 100 open requests in ONE stage is already
   far beyond any real merchant's worklist; if it is ever exceeded the footer
   says so rather than quietly truncating. */
const CL_REQ_FETCH = 100;

let clReqPage = 1;
let clReqTotal = 0;
let clReqCapped = false;
let clReqSearchTimer = null;
/* True when ONE stage is selected, which is the case the API can page natively.
   The two modes differ in who owns the page window — the server, or this file
   over a merged set — and every pager control branches on it. */
let clReqServerPaged = false;

function clInitRequests() {
  $('cl-requests').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>My Requests</h1>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clReqRefresh">
          ${clIco('refresh', { size: 15 })} Refresh
        </button>
        <button type="button" class="cl-btn cl-btn-primary" id="clReqNew"
          ${clActionAttrs('ticket.enquiry', CL_NO_ENQUIRY)}>
          ${clIco('plus', { size: 15 })} New Booking Enquiry
        </button>
      </div>
    </div>

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clReqStatus">Stage</label>
          <select id="clReqStatus" data-cl-status-filter>
            <option value="">All active work</option>
            ${CL_ACTIVE_STATUSES.map(s =>
              `<option value="${s}" data-cl-chip-tone="${CL_STATUS_TONE[s] || ''}">${clStageName(s)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <label for="clReqType">Type</label>
          <select id="clReqType">
            <option value="">All types</option>
            <option value="booking">Booking</option>
            <option value="ticket_enquiry">Booking enquiry</option>
            ${MERCHANT_SERVICE_REQUEST_TYPES.map(t =>
              `<option value="${t}">${clLabel(t)}</option>`).join('')}
          </select>
        </div>
        <!-- Labelled "Travel date", because that is the column the API filters
             on (ticket_service.list_requests). A range control that silently
             meant "created" is the exact mislabelling this portal has been
             caught by before. -->
        <div class="cl-field">
          <label for="clReqFrom">Travel date from</label>
          <input type="date" id="clReqFrom">
        </div>
        <div class="cl-field">
          <label for="clReqTo">Travel date to</label>
          <input type="date" id="clReqTo">
        </div>
        <div class="cl-field" style="flex:1 1 220px;">
          <label for="clReqSearch">Search</label>
          <input type="search" id="clReqSearch"
                 placeholder="Request no., PNR, route or passenger">
        </div>
        <div class="cl-toolbar-actions">
          <button type="button" class="cl-btn" id="clReqReset">Reset</button>
          <button type="button" class="cl-btn cl-btn-secondary" id="clReqApply">
            ${clIco('filter', { size: 14 })} Apply filters
          </button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Reference</th><th>Journey</th><th>Stage</th><th>Status</th>
              <th>Assigned team</th><th>Last updated</th><th>Expected update</th>
              <th class="cl-actions">Action</th>
            </tr></thead>
            <tbody id="clReqBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager">
        <span class="cl-pager-info" id="clReqCount">—</span>
        <span class="cl-pager-actions">
          <button type="button" class="cl-btn cl-btn-sm" id="clReqPrev">Previous</button>
          <button type="button" class="cl-btn cl-btn-sm" id="clReqNext">Next</button>
        </span>
      </div>
      <div class="cl-panel-note" id="clReqNote"></div>
    </div>`;

  /* The "finished bookings move to Booking History" line that used to carry a
     link to that screen went with the page descriptions; the rail is the way
     across, and it always was. */
  /* Booking starts at the enquiry, not at a search: a request can only be
     raised against an enquiry our team has already answered. */
  $('clReqNew').addEventListener('click', () => clGo('enquiry'));
  /* Stage is the facet this screen is actually read by, so it is a chip row
     rather than a dropdown. The <select> above stays as the value holder —
     see clChips() in classic-shell.js. */
  clChips('clReqStatus', 'Stage');

  $('clReqRefresh').addEventListener('click', () => clLoadRequests());
  $('clReqApply').addEventListener('click', () => clLoadRequests({ resetPage: true }));
  $('clReqReset').addEventListener('click', () => {
    ['clReqStatus', 'clReqType', 'clReqFrom', 'clReqTo', 'clReqSearch'].forEach(id => { $(id).value = ''; });
    clSyncChips('clReqStatus');     /* a bare .value write fires no change event */
    clLoadRequests({ resetPage: true });
  });
  ['clReqStatus', 'clReqType', 'clReqFrom', 'clReqTo'].forEach(id =>
    $(id).addEventListener('change', () => clLoadRequests({ resetPage: true })));
  /* Debounced: every keystroke is a request, and the server does the matching.
     350ms is long enough that typing a PNR is one round trip. */
  $('clReqSearch').addEventListener('input', () => {
    clearTimeout(clReqSearchTimer);
    clReqSearchTimer = setTimeout(() => clLoadRequests({ resetPage: true }), 350);
  });
  /* One stage is paged by the server, so turning the page is a fetch. "All
     active work" is a merged window this file already holds, so it is a
     re-render. Both go through clStepReqPage so the two cases cannot drift. */
  $('clReqPrev').addEventListener('click', () => clStepReqPage(-1));
  $('clReqNext').addEventListener('click', () => clStepReqPage(1));

  return clLoadRequests();
}

function clStepReqPage(delta) {
  const next = clReqPage + delta;
  if (next < 1) return;
  if (clReqServerPaged) {
    if (delta > 0 && (clReqPage * CL_REQ_PAGE_SIZE) >= clReqTotal) return;
    clReqPage = next;
    clLoadRequests();
    return;
  }
  if (delta > 0 && clReqPage * CL_REQ_PAGE_SIZE >= clRequestRows.length) return;
  clReqPage = next;
  clRenderRequestRows();
}

/* ------------------------------------------------------- stage vocabulary */

/* What a status MEANS to a merchant, who is holding it, and what happens next.

   Every field here is derived from the lifecycle — none of it is invented. The
   "assigned team" is the desk the state machine has the row sitting in, not a
   named person: there is no assignee on the merchant-facing response and
   inventing one would be a fiction the merchant could not act on.

   Two statuses read differently on the two tracks. On `classic_tours` (CR-2)
   an enquiry-led booking is approved by the MERCHANT'S OWN manager and never
   reaches a payment stage, so `pending_approval` is with their approver and
   `approved` goes straight to ticketing. On `standard` both are ours. */
const CL_STAGES = {
  draft: {
    name: 'Draft', tone: '',
    team: 'You', next: 'Submit it for approval',
  },
  pending_approval: {
    name: 'Waiting approval', tone: 'warn',
    team: 'Approver', next: 'An approval decision',
  },
  in_review: {
    name: 'Under processing', tone: 'warn',
    team: 'Booking Ops', next: 'Confirmation of the fare',
  },
  approved: {
    name: 'Approved', tone: 'info',
    team: 'Booking Ops', next: 'A payment request',
  },
  payment_pending: {
    name: 'Payment pending', tone: 'warn',
    team: 'You', next: 'Your payment',
  },
  paid: {
    name: 'Verification', tone: 'ok',
    team: 'Finance desk', next: 'Verification, then ticketing',
  },
};

function clStageName(status) {
  return CL_STAGES[status]?.name || clLabel(status);
}

/* The row's stage, resolved against its own track and its manager state. */
function clStageOf(r) {
  const base = CL_STAGES[r.status] || { name: clLabel(r.status), tone: '', team: '—', next: '—' };
  const stage = { ...base };
  const classic = r.workflow === 'classic_tours';

  if (r.status === 'pending_approval') {
    stage.team = classic ? 'Your approver' : 'Booking Ops';
  }
  if (r.status === 'approved' && classic) {
    stage.name = 'Ticketing';
    stage.team = 'Ticketing desk';
    stage.next = 'Ticket issue';
  }
  /* A service request waits for the merchant's OWN manager before our desk can
     see it at all (CR-2 / manager_approval.py). Saying "Booking Ops" while it
     is sitting with a colleague upstairs sends the merchant to the wrong place. */
  if (r.manager_state === 'pending') {
    stage.name = 'Waiting approval';
    stage.team = 'Your manager';
    stage.next = 'Your manager’s decision';
  }
  return stage;
}

/* "Last updated" is derived, because the merchant-facing response carries no
   `updated_at` — only `created_at`, `approved_at` and `completed_at`. The
   latest of those IS the last thing that demonstrably happened to the row, and
   naming the event beside the date is what keeps it from reading as a field the
   API does not have. */
function clLastUpdate(r) {
  const events = [
    ['Completed', r.completed_at],
    ['Approved', r.approved_at],
    ['Raised', r.created_at],
  ].filter(([, at]) => at);
  if (!events.length) return { label: '—', at: null };
  events.sort((a, b) => new Date(b[1]) - new Date(a[1]));
  return { label: events[0][0], at: events[0][1] };
}

/* How long a row has been sitting, in the units a person would say it in. */
function clAgeText(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms > 0)) return 'just now';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return 'under an hour';
}

/* --------------------------------------------------------------- loading */

/* Filters common to every call. Built once so the parallel status calls cannot
   describe different populations. */
function clRequestParams() {
  const params = {};
  const type = $('clReqType').value;
  const search = $('clReqSearch').value.trim();
  if (type) params.request_type = type;
  if (search) params.search = search;
  if ($('clReqFrom').value) params.date_from = $('clReqFrom').value;
  if ($('clReqTo').value) params.date_to = $('clReqTo').value;
  return params;
}

async function clLoadRequests({ resetPage = false } = {}) {
  /* THIS SCREEN MAY NEVER HAVE BEEN RENDERED.
     `clSubmitDraft`, `clCancelRequest` and `clContinueBookingDraft` all end by
     re-reading this table, and until Booking Request grew a strip of recent
     bookings those three were only ever reachable FROM this table, so the
     element was always there. They are now also reachable from a screen a
     merchant can land on first — every id below would be null and the reload
     would throw after a submit the server had already accepted. The
     clInvalidate() that precedes every one of those calls is what actually
     keeps this screen honest; re-reading it is only for when it is on screen. */
  if (!$('clReqBody')) return;

  if (resetPage) clReqPage = 1;
  const body = $('clReqBody');
  body.innerHTML = clLoadingRow(8, 'Loading your active work…');

  const base = clRequestParams();
  const chosen = $('clReqStatus').value;
  clReqServerPaged = !!chosen;

  try {
    /* ONE STAGE: the API can express this filter exactly, so it pages natively
       and every row in that stage is reachable however many there are. */
    if (chosen) {
      const data = await MerchantApi.listRequests({
        ...base, status: chosen, page: clReqPage, page_size: CL_REQ_PAGE_SIZE,
      });
      clRequestRows = data.items || [];
      clReqTotal = data.total ?? clRequestRows.length;
      clReqCapped = false;
      /* A filter change can strand the pager past the end of the new result
         set. Step back rather than showing an empty page with a live Previous. */
      if (!clRequestRows.length && clReqPage > 1 && clReqTotal > 0) {
        clReqPage = Math.max(1, Math.ceil(clReqTotal / CL_REQ_PAGE_SIZE));
        return clLoadRequests();
      }
      return clRenderRequestRows();
    }

    /* ALL ACTIVE: one scoped call per stage, merged. `allSettled` rather than
       `all` — one stage failing must not blank the other five, and the footer
       says how many stages actually answered. */
    const results = await Promise.allSettled(
      CL_ACTIVE_STATUSES.map(status =>
        MerchantApi.listRequests({ ...base, status, page_size: CL_REQ_FETCH })));

    const rows = [];
    let total = 0;
    let capped = false;
    let failed = 0;
    results.forEach(res => {
      if (res.status !== 'fulfilled') { failed += 1; return; }
      const items = res.value.items || [];
      const stageTotal = res.value.total ?? items.length;
      rows.push(...items);
      total += stageTotal;
      if (stageTotal > items.length) capped = true;
    });

    if (failed === CL_ACTIVE_STATUSES.length) throw results[0].reason;

    /* Newest first, matching the server's own ordering within each stage. */
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    clRequestRows = rows;
    clReqTotal = total;
    clReqCapped = capped;

    const maxPage = Math.max(1, Math.ceil(rows.length / CL_REQ_PAGE_SIZE));
    if (clReqPage > maxPage) clReqPage = maxPage;
    clRenderRequestRows(failed);
  } catch (err) {
    clRequestRows = [];
    body.innerHTML = clEmptyRow(8, clError(err, 'Failed to load your requests.'));
    $('clReqCount').textContent = '—';
    $('clReqPrev').disabled = true;
    $('clReqNext').disabled = true;
    $('clReqNote').textContent = '';
  }
}

function clRenderRequestRows(failedStages = 0) {
  const body = $('clReqBody');
  const all = clRequestRows;
  const start = (clReqPage - 1) * CL_REQ_PAGE_SIZE;
  /* Server-paged: `clRequestRows` IS the page. Merged: it is the whole window
     and this file cuts the page out of it. */
  const rows = clReqServerPaged ? all : all.slice(start, start + CL_REQ_PAGE_SIZE);
  const filtered = !!($('clReqSearch').value.trim() || $('clReqStatus').value
    || $('clReqType').value || $('clReqFrom').value || $('clReqTo').value);

  body.innerHTML = rows.length
    ? rows.map(clRequestRow).join('')
    : clEmptyRow(8,
      filtered ? 'Nothing matches those filters.' : 'No open requests',
      filtered
        ? ' Clear them to see everything still in motion.'
        : ' Everything you have raised has been settled. Start a booking enquiry to raise the next one.');

  /* The count line distinguishes what the pager can REACH from what matches.
     They are the same number until an account is big enough for a stage to
     exceed the per-stage fetch — and then saying only "of 3,881" while Next
     stops at row 600 is a promise the control cannot keep. */
  const first = rows.length ? start + 1 : 0;
  const last = start + rows.length;
  $('clReqCount').textContent = !rows.length
    ? '0 active requests'
    : clReqServerPaged || all.length >= clReqTotal
      ? `${first}–${last} of ${clReqTotal} active request${clReqTotal === 1 ? '' : 's'}`
      : `${first}–${last} of ${all.length} most recent · ${clReqTotal} active in total`;
  $('clReqPrev').disabled = clReqPage <= 1;
  $('clReqNext').disabled = clReqServerPaged
    ? clReqPage * CL_REQ_PAGE_SIZE >= clReqTotal
    : start + CL_REQ_PAGE_SIZE >= all.length;

  /* Honesty about the fetch, when there is anything to be honest about. */
  const notes = [];
  if (clReqCapped) {
    notes.push(`This account has more than ${CL_REQ_FETCH} requests in a single stage, so this list holds the ${CL_REQ_FETCH} most recent of each. Choose one stage above and it pages through every row in it.`);
  }
  if (failedStages) {
    notes.push(`${failedStages} stage${failedStages === 1 ? '' : 's'} could not be loaded, so this list may be incomplete. Try Refresh.`);
  }
  $('clReqNote').textContent = notes.join(' ');

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
  body.querySelectorAll('[data-cl-continue]').forEach(b =>
    b.addEventListener('click', () => clContinueBookingDraft(b.dataset.clContinue, b)));
}

/* Reopen a draft booking on the Booking Request screen.
   The row only carries a summary, so the full booking is re-read first —
   clResumeBookingDraft rebuilds the journey from its `details` and needs the
   passengers, which the list response does not include. */
async function clContinueBookingDraft(id, btn) {
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    const detail = await MerchantApi.getRequest(id);
    const booking = detail?.request || detail;
    if (!booking || booking.status !== 'draft') {
      /* Someone submitted it in another tab. Refuse rather than open an
         editable form over a booking the API will no longer accept edits to. */
      await clLoadRequests();
      return clOpenModal('No longer a draft', `
        <div class="cl-msg cl-msg-info" style="margin-top:0">
          This booking has already been submitted. Open it with <b>View</b> to see where it is.
        </div>`,
        '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
    }
    /* The envelope goes too: a group draft's manifest id is on it rather than
       on `request`, and without it the screen would ask for the sheet again. */
    clResumeBookingDraft(booking, detail);
  } catch (err) {
    clOpenModal('Could not open this draft',
      `<div class="cl-msg cl-msg-err" style="margin-top:0">${
        escapeHtml(clError(err, 'Please try again.'))}</div>`,
      '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
  }
}

/* The journey, as a route where there is one and as the title otherwise —
   a hotel or a package has no origin. */
function clJourneyCell(r) {
  const d = r.travel_details || r.details || {};
  const from = d.origin_city || d.origin;
  const to = d.destination_city || d.destination;
  const route = from && to
    ? `${escapeHtml(from)} <span style="color:var(--cl-text-muted)">→</span> ${escapeHtml(to)}`
    : escapeHtml(r.title || '—');
  const bits = [
    r.travel_date ? fmtDate(r.travel_date) : null,
    r.passengers?.length ? `${r.passengers.length} pax` : null,
    clRequestAmountText(r),
  ].filter(Boolean);
  return `<b>${route}</b>
    <div class="cl-kpi-sub" style="margin-top:2px;">${escapeHtml(bits.join(' · ')) || '—'}</div>`;
}

/* On a booking, `total_amount` is what the merchant owes. On a cancellation it
   is the refund due back to them, and on a reschedule it is the amount payable
   for the move — the same column, three different meanings, so the direction is
   spelled out rather than inferred.

   `moneyStr`, not `money()`: the amount is a decimal string and `money()` rounds
   it through a float, turning ₹60,000.50 into ₹60,001. */
function clRequestAmountText(r) {
  if (!moneyIsPositive(r.total_amount)) return '';
  const amount = moneyStr(r.total_amount);
  if (r.request_type === 'cancellation') return `${amount} refund due`;
  if (r.request_type === 'date_change') return `${amount} payable`;
  if (r.workflow === 'classic_tours') return `${amount} from wallet`;
  return amount;
}

function clRequestRow(r) {
  const stage = clStageOf(r);
  const updated = clLastUpdate(r);
  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}
      <div class="cl-kpi-sub">${escapeHtml(clLabel(r.request_type || r.travel_type || '—'))}</div></td>
    <td>${clJourneyCell(r)}</td>
    <td class="cl-nowrap"><span class="cl-tag cl-tag-plain${stage.tone ? ` cl-tag-${stage.tone}` : ''}">${escapeHtml(stage.name)}</span></td>
    <td>${clTag(r.status, r.status_label)}</td>
    <td class="cl-nowrap">${escapeHtml(stage.team)}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(updated.at))}
      <div class="cl-kpi-sub">${escapeHtml(updated.label)}</div></td>
    <td>${escapeHtml(stage.next)}
      <div class="cl-kpi-sub">waiting ${escapeHtml(clAgeText(updated.at))}</div></td>
    <td class="cl-actions">${clRequestActions(r)}</td>
  </tr>`;
}

/* Actions are driven by status, mirroring what the backend will actually
   accept — offering a button the API rejects is worse than not offering it. */
function clRequestActions(r) {
  const out = [`<button type="button" class="cl-btn cl-btn-sm" data-cl-view="${r.id}">View</button>`];
  if (r.status === 'draft') {
    /* Continue is BOOKINGS only, and only here. A draft's passengers can be
       edited right up to submit, and until this existed the only way back into
       one was Raise Booking on its enquiry — which a booking raised directly
       does not have, so "Save as draft" on that path had no way back at all.
       Other request types are raised from their own dialogs in one step and
       never sit in draft, so there is nothing for them to continue. */
    if (r.request_type === 'booking') {
      out.push(`<button type="button" class="cl-btn cl-btn-sm" data-cl-continue="${r.id}"
        ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Continue</button>`);
    }
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-submit="${r.id}"
      ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Submit</button>`);
  }
  if (r.status === 'payment_pending') {
    /* record_payment rejects amount <= 0 with a 400, so an unpriced row can only
       fail. Say so instead of offering a button that cannot work. */
    out.push(Number(r.total_amount) > 0
      ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-cl-pay="${r.id}"
         ${clActionAttrs('payment.pay', CL_NO_PAY)}>Pay</button>`
      : `<span class="cl-tag">Awaiting amount</span>`);
  }
  /* Cancel is for BOOKINGS. A service request is not the raiser's to take back:
     it belongs to their manager the moment it is raised, and they approve or
     reject it from the Service Requests screen. The backend refuses it too, so
     this is the UI half of one rule. */
  const isServiceRequest = MERCHANT_SERVICE_REQUEST_TYPES.includes(r.request_type);
  if (!isServiceRequest && ['draft', 'pending_approval', 'approved', 'payment_pending'].includes(r.status)) {
    out.push(`<button type="button" class="cl-btn cl-btn-sm cl-btn-danger" data-cl-cancel="${r.id}"
      ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Cancel</button>`);
  }
  return out.join('');
}

/* ------------------------------------------------------------------ detail */

/* Routes by request type rather than being replaced outright: a booking has a
   page of its own (itinerary, contact, timeline — too much for a dialog),
   while cancellations, refunds and ancillaries keep the modal that already
   served them well. Every caller keeps working, because the decision is made
   here rather than at each of the call sites. */
async function clOpenRequestDetail(id) {
  clOpenModal('Request details', `<div style="text-align:center;padding:30px 0;">
      <span class="cl-spin cl-spin-lg"></span></div>`, '');
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
    const stage = clStageOf(r);

    $('clModalTitle').textContent = `Request ${r.request_number || ''}`;
    $('clModalBody').innerHTML = `
      <dl class="cl-dl" style="margin-bottom:18px;">
        <div><dt>Status</dt><dd>${clTag(r.status, r.status_label)}</dd></div>
        <div><dt>Stage</dt><dd>${escapeHtml(stage.name)} · with ${escapeHtml(stage.team)}</dd></div>
        <div><dt>Item</dt><dd>${escapeHtml(r.title || '—')}</dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(clLabel(r.request_type || r.travel_type || '—'))}</dd></div>
        <div><dt>Total amount</dt><dd>${escapeHtml(moneyStr(r.total_amount))}</dd></div>
        <div><dt>Travel date</dt><dd>${escapeHtml(fmtDate(r.travel_date))}</dd></div>
        <div><dt>Raised</dt><dd>${escapeHtml(fmtDateTime(r.created_at))}</dd></div>
        ${r.pnr ? `<div><dt>PNR</dt><dd class="cl-ref">${escapeHtml(r.pnr)}</dd></div>` : ''}
        ${r.ticket_number ? `<div><dt>Ticket no.</dt><dd class="cl-ref">${escapeHtml(r.ticket_number)}</dd></div>` : ''}
      </dl>

      ${clDetailFacts(d)}

      <!-- ONE PASSENGER, ONE LINE. Every cell is nowrap and the wrapper
           scrolls horizontally, so a long name or a passport number can no
           longer push a traveller onto a second visual row — which made three
           passengers look like six at narrow widths. -->
      <h3 class="cl-form-legend">Passengers (${passengers.length})</h3>
      <div class="cl-table-wrap"><table class="cl-table">
        <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Passport</th><th>Seat</th><th>Meal</th></tr></thead>
        <tbody>${passengers.length ? passengers.map((p, i) => `<tr>
          <td>${i + 1}</td>
          <td class="cl-nowrap">${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' ') || '—')}</td>
          <td class="cl-nowrap">${escapeHtml(clLabel(p.passenger_type || 'adult'))}</td>
          <td class="cl-ref cl-nowrap">${escapeHtml(p.passport_number || '—')}</td>
          <td class="cl-nowrap">${escapeHtml(clLabel(p.seat_preference) || '—')}</td>
          <td class="cl-nowrap">${escapeHtml(clLabel(p.meal_preference) || '—')}</td>
        </tr>`).join('') : clEmptyRow(6, 'No passengers recorded.')}</tbody>
      </table></div>

      ${history.length ? `
        <h3 class="cl-form-legend">Activity</h3>
        <ul class="cl-timeline">${history.map((h, i) => `<li class="cl-timeline-item${i === history.length - 1 ? ' current' : ' done'}">
          <div class="cl-timeline-label">${escapeHtml(clLabel(h.status || h.to_status))}</div>
          <div class="cl-timeline-meta">${escapeHtml(fmtDateTime(h.at || h.changed_at || h.timestamp))}</div>
          ${h.remarks || h.note ? `<div class="cl-timeline-note">${escapeHtml(h.remarks || h.note)}</div>` : ''}
        </li>`).join('')}</ul>` : ''}`;

    const foot = [];
    if (r.status === 'draft') {
      foot.push(`<button type="button" class="cl-btn cl-btn-primary" data-cl-modal-submit="${r.id}"
        ${clActionAttrs('ticket.request', CL_NO_BOOKING)}>Submit for approval</button>`);
    }
    if (r.status === 'payment_pending' && Number(r.total_amount) > 0) {
      foot.push(`<button type="button" class="cl-btn cl-btn-primary" data-cl-modal-pay="${r.id}"
        ${clActionAttrs('payment.pay', CL_NO_PAY)}>Record payment</button>`);
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
    ['Airline', fmtAirline(d.airline)], ['Flight', d.flight_number],
    ['Origin', d.origin_city || d.origin], ['Destination', d.destination_city || d.destination],
    ['Departs', d.departure_time ? fmtDateTime(d.departure_time) : null],
    ['Arrives', d.arrival_time ? fmtDateTime(d.arrival_time) : null],
    ['Cabin', clLabel(d.cabin_class) || null], ['Hotel', d.hotel_name],
    ['Room', d.room_type], ['Nights', d.nights],
    ['Cruise', d.cruise_name], ['Cruise line', d.cruise_line],
    ['Package', d.package_name], ['Baggage', d.baggage_kg ? `${d.baggage_kg} kg` : null],
  ].filter(([, v]) => v != null && v !== '');
  if (!pairs.length) return '';
  return `<h3 class="cl-form-legend">Itinerary</h3>
    <dl class="cl-dl">${pairs.map(([k, v]) =>
      `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}</dl>`;
}

/* ----------------------------------------------------------------- actions */

async function clSubmitDraft(id) {
  if (!await clConfirm('Submit this draft for approval? You will not be able to edit the passengers afterwards.', 'Submit')) return;
  try {
    await MerchantApi.submitRequest(id);
    clInvalidate('dashboard', 'payments', 'reports', 'service-request', 'booking-history');
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
    <p style="margin:0 0 16px;font-size:13.5px;line-height:1.6;color:var(--cl-text-2);">
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
      clInvalidate('dashboard', 'payments', 'reports', 'service-request', 'booking-history');
      await clLoadRequests();
      clRefreshIfVisible('payments');
    } catch (err) {
      clMsg(msg, clError(err, 'Cancellation failed.'), 'err');
    }
  });
}
