'use strict';
/* Operations Portal — Bookings, Requests, Approvals, and the Request Ticket form.
   ===========================================================================
   Everything in this file works on ONE table. In this schema a booking, a
   service request, an enquiry and a live-chat thread are all rows in
   service_requests, discriminated by `request_type`; there is no separate
   bookings endpoint. So Bookings, Requests and each travel type's bookings tab
   are the same grid with a different fixed filter, built by one factory — which
   is what keeps the columns, the detail drawer and the lifecycle actions from
   drifting apart between five entry points.

   THE LIFECYCLE IS THE SERVER'S, NOT THIS SCREEN'S
   GET /api/requests/{id} returns `actions`: the transitions THIS actor may
   walk from THIS status, computed by lifecycle.allowed_transitions. The drawer
   renders buttons from that list rather than deciding for itself what a
   pending request can do. Two targets in that list have no endpoint of their
   own (in_review and payment_pending — approve_request walks both internally),
   and one is keyed by payment id rather than request id (paid, via payment
   verification), so OPS_TRANSITION_ENDPOINT in ops-api.js maps the list onto
   real routes and the drawer skips what cannot be called.
   =========================================================================== */

/* ===========================================================================
   THE SHARED REQUEST GRID
   =========================================================================== */

function opsRequestColumns(opts) {
  const cols = [
    OpsCol.ref('request_number', 'Request'),
    { key: 'title', label: 'Description', value: r => r.title },
  ];
  if (opsIsStaff()) cols.push({ key: 'merchant_name', label: 'Merchant', value: r => r.merchant_name });
  if (opts.showTypeColumn !== false) cols.push(OpsCol.enumLabel('request_type', 'Type'));
  if (opts.showTravelColumn !== false) cols.push(OpsCol.enumLabel('travel_type', 'Travel'));
  cols.push(
    { key: 'sector', label: 'Sector', value: r => opsSector(r) },
    { key: 'passengers', label: 'Passenger(s)', value: r => opsPassengerNames(r) },
    { key: 'pax_count', label: 'Pax', align: 'right', value: r => (r.passengers || []).length, hidden: true },
    OpsCol.ref('pnr', 'PNR'),
    { key: 'ticket_number', label: 'Ticket no.', value: r => r.ticket_number, hidden: true },
    { key: 'booking_reference', label: 'Booking ref.', value: r => r.booking_reference, hidden: true },
    { key: 'raised_by', label: 'Raised by', value: r => r.raised_by, hidden: true },
    OpsCol.date('travel_date', 'Travel date'),
    OpsCol.date('return_date', 'Return'),
    OpsCol.money('total_amount', 'Amount'),
    OpsCol.status(),
    OpsCol.dateTime('created_at', 'Created'),
    OpsCol.actions([
      { act: 'open', label: 'Open', primary: true },
    ]),
  );
  /* Return date is only ever populated on a round trip; hide it by default so
     it does not eat width on a table of one-ways. */
  const ret = cols.find(c => c.key === 'return_date');
  if (ret) ret.hidden = true;
  return cols;
}

/* opts: {id, title, exportName, fixed:{...}, statusOptions, showTypeColumn,
          showTravelColumn, bulk:boolean, note} */
