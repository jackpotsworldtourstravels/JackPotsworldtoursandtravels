'use strict';
/* Operations Portal — Payments and Wallet.
   ===========================================================================
   Three different questions, three different endpoints, three tabs — because
   they are genuinely not the same list:

     Verification queue  GET /api/admin/payments/pending  payment.verify
     All payments        GET /api/admin/payments          payment.view
     Payable now         GET /api/requests?status=payment_pending  payment.pay

   A LIMITATION THAT IS STATED, NOT PAPERED OVER
   PaymentSummary is {id, amount, currency, method, transaction_id, status,
   paid_date} — there is no merchant_id and no request reference on it. The
   join only exists in the other direction: GET /api/requests/{id} returns that
   request's payments. So the payment grids cannot show whose money a row is,
   and pretending otherwise (by guessing from the amount, say) would be worse
   than saying so. Each row therefore carries a "Find booking" action that
   searches the request register for the transaction reference, and the panel
   note explains why that indirection exists.

   THE COUNTER THAT MEANS THE OPPOSITE OF WHAT IT LOOKS LIKE
   `pending_payments_count` on the merchant dashboard counts payments the
   merchant has ALREADY SUBMITTED and that are awaiting verification. It is not
   money owed. Money owed is the total of requests at `payment_pending`. Both
   are shown on the Wallet screen, labelled, because reading one as the other
   is a genuine accounting error.
   =========================================================================== */

function opsInitPayments() {
  const host = $('ops-payments');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Payments</h1>
        <p>Verification queue, the full ledger, and what is payable right now.</p>
      </div>
    </div>
    <div id="opsPaymentsTabs"></div>`;

  OpsTabs($('opsPaymentsTabs'), [
    {
      id: 'queue', label: 'Verification queue', when: opsCan('payment.verify'),
      render: body => opsPendingPaymentsGrid(body),
    },
    {
      id: 'all', label: 'All payments', when: opsCan('payment.view') && opsIsStaff(),
      render: body => opsAllPaymentsGrid(body),
    },
    {
      /* The brief's "Pending Payments" for a merchant: approved bookings with
         money still to send. Distinct from the staff verification queue above,
         which is payments already sent awaiting a check. */
      id: 'payable', label: 'Pending payments', when: opsCan('payment.pay'),
      render: body => opsPayablesGrid(body),
    },
    {
      /* Covers the brief's "Completed Payments" and "Payment History" both —
         one collection pass with a status filter, rather than two tabs firing
         the same 20-plus detail calls to show subsets of one another. */
      id: 'history', label: 'Payment history', when: opsCan('payment.view') && !opsIsStaff(),
      render: body => opsMerchantPaymentHistory(body),
    },
  ], { hash: 'payments' });
}

/* --------------------------------------------------------- shared columns */

function opsPaymentColumns({ withActions }) {
  const cols = [
    { key: 'id', label: 'Payment ID', align: 'right', nowrap: true },
    { key: 'method', label: 'Method', value: r => opsLabel(r.method) },
    { key: 'transaction_id', label: 'Transaction ref.', nowrap: true,
      render: r => (r.transaction_id ? `<span class="ops-mono">${escapeHtml(r.transaction_id)}</span>` : '<span class="ops-muted">—</span>'),
      text: r => r.transaction_id || '' },
    OpsCol.money('amount', 'Amount'),
    { key: 'currency', label: 'Ccy', nowrap: true, hidden: true },
    OpsCol.status('status', 'Status'),
    OpsCol.dateTime('paid_date', 'Paid'),
  ];
  if (withActions) {
    cols.push(OpsCol.actions([
      { act: 'verify', label: 'Verify', primary: true, when: r => r.status === 'pending' && opsCan('payment.verify') },
      { act: 'reject', label: 'Reject', danger: true, when: r => r.status === 'pending' && opsCan('payment.verify') },
      { act: 'refund', label: 'Refund', when: r => r.status === 'success' && opsCan('payment.manage') },
      { act: 'find', label: 'Find booking', when: r => !!r.transaction_id && opsCan('ticket.view') },
    ]));
  }
  return cols;
}

const OPS_PAYMENT_NOTE = `
  <b>These rows carry no merchant or booking reference</b> — <code>PaymentSummary</code> is
  amount, method, transaction id, status and date, and nothing else. The link to a booking
  exists only in the other direction (<code>GET /api/requests/{id}</code> lists that request's
  payments), which is what <b>Find booking</b> uses: it searches the request register for the
  transaction reference. Verifying from inside a request's own drawer is the shorter path when
  you already have the booking open.`;

/* Search the request register for a payment's transaction reference. This is
   best-effort by construction: list_requests searches PNR, request number,
   booking reference, ticket number, title, destination and passenger — NOT
   transaction ids — so a hit only happens when the reference was also written
   into one of those fields. The dialog says so rather than reporting "not
   found" as if the booking did not exist. */
async function opsFindBookingForPayment(payment) {
  const body = opsOpenModal(`Payment ${payment.id} — find the booking`,
    opsSpinner('Searching the request register…'),
    '<span class="ops-spacer"></span><button type="button" class="ops-btn" id="opsFbClose">Close</button>');
  $('opsFbClose').addEventListener('click', opsCloseModal);
  try {
    const d = await OpsApi.listRequests({ search: payment.transaction_id, page_size: 10 });
    const rows = d.items || [];
    body.innerHTML = rows.length ? `
      <p style="margin:0 0 8px;font-size:12px">Requests matching
        <span class="ops-mono">${escapeHtml(payment.transaction_id)}</span>:</p>
      <div class="ops-table-wrap"><table class="ops-table">
        <thead><tr><th>Request</th><th>Title</th><th>Status</th><th class="ops-num">Amount</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td><span class="ops-ref">${escapeHtml(r.request_number)}</span></td>
          <td>${escapeHtml(r.title || '—')}</td>
          <td>${opsTag(r.status, r.status_label)}</td>
          <td class="ops-num">${money(Number(r.total_amount))}</td>
          <td class="ops-actions"><button type="button" class="ops-btn ops-btn-sm ops-btn-primary" data-ops-fb="${r.id}">Open</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : `
      <div class="ops-msg ops-msg-warn" style="margin:0">
        No request matches this transaction reference. That is expected rather than surprising:
        the request search covers PNR, request number, booking reference, ticket number, title,
        destination and passenger details — it does not index transaction ids. Open the booking
        from the register and use the Payments section of its drawer instead.
      </div>`;
    opsAll('[data-ops-fb]', body).forEach(b =>
      b.addEventListener('click', () => opsOpenRequest(b.dataset.opsFb)));
  } catch (err) {
    body.innerHTML = `<div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'The search failed.'))}</div>`;
  }
}

