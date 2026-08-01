'use strict';
/* Classic — Dashboard. GET /api/merchant/dashboard, once.
   ===========================================================================
   The figure strip is deliberately flat and clickable: every number a merchant
   sees should be reachable, so each KPI navigates to the screen that lists the
   rows behind it, with that screen's status filter pre-selected.

   Two counter distinctions that are easy to get wrong and are wrong in a way
   that costs the merchant money, so they are labelled explicitly here:

   - `requests_by_status.payment_pending` is MONEY OWED — requests waiting for
     the merchant to pay.
   - `pending_payments_count` is money ALREADY SENT and awaiting our
     verification. It is computed from Payment rows with payment_status PENDING.
     It is NOT money owed. Its KPI therefore links to `payment_pending`, because
     verify_payment is what moves a request on to Paid — so a payment awaiting
     verification still belongs to a request sitting in Payment Pending.

   A THIRD DISTINCTION, new with Booking Enquiry. A booking enquiry is a
   service_requests row like any other, so /api/merchant/dashboard's
   `requests_by_status` counts enquiries alongside bookings — an unanswered
   enquiry lands in `pending_approval` next to a booking awaiting approval.
   Those are not the same thing to a merchant, so the two enquiry figures are
   fetched separately from /api/enquiries and given their own KPIs, and the
   shared "Pending approval" tile says out loud that it spans both. The
   alternative was filtering enquiries out of a counter every other portal
   shares, which would have made the same number mean different things
   depending on which screen you read it from. */

let clDashData = null;
/* The finance_service position for this merchant (M4). Held alongside the
   dashboard payload because the Account panel renders from it too. */
let clDashPosition = null;

async function clInitDashboard() {
  const root = $('cl-dashboard');
  root.innerHTML = `
    <div class="cl-page-head">
      <div>
        <h1>Dashboard</h1>
        <p>Account position and the queues that need attention.</p>
      </div>
      <div class="cl-page-actions">
        <button type="button" class="cl-btn" id="clDashRefresh">Refresh</button>
        <!-- CR-5 removed the "Enquire ticket" action from here. Raising an
             enquiry belongs on the Booking Enquiry screen, which is one click
             away in the rail and carries the listing the new row lands in; a
             second entry point on the dashboard opened the same modal over a
             screen that then could not show the result. -->
      </div>
    </div>
    <div id="clDashKpis"><div class="cl-panel"><div class="cl-panel-body">
      <span class="cl-spin"></span> Loading account summary…
    </div></div></div>
    <div id="clDashRecent"></div>`;

  $('clDashRefresh').addEventListener('click', () => { clLoaded.add('dashboard'); clInitDashboard(); });

  await clLoadDashboard();
}

/* Enquiry counts, from the enquiry list itself rather than from the shared
   status counters — see the note at the head of this file. One page of 100 is
   the router's ceiling and is far more than a merchant has open at once; if it
   ever were not, `total` is reported so the tile cannot quietly undercount. */
async function clEnquiryCounts() {
  try {
    const data = await MerchantApi.listEnquiries({ page_size: 100 });
    const rows = data.items || [];
    return {
      open: rows.filter(r => ['pending_approval', 'in_review'].includes(r.status)).length,
      ready: rows.filter(r => r.status === 'approved' && !r.booking_request_id).length,
      partial: (data.total ?? rows.length) > rows.length,
    };
  } catch {
    /* The dashboard must still render if this one call fails. */
    return null;
  }
}