function opsBuildRequestGrid(host, opts) {
  const fixed = opts.fixed || {};

  const filters = [];
  if (!fixed.status) {
    filters.push({
      key: 'status', label: 'Status', type: 'select', anyLabel: 'Any status',
      options: (opts.statusOptions || OPS_REQUEST_STATUSES).map(s => ({ value: s, label: opsStatusLabel(s) })),
    });
  }
  if (!fixed.request_type) {
    filters.push({
      key: 'request_type', label: 'Type', type: 'select', anyLabel: 'Any type',
      options: OPS_REQUEST_TYPES.map(t => ({ value: t, label: opsLabel(t) })),
    });
  }
  if (!fixed.travel_type) {
    filters.push({
      key: 'travel_type', label: 'Travel', type: 'select', anyLabel: 'Any',
      options: OPS_TRAVEL_TYPES.map(t => ({ value: t, label: opsLabel(t) })),
    });
  }
  /* merchant_id is ignored server-side unless the caller is platform staff
     (ticket_service.list_requests), so a merchant is not offered it. */
  if (opsIsStaff()) {
    filters.push({ key: 'merchant_id', label: 'Merchant ID', type: 'number', placeholder: 'any' });
  }
  /* Labelled TRAVEL date because that is the column the API filters — see the
     note under the grid. This is the single most misleading pair of parameters
     in the whole API and the label is the fix. */
  filters.push(
    { key: 'date_from', label: 'Travel from', type: 'date' },
    { key: 'date_to', label: 'Travel to', type: 'date' },
  );

  const bulk = [];
  if (opts.bulk !== false) {
    if (opsCan('ticket.approve')) {
      bulk.push({
        label: 'Approve selected',
        run: async (rows, api) => opsBulkLifecycle(rows, api, {
          verb: 'Approve',
          /* A bulk approve sends no amount, and the API refuses to approve a
             booking at 0 — it would land in Payment Pending unpayable. An
             unpriced booking therefore needs the one-at-a-time dialog that asks
             for the fare, so it is skipped here with a reason rather than
             attempted and reported as a failure. Service requests carry no
             amount of their own and are unaffected. */
          filter: r => ['pending_approval', 'in_review'].includes(r.status)
            && (OPS_SERVICE_REQUEST_TYPES.includes(r.request_type) || Number(r.total_amount) > 0),
          skipNote: 'only Pending or Under Review requests can be approved, and a booking with '
            + 'no amount must be approved on its own so the fare can be entered',
          act: r => (OPS_SERVICE_REQUEST_TYPES.includes(r.request_type)
            ? OpsApi.resolveServiceRequest(r.id, { approve: true })
            : OpsApi.approveRequest(r.id, {})),
        }),
      });
    }
    if (opsCan('ticket.reject')) {
      bulk.push({
        label: 'Reject selected', danger: true,
        run: async (rows, api) => {
          const reason = await opsPrompt({
            title: 'Reject selected requests', label: 'Reason (applied to every selected request)',
            required: true, multiline: true, confirmLabel: 'Reject', danger: true,
          });
          if (!reason) return;
          return opsBulkLifecycle(rows, api, {
            verb: 'Reject', filter: r => ['pending_approval', 'in_review'].includes(r.status),
            skipNote: 'only requests that are Pending or Under Review can be rejected',
            confirm: false,
            act: r => (OPS_SERVICE_REQUEST_TYPES.includes(r.request_type)
              ? OpsApi.resolveServiceRequest(r.id, { approve: false, reason })
              : OpsApi.rejectRequest(r.id, reason)),
          });
        },
      });
    }
    if (opsCan('ticket.issue')) {
      bulk.push({
        label: 'Issue tickets',
        run: async (rows, api) => opsBulkLifecycle(rows, api, {
          verb: 'Issue ticket for', filter: r => r.status === 'paid',
          skipNote: 'a ticket can only be issued once a request is Paid',
          act: r => OpsApi.issueTicket(r.id),
        }),
      });
    }
    if (opsCan('ticket.request')) {
      bulk.push({
        label: 'Submit drafts',
        run: async (rows, api) => opsBulkLifecycle(rows, api, {
          verb: 'Submit', filter: r => r.status === 'draft',
          skipNote: 'only drafts can be submitted',
          act: r => OpsApi.submitRequest(r.id),
        }),
      });
    }
  }

  /* The backend can export bookings and service requests properly (csv via
     stdlib, xlsx via openpyxl, pdf via reportlab) across the whole filtered
     result set, so use it rather than dumping the page. `payments` is a third
     report type and lives on the Payments screen. */
  const serverType = fixed.request_type === 'booking' ? 'bookings'
    : (fixed.request_type && OPS_SERVICE_REQUEST_TYPES.includes(fixed.request_type)) ? 'service_requests'
    : opts.serverExportType || null;

  const exportServer = serverType && opsCan('report.export') ? {
    csv: q => opsExportRequests(serverType, 'csv', q, fixed),
    xlsx: q => opsExportRequests(serverType, 'xlsx', q, fixed),
    pdf: q => opsExportRequests(serverType, 'pdf', q, fixed),
  } : null;

  const grid = OpsGrid({
    id: opts.id,
    mount: host,
    title: opts.title,
    exportName: opts.exportName || opts.id,
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Request no., PNR, ticket, passenger, passport, destination…',
    filters,
    filterDefaults: opts.filterDefaults || {},
    columns: opsRequestColumns(opts),
    selectable: bulk.length > 0,
    bulkActions: bulk,
    exportServer,
    onRow: r => opsOpenRequest(r.id),
    rowClass: r => (['rejected', 'cancelled'].includes(r.status) ? 'ops-muted-row' : ''),
    note: opts.note || `<b>Travel from / to filter the travel date, not the date the request was
      raised</b> — <code>date_from</code> maps to <code>service_requests.travel_date</code>
      server-side. Search covers request number, PNR, ticket number, booking reference,
      destination city and passenger name or passport.`,
    emptyText: 'No requests match these criteria.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize, ...fixed };
      ['status', 'request_type', 'travel_type', 'date_from', 'date_to'].forEach(k => {
        if (f[k]) params[k] = f[k];
      });
      if (f.merchant_id) params.merchant_id = Number(f.merchant_id);
      if (search) params.search = search;
      const d = await OpsApi.listRequests(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: {
      open: row => opsOpenRequest(row.id),
    },
  });

  /* A dashboard tile or a search hit can pre-filter this grid. */
  const pending = opsTakePendingFilter(opts.pendingKey || opts.id);
  if (pending) Object.entries(pending).forEach(([k, v]) => grid.setFilter(k, v, false));
  if (pending) grid.reload();

  return grid;
}

function opsExportRequests(type, format, query, fixed) {
  const params = { type, format };
  const f = query.filters || {};
  if (query.search) params.search = query.search;
  if (f.status || fixed.status) params.status = f.status || fixed.status;
  if (f.date_from) params.date_from = f.date_from;
  if (f.date_to) params.date_to = f.date_to;
  if (f.merchant_id) params.merchant_id = Number(f.merchant_id);
  return OpsApi.exportReport(params);
}

/* Runs a lifecycle action over a selection, one call at a time so a failure
   halfway is reported precisely rather than as a single opaque failure. Rows
   the action cannot legally apply to are counted and named, never silently
   dropped — an operator who selects twelve rows and sees "3 approved" must be
   told what happened to the other nine. */
async function opsBulkLifecycle(rows, api, { verb, filter, act, skipNote, confirm = true }) {
  const eligible = rows.filter(filter);
  const skipped = rows.length - eligible.length;
  if (!eligible.length) {
    return opsToast(`Nothing to do — ${skipNote}.`, 'err');
  }
  if (confirm) {
    const msg = `${verb} ${eligible.length} request${eligible.length === 1 ? '' : 's'}?`
      + (skipped ? ` ${skipped} of the ${rows.length} selected will be skipped — ${skipNote}.` : '');
    if (!await opsConfirm(msg, verb)) return;
  }

  let ok = 0;
  const errors = [];
  for (const r of eligible) {
    try { await act(r); ok++; } catch (err) { errors.push(`${r.request_number}: ${opsError(err)}`); }
  }
  api.clearSelection();
  opsAfterWrite();
  api.reload();

  if (errors.length) {
    opsOpenModal(`${verb}: ${ok} succeeded, ${errors.length} failed`,
      `<ul style="margin:0;padding-left:18px;font-size:12px">
         ${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
       </ul>`,
      '<span class="ops-spacer"></span><button type="button" class="ops-btn ops-btn-primary" id="opsBulkClose">Close</button>');
    $('opsBulkClose').addEventListener('click', opsCloseModal);
  } else {
    opsToast(`${verb}: ${ok} request${ok === 1 ? '' : 's'} done${skipped ? `, ${skipped} skipped` : ''}.`, 'ok');
  }
}

/* ===========================================================================
   REQUEST DETAIL
   =========================================================================== */

async function opsOpenRequest(id) {
  const body = opsOpenModal('Request', opsSpinner('Loading request…'), '', { wide: true });
  try {
    const d = await OpsApi.getRequest(id);
    opsRenderRequestDetail(d);
  } catch (err) {
    body.innerHTML = `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load this request.'))}</div>`;
  }
}

function opsRenderRequestDetail(d) {
  const r = d.request;
  const det = r.details || {};
  const isService = OPS_SERVICE_REQUEST_TYPES.includes(r.request_type);

  /* Progress rail: lifecycle.HAPPY_PATH with everything up to the current
     status marked done. A rejected or cancelled request left the path, so the
     rail shows where it stopped instead of pretending it is still moving. */
  const idx = OPS_HAPPY_PATH.indexOf(r.status);
  const derailed = ['rejected', 'cancelled'].includes(r.status);
  const rail = OPS_HAPPY_PATH.map((s, i) => {
    let cls = '';
    if (!derailed) cls = i < idx ? 'done' : i === idx ? 'current' : '';
    else cls = i === 0 ? 'done' : '';
    return `<div class="ops-step ${cls}"><b>${escapeHtml(opsStatusLabel(s))}</b>${
      cls === 'current' ? 'now' : cls === 'done' ? 'done' : ''}</div>`;
  }).join('') + (derailed ? `<div class="ops-step bad"><b>${escapeHtml(opsStatusLabel(r.status))}</b>stopped here</div>` : '');

  const timeline = (d.timeline || []).map(t => `
    <li class="${t.state === 'done' ? 'done' : t.state === 'current' ? 'current' : ''}">
      <b>${escapeHtml(t.label || opsStatusLabel(t.status))}</b>
      ${t.at ? `<small>${escapeHtml(fmtDateTime(t.at))}${t.by ? ` · ${escapeHtml(t.by)}` : ''}</small>` : ''}
      ${t.reason ? `<small>Reason: ${escapeHtml(t.reason)}</small>` : ''}
      ${t.note ? `<small>Note: ${escapeHtml(t.note)}</small>` : ''}
    </li>`).join('');

  const pax = (r.passengers || []);
  const paxTable = pax.length ? `
    <div class="ops-table-wrap">
      <table class="ops-table">
        <thead><tr>
          <th>#</th><th>Name</th><th>Type</th><th>Gender</th><th>DOB</th>
          <th>Nationality</th><th>Passport</th><th>Expiry</th><th>Seat</th><th>Meal</th><th>Status</th>
        </tr></thead>
        <tbody>${pax.map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml([p.title, p.first_name, p.last_name].filter(Boolean).join(' '))}</td>
            <td>${escapeHtml(opsLabel(p.passenger_type))}</td>
            <td>${escapeHtml(opsLabel(p.gender) || '—')}</td>
            <td class="ops-nowrap">${escapeHtml(p.dob ? fmtDate(p.dob) : '—')}</td>
            <td>${escapeHtml(p.nationality || '—')}</td>
            <td class="ops-mono">${escapeHtml(p.passport_number || '—')}</td>
            <td class="ops-nowrap">${escapeHtml(p.passport_expiry ? fmtDate(p.passport_expiry) : '—')}</td>
            <td>${escapeHtml(opsLabel(p.seat_preference) || '—')}</td>
            <td>${escapeHtml(opsLabel(p.meal_preference) || '—')}</td>
            <td>${p.is_cancelled ? '<span class="ops-tag ops-tag-err">Cancelled</span>' : '<span class="ops-tag ops-tag-ok">Active</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="ops-empty">No passengers recorded.</div>';

  /* Payments: the only place a payment can be tied back to its booking, since
     PaymentSummary carries no request reference in the other direction. This
     is also where a pending payment gets verified, because verification is
     keyed by payment_id, not request_id. */
  const payRows = (d.payments || []);
  const canVerify = opsCan('payment.verify');
  const canRefund = opsCan('payment.manage');
  const payTable = payRows.length ? `
    <div class="ops-table-wrap">
      <table class="ops-table">
        <thead><tr><th>ID</th><th>Method</th><th>Transaction</th>
          <th class="ops-num">Amount</th><th>Status</th><th>Date</th><th class="ops-actions"></th></tr></thead>
        <tbody>${payRows.map(p => `
          <tr>
            <td>${p.id}</td>
            <td>${escapeHtml(p.method || '—')}</td>
            <td class="ops-mono">${escapeHtml(p.transaction_id || '—')}</td>
            <td class="ops-num">${money(Number(p.amount))}</td>
            <td>${opsTag(p.status)}</td>
            <td class="ops-nowrap">${escapeHtml(p.paid_date ? fmtDateTime(p.paid_date) : '—')}</td>
            <td class="ops-actions">
              ${canVerify && p.status === 'pending' ? `
                <button type="button" class="ops-btn ops-btn-sm ops-btn-primary" data-ops-pv="${p.id}">Verify</button>
                <button type="button" class="ops-btn ops-btn-sm ops-btn-danger" data-ops-pr="${p.id}">Reject</button>` : ''}
              ${canRefund && p.status === 'success' ? `
                <button type="button" class="ops-btn ops-btn-sm" data-ops-refund="${p.id}" data-ops-amt="${escapeHtml(String(p.amount))}">Refund</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="ops-empty">No payments recorded against this request.</div>';

  const body = $('opsModalBody');
  $('opsModalTitle').textContent = `${r.request_number} — ${opsStatusLabel(r.status)}`;
  body.innerHTML = `
    <div class="ops-rail-steps" style="margin-bottom:10px">${rail}</div>

    <div class="ops-cols-2">
      <fieldset class="ops-fieldset"><legend>Request</legend><div class="ops-fieldset-body">
        <dl class="ops-dl ops-dl-rows">
          <div><dt>Request no.</dt><dd class="ops-ref">${escapeHtml(r.request_number)}</dd></div>
          <div><dt>Type</dt><dd>${escapeHtml(opsLabel(r.request_type))}</dd></div>
          <div><dt>Status</dt><dd>${opsTag(r.status, r.status_label)}</dd></div>
          ${r.parent_request_id ? `<div><dt>Against booking</dt><dd>
            <button type="button" class="ops-btn ops-btn-sm ops-btn-link" data-ops-parent="${r.parent_request_id}">
              open parent booking</button></dd></div>` : ''}
          <div><dt>Description</dt><dd>${escapeHtml(r.title || '—')}</dd></div>
          ${opsIsStaff() ? `<div><dt>Merchant</dt><dd>${escapeHtml(r.merchant_name || '—')}</dd></div>` : ''}
          <div><dt>Raised by</dt><dd>${escapeHtml(r.raised_by || '—')}</dd></div>
          <div><dt>Created</dt><dd>${escapeHtml(fmtDateTime(r.created_at))}</dd></div>
          ${r.approved_at ? `<div><dt>Approved</dt><dd>${escapeHtml(fmtDateTime(r.approved_at))}</dd></div>` : ''}
          ${r.completed_at ? `<div><dt>Closed</dt><dd>${escapeHtml(fmtDateTime(r.completed_at))}</dd></div>` : ''}
          ${r.rejection_reason ? `<div><dt>Rejection reason</dt><dd>${escapeHtml(r.rejection_reason)}</dd></div>` : ''}
          <div><dt>Remarks</dt><dd>${escapeHtml(r.remarks || '—')}</dd></div>
        </dl>
      </div></fieldset>

      <fieldset class="ops-fieldset"><legend>Travel &amp; documents</legend><div class="ops-fieldset-body">
        <dl class="ops-dl ops-dl-rows">
          <div><dt>Travel type</dt><dd>${escapeHtml(opsLabel(r.travel_type) || '—')}</dd></div>
          <div><dt>Sector</dt><dd>${escapeHtml(opsSector(r) || '—')}</dd></div>
          <div><dt>Travel date</dt><dd>${escapeHtml(fmtDate(r.travel_date))}</dd></div>
          ${r.return_date ? `<div><dt>Return date</dt><dd>${escapeHtml(fmtDate(r.return_date))}</dd></div>` : ''}
          ${det.airline ? `<div><dt>Airline</dt><dd>${escapeHtml(det.airline)}</dd></div>` : ''}
          ${det.flight_number ? `<div><dt>Flight</dt><dd>${escapeHtml(det.flight_number)}</dd></div>` : ''}
          ${det.hotel_name ? `<div><dt>Hotel</dt><dd>${escapeHtml(det.hotel_name)}</dd></div>` : ''}
          ${det.room_type ? `<div><dt>Room</dt><dd>${escapeHtml(det.room_type)}</dd></div>` : ''}
          ${det.cabin_class ? `<div><dt>Cabin</dt><dd>${escapeHtml(opsLabel(det.cabin_class))}</dd></div>` : ''}
          <div><dt>PNR</dt><dd class="ops-ref">${escapeHtml(r.pnr || '—')}</dd></div>
          <div><dt>Ticket no.</dt><dd class="ops-ref">${escapeHtml(r.ticket_number || '—')}</dd></div>
          <div><dt>Booking ref.</dt><dd class="ops-ref">${escapeHtml(r.booking_reference || '—')}</dd></div>
          <div><dt>Invoice no.</dt><dd class="ops-ref">${escapeHtml(r.invoice_number || '—')}</dd></div>
          <div><dt>Quantity</dt><dd>${escapeHtml(String(r.quantity ?? '—'))}</dd></div>
          <div><dt>Amount</dt><dd><b>${money(Number(r.total_amount))}</b></dd></div>
        </dl>
      </div></fieldset>
    </div>

    ${isService && Object.keys(det).length ? `
      <fieldset class="ops-fieldset"><legend>Change requested</legend><div class="ops-fieldset-body">
        <pre class="ops-json">${escapeHtml(JSON.stringify(det, null, 2))}</pre>
      </div></fieldset>` : ''}

    <fieldset class="ops-fieldset"><legend>Passengers (${pax.length})</legend>
      <div class="ops-fieldset-body" style="padding:0">${paxTable}</div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>Payments</legend>
      <div class="ops-fieldset-body" style="padding:0">${payTable}</div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>Approval status</legend>
      <div class="ops-fieldset-body"><ul class="ops-timeline">${timeline || '<li>No history recorded.</li>'}</ul></div>
    </fieldset>

    <div class="ops-msg" id="opsRdMsg"></div>`;

  /* --- action buttons, derived from the server's own `actions` list ------- */
  const actions = (d.actions || [])
    .map(a => ({ ...a, ep: OPS_TRANSITION_ENDPOINT[a.to] }))
    .filter(a => a.ep);

  const extra = [];
  /* Merchant-side payment: only while payment_pending, and only with
     payment.pay. record_payment does not check request_type, so an approved
     service request is payable here too. */
  if (r.status === 'payment_pending' && opsCan('payment.pay')) {
    extra.push(`<button type="button" class="ops-btn ops-btn-primary" id="opsRdPay">Record payment</button>`);
  }
  /* Staff-side correction of what is owed. Only at Payment Pending — before it
     approval carries the amount, after it money has moved and a change is a
     refund or an extra charge, not an overwrite. Highlighted when the booking
     is unpriced, because then nobody can do anything else with it. */
  if (r.status === 'payment_pending' && r.request_type !== 'ticket_enquiry' && opsCan('ticket.approve')) {
    const unpriced = !(Number(r.total_amount) > 0);
    extra.push(`<button type="button" class="ops-btn ${unpriced ? 'ops-btn-primary' : ''}" id="opsRdReprice">${
      unpriced ? 'Set amount' : 'Correct amount'}</button>`);
  }
  /* Service requests can only be raised against a confirmed booking. */
  if (r.request_type === 'booking'
      && ['approved', 'payment_pending', 'paid', 'ticket_issued', 'completed'].includes(r.status)
      && opsCan('servicerequest.create')) {
    extra.push(`<button type="button" class="ops-btn" id="opsRdService">Raise service request</button>`);
  }
  if (r.status === 'draft' && opsCan('ticket.request')) {
    extra.push(`<button type="button" class="ops-btn" id="opsRdEdit">Edit draft</button>`);
  }

  $('opsModalFoot').innerHTML = `
    ${extra.join('')}
    <span class="ops-spacer"></span>
    ${actions.map((a, i) => `<button type="button" class="ops-btn ${a.to === 'rejected' || a.to === 'cancelled' ? 'ops-btn-danger' : 'ops-btn-primary'}"
        data-ops-act-i="${i}">${escapeHtml(a.ep.label)}</button>`).join('')}
    <button type="button" class="ops-btn" id="opsRdClose">Close</button>`;

  $('opsRdClose').addEventListener('click', opsCloseModal);
  opsAll('[data-ops-parent]', body).forEach(b =>
    b.addEventListener('click', () => opsOpenRequest(b.dataset.opsParent)));

  opsAll('[data-ops-act-i]', $('opsModalFoot')).forEach(btn => {
    btn.addEventListener('click', () => opsRunTransition(r, actions[Number(btn.dataset.opsActI)]));
  });

  $('opsRdPay')?.addEventListener('click', () => opsPayDialog(r));
  $('opsRdReprice')?.addEventListener('click', async () => {
    const res = await opsRepriceDialog(r);
    if (!res) return;
    try {
      await OpsApi.repriceRequest(r.id, res);
      opsCloseModal();
      opsToast(`${r.request_number} is now ${money(res.amount)}. The merchant has been notified.`, 'ok');
      opsAfterWrite();
      opsOpenRequest(r.id);
    } catch (err) { opsMsg($('opsRpMsg'), opsError(err, 'Could not change the amount.'), 'err'); }
  });
  $('opsRdService')?.addEventListener('click', () => opsServiceRequestDialog(r));
  $('opsRdEdit')?.addEventListener('click', () => { opsCloseModal(); opsEditDraft(r.id); });

  opsAll('[data-ops-pv]', body).forEach(b =>
    b.addEventListener('click', () => opsVerifyDialog(b.dataset.opsPv, true, () => opsOpenRequest(r.id))));
  opsAll('[data-ops-pr]', body).forEach(b =>
    b.addEventListener('click', () => opsVerifyDialog(b.dataset.opsPr, false, () => opsOpenRequest(r.id))));
  opsAll('[data-ops-refund]', body).forEach(b =>
    b.addEventListener('click', () => opsRefundDialog(b.dataset.opsRefund, b.dataset.opsAmt, () => opsOpenRequest(r.id))));
}

/* One transition. Service requests take a different route to bookings for
   approve/reject (resolve_service_request refuses anything that is not a
   service type, and the approve endpoint would move it down the booking path
   instead), so the type decides the call. */
async function opsRunTransition(r, action) {
  const isService = OPS_SERVICE_REQUEST_TYPES.includes(r.request_type);
  const ep = action.ep;
  let reason = null;

  if (ep.reason || action.requires_reason) {
    reason = await opsPrompt({
      title: ep.label,
      label: action.to === 'rejected' ? 'Reason for rejection' : 'Reason',
      required: !!action.requires_reason,
      multiline: true,
      confirmLabel: ep.label,
      danger: action.to === 'rejected' || action.to === 'cancelled',
    });
    if (reason === null) return;
  } else if (action.to === 'approved' && !isService) {
    /* Approval is where a quote becomes a payable amount, so it is the one
       transition that offers to change the figure — approve_request writes
       final_amount onto total_amount. Left blank, the quoted amount stands. */
    const res = await opsApproveDialog(r);
    if (!res) return;
    return opsApplyTransition(r, () => OpsApi.approveRequest(r.id, res), ep.label);
  } else if (!await opsConfirm(`${ep.label} — ${r.request_number}?`, ep.label,
      { danger: action.to === 'cancelled' })) {
    return;
  }

  const call = () => {
    if (isService && action.to === 'approved') return OpsApi.resolveServiceRequest(r.id, { approve: true, reason });
    if (isService && action.to === 'rejected') return OpsApi.resolveServiceRequest(r.id, { approve: false, reason });
    if (action.to === 'cancelled') return OpsApi.cancelRequest(r.id, reason);
    if (action.to === 'rejected') return OpsApi.rejectRequest(r.id, reason);
    return OpsApi[ep.fn](r.id);
  };
  return opsApplyTransition(r, call, ep.label);
}

async function opsApplyTransition(r, call, label) {
  opsMsg($('opsRdMsg'), `${label}…`, 'muted');
  try {
    await call();
    opsToast(`${r.request_number}: ${label.toLowerCase()} done.`, 'ok');
    opsAfterWrite();
    opsOpenRequest(r.id);      /* re-read: the next legal actions have changed */
  } catch (err) {
    opsMsg($('opsRdMsg'), opsError(err, `${label} failed.`), 'err');
  }
}

function opsApproveDialog(r) {
  /* An enquiry-led booking reaches approval carrying ₹0 — nothing prices it
     before the desk does. Approving it without a figure produces a Payment
     Pending booking the merchant is asked to pay and cannot (record_payment
     refuses 0), with no way back: Payment Pending has no edge to Approved. The
     API refuses that now, so the field stops being optional exactly when
     leaving it blank would have created one. A catalog-led booking already
     carries a quote and keeps the old blank-means-unchanged behaviour. */
  const quoted = Number(r.total_amount);
  const needsAmount = !(quoted > 0);
  return new Promise(resolve => {
    opsOpenModal('Approve request', `
      <p style="margin:0 0 10px;font-size:12px">
        Approving <b>${escapeHtml(r.request_number)}</b> moves it straight to
        <b>Payment Pending</b> — the API walks Under Review → Approved → Payment Pending
        in one step, so there is no separate action afterwards.
      </p>
      <div class="ops-form ops-form-2">
        <div class="ops-field">
          <label for="opsApAmt">Final amount (₹)${needsAmount ? ' *' : ''}</label>
          <input type="number" id="opsApAmt" min="0.01" step="0.01" placeholder="${needsAmount ? 'e.g. 48000' : escapeHtml(String(r.total_amount))}">
          <span class="ops-field-hint">${needsAmount
            ? 'This booking has no amount yet. It becomes what the merchant pays, so it is required and cannot be zero.'
            : `Leave blank to keep the quoted ${money(quoted)}. This becomes the payable amount.`}</span>
        </div>
        <div class="ops-field">
          <label for="opsApNote">Note</label>
          <input type="text" id="opsApNote" placeholder="Recorded on the timeline">
        </div>
      </div>
      <div class="ops-msg" id="opsApMsg"></div>`,
      `<span class="ops-spacer"></span>
       <button type="button" class="ops-btn" data-ops-ap="0">Cancel</button>
       <button type="button" class="ops-btn ops-btn-primary" data-ops-ap="1">Approve</button>`);

    let done = false;
    const finish = v => { if (done) return; done = true; opsModalOnClose = null; resolve(v); };
    opsAll('[data-ops-ap]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.opsAp === '0') { opsCloseModal(); return finish(null); }
      const amt = $('opsApAmt').value;
      if (amt !== '' && Number(amt) < 0) return opsMsg($('opsApMsg'), 'The amount cannot be negative.', 'err');
      if (needsAmount && !(Number(amt) > 0)) {
        return opsMsg($('opsApMsg'), 'Enter the amount to charge — it cannot be blank or zero.', 'err');
      }
      finish({ finalAmount: amt === '' ? null : Number(amt), note: $('opsApNote').value.trim() });
    }));
    opsModalOnClose = () => { done = true; resolve(null); };
  });
}

/* Correcting the amount on a booking already at Payment Pending — the only
   stage where what is owed can still change without money having moved.
   Deliberately not the approve dialog: approve cannot be called again from
   here (no Payment Pending → Approved edge), which is what left mispriced and
   unpriced bookings stuck before POST .../reprice existed. */
function opsRepriceDialog(r) {
  const current = Number(r.total_amount);
  const unpriced = !(current > 0);
  return new Promise(resolve => {
    opsOpenModal(unpriced ? 'Set the amount' : 'Correct the amount', `
      <p style="margin:0 0 10px;font-size:12px">
        ${unpriced
          ? `<b>${escapeHtml(r.request_number)}</b> was approved without a fare, so the merchant sees
             “Awaiting amount” and has nothing to pay.`
          : `<b>${escapeHtml(r.request_number)}</b> is currently ${money(current)}. The merchant is
             notified of the new amount and the reason.`}
        The booking stays in <b>Payment Pending</b>.
      </p>
      <div class="ops-form ops-form-2">
        <div class="ops-field">
          <label for="opsRpAmt">Amount to charge (₹) *</label>
          <input type="number" id="opsRpAmt" min="0.01" step="0.01" value="${unpriced ? '' : escapeHtml(String(r.total_amount))}">
        </div>
        <div class="ops-field">
          <label for="opsRpReason">Reason *</label>
          <input type="text" id="opsRpReason" maxlength="500" placeholder="e.g. Fare confirmed with the airline">
        </div>
      </div>
      <div class="ops-msg" id="opsRpMsg"></div>`,
      `<span class="ops-spacer"></span>
       <button type="button" class="ops-btn" data-ops-rp="0">Cancel</button>
       <button type="button" class="ops-btn ops-btn-primary" data-ops-rp="1">${unpriced ? 'Set amount' : 'Update amount'}</button>`);

    let done = false;
    const finish = v => { if (done) return; done = true; opsModalOnClose = null; resolve(v); };
    opsAll('[data-ops-rp]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.opsRp === '0') { opsCloseModal(); return finish(null); }
      const amount = Number($('opsRpAmt').value);
      if (!(amount > 0)) return opsMsg($('opsRpMsg'), 'Enter an amount greater than zero.', 'err');
      const reason = $('opsRpReason').value.trim();
      if (!reason) return opsMsg($('opsRpMsg'), 'A reason is required — the merchant is told it.', 'err');
      finish({ amount, reason });
    }));
    opsModalOnClose = () => { done = true; resolve(null); };
  });
}

