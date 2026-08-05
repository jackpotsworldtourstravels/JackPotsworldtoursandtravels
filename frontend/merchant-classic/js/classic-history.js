'use strict';
/* Merchant Portal — Booking History.
   ===========================================================================
   Everything that has stopped moving: ticketed, completed, cancelled, and the
   ones we could not confirm. My Requests is the worklist; this is the archive,
   and the split is what lets each be good at one job. A worklist should be
   short enough to read top to bottom; an archive should be searchable, filtered
   and exportable, and it is fine for it to hold thousands of rows.

   WHAT COUNTS AS HISTORY
   `ticket_issued`, `completed`, `cancelled` and `rejected` — the four terminal
   members of request_status_enum. The brief also asked for "Refunded" and
   "Expired": neither is a status this system has. A refund is not a state a
   booking reaches, it is the settlement of a CANCELLATION — so a refunded
   booking is here under Cancelled, and the money it earned back is on its
   cancellation, on Service Requests and in the wallet ledger. Inventing two
   tabs that could never fill would have been worse than saying so, which the
   footer of this screen does.

   FETCHING — the same shape as My Requests, and for the same reason.
   `GET /api/requests` takes one status, so "All closed" fires one scoped call
   per terminal status in parallel and merges them; the count is the sum of the
   servers' own totals. Search, travel-date range and type are passed to the
   server on every one of those calls. Choosing a single status collapses to one
   call and pages properly, which is the route to take on a large account — and
   the footer says so when the merge is capped.

   DOWNLOADS ARE REAL AND ARE GATED SERVER-SIDE.
   `GET /api/requests/{id}/invoice` and `/confirmation` generate a PDF on demand
   from the booking, its passengers and its payments — nothing is stored, so a
   refund recorded a minute ago is already in the invoice. Both 409 on a booking
   that is not ticketed or completed, which is what the row's `generated` flag
   mirrors. `/tickets` lists the airline's own files, attached by our desk.

   Every one of them is reached through a single **View Documents** dialog —
   see the document tray at the foot of this file. */

const CL_HISTORY_STATUSES = ['ticket_issued', 'completed', 'cancelled', 'rejected'];

const CL_HISTORY_LABELS = {
  ticket_issued: 'Ticketed',
  completed: 'Travel completed',
  cancelled: 'Cancelled',
  rejected: 'Not confirmed',
};

const CL_HIST_PAGE_SIZE = 25;
const CL_HIST_FETCH = 100;

let clHistRows = [];
let clHistPage = 1;
let clHistTotal = 0;
let clHistCapped = false;
let clHistSearchTimer = null;
/* True when ONE outcome is selected, which is the case the API can page
   natively. See the same flag on My Requests. */
let clHistServerPaged = false;