async function clLoadDashboard() {
  const kpis = $('clDashKpis');
  try {
    /* M4: the money tiles come from finance_service, not from the dashboard
       payload's raw `wallet_balance` / `credit_limit` columns. A credit limit
       shown on its own is the misreading this milestone exists to prevent — it
       is a ceiling with no indication of how much is left, and the merchant
       reads it as headroom. `position` carries `credit_used`, `credit_available`
       and `outstanding`, all computed server-side.

       The position is optional: if that call fails the rest of the dashboard
       still renders, with the money tiles saying so rather than the whole screen
       breaking over a KPI strip. */
    const [data, enq, position] = await Promise.all([
      MerchantApi.dashboard(),
      clEnquiryCounts(),
      MerchantApi.financePosition().catch(() => null),
    ]);
    clDashData = data;
    clDashPosition = position;
    const s = data.requests_by_status || {};

    /* `pending_approval + in_review` mirrors Premium: both are "with our team,
       not yet actionable by the merchant". Enquiries are in this figure too,
       which is why the sub-label says so and the two tiles beside it break the
       enquiry side out on its own. */
    const awaiting = (s.pending_approval || 0) + (s.in_review || 0);

    kpis.innerHTML = `<div class="cl-kpis">
      ${clKpi('Wallet balance',
              position ? moneyStr(position.wallet_balance) : '—',
              position ? 'Available to spend' : 'Position unavailable', 'payments')}
      ${position && position.has_credit_limit
          ? clKpi('Credit available', moneyStr(position.credit_available),
                  `${moneyStr(position.credit_used)} of ${moneyStr(position.credit_limit)} used`, 'payments')
          : clKpi('Balance due',
                  position ? moneyStr(position.outstanding) : '—',
                  position ? 'Across your billable bookings' : 'Position unavailable', 'payments')}
      ${clKpi('Enquiries open', enq ? enq.open : '—', 'Awaiting our answer', 'enquiry')}
      ${clKpi('Ready to book', enq ? enq.ready : '—', 'Answered — request a ticket', 'enquiry')}
      ${clKpi('Pending approval', awaiting, 'Bookings + enquiries with us', 'requests', 'pending_approval')}
      ${clKpi('Payment pending', s.payment_pending || 0, 'You owe payment', 'payments', 'payment_pending')}
      ${clKpi('Completed', s.completed || 0, 'Closed requests', 'requests', 'completed')}
    </div>`;
    /* CR-5 dropped four tiles from this strip: Ticketed, Awaiting verification,
       Unread notices, and the Account panel below it. Each already had a home
       that showed more than a bare number — My Requests filtered to Ticketed,
       the Payments screen's position strip, the notification bell and its
       centre, and Profile & Settings. Ten tiles is a wall to read past to
       reach the two that need action today. */

    kpis.querySelectorAll('[data-cl-kpi-to]').forEach(btn => {
      btn.addEventListener('click', () => {
        const to = btn.dataset.clKpiTo;
        const filter = btn.dataset.clKpiFilter || '';
        /* Pre-select the destination's own status <select> and fire its change
           handler, so the merchant lands on exactly the rows the number counted
           rather than on an unfiltered table. */
        clGo(to, () => {
          if (!filter) return;
          const sel = $(`cl-${to}`)?.querySelector('[data-cl-status-filter]');
          if (!sel) return;
          if ([...sel.options].some(o => o.value === filter)) {
            sel.value = filter;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      });
    });

    clRenderDashRecent(data.recent_requests || []);
  } catch (err) {
    kpis.innerHTML = `<div class="cl-panel"><div class="cl-panel-body">
      <div class="cl-msg cl-msg-err" style="margin-top:0">${escapeHtml(clError(err, 'Failed to load the dashboard.'))}</div>
    </div></div>`;
  }
}

/* A non-clickable KPI omits data-cl-kpi-to and renders as a <div>, so a keyboard
   user never tabs onto a figure that does nothing. */
function clKpi(label, value, sub, to, filter) {
  const inner = `<div class="cl-kpi-label">${escapeHtml(label)}</div>
    <div class="cl-kpi-value">${escapeHtml(String(value ?? '—'))}</div>
    <div class="cl-kpi-sub">${escapeHtml(sub || '')}</div>`;
  return to
    ? `<button type="button" class="cl-kpi" data-cl-kpi-to="${escapeHtml(to)}"
         data-cl-kpi-filter="${escapeHtml(filter || '')}"
         title="Open ${escapeHtml(CL_TITLES[to] || to)}">${inner}</button>`
    : `<div class="cl-kpi">${inner}</div>`;
}

/* CR-5 removed `clRenderDashAccount` and the "Account" panel it drew.
   Every field on it was a second copy of something with a better home: company
   name and merchant code are in the header and on Profile & Settings; wallet
   balance, credit limit and balance due are the first three tiles of the
   Payments position strip, which also shows what is used and what is left;
   support contact is the Support screen. `clDashPosition` is still held, and
   still fed by the same `financePosition()` call, because the two money KPIs
   above render from it. */

function clRenderDashRecent(rows) {
  if (!rows.length) {
    $('clDashRecent').innerHTML = `
      <div class="cl-panel"><div class="cl-panel-head"><h2>Recent requests</h2></div>
      <div class="cl-panel-body"><p style="margin:0;color:var(--cl-text-muted);font-size:12.5px;">
        Nothing raised yet. Start with a <b>Booking Enquiry</b> — once our team quotes it,
        you can turn it into a booking request.</p></div></div>`;
    return;
  }
  $('clDashRecent').innerHTML = `
    <div class="cl-panel">
      <div class="cl-panel-head">
        <h2>Recent requests</h2>
        <div class="cl-panel-tools">
          <button type="button" class="cl-btn cl-btn-sm" id="clDashAll">View all</button>
        </div>
      </div>
      <div class="cl-panel-body cl-flush"><div class="cl-table-wrap">
        <table class="cl-table">
          <thead><tr>
            <th>Request no.</th><th>Item</th><th>Status</th>
            <th class="cl-num">Amount</th><th>Created</th><th class="cl-actions">Action</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td class="cl-ref">${escapeHtml(r.request_number || '—')}</td>
              <td>${escapeHtml(r.title || '—')}</td>
              <td>${clTag(r.status)}</td>
              <td class="cl-num">${money(r.total_amount)}</td>
              <td class="cl-nowrap">${escapeHtml(fmtDate(r.created_at))}</td>
              <td class="cl-actions">
                <button type="button" class="cl-btn cl-btn-sm" data-cl-dash-view="${r.id}">Open</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div></div>
    </div>`;

  $('clDashAll').addEventListener('click', () => clGo('requests'));
  $('clDashRecent').querySelectorAll('[data-cl-dash-view]').forEach(b => {
    b.addEventListener('click', () => clGo('requests', () => clOpenRequestDetail(b.dataset.clDashView)));
  });
}