/* ===========================================================================
   PAYMENT DIALOGS (shared with the Payments screen)
   =========================================================================== */

function opsPayDialog(r, after) {
  const due = Number(r.total_amount);
  if (!(due > 0)) {
    return opsOpenModal('Amount not set yet', `
      <div class="ops-msg ops-msg-warn" style="margin:0">
        ${escapeHtml(r.request_number)} is Payment Pending but its amount is ₹0. The API rejects a
        payment of zero or less, so there is nothing that can be paid until the approvals team
        sets a final amount.
      </div>`, '<span class="ops-spacer"></span><button type="button" class="ops-btn" onclick="opsCloseModal()">Close</button>');
  }
  opsOpenModal(`Record payment — ${r.request_number}`, `
    <div class="ops-form ops-form-2">
      <div class="ops-field">
        <label for="opsPayAmt">Amount (₹)<span class="ops-req">*</span></label>
        <input type="number" id="opsPayAmt" min="0.01" step="0.01" value="${escapeHtml(String(due))}">
        <span class="ops-field-hint">Due: ${money(due)}</span>
      </div>
      <div class="ops-field">
        <label for="opsPayMethod">Method<span class="ops-req">*</span></label>
        <select id="opsPayMethod">
          ${opsSelectOptions(['bank_transfer', 'neft', 'rtgs', 'upi', 'card', 'wallet', 'cheque', 'cash'], 'bank_transfer')}
        </select>
      </div>
      <div class="ops-field ops-field-full">
        <label for="opsPayTxn">Transaction reference</label>
        <input type="text" id="opsPayTxn" placeholder="UTR / reference number">
        <span class="ops-field-hint">Recorded as submitted and held until an administrator verifies it.</span>
      </div>
    </div>
    <div class="ops-msg" id="opsPayMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsPayCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsPaySave">Record payment</button>`);

  $('opsPayCancel').addEventListener('click', opsCloseModal);
  $('opsPaySave').addEventListener('click', async () => {
    const amount = Number($('opsPayAmt').value);
    if (!(amount > 0)) return opsMsg($('opsPayMsg'), 'Enter an amount greater than zero.', 'err');
    $('opsPaySave').disabled = true;
    try {
      await OpsApi.payRequest(r.id, {
        amount, method: $('opsPayMethod').value, transactionId: $('opsPayTxn').value.trim(),
      });
      opsToast(`Payment of ${money(amount)} recorded against ${r.request_number}.`, 'ok');
      opsAfterWrite();
      if (after) after(); else opsOpenRequest(r.id);
    } catch (err) {
      opsMsg($('opsPayMsg'), opsError(err, 'The payment was not accepted.'), 'err');
    } finally {
      $('opsPaySave').disabled = false;
    }
  });
}