function opsPaymentActions(gridRef) {
  return {
    verify: row => opsVerifyDialog(row.id, true, () => { opsCloseModal(); gridRef().reload(); }),
    reject: row => opsVerifyDialog(row.id, false, () => { opsCloseModal(); gridRef().reload(); }),
    refund: row => opsRefundDialog(row.id, row.amount, () => { opsCloseModal(); gridRef().reload(); }),
    find: row => opsFindBookingForPayment(row),
  };
}

/* ------------------------------------------------------ verification queue */

function opsPendingPaymentsGrid(host) {
  let grid = null;
  grid = OpsGrid({
    id: 'pay-queue',
    mount: host,
    title: 'Payments awaiting verification',
    exportName: 'payments-awaiting-verification',
    mode: 'server',
    searchable: false,   /* the pending endpoint takes page/page_size only */
    filters: [],
    columns: opsPaymentColumns({ withActions: true }),
    selectable: true,
    bulkActions: [{
      label: 'Verify selected',
      run: async (rows, api) => {
        const eligible = rows.filter(r => r.status === 'pending');
        if (!eligible.length) return opsToast('Only pending payments can be verified.', 'err');
        if (!await opsConfirm(
          `Verify ${eligible.length} payment${eligible.length === 1 ? '' : 's'} totalling `
          + `${money(eligible.reduce((s, r) => s + Number(r.amount), 0))}? Each linked request moves to Paid.`,
          'Verify all')) return;
        let ok = 0;
        const errs = [];
        for (const p of eligible) {
          try { await OpsApi.verifyPayment(p.id, { approve: true }); ok++; }
          catch (err) { errs.push(`Payment ${p.id}: ${opsError(err)}`); }
        }
        api.clearSelection();
        opsAfterWrite();
        api.reload();
        if (errs.length) opsToast(`${ok} verified, ${errs.length} failed: ${errs[0]}`, 'err');
        else opsToast(`${ok} payment${ok === 1 ? '' : 's'} verified.`, 'ok');
      },
    }],
    note: `Verifying moves the linked request to <b>Paid</b>. Rejecting marks the payment failed
      and leaves the request at Payment Pending so the merchant can pay again — it does not
      cancel anything. ${OPS_PAYMENT_NOTE}`,
    emptyText: 'Nothing is waiting for verification.',
    fetch: async ({ page, pageSize }) => {
      const d = await OpsApi.pendingPayments({ page, page_size: pageSize });
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: opsPaymentActions(() => grid),
    onLoad: res => {
      /* A running total of the money on this page — the first thing a finance
         clerk wants and the endpoint does not provide. */
      const rows = res.rows || [];
      const sum = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      const head = opsEl('.ops-panel-tools', host);
      if (head) {
        head.innerHTML = `<span class="ops-grid-count">${rows.length} on this page · ${money(sum)}</span>`;
      }
    },
  });
  return grid;
}

/* ----------------------------------------------------------- all payments */

function opsAllPaymentsGrid(host) {
  let grid = null;
  grid = OpsGrid({
    id: 'pay-all',
    mount: host,
    title: 'Payment ledger',
    exportName: 'payments',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Transaction reference or method…',
    filters: [
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'Any status',
        options: OPS_PAYMENT_STATUSES.map(s => ({ value: s, label: opsLabel(s) })) },
      { key: 'merchant_id', label: 'Merchant ID', type: 'number', placeholder: 'any' },
      { key: 'date_from', label: 'Created from', type: 'date' },
      { key: 'date_to', label: 'Created to', type: 'date' },
    ],
    columns: opsPaymentColumns({ withActions: true }),
    exportServer: opsCan('report.export') ? {
      csv: q => opsExportPayments('csv', q),
      xlsx: q => opsExportPayments('xlsx', q),
      pdf: q => opsExportPayments('pdf', q),
    } : null,
    note: `Search here matches the transaction reference or the payment method only — those are
      the two columns <code>/api/admin/payments</code> puts behind <code>search</code>. Unlike the
      request register, the date filters here really are the <b>created</b> date.
      ${OPS_PAYMENT_NOTE}`,
    emptyText: 'No payments match these criteria.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      if (f.status) params.status = f.status;
      if (f.merchant_id) params.merchant_id = Number(f.merchant_id);
      if (f.date_from) params.date_from = f.date_from;
      if (f.date_to) params.date_to = f.date_to;
      const d = await OpsApi.listPayments(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: opsPaymentActions(() => grid),
    onLoad: res => {
      const rows = res.rows || [];
      const ok = rows.filter(r => r.status === 'success');
      const head = opsEl('.ops-panel-tools', host);
      if (head) {
        head.innerHTML = `<span class="ops-grid-count">${res.total} records · this page:
          ${money(ok.reduce((s, r) => s + Number(r.amount || 0), 0))} successful</span>`;
      }
    },
  });
  return grid;
}

/* The payments report ignores `status` and `search` server-side (see
   reports._payment_rows), so only the parameters it actually honours are sent —
   an export that silently ignored a filter the operator set would be worse
   than one that never offered it. */
function opsExportPayments(format, query) {
  const f = query.filters || {};
  const params = { type: 'payments', format };
  if (f.date_from) params.date_from = f.date_from;
  if (f.date_to) params.date_to = f.date_to;
  if (f.merchant_id) params.merchant_id = Number(f.merchant_id);
  if (f.status || query.search) {
    opsToast('The server-side payments report covers dates and merchant only — the status filter and search are not applied to it.', 'err');
  }
  return OpsApi.exportReport(params);
}

/* ------------------------------------------------------------- payables */

function opsPayablesGrid(host) {
  let grid = null;
  grid = OpsGrid({
    id: 'pay-due',
    mount: host,
    title: 'Payable now',
    exportName: 'payables',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Request no., PNR, passenger…',
    filters: [
      { key: 'request_type', label: 'Type', type: 'select', anyLabel: 'Any type',
        options: ['booking', ...OPS_SERVICE_REQUEST_TYPES].map(t => ({ value: t, label: opsLabel(t) })) },
      { key: 'travel_type', label: 'Travel', type: 'select', anyLabel: 'Any',
        options: OPS_TRAVEL_TYPES.map(t => ({ value: t, label: opsLabel(t) })) },
    ],
    columns: [
      OpsCol.ref('request_number', 'Request'),
      { key: 'title', label: 'Description', value: r => r.title },
      ...(opsIsStaff() ? [{ key: 'merchant_name', label: 'Merchant', value: r => r.merchant_name }] : []),
      OpsCol.enumLabel('request_type', 'Type'),
      { key: 'passengers', label: 'Passenger(s)', value: r => opsPassengerNames(r) },
      OpsCol.date('travel_date', 'Travel date'),
      OpsCol.money('total_amount', 'Amount due'),
      OpsCol.actions([
        { act: 'pay', label: 'Pay', primary: true, when: r => Number(r.total_amount) > 0 },
        { act: 'open', label: 'Open' },
      ]),
    ],
    onRow: r => opsOpenRequest(r.id),
    note: `Everything at <b>Payment Pending</b>, which is what "owed" means in this system.
      Service requests appear here too and that is correct — <code>record_payment</code> gates on
      status alone, not on request type, so an approved change request is payable through the
      same route. A row showing <b>₹0</b> cannot be paid: the API rejects a payment of zero, so
      it is waiting for the approvals team to set a final amount.`,
    emptyText: 'Nothing is awaiting payment.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize, status: 'payment_pending' };
      if (search) params.search = search;
      if (f.request_type) params.request_type = f.request_type;
      if (f.travel_type) params.travel_type = f.travel_type;
      const d = await OpsApi.listRequests(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: {
      pay: row => opsPayDialog(row, () => { opsCloseModal(); grid.reload(); }),
      open: row => opsOpenRequest(row.id),
    },
    onLoad: res => {
      const rows = res.rows || [];
      const due = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
      const zero = rows.filter(r => !(Number(r.total_amount) > 0)).length;
      const head = opsEl('.ops-panel-tools', host);
      if (head) {
        head.innerHTML = `<span class="ops-grid-count">${money(due)} due on this page${
          zero ? ` · ${zero} awaiting an amount` : ''}${
          res.total > rows.length ? ` · ${res.total} rows in total` : ''}</span>`;
      }
    },
  });
  return grid;
}

/* How many requests the merchant history reads payments from. Each one is a
   separate detail call, so this is the ceiling on that fan-out. */
const OPS_MPH_LIMIT = 24;

/* A merchant cannot call /api/admin/payments (it needs payment.view, which a
   merchant HAS, but the route is platform-wide by design and returns every
   merchant's rows — it is registered under /api/admin and the portal does not
   offer a merchant a ledger it has no scoped endpoint for). What a merchant
   can see is the payments recorded against its own requests, so its history is
   assembled from those. Bounded to one page of requests, and it says so. */
async function opsMerchantPaymentHistory(host) {
  host.innerHTML = `<div class="ops-panel">
    <div class="ops-panel-head"><h2>My payment history</h2>
      <div class="ops-panel-tools">
        <span class="ops-grid-flabel">Status</span>
        <select id="opsMphStatus" title="Filter by payment status">
          <option value="">All</option>
          <option value="success">Completed</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </select>
        <span class="ops-grid-count" id="opsMphCount">—</span>
      </div></div>
    <div class="ops-panel-body ops-flush" id="opsMphBody">${opsSpinner('Collecting payments…')}</div>
    <div class="ops-panel-note">
      Assembled from your requests that have reached a payment stage, because the payment ledger
      endpoint is platform-wide rather than merchant-scoped. It reads the ${OPS_MPH_LIMIT} most
      recent such requests, so it is your recent history rather than all of it. The status filter
      applies to the rows already collected — one fan-out, filtered in the browser, rather than a
      fresh pass per status.
    </div>
  </div>`;

  try {
    /* Only the statuses that can have a payment behind them, newest first, and
       capped — this costs one detail call per request, so an uncapped version
       would fire a hundred requests to draw one table. */
    const stages = ['payment_pending', 'paid', 'ticket_issued', 'completed'];
    const pages = await Promise.all(stages.map(s =>
      OpsApi.listRequests({ status: s, page_size: 10 }).catch(() => ({ items: [] }))));
    const requests = pages.flatMap(p => p.items || [])
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const details = await Promise.all(requests.slice(0, OPS_MPH_LIMIT).map(r =>
      OpsApi.getRequest(r.id).then(d => ({ r, payments: d.payments || [] })).catch(() => null)));

    const rows = [];
    details.filter(Boolean).forEach(({ r, payments }) => {
      payments.forEach(p => rows.push({ ...p, request_number: r.request_number, request_id: r.id }));
    });
    rows.sort((a, b) => new Date(b.paid_date || 0) - new Date(a.paid_date || 0));

    /* Invoice download and proof upload are both in the brief and neither has
       a route: nothing on the server generates a PDF invoice, and the pay
       endpoint takes a JSON body (amount, method, transaction id) with no file
       field. Rendered per row, disabled, reason on hover. */
    const INVOICE_WHY = 'Invoice generation not yet available — no endpoint produces an invoice document.';
    const PROOF_WHY = 'Proof upload is not yet supported — the payment endpoint accepts a transaction reference, not a file.';

    const paint = () => {
      const want = $('opsMphStatus').value;
      const shown = want ? rows.filter(r => r.status === want) : rows;
      const paid = shown.filter(r => r.status === 'success').reduce((s, r) => s + Number(r.amount || 0), 0);
      $('opsMphCount').textContent =
        `${shown.length} payment${shown.length === 1 ? '' : 's'}${want ? ` of ${rows.length}` : ''} · ${money(paid)} verified`;

      $('opsMphBody').innerHTML = shown.length ? `
        <div class="ops-table-wrap"><table class="ops-table">
          <thead><tr><th>Request</th><th>Payment ID</th><th>Method</th><th>Transaction</th>
            <th class="ops-num">Amount</th><th>Status</th><th>Date</th><th class="ops-actions">Action</th></tr></thead>
          <tbody>${shown.map(p => `<tr>
            <td><span class="ops-ref">${escapeHtml(p.request_number)}</span></td>
            <td class="ops-num">${p.id}</td>
            <td>${escapeHtml(opsLabel(p.method) || '—')}</td>
            <td class="ops-mono">${escapeHtml(p.transaction_id || '—')}</td>
            <td class="ops-num">${money(Number(p.amount))}</td>
            <td>${opsTag(p.status)}</td>
            <td class="ops-nowrap">${escapeHtml(p.paid_date ? fmtDateTime(p.paid_date) : '—')}</td>
            <td class="ops-actions">
              <button type="button" class="ops-btn ops-btn-sm" data-ops-mph="${p.request_id}">Open</button>
              <button type="button" class="ops-btn ops-btn-sm" disabled title="${escapeHtml(INVOICE_WHY)}">Invoice</button>
              <button type="button" class="ops-btn ops-btn-sm" disabled title="${escapeHtml(PROOF_WHY)}">Proof</button>
            </td>
          </tr>`).join('')}</tbody>
        </table></div>`
        : `<div class="ops-empty">${want ? 'No payments with that status.' : 'No payments recorded yet.'}</div>`;

      opsAll('[data-ops-mph]', host).forEach(b =>
        b.addEventListener('click', () => opsOpenRequest(b.dataset.opsMph)));
    };

    $('opsMphStatus').addEventListener('change', paint);
    paint();
  } catch (err) {
    $('opsMphBody').innerHTML = `<div class="ops-empty">${escapeHtml(opsError(err, 'Could not assemble your payment history.'))}</div>`;
  }
}

/* ===========================================================================
   WALLET
   =========================================================================== */

function opsInitWallet() {
  const host = $('ops-wallet');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Wallet</h1>
        <p>Balance, sanctioned credit, and what is actually owed.</p>
      </div>
    </div>
    <div id="opsWalletBody">${opsSpinner()}</div>`;

  /* An account with a merchant sees its own wallet; platform staff see the
     wallet column across every merchant, which is the only cross-merchant
     view of the same two figures that exists. */
  if (!opsMerchantId()) return opsMerchantWallets($('opsWalletBody'));

  /* The brief's Wallet screen is five things. Two of them have no endpoint, so
     they are their own tabs that say so rather than being quietly dropped:

       Current balance / Credit limit  merchant record, via the dashboard  REAL
       Recent transactions             payments against own requests       REAL
       Top-up                          no route                        PENDING
       Settlement history              no route                        PENDING
       Withdrawal history              no route                        PENDING

     There is no wallet-ledger table at all — `wallet_balance` is a single
     Numeric column on `merchants` that the platform sets. So there is nothing
     to page through for settlements or withdrawals, and no endpoint that would
     move money either way. `WALLET_TOPUP` exists as a PaymentType enum value
     but nothing constructs one: the only payment-creating route is
     POST /api/requests/{id}/pay, which needs a request to pay for.

     Recent transactions reuses opsMerchantPaymentHistory — the same function
     the Payments screen renders, not a second copy of it. */
  OpsTabs($('opsWalletBody'), [
    { id: 'overview', label: 'Overview', render: body => opsOwnWallet(body) },
    { id: 'transactions', label: 'Recent transactions',
      render: body => opsMerchantPaymentHistory(body) },
    { id: 'settlements', label: 'Settlement history',
      render: body => {
        body.innerHTML = opsPendingPanel('Settlement history',
          'Backend integration pending.',
          'No settlement records exist on the server. The wallet is a single balance field on your '
          + 'company record rather than a ledger, so there is no settlement run to list. Payments '
          + 'you have made are under Recent transactions.');
      } },
    { id: 'withdrawals', label: 'Withdrawal history',
      render: body => {
        body.innerHTML = opsPendingPanel('Withdrawal history',
          'Backend integration pending.',
          'Withdrawals are not supported — there is no endpoint to request one and no record of '
          + 'past withdrawals to show. Refunds, which are a different thing, are issued by an '
          + 'administrator against a specific payment and appear under Recent transactions.');
      } },
  ], { hash: 'wallet' });
}

async function opsOwnWallet(host) {
  try {
    const [dash, due] = await Promise.all([
      OpsApi.merchantDashboard(),
      OpsApi.listRequests({ status: 'payment_pending', page_size: OPS_PAGE_MAX }).catch(() => ({ items: [], total: 0 })),
    ]);
    const dueRows = due.items || [];
    const dueTotal = dueRows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const capped = (due.total ?? dueRows.length) > dueRows.length;

    host.innerHTML = `
      <div class="ops-panel">
        <div class="ops-panel-head"><h2>${escapeHtml(OpsSession.user?.merchant_name || 'Your company')}</h2>
          <div class="ops-panel-tools">
            <button type="button" class="ops-btn ops-btn-sm" id="opsWalletTopup">Top-up</button>
          </div>
        </div>
        <div class="ops-panel-body">
          <div class="ops-kpis">
            ${opsKpi({ label: 'Wallet balance', value: money(Number(dash.wallet_balance)), sub: 'available' })}
            ${opsKpi({ label: 'Credit limit', value: money(Number(dash.credit_limit)), sub: 'sanctioned' })}
            ${opsKpi({ label: 'Owed now', value: money(dueTotal), tone: dueTotal ? 'warn' : '',
              sub: capped ? `${dueRows.length} of ${due.total} rows` : `${dueRows.length} request(s)` })}
            ${opsKpi({ label: 'In verification', value: dash.pending_payments_count || 0,
              tone: dash.pending_payments_count ? 'warn' : '', sub: 'payments submitted' })}
          </div>
        </div>
        <div class="ops-panel-note">
          <b>Owed now</b> is the total of your requests at Payment Pending${capped ? ' — capped at the API\'s 100-row page, so the real figure is higher' : ''}.
          <b>In verification</b> is a different thing: payments you have already submitted that an
          administrator has not checked yet. Neither figure is a statement of account —
          <code>wallet_balance</code> and <code>credit_limit</code> are the authoritative fields and
          are set by the platform, not derived here.
        </div>
      </div>
      <div id="opsWalletDue"></div>`;

    $('opsWalletTopup').addEventListener('click', opsWalletTopupDialog);

    opsBuildRequestGrid($('opsWalletDue'), {
      id: 'wallet-due',
      title: 'Requests awaiting payment',
      exportName: 'amount-owed',
      fixed: { status: 'payment_pending' },
      bulk: false,
      note: `The same rows as Payments → Payable now. Open one to record a payment against it.`,
    });
  } catch (err) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'Could not load the wallet.'))}</div>
    </div></div>`;
  }
}

/* The top-up form, complete and inert. The dialog opens and the fields work —
   an operator can see exactly what the flow will ask for — but Confirm is
   disabled because no endpoint accepts it. Deliberately NOT wired to a
   localStorage stand-in or an optimistic balance bump: a top-up that appears
   to succeed and then vanishes is worse than one that never started. */
function opsWalletTopupDialog() {
  opsOpenModal('Wallet top-up', `
    <div class="ops-form ops-form-2">
      <div class="ops-field">
        <label for="opsTuAmount">Amount<span class="ops-req">*</span></label>
        <input type="number" id="opsTuAmount" min="1" step="0.01" placeholder="0.00">
      </div>
      <div class="ops-field">
        <label for="opsTuMethod">Method<span class="ops-req">*</span></label>
        <select id="opsTuMethod">
          <option value="bank_transfer">Bank transfer / NEFT</option>
          <option value="upi">UPI</option>
          <option value="cheque">Cheque</option>
        </select>
      </div>
      <div class="ops-field ops-field-full">
        <label for="opsTuRef">Transaction reference</label>
        <input type="text" id="opsTuRef" placeholder="UTR / cheque number">
      </div>
      <div class="ops-field ops-field-full">
        <label for="opsTuNote">Note</label>
        <input type="text" id="opsTuNote" placeholder="Anything the finance desk should know">
      </div>
    </div>
    <div class="ops-pending-block" style="margin-top:10px">
      <p><b>Backend integration pending — this cannot be submitted yet.</b></p>
      <p class="ops-muted">
        There is no wallet top-up endpoint on the server. The wallet is a single balance field on
        your company record that the platform sets; nothing exists to credit it from here.
        To add funds, send your remittance to the finance desk and they will credit the balance.
      </p>
    </div>`,
    `<span class="ops-spacer"></span>
     <button type="button" class="ops-btn" id="opsTuCancel">Cancel</button>
     <button type="button" class="ops-btn ops-btn-primary" disabled
             title="Backend integration pending">Confirm top-up</button>`);
  $('opsTuCancel').addEventListener('click', opsCloseModal);
}

function opsMerchantWallets(host) {
  if (!opsCan('merchant.view')) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-info" style="margin:0">
        Your account is not linked to a merchant, so it has no wallet of its own, and it cannot
        view merchants' wallets either (that needs <code>merchant.view</code>).
      </div></div></div>`;
    return;
  }
  host.innerHTML = '<div id="opsWalletGrid"></div>';

  return OpsGrid({
    id: 'wallet-merchants',
    mount: $('opsWalletGrid'),
    title: 'Merchant wallets and credit limits',
    exportName: 'merchant-wallets',
    mode: 'server',
    searchable: true,
    searchPlaceholder: 'Company, code or email…',
    filters: [
      { key: 'status', label: 'Status', type: 'select', anyLabel: 'Any status',
        options: OPS_MERCHANT_STATUSES.map(s => ({ value: s, label: opsLabel(s) })) },
    ],
    columns: [
      OpsCol.ref('merchant_code', 'Code'),
      { key: 'company_name', label: 'Company' },
      OpsCol.enumLabel('company_type', 'Type'),
      OpsCol.money('wallet_balance', 'Wallet'),
      OpsCol.money('credit_limit', 'Credit limit'),
      { key: 'user_count', label: 'Users', align: 'right' },
      OpsCol.status(),
      OpsCol.actions([
        { act: 'view', label: 'Open' },
        { act: 'limit', label: 'Set credit limit', when: () => opsCan('merchant.edit') },
      ]),
    ],
    note: `Wallet balance and credit limit are fields on the merchant record. There is no
      transaction-level wallet ledger endpoint, so this is the current position rather than a
      statement — movements are visible as payments against individual requests.`,
    emptyText: 'No merchants match these criteria.',
    fetch: async ({ page, pageSize, search, filters: f }) => {
      const params = { page, page_size: pageSize };
      if (search) params.search = search;
      if (f.status) params.status = f.status;
      const d = await OpsApi.listMerchants(params);
      return { rows: d.items || [], total: d.total ?? 0 };
    },
    actions: {
      view: row => opsOpenMerchant(row.id),
      limit: async row => {
        const v = await opsPrompt({
          title: `Credit limit — ${row.company_name}`,
          label: `New credit limit in ₹ (currently ${money(Number(row.credit_limit))})`,
          required: true, confirmLabel: 'Save',
        });
        if (v === null) return;
        const n = Number(v);
        if (!(n >= 0)) return opsToast('Enter a number of zero or more.', 'err');
        try {
          await OpsApi.updateMerchant(row.id, { credit_limit: n });
          opsToast(`Credit limit for ${row.company_name} set to ${money(n)}.`, 'ok');
          opsInvalidate('merchants');
          opsRefreshIfVisible('wallet');
        } catch (err) { opsToast(opsError(err, 'The change failed.'), 'err'); }
      },
    },
  });
}
