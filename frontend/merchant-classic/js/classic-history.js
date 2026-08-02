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
   that is not ticketed or completed, which is why those buttons appear on those
   rows only. `/tickets` lists the airline's own files, attached by our desk. */

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
        <p>Every booking that has reached its end — ticketed, travelled, cancelled or closed.
           Anything still moving is on <a href="#" data-cl-to-requests>My Requests</a>.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clHistCsv">${clIco('download', { size: 15 })} CSV</button>
        <button type="button" class="cl-btn" id="clHistXlsx">${clIco('download', { size: 15 })} XLSX</button>
        <button type="button" class="cl-btn cl-btn-secondary" id="clHistPdf">${clIco('download', { size: 15 })} PDF</button>
      </div>
    </div>

    <div class="cl-kpis" id="clHistKpis"></div>

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
        <div class="cl-field" style="flex:1 1 230px;">
          <label for="clHistSearch">Search</label>
          <input type="search" id="clHistSearch"
                 placeholder="PNR, ticket no., reference, route or passenger">
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
          <li><b>Invoice</b> and <b>Confirmation</b> are generated fresh each time from the
              booking, its passengers and its payments — there is no stored file to fall out of
              step with the ledger.</li>
          <li><b>Ticket</b> opens the airline's own documents, attached by our desk.</li>
          <li>A <b>refunded</b> booking appears here as <b>Cancelled</b>. Refunds are settled on
              the cancellation that earned them — see Service Requests, and the credit on your
              wallet ledger.</li>
          <li>The export always describes the rows the filters above are showing.</li>
        </ul>
      </div>
    </div>`;

  $('cl-booking-history').querySelector('[data-cl-to-requests]').addEventListener('click', e => {
    e.preventDefault(); clGo('requests');
  });
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
      clRenderHistoryKpis({ [chosen]: clHistTotal }, chosen);
      return clRenderHistoryRows();
    }

    /* ALL CLOSED: one scoped call per outcome, merged. */
    const results = await Promise.allSettled(
      CL_HISTORY_STATUSES.map(status =>
        MerchantApi.listRequests({ ...base, status, page_size: CL_HIST_FETCH })));

    const rows = [];
    const byStatus = {};
    let total = 0;
    let capped = false;
    let failed = 0;
    results.forEach((res, i) => {
      if (res.status !== 'fulfilled') { failed += 1; return; }
      const items = res.value.items || [];
      const stageTotal = res.value.total ?? items.length;
      byStatus[CL_HISTORY_STATUSES[i]] = stageTotal;
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

    clRenderHistoryKpis(byStatus, chosen);
    clRenderHistoryRows(failed);
  } catch (err) {
    clHistRows = [];
    body.innerHTML = clEmptyRow(9, clError(err, 'Failed to load your booking history.'));
    $('clHistKpis').innerHTML = '';
    $('clHistCount').textContent = '—';
    $('clHistPrev').disabled = true;
    $('clHistNext').disabled = true;
    $('clHistNote').textContent = '';
  }
}

/* Four figures, each of them a server-side total for its own status under the
   current filters. Nothing here counts rows. */
function clRenderHistoryKpis(byStatus, chosen) {
  const tiles = CL_HISTORY_STATUSES.map(s => ({
    key: s,
    label: CL_HISTORY_LABELS[s],
    value: byStatus[s] ?? (chosen && chosen !== s ? '—' : 0),
    sub: chosen && chosen !== s ? 'not in this filter' : 'matching your filters',
    icon: s === 'ticket_issued' ? 'ticket' : s === 'completed' ? 'checkCircle' : 'x',
    tone: s === 'ticket_issued' ? 'ok' : s === 'completed' ? 'info' : 'err',
  }));

  $('clHistKpis').innerHTML = tiles.map(t => `
    <div class="cl-kpi">
      <div class="cl-kpi-head"><span class="cl-kpi-ico ${t.tone}">${clIco(t.icon)}</span></div>
      <div class="cl-kpi-label">${escapeHtml(t.label)}</div>
      <div class="cl-kpi-value">${escapeHtml(String(t.value))}</div>
      <div class="cl-kpi-sub">${escapeHtml(t.sub)}</div>
    </div>`).join('');
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
  body.querySelectorAll('[data-cl-hist-invoice]').forEach(b =>
    b.addEventListener('click', () => clHistDownload(b, 'invoice', b.dataset.clHistInvoice, b.dataset.clRef)));
  body.querySelectorAll('[data-cl-hist-confirm]').forEach(b =>
    b.addEventListener('click', () => clHistDownload(b, 'confirmation', b.dataset.clHistConfirm, b.dataset.clRef)));
  body.querySelectorAll('[data-cl-hist-ticket]').forEach(b =>
    b.addEventListener('click', () => clHistTickets(b.dataset.clHistTicket, b.dataset.clRef)));
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
    <td class="cl-nowrap">${escapeHtml(d.airline || '—')}
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
      <button type="button" class="cl-btn cl-btn-sm" data-cl-hist-view="${r.id}">View</button>
      ${ticketable ? `
        <button type="button" class="cl-btn cl-btn-sm" data-cl-hist-ticket="${r.id}"
          data-cl-ref="${escapeHtml(r.request_number || '')}">Ticket</button>
        <button type="button" class="cl-btn cl-btn-sm" data-cl-hist-invoice="${r.id}"
          data-cl-ref="${escapeHtml(r.request_number || '')}">Invoice</button>
        <button type="button" class="cl-btn cl-btn-sm" data-cl-hist-confirm="${r.id}"
          data-cl-ref="${escapeHtml(r.request_number || '')}">Confirmation</button>` : ''}
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

/* ------------------------------------------------------------- downloads */

/* One code path for both PDFs. The button reports its own progress rather than
   a page-level message: on a table of 25 rows a global "downloading…" tells you
   nothing about which row you pressed. */
async function clHistDownload(btn, kind, id, reference) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const blob = kind === 'invoice'
      ? await MerchantApi.downloadInvoice(id)
      : await MerchantApi.downloadConfirmation(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reference || 'booking'}-${kind}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Revoked on the next tick — revoking synchronously can cancel the download
       in some browsers before they have read the blob. */
    setTimeout(() => URL.revokeObjectURL(url), 0);
    clMsg($('clHistMsg'), `${clLabel(kind)} for ${reference} downloaded.`, 'ok');
  } catch (err) {
    clMsg($('clHistMsg'), clError(err, `Could not generate the ${kind}.`), 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = label;
  }
}

/* The airline's own files. A narrower list than every document on the booking:
   the merchant should only ever be offered the paperwork it is meant to have. */
async function clHistTickets(id, reference) {
  clOpenModal(`Ticket documents — ${reference}`,
    `<div style="text-align:center;padding:30px 0;"><span class="cl-spin cl-spin-lg"></span></div>`,
    '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
  try {
    const data = await MerchantApi.listTicketDocuments(id);
    const docs = data.items || data || [];
    $('clModalBody').innerHTML = docs.length
      ? `<ul class="cl-files">${docs.map(doc => `<li class="cl-file">
          <span class="cl-file-ico">${escapeHtml((doc.file_name || 'PDF').split('.').pop().slice(0, 4).toUpperCase())}</span>
          <span class="cl-file-meta">
            <b>${escapeHtml(doc.file_name || doc.doc_type || 'Document')}</b>
            <span>${escapeHtml(clLabel(doc.doc_type || ''))}${doc.uploaded_at ? ` · ${fmtDate(doc.uploaded_at)}` : ''}</span>
          </span>
          <button type="button" class="cl-btn cl-btn-sm" data-cl-doc="${doc.id ?? doc.document_id}">
            ${clIco('download', { size: 14 })} Download</button>
        </li>`).join('')}</ul>`
      : `<div class="cl-blank"><span class="cl-blank-ico">${clIco('file', { size: 26 })}</span>
          <b>No ticket documents yet</b>
          <p>Our desk attaches the airline's files once the ticket is issued. The Confirmation PDF
             above is always available and is generated from the booking itself.</p></div>`;

    $('clModalBody').querySelectorAll('[data-cl-doc]').forEach(b =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const url = await MerchantApi.downloadDocument(b.dataset.clDoc);
          window.open(url, '_blank', 'noopener');
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (err) {
          clOpenModal('Download failed',
            `<div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Could not download that file.'))}</div>`,
            '<button type="button" class="cl-btn" onclick="clCloseModal()">Close</button>');
        } finally {
          b.disabled = false;
        }
      }));
  } catch (err) {
    $('clModalBody').innerHTML = `<div class="cl-msg cl-msg-err" style="margin-top:0">${
      escapeHtml(clError(err, 'Could not load the ticket documents.'))}</div>`;
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