function opsVerifyDialog(paymentId, approve, after) {
  opsOpenModal(approve ? 'Verify payment' : 'Reject payment', `
    <p style="margin:0 0 10px;font-size:12px">
      ${approve
        ? 'Verifying marks the payment successful and moves its request to <b>Paid</b>.'
        : 'Rejecting marks the payment failed. The request stays at Payment Pending so the merchant can pay again.'}
    </p>
    <div class="ops-form"><div class="ops-field ops-field-full">
      <label for="opsVfNote">Note${approve ? '' : ' (shown to the merchant)'}</label>
      <input type="text" id="opsVfNote" placeholder="${approve ? 'Optional' : 'e.g. reference not found in the bank statement'}">
    </div></div>
    <div class="ops-msg" id="opsVfMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsVfCancel">Cancel</button>
     <button type="button" class="ops-btn ${approve ? 'ops-btn-primary' : 'ops-btn-danger'}" id="opsVfSave">
       ${approve ? 'Verify' : 'Reject'}</button>`);

  $('opsVfCancel').addEventListener('click', opsCloseModal);
  $('opsVfSave').addEventListener('click', async () => {
    $('opsVfSave').disabled = true;
    try {
      await OpsApi.verifyPayment(paymentId, { approve, note: $('opsVfNote').value.trim() });
      opsToast(approve ? 'Payment verified.' : 'Payment rejected.', 'ok');
      opsAfterWrite();
      after?.();
    } catch (err) {
      opsMsg($('opsVfMsg'), opsError(err, 'The action failed.'), 'err');
    } finally {
      $('opsVfSave').disabled = false;
    }
  });
}