function clInitHistory() {
  $('cl-booking-history').innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Booking History</h1>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clHistCsv"
          ${clActionAttrs('report.export', CL_NO_EXPORT)}>${clIco('download', { size: 15 })} CSV</button>
        <button type="button" class="cl-btn" id="clHistXlsx"
          ${clActionAttrs('report.export', CL_NO_EXPORT)}>${clIco('download', { size: 15 })} XLSX</button>
        <button type="button" class="cl-btn cl-btn-secondary" id="clHistPdf"
          ${clActionAttrs('report.export', CL_NO_EXPORT)}>${clIco('download', { size: 15 })} PDF</button>
      </div>
    </div>

    <!-- The four summary tiles (Ticketed / Travel completed / Cancelled / Not
         confirmed) are gone. They were four counts of the same four buckets the
         Outcome dropdown below already selects between, sitting above a table
         that shows those rows — so the screen answered the same question three
         times. The dropdown is now the single way to narrow by outcome. -->

    <div class="cl-panel">
      <div class="cl-toolbar">
        <div class="cl-field">
          <label for="clHistStatus">Outcome</label>
          <select id="clHistStatus" data-cl-status-filter>
            <option value="">All closed bookings</option>
            ${CL_HISTORY_STATUSES.map(s =>
              `<option value="${s}" data-cl-chip-tone="${CL_STATUS_TONE[s] || ''}">${CL_HISTORY_LABELS[s]}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <label for="clHistType">Type</label>
          <select id="clHistType">
            <option value="booking">Bookings</option>
            <option value="">Everything</option>
            ${MERCHANT_SERVICE_REQUEST_TYPES.map(t =>
              `<option value="${t}">${clLabel(t)}</option>`).join('')}
          </select>
        </div>
        <div class="cl-field">
          <label for="clHistFrom">Travel date from</label>
          <input type="date" id="clHistFrom">
        </div>
        <div class="cl-field">
          <label for="clHistTo">Travel date to</label>
          <input type="date" id="clHistTo">
        </div>
        <!-- One box, both keys. ticket_service.list_requests matches the term
             against the PNR AND against every passenger's first/last name via a
             subquery, so a passenger name finds the booking and the PNR column
             beside it answers "which PNR was that on".
             (No backticks in this comment: it sits inside a template literal,
             and one would close the string.) -->
        <div class="cl-field" style="flex:1 1 230px;">
          <label for="clHistSearch">Search by passenger name or PNR</label>
          <input type="search" id="clHistSearch"
                 placeholder="Passenger name, PNR, ticket no. or reference">
        </div>
        <div class="cl-toolbar-actions">
          <button type="button" class="cl-btn" id="clHistReset">Reset</button>
          <button type="button" class="cl-btn cl-btn-secondary" id="clHistApply">
            ${clIco('filter', { size: 14 })} Apply filters
          </button>
        </div>
      </div>

      <div class="cl-panel-body cl-flush">
        <div class="cl-table-wrap">
          <table class="cl-table">
            <thead><tr>
              <th>Reference</th><th>Journey</th><th>Airline</th><th>PNR</th>
              <th>Passengers</th><th>Travel date</th><th class="cl-num">Payment</th>
              <th>Outcome</th><th class="cl-actions">Documents</th>
            </tr></thead>
            <tbody id="clHistBody"></tbody>
          </table>
        </div>
      </div>
      <div class="cl-pager">
        <span class="cl-pager-info" id="clHistCount">—</span>
        <span class="cl-pager-actions">
          <button type="button" class="cl-btn cl-btn-sm" id="clHistPrev">Previous</button>
          <button type="button" class="cl-btn cl-btn-sm" id="clHistNext">Next</button>
        </span>
      </div>
      <div class="cl-panel-note" id="clHistNote"></div>
    </div>

    <div class="cl-msg" id="clHistMsg"></div>

    <div class="cl-panel">
      <div class="cl-panel-head"><h2>${clIco('info')}About this archive</h2></div>
      <div class="cl-panel-body">
        <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.8;color:var(--cl-text-2);">
          <li><b>View Documents</b> on any row opens everything that booking can produce —
              e-ticket, invoice and confirmation — each with a <b>View</b> and a
              <b>Download</b>. Anything not yet available is listed and marked, rather than
              left out.</li>
          <li><b>Invoice</b> and <b>Confirmation</b> are generated fresh each time from the
              booking, its passengers and its payments — there is no stored file to fall out of
              step with the ledger. Both become available once the booking is ticketed.</li>
          <li>The <b>e-ticket</b> is the airline's own document, attached by our desk.</li>
          <li>A <b>refunded</b> booking appears here as <b>Cancelled</b>. Refunds are settled on
              the cancellation that earned them — see Service Requests, and the credit on your
              wallet ledger.</li>
          <li>The export always describes the rows the filters above are showing.</li>
        </ul>
      </div>
    </div>`;

  /* The "anything still moving is on My Requests" line that used to carry a
     link to that screen went with the page descriptions; the rail is the way
     across, and it always was. */
  clChips('clHistStatus', 'Outcome');

  $('clHistApply').addEventListener('click', () => clLoadHistory({ resetPage: true }));
  $('clHistReset').addEventListener('click', () => {
    ['clHistStatus', 'clHistFrom', 'clHistTo', 'clHistSearch'].forEach(id => { $(id).value = ''; });
    $('clHistType').value = 'booking';
    clSyncChips('clHistStatus');
    clLoadHistory({ resetPage: true });
  });
  ['clHistStatus', 'clHistType', 'clHistFrom', 'clHistTo'].forEach(id =>
    $(id).addEventListener('change', () => clLoadHistory({ resetPage: true })));
  $('clHistSearch').addEventListener('input', () => {
    clearTimeout(clHistSearchTimer);
    clHistSearchTimer = setTimeout(() => clLoadHistory({ resetPage: true }), 350);
  });
  $('clHistPrev').addEventListener('click', () => clStepHistPage(-1));
  $('clHistNext').addEventListener('click', () => clStepHistPage(1));
  ['csv', 'xlsx', 'pdf'].forEach(fmt =>
    $(`clHist${fmt[0].toUpperCase()}${fmt.slice(1)}`).addEventListener('click', () => clExportHistory(fmt)));

  return clLoadHistory();
}

/* One outcome is paged by the server, so turning the page is a fetch. "All
   closed" is a merged window this file already holds, so it is a re-render. */
function clStepHistPage(delta) {
  const next = clHistPage + delta;
  if (next < 1) return;
  if (clHistServerPaged) {
    if (delta > 0 && (clHistPage * CL_HIST_PAGE_SIZE) >= clHistTotal) return;
    clHistPage = next;
    clLoadHistory();
    return;
  }
  if (delta > 0 && clHistPage * CL_HIST_PAGE_SIZE >= clHistRows.length) return;
  clHistPage = next;
  clRenderHistoryRows();
}

/* --------------------------------------------------------------- loading */

function clHistoryParams() {
  const params = {};
  const type = $('clHistType').value;
  const search = $('clHistSearch').value.trim();
  if (type) params.request_type = type;
  if (search) params.search = search;
  if ($('clHistFrom').value) params.date_from = $('clHistFrom').value;
  if ($('clHistTo').value) params.date_to = $('clHistTo').value;
  return params;
}

async function clLoadHistory({ resetPage = false } = {}) {
  if (resetPage) clHistPage = 1;
  const body = $('clHistBody');
  body.innerHTML = clLoadingRow(9, 'Loading your booking history…');
  clMsg($('clHistMsg'), '');

  const base = clHistoryParams();
  const chosen = $('clHistStatus').value;
  clHistServerPaged = !!chosen;

  try {
    /* ONE OUTCOME: the API expresses this filter exactly, so it pages natively
       and every row is reachable however many there are. */
    if (chosen) {
      const data = await MerchantApi.listRequests({
        ...base, status: chosen, page: clHistPage, page_size: CL_HIST_PAGE_SIZE,
      });
      clHistRows = data.items || [];
      clHistTotal = data.total ?? clHistRows.length;
      clHistCapped = false;
      if (!clHistRows.length && clHistPage > 1 && clHistTotal > 0) {
        clHistPage = Math.max(1, Math.ceil(clHistTotal / CL_HIST_PAGE_SIZE));
        return clLoadHistory();
      }
      return clRenderHistoryRows();
    }

    /* ALL CLOSED: one scoped call per outcome, merged. */
    const results = await Promise.allSettled(
      CL_HISTORY_STATUSES.map(status =>
        MerchantApi.listRequests({ ...base, status, page_size: CL_HIST_FETCH })));

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

    if (failed === CL_HISTORY_STATUSES.length) throw results[0].reason;

    /* Most recent travel first — this is an archive, and "when did we fly" is
       how a person looks a booking up. Rows with no travel date fall to the
       end rather than sorting as 1970. */
    rows.sort((a, b) => {
      const at = a.travel_date ? new Date(a.travel_date) : null;
      const bt = b.travel_date ? new Date(b.travel_date) : null;
      if (at && bt) return bt - at;
      if (at) return -1;
      if (bt) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    clHistRows = rows;
    clHistTotal = total;
    clHistCapped = capped;

    const maxPage = Math.max(1, Math.ceil(rows.length / CL_HIST_PAGE_SIZE));
    if (clHistPage > maxPage) clHistPage = maxPage;

    clRenderHistoryRows(failed);
  } catch (err) {
    clHistRows = [];
    body.innerHTML = clEmptyRow(9, clError(err, 'Failed to load your booking history.'));
    $('clHistCount').textContent = '—';
    $('clHistPrev').disabled = true;
    $('clHistNext').disabled = true;
    $('clHistNote').textContent = '';
  }
}

function clRenderHistoryRows(failedStages = 0) {
  const body = $('clHistBody');
  const all = clHistRows;
  const start = (clHistPage - 1) * CL_HIST_PAGE_SIZE;
  /* Server-paged: `clHistRows` IS the page. Merged: it is the whole window. */
  const rows = clHistServerPaged ? all : all.slice(start, start + CL_HIST_PAGE_SIZE);
  const filtered = !!($('clHistSearch').value.trim() || $('clHistStatus').value
    || $('clHistFrom').value || $('clHistTo').value);

  body.innerHTML = rows.length
    ? rows.map(clHistoryRow).join('')
    : clEmptyRow(9,
      filtered ? 'Nothing matches those filters.' : 'No closed bookings yet',
      filtered
        ? ' Try widening the travel-date range or clearing the outcome.'
        : ' Bookings arrive here once they are ticketed, travelled or closed.');

  /* What the pager can REACH, then what matches. See the same note on My
     Requests: a footer that quotes the full total while Next stops short is a
     promise the control cannot keep. */
  const first = rows.length ? start + 1 : 0;
  const last = start + rows.length;
  $('clHistCount').textContent = !rows.length
    ? '0 bookings'
    : clHistServerPaged || all.length >= clHistTotal
      ? `${first}–${last} of ${clHistTotal} booking${clHistTotal === 1 ? '' : 's'}`
      : `${first}–${last} of ${all.length} most recent · ${clHistTotal} closed in total`;
  $('clHistPrev').disabled = clHistPage <= 1;
  $('clHistNext').disabled = clHistServerPaged
    ? clHistPage * CL_HIST_PAGE_SIZE >= clHistTotal
    : start + CL_HIST_PAGE_SIZE >= all.length;

  const notes = [];
  if (clHistCapped) {
    notes.push(`This account has more than ${CL_HIST_FETCH} bookings under a single outcome, so this list holds the ${CL_HIST_FETCH} most recent of each. Choose one outcome above and it pages through every row in it — and narrowing the travel dates works on both. The export is not limited this way.`);
  }
  if (failedStages) {
    notes.push(`${failedStages} outcome${failedStages === 1 ? '' : 's'} could not be loaded, so this list may be incomplete.`);
  }
  $('clHistNote').textContent = notes.join(' ');

  body.querySelectorAll('[data-cl-hist-view]').forEach(b =>
    b.addEventListener('click', () => clOpenRequestDetail(b.dataset.clHistView)));
  body.querySelectorAll('[data-cl-hist-docs]').forEach(b =>
    b.addEventListener('click', () => clHistDocuments(
      b.dataset.clHistDocs, b.dataset.clRef,
      b.dataset.clGenerated === '1', b.dataset.clOutcome)));
}

function clHistoryRow(r) {
  const d = r.travel_details || r.details || {};
  const from = d.origin_city || d.origin;
  const to = d.destination_city || d.destination;
  const route = from && to
    ? `${escapeHtml(from)} <span style="color:var(--cl-text-muted)">→</span> ${escapeHtml(to)}`
    : escapeHtml(r.title || '—');
  const pax = r.passengers || [];
  const lead = pax.length
    ? [pax[0].title, pax[0].first_name, pax[0].last_name].filter(Boolean).join(' ')
    : '';
  const ticketable = ['ticket_issued', 'completed'].includes(r.status);

  return `<tr>
    <td class="cl-ref">${escapeHtml(r.request_number || '—')}
      ${r.booking_reference ? `<div class="cl-kpi-sub">${escapeHtml(r.booking_reference)}</div>` : ''}</td>
    <td><b>${route}</b>
      <div class="cl-kpi-sub">${escapeHtml(clLabel(r.request_type || r.travel_type || '—'))}</div></td>
    <td class="cl-nowrap">${escapeHtml(fmtAirline(d.airline))}
      ${d.flight_number ? `<div class="cl-kpi-sub">${escapeHtml(d.flight_number)}</div>` : ''}</td>
    <td class="cl-ref">${escapeHtml(r.pnr || '—')}
      ${r.ticket_number ? `<div class="cl-kpi-sub">${escapeHtml(r.ticket_number)}</div>` : ''}</td>
    <td>${pax.length ? `${pax.length}` : '—'}
      ${lead ? `<div class="cl-kpi-sub">${escapeHtml(lead)}${pax.length > 1 ? ` +${pax.length - 1}` : ''}</div>` : ''}</td>
    <td class="cl-nowrap">${escapeHtml(fmtDate(r.travel_date))}
      ${r.return_date ? `<div class="cl-kpi-sub">rtn ${escapeHtml(fmtDate(r.return_date))}</div>` : ''}</td>
    <td class="cl-num">${escapeHtml(moneyStr(r.total_amount))}
      <div class="cl-kpi-sub">${escapeHtml(clHistPaymentNote(r))}</div></td>
    <td>${clTag(r.status, CL_HISTORY_LABELS[r.status] || r.status_label)}</td>
    <td class="cl-actions">
      <button type="button" class="cl-btn cl-btn-sm cl-btn-quiet" data-cl-hist-view="${r.id}">View Booking</button>
      <button type="button" class="cl-btn cl-btn-sm" data-cl-hist-docs="${r.id}"
        data-cl-ref="${escapeHtml(r.request_number || '')}"
        data-cl-generated="${ticketable ? '1' : ''}"
        data-cl-outcome="${escapeHtml(r.status || '')}"
        >${clIco('file', { size: 14 })}View Documents</button>
    </td>
  </tr>`;
}

/* How the booking was settled, in the words that apply to its track. On the
   classic (enquiry-led) track there is no payment step in this portal at all —
   the fare is charged to the wallet when the ticket is issued (CR-2/CR-4). */
function clHistPaymentNote(r) {
  if (!moneyIsPositive(r.total_amount)) return 'no amount recorded';
  if (r.status === 'cancelled') return 'see the cancellation';
  if (r.workflow === 'classic_tours') return 'charged to wallet';
  return 'settled';
}

/* ------------------------------------------------------------- documents */

/* THE DOCUMENT TRAY.
   ===========================================================================
   One button on the row — View Documents — opening one dialog that holds every
   paper this booking can produce. It replaced three separate row buttons
   (Ticket / Invoice / Confirmation) which put nine controls in a 25-row table
   and still could not say whether any of them would work: the ticket buttons
   appeared on every ticketed booking whether or not our desk had attached a
   file, so a merchant found out by pressing one and reading an empty list.

   NOTHING ABOUT THE DOWNLOADS CHANGED. Invoice and Confirmation are the same
   two calls as before — generated on demand from the booking, its passengers
   and its payments, so a refund recorded a minute ago is already in them — and
   both 409 on a booking that is not ticketed or completed, which is exactly the
   `generated` flag the row passes in. The ticket files are still
   `GET /api/requests/{id}/tickets`. What is new is presentation: the two verbs
   a merchant actually wants are now BOTH offered, and an unavailable document
   says so instead of being silently missing.

   VIEW AND DOWNLOAD ARE THE SAME BYTES. Every one of these is fetched with the
   bearer token and handed to the browser as an object URL — a plain href cannot
   authenticate. The only difference between the two verbs is whether the
   anchor carries `download`.

   AVAILABILITY IS RESOLVED IN TWO SPEEDS. Invoice and Confirmation are known
   from the row's status before the dialog opens. The ticket is not knowable
   without asking, so its row opens in a checking state and settles when
   /tickets answers — the dialog is useful immediately either way. */

const CL_DOC_KINDS = [
  {
    key: 'ticket', label: 'E-ticket', icon: 'ticket',
    note: 'The airline’s own document, attached by our desk once the ticket is issued.',
    /* Not "this booking is not ticketed": the desk may simply not have
       attached the airline's file yet on a booking that IS ticketed. */
    absent: 'Our desk has not attached the airline’s file to this booking yet.',
  },
  {
    key: 'invoice', label: 'Invoice', icon: 'receipt',
    note: 'Generated fresh from this booking, its passengers and its payments.',
    absent: 'Available once the booking has been ticketed.',
  },
  {
    key: 'confirmation', label: 'Booking confirmation', icon: 'file',
    note: 'The itinerary and travellers exactly as we hold them.',
    absent: 'Available once the booking has been ticketed.',
  },
];

/* One row of the tray. `inner` is whatever sits on the right — the pair of
   verbs, the Not Available badge, or a spinner while we find out. */
function clDocRow(kind, inner, { off = false, note = null, sub = '' } = {}) {
  return `<li class="cl-doc${off ? ' cl-doc-off' : ''}" data-cl-doc-row="${kind.key}">
    <span class="cl-doc-ico">${clIco(kind.icon, { size: 20 })}</span>
    <span class="cl-doc-meta">
      <b>${escapeHtml(kind.label)}</b>
      <span>${escapeHtml(note ?? kind.note)}</span>
    </span>
    ${inner}
    ${sub}
  </li>`;
}

/* The two verbs. `docId` names a specific ticket file — Invoice and
   Confirmation are generated and have neither an id nor a server-side name, so
   those two fall back to `<reference>-<kind>.pdf` at save time. */
function clDocVerbs(kindKey, docId = '', fileName = '') {
  const attrs = `data-cl-doc-kind="${kindKey}" data-cl-doc-id="${escapeHtml(String(docId))}"`
    + ` data-cl-doc-name="${escapeHtml(fileName)}"`;
  return `<span class="cl-doc-actions">
    <button type="button" class="cl-btn cl-btn-sm" data-cl-doc-act="view" ${attrs}
      >${clIco('eye', { size: 14 })}View</button>
    <button type="button" class="cl-btn cl-btn-sm" data-cl-doc-act="download" ${attrs}
      >${clIco('download', { size: 14 })}Download</button>
  </span>`;
}

const clDocNa = () =>
  `<span class="cl-doc-na">${clIco('x', { size: 13 })}Not Available</span>`;

const clDocChecking = () =>
  `<span class="cl-doc-na"><span class="cl-spin"></span>Checking…</span>`;

async function clHistDocuments(id, reference, generated, outcome) {
  const kinds = Object.fromEntries(CL_DOC_KINDS.map(k => [k.key, k]));

  /* "Available once the booking has been ticketed" is true of a booking that
     still might be, and a lie to one that never will. A cancelled or refused
     booking is told the ending it actually reached. */
  const closed = outcome === 'cancelled' || outcome === 'rejected';
  const absent = closed
    ? `Not generated for a booking that ${outcome === 'cancelled' ? 'was cancelled' : 'was not confirmed'}.`
    : null;

  clOpenModal(`Documents — ${reference || 'booking'}`, `
    <p class="cl-muted" style="margin:0 0 14px;font-size:12.5px;line-height:1.6;">
      Everything this booking can produce. <b>View</b> opens the PDF in a new tab;
      <b>Download</b> saves it.
    </p>
    <ul class="cl-docs" id="clDocList">
      ${clDocRow(kinds.ticket, clDocChecking())}
      ${generated
        ? clDocRow(kinds.invoice, clDocVerbs('invoice'))
        : clDocRow(kinds.invoice, clDocNa(), { off: true, note: absent ?? kinds.invoice.absent })}
      ${generated
        ? clDocRow(kinds.confirmation, clDocVerbs('confirmation'))
        : clDocRow(kinds.confirmation, clDocNa(), { off: true, note: absent ?? kinds.confirmation.absent })}
    </ul>
    <div class="cl-msg" id="clDocMsg"></div>`,
    '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');

  clDocBind(id, reference);

  /* The ticket row, once we know. Guarded on the dialog still being open: a
     merchant who closed it before /tickets answered must not have a stale row
     written into whatever dialog is there now. */
  let ticketRowHtml;
  try {
    const data = await MerchantApi.listTicketDocuments(id);
    const docs = (data.items || data || []).filter(Boolean);
    ticketRowHtml = !docs.length
      ? clDocRow(kinds.ticket, clDocNa(), { off: true, note: kinds.ticket.absent })
      : docs.length === 1
        ? clDocRow(kinds.ticket,
          clDocVerbs('ticket', docs[0].id ?? docs[0].document_id, clDocFileName(docs[0])), {
            note: clDocFileNote(docs[0], kinds.ticket),
          })
        /* More than one file: the verbs cannot mean "the ticket" any more, so
           they move down on to each file and the row above just counts them. */
        : clDocRow(kinds.ticket, '', {
          note: `${docs.length} files attached by our desk.`,
          sub: `<ul class="cl-doc-sub">${docs.map(doc => {
            const name = clDocFileName(doc) || clLabel(doc.doc_type || 'Document');
            return `<li>
              <span class="cl-doc-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
              ${clDocVerbs('ticket', doc.id ?? doc.document_id, clDocFileName(doc))}
            </li>`;
          }).join('')}</ul>`,
        });
  } catch (err) {
    ticketRowHtml = clDocRow(kinds.ticket, clDocNa(), {
      off: true, note: clError(err, 'The ticket documents could not be listed.'),
    });
  }

  const row = $('clDocList')?.querySelector('[data-cl-doc-row="ticket"]');
  if (!row) return;                              /* dialog closed, or replaced */
  row.outerHTML = ticketRowHtml;
  clDocBind(id, reference);
}

/* THE FIELD IS `original_filename`, NOT `file_name`.
   ===========================================================================
   `GET /api/requests/{id}/tickets` returns a bare ARRAY (no `Page` envelope) of
   documents shaped `{id, doc_type, original_filename, created_at, size_bytes,
   content_type, …}`. The screen this replaced read `file_name` and
   `uploaded_at`, neither of which exists on that payload — so every attachment
   rendered as the bare word "Ticket" with no date. Both spellings are accepted
   here because `listDocuments` is a different endpoint and this helper is one
   rename away from being pointed at it. */
function clDocFileName(doc) {
  return doc.original_filename || doc.file_name || '';
}

/* The desk's own filename, when it told us one, plus how big it is and when it
   landed. Falls back to the kind's standing description rather than to a
   restatement of the row's own title. */
function clDocFileNote(doc, kind) {
  const name = clDocFileName(doc);
  if (!name) return kind.note;
  const when = doc.created_at || doc.uploaded_at;
  return [name, clDocSize(doc.size_bytes), when ? `attached ${fmtDate(when)}` : null]
    .filter(Boolean).join(' · ');
}

function clDocSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* Re-bound after the ticket row settles. Cheap and idempotent — the handler is
   attached per element and every element it finds is freshly rendered. */
function clDocBind(id, reference) {
  $('clDocList')?.querySelectorAll('[data-cl-doc-act]').forEach(b => {
    if (b.dataset.clDocBound) return;
    b.dataset.clDocBound = '1';
    b.addEventListener('click', () => clDocFetch(b, {
      id, reference,
      kind: b.dataset.clDocKind,
      docId: b.dataset.clDocId,
      fileName: b.dataset.clDocName,
      mode: b.dataset.clDocAct,
    }));
  });
}

/* Hand the bytes to the browser. Returns false only when a pop-up blocker ate
   the new tab, which is the one failure that leaves no trace on screen. */
function clDocPresent(url, filename, mode) {
  if (mode === 'download') {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }
  return !!window.open(url, '_blank', 'noopener');
}

/* One code path for all three kinds and both verbs. The button reports its own
   progress: on a tray of three rows a dialog-level "working…" does not say
   which one you pressed. */
async function clDocFetch(btn, { id, reference, kind, docId, fileName, mode }) {
  const msg = $('clDocMsg');
  btn.disabled = true;
  btn.classList.add('loading');
  clMsg(msg, '');
  try {
    /* downloadDocument hands back an object URL (the server names the file);
       the two generated PDFs hand back a Blob and we name them. */
    const url = kind === 'ticket'
      ? await MerchantApi.downloadDocument(docId)
      : URL.createObjectURL(kind === 'invoice'
        ? await MerchantApi.downloadInvoice(id)
        : await MerchantApi.downloadConfirmation(id));

    /* The desk's own filename when there is one, so a saved e-ticket keeps the
       name the airline gave it; the generated pair are named after the row. */
    const ok = clDocPresent(url, fileName || `${reference || 'booking'}-${kind}.pdf`, mode);

    /* Revoked late, not on the next tick: a tab opened on this URL is still
       reading from it, and revoking underneath a PDF viewer blanks it. The
       download path is finished with it immediately but shares the timer —
       one minute of a held blob is not worth a second code path. */
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    clMsg(msg, ok
      ? (mode === 'download'
        ? `${clLabel(kind)} for ${reference} downloaded.`
        : `${clLabel(kind)} opened in a new tab.`)
      : 'Your browser blocked the new tab. Use Download instead, or allow pop-ups for this site.',
      ok ? 'ok' : 'warn');
  } catch (err) {
    clMsg(msg, clError(err, `Could not fetch the ${kind}.`), 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

/* The export runs the SAME filters the table is showing, through
   /api/reports/export, which builds its rows server-side. It is not limited by
   the per-status fetch ceiling above — that is a display cap, this is a query. */
async function clExportHistory(format) {
  const msg = $('clHistMsg');
  clMsg(msg, `Preparing the ${format.toUpperCase()} export…`, 'muted');
  try {
    const params = { type: 'bookings', format, ...clHistoryParams() };
    /* `request_type` is the table's own filter name; the export takes a status
       and the same date range. A single chosen outcome is passed through; "all
       closed" cannot be expressed as one status, so the export then covers the
       full range and the message says so. */
    delete params.request_type;
    const chosen = $('clHistStatus').value;
    if (chosen) params.status = chosen;

    const blob = await MerchantApi.exportReport(params);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `booking-history-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clMsg(msg, chosen
      ? `${format.toUpperCase()} export downloaded — ${CL_HISTORY_LABELS[chosen]} bookings only.`
      : `${format.toUpperCase()} export downloaded. It covers every booking in the date range, not only the closed ones — pick an outcome above to narrow it.`,
      'ok');
  } catch (err) {
    clMsg(msg, clError(err, 'Failed to export.'), 'err');
  }
}