function opsRefundDialog(paymentId, maxAmount, after) {
  opsOpenModal('Refund payment', `
    <div class="ops-form ops-form-2">
      <div class="ops-field">
        <label for="opsRfAmt">Refund amount (₹)<span class="ops-req">*</span></label>
        <input type="number" id="opsRfAmt" min="0.01" step="0.01" value="${escapeHtml(String(maxAmount))}">
        <span class="ops-field-hint">Paid: ${money(Number(maxAmount))}. A smaller figure is a partial refund.</span>
      </div>
      <div class="ops-field">
        <label for="opsRfReason">Reason<span class="ops-req">*</span></label>
        <input type="text" id="opsRfReason" placeholder="Required">
      </div>
    </div>
    <div class="ops-msg" id="opsRfMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsRfCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-danger" id="opsRfSave">Refund</button>`);

  $('opsRfCancel').addEventListener('click', opsCloseModal);
  $('opsRfSave').addEventListener('click', async () => {
    const amount = Number($('opsRfAmt').value);
    const reason = $('opsRfReason').value.trim();
    if (!(amount > 0)) return opsMsg($('opsRfMsg'), 'Enter an amount greater than zero.', 'err');
    if (!reason) return opsMsg($('opsRfMsg'), 'A reason is required.', 'err');
    $('opsRfSave').disabled = true;
    try {
      await OpsApi.refundPayment(paymentId, { amount, reason });
      opsToast('Refund recorded.', 'ok');
      opsAfterWrite();
      after?.();
    } catch (err) {
      opsMsg($('opsRfMsg'), opsError(err, 'The refund failed.'), 'err');
    } finally {
      $('opsRfSave').disabled = false;
    }
  });
}

/* ===========================================================================
   SERVICE REQUEST
   ===========================================================================
   `details` is a different shape per type, and the backend reads specific keys
   out of it (ticket_service.create_service_request's docstring lists them), so
   the form changes with the type rather than posting a free-form blob.       */

const OPS_SR_FORMS = {
  cancellation: { label: 'Cancellation', needsPax: 'many' },
  date_change: { label: 'Date change', needsPax: 'one', needsDate: true },
  refund: { label: 'Refund', needsAmount: true },
  passenger_modification: { label: 'Passenger modification', needsPax: 'one', needsChanges: true },
  extra_baggage: { label: 'Extra baggage', needsPax: 'one' },
  meal: { label: 'Meal request', needsPax: 'one' },
  seat: { label: 'Seat request', needsPax: 'one' },
};

function opsServiceRequestDialog(booking) {
  const pax = booking.passengers || [];
  const typeOptions = Object.entries(OPS_SR_FORMS).map(([v, o]) => ({ value: v, label: o.label }));

  opsOpenModal(`Service request — against ${booking.request_number}`, `
    <div class="ops-form ops-form-2">
      <div class="ops-field">
        <label for="opsSrType">Request type<span class="ops-req">*</span></label>
        <select id="opsSrType">${opsSelectOptions(typeOptions, 'date_change')}</select>
      </div>
      <div class="ops-field" id="opsSrPaxOneWrap">
        <label for="opsSrPaxOne">Passenger<span class="ops-req">*</span></label>
        <select id="opsSrPaxOne">${pax.map(p =>
          `<option value="${p.id}">${escapeHtml([p.first_name, p.last_name].filter(Boolean).join(' '))}${p.is_cancelled ? ' (cancelled)' : ''}</option>`).join('')}</select>
      </div>
      <div class="ops-field" id="opsSrDateWrap">
        <label for="opsSrDate">New travel date<span class="ops-req">*</span></label>
        <input type="date" id="opsSrDate" min="${opsToday()}">
      </div>
      <div class="ops-field" id="opsSrAmountWrap">
        <label for="opsSrAmount">Refund amount (₹)<span class="ops-req">*</span></label>
        <input type="number" id="opsSrAmount" min="0.01" step="0.01" placeholder="${escapeHtml(String(booking.total_amount))}">
      </div>
      <div class="ops-field ops-field-full" id="opsSrPaxManyWrap">
        <label>Passengers to cancel<span class="ops-req">*</span></label>
        <div style="border:1px solid var(--ops-line);border-radius:3px;padding:5px;max-height:120px;overflow:auto">
          ${pax.length ? pax.map(p => `
            <label class="ops-check"><input type="checkbox" data-ops-srpax="${p.id}" ${p.is_cancelled ? 'disabled' : ''}>
              ${escapeHtml([p.first_name, p.last_name].filter(Boolean).join(' '))}${p.is_cancelled ? ' — already cancelled' : ''}</label>`).join('')
            : '<span class="ops-muted">This booking has no passengers on file.</span>'}
        </div>
      </div>
      <div class="ops-field ops-field-full" id="opsSrChangesWrap">
        <label for="opsSrChanges">Changes requested<span class="ops-req">*</span></label>
        <textarea id="opsSrChanges" rows="2" placeholder="e.g. correct surname spelling to RAGHAVAN"></textarea>
      </div>
      <div class="ops-field ops-field-full">
        <label for="opsSrRemarks">Remarks<span class="ops-req">*</span></label>
        <textarea id="opsSrRemarks" rows="2" placeholder="Why this change is needed — visible to the approvals team"></textarea>
      </div>
    </div>
    <div class="ops-msg" id="opsSrMsg"></div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsSrCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" id="opsSrSave">Raise request</button>`, { wide: false });

  const sync = () => {
    const t = $('opsSrType').value;
    const cfg = OPS_SR_FORMS[t];
    $('opsSrPaxOneWrap').classList.toggle('ops-hidden', cfg.needsPax !== 'one');
    $('opsSrPaxManyWrap').classList.toggle('ops-hidden', cfg.needsPax !== 'many');
    $('opsSrDateWrap').classList.toggle('ops-hidden', !cfg.needsDate);
    $('opsSrAmountWrap').classList.toggle('ops-hidden', !cfg.needsAmount);
    $('opsSrChangesWrap').classList.toggle('ops-hidden', !cfg.needsChanges);
  };
  $('opsSrType').addEventListener('change', sync);
  sync();

  $('opsSrCancel').addEventListener('click', opsCloseModal);
  $('opsSrSave').addEventListener('click', async () => {
    const msg = $('opsSrMsg');
    const requestType = $('opsSrType').value;
    const cfg = OPS_SR_FORMS[requestType];
    const remarks = $('opsSrRemarks').value.trim();
    if (!remarks) return opsMsg(msg, 'Remarks are required.', 'err');

    const details = {};
    if (cfg.needsPax === 'one') {
      const id = Number($('opsSrPaxOne').value);
      if (!id) return opsMsg(msg, 'Select a passenger.', 'err');
      details.passenger_id = id;
    }
    if (cfg.needsPax === 'many') {
      const ids = opsAll('[data-ops-srpax]:checked').map(cb => Number(cb.dataset.opsSrpax));
      if (!ids.length) return opsMsg(msg, 'Select at least one passenger to cancel.', 'err');
      details.passenger_ids = ids;
    }
    if (cfg.needsDate) {
      if (!$('opsSrDate').value) return opsMsg(msg, 'Choose the new travel date.', 'err');
      details.new_travel_date = $('opsSrDate').value;
    }
    if (cfg.needsAmount) {
      const a = Number($('opsSrAmount').value);
      if (!(a > 0)) return opsMsg(msg, 'Enter the refund amount.', 'err');
      details.amount = a;
    }
    if (cfg.needsChanges) {
      const c = $('opsSrChanges').value.trim();
      if (!c) return opsMsg(msg, 'Describe the change.', 'err');
      details.changes = { note: c };
    }

    $('opsSrSave').disabled = true;
    opsMsg(msg, 'Raising…', 'muted');
    try {
      const d = await OpsApi.createServiceRequest({
        bookingId: booking.id, requestType, remarks, details,
      });
      const num = d?.request?.request_number || '';
      opsCloseModal();
      opsToast(`Service request ${num} raised and sent for approval.`, 'ok');
      opsAfterWrite();
    } catch (err) {
      opsMsg(msg, opsError(err, 'Could not raise the service request.'), 'err');
    } finally {
      const btn = $('opsSrSave');
      if (btn) btn.disabled = false;
    }
  });
}

/* ===========================================================================
   SECTIONS
   =========================================================================== */

function opsInitBookings() {
  const host = $('ops-bookings');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Bookings</h1>
        <p>Every confirmed and in-flight booking${opsIsStaff() ? ' across all merchants' : ''}.
           Open a row for its passengers, payments, timeline and the actions available to you.</p>
      </div>
      <div class="ops-page-actions">
        ${opsCan('ticket.request') ? '<button type="button" class="ops-btn ops-btn-primary" id="opsBkNew">New request <span class="ops-kbd">Ctrl+N</span></button>' : ''}
      </div>
    </div>
    <div id="opsBookingsGrid"></div>`;
  $('opsBkNew')?.addEventListener('click', () => opsGo('new-request'));

  return opsBuildRequestGrid($('opsBookingsGrid'), {
    id: 'bookings',
    pendingKey: 'bookings',
    title: 'Booking register',
    exportName: 'bookings',
    fixed: { request_type: 'booking' },
    showTypeColumn: false,
  });
}

function opsInitRequests() {
  const host = $('ops-requests');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Requests</h1>
        <p>Everything raised in the system — bookings, change requests, enquiries and chats —
           in one register.</p>
      </div>
      <div class="ops-page-actions">
        ${opsCan('ticket.request') ? '<button type="button" class="ops-btn ops-btn-primary" id="opsRqNew">New request</button>' : ''}
      </div>
    </div>
    <div id="opsRequestsTabs"></div>`;
  $('opsRqNew')?.addEventListener('click', () => opsGo('new-request'));

  OpsTabs($('opsRequestsTabs'), [
    {
      id: 'all', label: 'All requests',
      render: body => opsBuildRequestGrid(body, {
        id: 'req-all', pendingKey: 'requests', title: 'All requests', exportName: 'requests',
        serverExportType: 'bookings',
      }),
    },
    {
      id: 'service', label: 'Service requests',
      render: body => opsBuildRequestGrid(body, {
        id: 'req-service', title: 'Service requests', exportName: 'service-requests',
        filterDefaults: { request_type: 'date_change' },
        serverExportType: 'service_requests',
        showTravelColumn: true,
        note: `Change requests are raised against a confirmed booking. The type filter is
               required to see one kind at a time — the API filters on a single
               <code>request_type</code>, so "all service requests at once" is the All requests
               tab with the type column sorted.`,
      }),
    },
    {
      id: 'drafts', label: 'Drafts', when: opsCan('ticket.request'),
      render: body => opsBuildRequestGrid(body, {
        id: 'req-drafts', title: 'Drafts — not yet submitted', exportName: 'draft-requests',
        fixed: { status: 'draft' },
        note: `A draft holds nothing: no seat, no rate, no place in the approvals queue.
               Select drafts and use <b>Submit drafts</b>, or open one to edit it first.`,
      }),
    },
  ], { hash: 'requests' });
}

/* ---------------------------------------------------------------- approvals */

function opsInitApprovals() {
  const host = $('ops-approvals');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Approvals</h1>
        <p>One queue for both kinds of decision: merchant applications and request approvals.</p>
      </div>
    </div>
    <div id="opsApprovalsGrid"></div>`;

  const grid = OpsGrid({
    id: 'approvals',
    mount: $('opsApprovalsGrid'),
    title: 'Approval queue',
    exportName: 'approval-queue',
    mode: 'server',
    searchable: false,   /* the endpoint has no search parameter */
    filters: [
      { key: 'kind', label: 'Kind', type: 'select', anyLabel: 'All',
        options: [{ value: 'merchant', label: 'Merchant applications' }, { value: 'request', label: 'Requests' }] },
      { key: 'request_type', label: 'Type', type: 'select', anyLabel: 'Any',
        options: ['booking', ...OPS_SERVICE_REQUEST_TYPES].map(t => ({ value: t, label: opsLabel(t) })) },
      { key: 'priority', label: 'Priority', type: 'select', anyLabel: 'Any',
        options: OPS_PRIORITIES.map(p => ({ value: p, label: opsLabel(p) })) },
      { key: 'merchant_id', label: 'Merchant ID', type: 'number', placeholder: 'any' },
      { key: 'date_from', label: 'From', type: 'date' },
      { key: 'date_to', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'kind', label: 'Kind', nowrap: true,
        render: r => (r.kind === 'merchant'
          ? '<span class="ops-tag ops-tag-info ops-tag-sq">Merchant</span>'
          : '<span class="ops-tag ops-tag-sq">Request</span>'),
        text: r => r.kind },
      { key: 'title', label: 'Item', value: r => r.title },
      { key: 'merchant_name', label: 'Merchant', value: r => r.merchant_name },
      OpsCol.enumLabel('request_type', 'Type'),
      { key: 'priority', label: 'Priority', nowrap: true,
        render: r => (r.priority ? opsTag(r.priority, opsLabel(r.priority)) : '<span class="ops-muted">—</span>'),
        text: r => r.priority || '' },
      { key: 'status', label: 'Status', nowrap: true,
        render: r => opsTag(r.status, r.status_label), text: r => r.status_label },
      OpsCol.dateTime('submitted_at', 'Submitted'),
      OpsCol.actions([
        { act: 'open', label: 'Open', when: r => r.kind === 'request' },
        { act: 'view', label: 'View', when: r => r.kind === 'merchant' },
        { act: 'approve', label: 'Approve', primary: true,
          when: r => (r.kind === 'merchant' ? opsCan('merchant.approve') : opsCan('ticket.approve')) },
        { act: 'reject', label: 'Reject', danger: true,
          when: r => (r.kind === 'merchant' ? opsCan('merchant.suspend') : opsCan('ticket.reject')) },
      ]),
    ],
    selectable: false,
    note: `Two row kinds, two sets of endpoints. <b>Merchant</b> rows approve via
      <code>POST /api/admin/merchants/{id}/approve</code>; there is no reject route for a
      merchant, so declining an application sets it <b>inactive</b> instead.
      <b>Request</b> rows go to the approve/reject routes, or to the service-request resolve
      route when the type is a change request. Note the date filters are not symmetrical:
      for merchant rows they match the created date, for request rows they match the
      <b>travel</b> date.`,
    emptyText: 'Nothing is waiting for a decision.',
    fetch: async ({ page, pageSize, filters: f }) => {
      const params = { page, page_size: pageSize };
      ['request_type', 'priority', 'date_from', 'date_to'].forEach(k => { if (f[k]) params[k] = f[k]; });
      if (f.merchant_id) params.merchant_id = Number(f.merchant_id);
      const d = await OpsApi.approvalQueue(params);
      let rows = d.items || [];
      let total = d.total ?? rows.length;
      /* `kind` is not a server-side filter, so it narrows the page in hand and
         the count is adjusted to match what is actually shown. */
      if (f.kind) {
        rows = rows.filter(r => r.kind === f.kind);
        total = rows.length;
      }
      return { rows, total };
    },
    actions: {
      open: row => opsOpenRequest(row.id),
      view: row => opsOpenMerchant(row.id),
      approve: async row => {
        if (row.kind === 'merchant') {
          if (!await opsConfirm(`Approve ${row.merchant_name}? Its staff will be able to sign in immediately.`, 'Approve')) return;
          try {
            await OpsApi.approveMerchant(row.id);
            opsToast(`${row.merchant_name} approved.`, 'ok');
            opsInvalidate('merchants', 'dashboard');
            grid.reload();
            opsLoadBadges();
          } catch (err) { opsToast(opsError(err, 'Approval failed.'), 'err'); }
          return;
        }
        const isService = OPS_SERVICE_REQUEST_TYPES.includes(row.request_type);
        if (isService) {
          if (!await opsConfirm(`Approve ${row.title}?`, 'Approve')) return;
          try {
            await OpsApi.resolveServiceRequest(row.id, { approve: true });
            opsToast('Service request approved.', 'ok');
            opsAfterWrite();
            grid.reload();
          } catch (err) { opsToast(opsError(err, 'Approval failed.'), 'err'); }
          return;
        }
        /* A booking approval sets the payable amount, so it uses the full
           dialog rather than a yes/no. */
        const d = await OpsApi.getRequest(row.id).catch(() => null);
        if (!d) return opsToast('Could not load the request.', 'err');
        const res = await opsApproveDialog(d.request);
        if (!res) return;
        try {
          await OpsApi.approveRequest(row.id, res);
          opsCloseModal();
          opsToast(`${d.request.request_number} approved and moved to Payment Pending.`, 'ok');
          opsAfterWrite();
          grid.reload();
        } catch (err) { opsMsg($('opsApMsg'), opsError(err, 'Approval failed.'), 'err'); }
      },
      reject: async row => {
        if (row.kind === 'merchant') {
          const ok = await opsConfirm(
            `There is no "reject" action for a merchant application. Set ${row.merchant_name} to `
            + `inactive instead? It stays on file and can be approved later.`, 'Set inactive', { danger: true });
          if (!ok) return;
          try {
            await OpsApi.setMerchantStatus(row.id, 'inactive');
            opsToast(`${row.merchant_name} set inactive.`, 'ok');
            opsInvalidate('merchants', 'dashboard');
            grid.reload();
          } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
          return;
        }
        const reason = await opsPrompt({
          title: 'Reject request', label: 'Reason', required: true, multiline: true,
          confirmLabel: 'Reject', danger: true,
        });
        if (!reason) return;
        try {
          if (OPS_SERVICE_REQUEST_TYPES.includes(row.request_type)) {
            await OpsApi.resolveServiceRequest(row.id, { approve: false, reason });
          } else {
            await OpsApi.rejectRequest(row.id, reason);
          }
          opsToast('Request rejected.', 'ok');
          opsAfterWrite();
          grid.reload();
        } catch (err) { opsToast(opsError(err, 'Rejection failed.'), 'err'); }
      },
    },
  });
  return grid;
}

/* ===========================================================================
   REQUEST TICKET — the enterprise form
   ===========================================================================
   The brief's section order, kept literally: Passenger Information, Travel
   Information, Documents, Payment Summary, Approval Status, Remarks; with
   Save / Submit / Reset / Cancel.

   TWO THINGS WORTH KNOWING
   1. A request is always raised against a PRICED CATALOG ITEM —
      CreateBookingRequest requires catalog_item_id. So the form starts from a
      quote, which is why the empty state sends you to inventory rather than
      offering a blank booking that could not be posted.
   2. "Documents" is passport and travel-document data, which lives on the
      passenger record (PassengerInput carries passport number, issuing
      country, issue date and expiry). File upload is NOT available: the
      documents module is listed as pending in GET /api/status and has no
      endpoint. The section says so instead of showing a dead file input.
   =========================================================================== */

let opsForm = null;   /* {quote, passengers, draftId, travelDate, returnDate, remarks} */

function opsStartRequestFrom(quote, passengers) {
  opsForm = {
    quote,
    paxCount: passengers || quote.passengers || 1,
    draftId: null,
    seeded: null,
  };
  opsInvalidate('new-request');
  opsGo('new-request');
}

/* Open an existing draft for editing: same form, but Save writes through
   PUT /api/requests/{id} + PUT /api/requests/{id}/passengers instead of POST. */
async function opsEditDraft(id) {
  try {
    const d = await OpsApi.getRequest(id);
    const r = d.request;
    /* A draft's catalog item is not returned by the request endpoint, so the
       form runs in "edit" mode: the priced item is displayed from the request's
       own stored pricing rather than re-quoted. */
    opsForm = {
      quote: null,
      draftId: r.id,
      seeded: r,
      paxCount: Math.max(1, (r.passengers || []).length),
    };
    opsInvalidate('new-request');
    opsGo('new-request');
  } catch (err) {
    opsToast(opsError(err, 'Could not open that draft.'), 'err');
  }
}

function opsInitNewRequest() {
  const host = $('ops-new-request');

  if (!opsCan('ticket.request')) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-info" style="margin:0">
        Your account does not hold <code>ticket.request</code>, so it cannot raise bookings.
        Platform staff approve and issue; merchants raise.
      </div></div></div>`;
    return;
  }

  if (!opsForm) {
    host.innerHTML = `
      <div class="ops-page-head"><div>
        <h1>Request Ticket</h1>
        <p>A request is always raised against a priced inventory row, so start from a search.</p>
      </div></div>
      <div class="ops-panel"><div class="ops-panel-body">
        <p style="margin:0 0 10px;font-size:12px">
          Pick a travel type, search the inventory and press <b>Select</b> on the row you want.
          The fare is quoted for your party size before any passenger details are entered.
        </p>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${OPS_TRAVEL_TYPES.map(t => `<button type="button" class="ops-btn ${t === 'flight' ? 'ops-btn-primary' : ''}"
            data-ops-goinv="${t}s">Search ${t}s</button>`).join('')}
        </div>
      </div></div>`;
    opsAll('[data-ops-goinv]', host).forEach(b =>
      b.addEventListener('click', () => opsGo(b.dataset.opsGoinv)));
    return;
  }

  opsRenderRequestForm();
}

function opsRenderRequestForm() {
  const host = $('ops-new-request');
  const editing = !!opsForm.draftId;
  const q = opsForm.quote;
  const seeded = opsForm.seeded;
  const item = q?.item || null;
  const det = item?.details || seeded?.details || {};
  const travelDate = item?.travel_date || seeded?.travel_date || '';
  const returnDate = seeded?.return_date || '';

  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>${editing ? `Edit draft ${escapeHtml(seeded.request_number)}` : 'Request Ticket'}</h1>
        <p>Names must match the travel document exactly. Tab moves through the grid;
           <span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">S</span> saves a draft.</p>
      </div>
      <div class="ops-page-actions">
        <button type="button" class="ops-btn" id="opsRfCancelAll">Cancel</button>
      </div>
    </div>

    <fieldset class="ops-fieldset"><legend>1 · Travel information</legend>
      <div class="ops-fieldset-body">
        <dl class="ops-dl">
          <div><dt>Item</dt><dd>${escapeHtml(item?.title || seeded?.title || '—')}</dd></div>
          <div><dt>Travel type</dt><dd>${escapeHtml(opsLabel(item?.travel_type || seeded?.travel_type) || '—')}</dd></div>
          ${det.airline ? `<div><dt>Airline</dt><dd>${escapeHtml(det.airline)}</dd></div>` : ''}
          ${det.flight_number ? `<div><dt>Flight</dt><dd>${escapeHtml(det.flight_number)}</dd></div>` : ''}
          ${det.hotel_name ? `<div><dt>Hotel</dt><dd>${escapeHtml(det.hotel_name)}</dd></div>` : ''}
          ${det.room_type ? `<div><dt>Room</dt><dd>${escapeHtml(det.room_type)}</dd></div>` : ''}
          ${det.cabin_class ? `<div><dt>Cabin</dt><dd>${escapeHtml(opsLabel(det.cabin_class))}</dd></div>` : ''}
          <div><dt>Sector</dt><dd>${escapeHtml(opsSector({ details: det }) || '—')}</dd></div>
        </dl>
        <div class="ops-form ops-form-2" style="margin-top:10px">
          <div class="ops-field">
            <label for="opsRfDate">Travel date</label>
            <input type="date" id="opsRfDate" value="${escapeHtml(String(travelDate).slice(0, 10))}">
            <span class="ops-field-hint">Defaults to the inventory row's date.</span>
          </div>
          <div class="ops-field">
            <label for="opsRfReturn">Return date</label>
            <input type="date" id="opsRfReturn" value="${escapeHtml(String(returnDate).slice(0, 10))}">
            <span class="ops-field-hint">Leave blank for a one-way or single-stay booking.</span>
          </div>
        </div>
      </div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>2 · Passenger information</legend>
      <div class="ops-fieldset-body">
        <div class="ops-form-actions" style="margin:0 0 8px;padding:0;border:none">
          <button type="button" class="ops-btn ops-btn-sm" id="opsRfAddPax">+ Add passenger</button>
          <button type="button" class="ops-btn ops-btn-sm" id="opsRfFillDown"
            title="Copy nationality and document country from the first passenger down the list">Fill down</button>
          <span class="ops-field-hint ops-spacer" id="opsRfPaxCount"></span>
        </div>
        <div id="opsRfPaxList"></div>
      </div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>3 · Documents</legend>
      <div class="ops-fieldset-body">
        <p style="margin:0;font-size:11.5px;color:var(--ops-ink-soft)">
          Travel-document data is captured per passenger above — passport number, issuing country,
          issue date and expiry. <b>File upload is not available in this build:</b> the documents
          module is listed as pending by <code>GET /api/status</code> and has no endpoint, so
          there is nothing to upload to yet. A missing passport on an international sector will
          delay ticketing even though it does not block this form.
        </p>
      </div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>4 · Payment summary</legend>
      <div class="ops-fieldset-body" id="opsRfPay">
        ${q ? opsQuoteTable(q) : `
          <dl class="ops-dl">
            <div><dt>Amount on the draft</dt><dd><b>${money(Number(seeded?.total_amount))}</b></dd></div>
          </dl>
          <p class="ops-field-hint" style="margin-top:6px">
            A draft's catalog item is not returned by the request endpoint, so this shows the
            amount stored on the draft rather than a fresh quote.</p>`}
        <p class="ops-field-hint" style="margin-top:8px">
          Nothing is charged here. The payable figure is fixed when the approvals team approves
          the request, which may set a final amount that differs from the quote.
        </p>
      </div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>5 · Approval status</legend>
      <div class="ops-fieldset-body">
        ${editing
          ? `<dl class="ops-dl"><div><dt>Current status</dt><dd>${opsTag(seeded.status, seeded.status_label)}</dd></div></dl>`
          : `<div class="ops-rail-steps">
               <div class="ops-step current"><b>Created</b>on save</div>
               <div class="ops-step"><b>Pending</b>on submit</div>
               <div class="ops-step"><b>Under Review</b>our team</div>
               <div class="ops-step"><b>Approved</b>amount fixed</div>
               <div class="ops-step"><b>Payment Pending</b>you pay</div>
               <div class="ops-step"><b>Ticket Issued</b>documents</div>
             </div>`}
        <p class="ops-field-hint" style="margin-top:8px">
          <b>Save</b> creates a draft, which holds nothing — no seat, no rate, no place in the
          queue. <b>Submit</b> is what puts it in front of the approvals team.
        </p>
      </div>
    </fieldset>

    <fieldset class="ops-fieldset"><legend>6 · Remarks</legend>
      <div class="ops-fieldset-body">
        <div class="ops-form"><div class="ops-field ops-field-full">
          <label for="opsRfRemarks">Remarks</label>
          <textarea id="opsRfRemarks" rows="2"
            placeholder="Anything the approvals or ticketing team needs to know">${escapeHtml(seeded?.remarks || '')}</textarea>
        </div></div>
      </div>
    </fieldset>

    <div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-form-actions" style="margin:0;padding:0;border:none">
        <button type="button" class="ops-btn ops-btn-primary" id="opsRfSubmit">Submit for approval</button>
        <button type="button" class="ops-btn" id="opsRfSave">Save ${editing ? 'changes' : 'as draft'}</button>
        <button type="button" class="ops-btn" id="opsRfReset">Reset</button>
        <button type="button" class="ops-btn" id="opsRfCancel2">Cancel</button>
      </div>
      <div class="ops-msg" id="opsRfMsg"></div>
    </div></div>`;

  /* passengers */
  const list = $('opsRfPaxList');
  const seedPax = seeded?.passengers || [];
  const n = Math.max(1, seedPax.length || opsForm.paxCount || 1);
  for (let i = 0; i < n; i++) opsAddPaxRow(list, i, seedPax[i]);
  opsSyncPaxCount();

  $('opsRfAddPax').addEventListener('click', () => {
    opsAddPaxRow(list, opsAll('[data-ops-pax]', list).length);
    opsSyncPaxCount();
  });
  $('opsRfFillDown').addEventListener('click', opsFillDown);
  $('opsRfSubmit').addEventListener('click', () => opsSaveRequest(true));
  $('opsRfSave').addEventListener('click', () => opsSaveRequest(false));
  $('opsRfReset').addEventListener('click', async () => {
    if (!await opsConfirm('Clear every passenger field on this form?', 'Reset')) return;
    opsInvalidate('new-request');
    opsGo('new-request');
  });
  const cancel = async () => {
    if (!await opsConfirm('Discard this request?', 'Discard', { danger: true })) return;
    opsForm = null;
    opsInvalidate('new-request');
    opsGo(editing ? 'requests' : 'bookings');
  };
  $('opsRfCancel2').addEventListener('click', cancel);
  $('opsRfCancelAll').addEventListener('click', cancel);

  /* Ctrl+S saves the draft. preventDefault marks the event handled so the
     shell does not report "nothing to save". */
  host.addEventListener('ops:save', e => {
    e.preventDefault();
    opsSaveRequest(false);
  });

  /* Autofocus the first name field — the whole point of a data-entry form. */
  setTimeout(() => opsEl('[data-field="first_name"]', list)?.focus(), 0);
}

const OPS_PAX_TITLES = ['Mr', 'Ms', 'Mrs', 'Dr', 'Mstr'];

function opsAddPaxRow(list, index, seed) {
  const el = document.createElement('div');
  el.dataset.opsPax = String(index);
  el.style.cssText = 'padding:8px 0;border-top:1px solid var(--ops-line-soft);';
  if (index === 0) el.style.borderTop = 'none';
  const v = (k, d = '') => escapeHtml(String(seed?.[k] ?? d));
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <b style="font-size:11.5px">Passenger ${index + 1}</b>
      ${seed?.is_cancelled ? '<span class="ops-tag ops-tag-err">Cancelled</span>' : ''}
      <button type="button" class="ops-btn ops-btn-sm ops-btn-link" data-ops-pax-remove
        ${index === 0 ? 'style="visibility:hidden"' : ''}>Remove</button>
    </div>
    <div class="ops-form">
      <div class="ops-field" style="max-width:82px">
        <label>Title</label>
        <select data-field="title">${['', ...OPS_PAX_TITLES].map(t =>
          `<option value="${t}"${seed?.title === t ? ' selected' : ''}>${t || '—'}</option>`).join('')}</select>
      </div>
      <div class="ops-field"><label>First name<span class="ops-req">*</span></label>
        <input type="text" data-field="first_name" value="${v('first_name')}" autocomplete="off"></div>
      <div class="ops-field"><label>Last name<span class="ops-req">*</span></label>
        <input type="text" data-field="last_name" value="${v('last_name')}" autocomplete="off"></div>
      <div class="ops-field"><label>Type</label>
        <select data-field="passenger_type">${opsSelectOptions(['adult', 'child', 'infant'], seed?.passenger_type || 'adult')}</select></div>
      <div class="ops-field"><label>Gender</label>
        <select data-field="gender"><option value="">—</option>
          ${opsSelectOptions(['male', 'female', 'other'], seed?.gender || '')}</select></div>
      <div class="ops-field"><label>Date of birth</label>
        <input type="date" data-field="dob" value="${v('dob').slice(0, 10)}"></div>
      <div class="ops-field"><label>Nationality</label>
        <input type="text" data-field="nationality" value="${v('nationality')}" placeholder="e.g. Indian"></div>
      <div class="ops-field"><label>Passport no.</label>
        <input type="text" data-field="passport_number" value="${v('passport_number')}" autocomplete="off"></div>
      <div class="ops-field"><label>Issuing country</label>
        <input type="text" data-field="passport_issue_country" value="${v('passport_issue_country')}"></div>
      <div class="ops-field"><label>Issue date</label>
        <input type="date" data-field="passport_issue_date" value="${v('passport_issue_date').slice(0, 10)}"></div>
      <div class="ops-field"><label>Expiry</label>
        <input type="date" data-field="passport_expiry" value="${v('passport_expiry').slice(0, 10)}"></div>
      <div class="ops-field"><label>Seat</label>
        <select data-field="seat_preference"><option value="">—</option>
          ${opsSelectOptions(['window', 'aisle', 'middle', 'front_row', 'exit_row'], seed?.seat_preference || '')}</select></div>
      <div class="ops-field"><label>Meal</label>
        <select data-field="meal_preference"><option value="">—</option>
          ${opsSelectOptions(['veg', 'non_veg', 'vegan', 'jain', 'kosher', 'halal'], seed?.meal_preference || '')}</select></div>
    </div>`;
  list.appendChild(el);
  el.querySelector('[data-ops-pax-remove]').addEventListener('click', () => {
    el.remove();
    opsRenumberPax(list);
    opsSyncPaxCount();
  });
}

function opsRenumberPax(list) {
  opsAll('[data-ops-pax]', list).forEach((el, i) => {
    el.dataset.opsPax = String(i);
    el.querySelector('b').textContent = `Passenger ${i + 1}`;
    el.style.borderTop = i === 0 ? 'none' : '1px solid var(--ops-line-soft)';
    el.querySelector('[data-ops-pax-remove]').style.visibility = i === 0 ? 'hidden' : 'visible';
  });
}

function opsSyncPaxCount() {
  const n = opsAll('[data-ops-pax]', $('opsRfPaxList')).length;
  const quoted = opsForm?.quote?.passengers;
  $('opsRfPaxCount').textContent = quoted && n !== quoted
    ? `${n} passenger${n === 1 ? '' : 's'} — the quote was priced for ${quoted}, so the amount will be recalculated on approval.`
    : `${n} passenger${n === 1 ? '' : 's'}`;
}

/* Nationality and issuing country are identical across a family or a corporate
   group, and retyping them for six travellers is exactly the drudgery this
   interface exists to remove. */
function opsFillDown() {
  const cards = opsAll('[data-ops-pax]', $('opsRfPaxList'));
  if (cards.length < 2) return opsToast('Add a second passenger first.');
  let copied = 0;
  ['nationality', 'passport_issue_country'].forEach(f => {
    const src = opsEl(`[data-field="${f}"]`, cards[0]).value;
    if (!src) return;
    cards.slice(1).forEach(c => {
      const el = opsEl(`[data-field="${f}"]`, c);
      if (!el.value) { el.value = src; copied++; }
    });
  });
  opsMsg($('opsRfMsg'), copied
    ? `Copied nationality and issuing country into ${copied} empty field${copied === 1 ? '' : 's'}.`
    : 'Nothing to copy — passenger 1 has no nationality or issuing country, or the others are already filled.',
    copied ? 'muted' : 'warn');
}

/* Exactly the PassengerInput keys. Optional values go as undefined so they are
   omitted from the JSON rather than sent as '' — the backend distinguishes
   absent from empty, and an empty passport number is not the same as none. */
function opsPaxPayload(card) {
  const get = f => opsEl(`[data-field="${f}"]`, card)?.value.trim() || '';
  return {
    title: get('title') || undefined,
    first_name: get('first_name'),
    last_name: get('last_name'),
    gender: get('gender') || undefined,
    dob: get('dob') || undefined,
    passenger_type: get('passenger_type') || 'adult',
    nationality: get('nationality') || undefined,
    passport_number: get('passport_number') || undefined,
    passport_issue_country: get('passport_issue_country') || undefined,
    passport_issue_date: get('passport_issue_date') || undefined,
    passport_expiry: get('passport_expiry') || undefined,
    seat_preference: get('seat_preference') || undefined,
    meal_preference: get('meal_preference') || undefined,
    special_services: [],
  };
}

function opsFlagMissingNames() {
  let first = null;
  opsAll('[data-ops-pax]', $('opsRfPaxList')).forEach(card => {
    ['first_name', 'last_name'].forEach(f => {
      const el = opsEl(`[data-field="${f}"]`, card);
      const bad = !el.value.trim();
      el.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (bad && !first) first = el;
    });
  });
  first?.focus();
  return !!first;
}

async function opsSaveRequest(finalize) {
  const msg = $('opsRfMsg');
  const buttons = ['opsRfSubmit', 'opsRfSave'].map($);

  if (opsFlagMissingNames()) {
    return opsMsg(msg, 'Every passenger needs a first and last name.', 'err');
  }
  const cards = opsAll('[data-ops-pax]', $('opsRfPaxList'));
  if (!cards.length) return opsMsg(msg, 'Add at least one passenger.', 'err');
  const passengers = cards.map(opsPaxPayload);

  const travelDate = $('opsRfDate').value;
  const returnDate = $('opsRfReturn').value;
  const remarks = $('opsRfRemarks').value.trim();
  if (returnDate && travelDate && returnDate < travelDate) {
    return opsMsg(msg, 'The return date cannot be before the travel date.', 'err');
  }

  buttons.forEach(b => { b.disabled = true; });
  opsMsg(msg, finalize ? 'Submitting…' : 'Saving…', 'muted');

  try {
    let requestId = opsForm.draftId;
    let requestNumber = opsForm.seeded?.request_number;

    if (requestId) {
      /* Editing: two calls, because the draft endpoint takes the scalar fields
         and the passenger list is replaced wholesale by its own route. */
      await OpsApi.updateDraft(requestId, { remarks, travelDate, returnDate });
      await OpsApi.replacePassengers(requestId, passengers);
    } else {
      const created = await OpsApi.createRequest({
        catalogItemId: opsForm.quote.item.id,
        passengers,
        travelDate,
        returnDate,
        remarks,
      });
      requestId = created.request.id;
      requestNumber = created.request.request_number;
      /* Remember the draft so a second Save updates it instead of creating a
         duplicate request — the single most costly mistake this form could make. */
      opsForm.draftId = requestId;
      opsForm.seeded = created.request;
    }

    if (finalize) {
      await OpsApi.submitRequest(requestId);
      opsRequestSubmitted(requestNumber);
    } else {
      opsMsg(msg, `Draft ${requestNumber} saved. Submit it here or from Requests → Drafts when ready.`, 'ok');
    }
    opsAfterWrite();
  } catch (err) {
    opsMsg(msg, opsError(err, 'The request could not be saved.'), 'err');
  } finally {
    buttons.forEach(b => { if (b) b.disabled = false; });
  }
}

/* A confirmation screen rather than a toast: the request number is the one
   thing that needs writing down, so it must not vanish on a timer. */
function opsRequestSubmitted(requestNumber) {
  const host = $('ops-new-request');
  host.innerHTML = `
    <div class="ops-page-head"><div>
      <h1>Submitted for approval</h1>
      <p>Request <span class="ops-ref">${escapeHtml(requestNumber)}</span> is with the approvals team.</p>
    </div></div>
    <div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-ok" style="margin:0">
        <b>${escapeHtml(requestNumber)}</b> has been submitted. It will move to Payment Pending once
        approved, and the payable amount is confirmed at that point.
      </div>
      <div class="ops-form-actions">
        <button type="button" class="ops-btn ops-btn-primary" id="opsRsList">Open Bookings</button>
        <button type="button" class="ops-btn" id="opsRsNew">Raise another</button>
      </div>
    </div></div>`;
  $('opsRsList').addEventListener('click', () => { opsForm = null; opsInvalidate('new-request'); opsGo('bookings'); });
  $('opsRsNew').addEventListener('click', () => { opsForm = null; opsInvalidate('new-request'); opsGo('flights'); });
}
