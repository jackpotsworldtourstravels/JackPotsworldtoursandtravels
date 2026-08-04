'use strict';
/* Operations Portal — Dashboard.
   ===========================================================================
   There are three dashboard endpoints, one per portal, each behind its own
   permission:

     GET /api/merchant/dashboard      ticket.view          wallet + own counters
     GET /api/admin/dashboard         merchant.view        platform-wide counters
     GET /api/super-admin/dashboard   system.activity.view admin/merchant headcount

   An Admin holds ALL THREE codes, so this screen asks for every dashboard the
   session is allowed to call, in parallel, and builds the tile strip from
   whatever comes back. That is why it uses allSettled rather than await in
   sequence: one 403 or one slow query must not blank the other two.

   One tile is computed rather than fetched. "Raised today" does not exist as
   a counter, and it cannot be derived with a filter either — date_from on
   /api/requests matches TRAVEL date, not created_at. Since list_requests
   orders by created_at desc, counting today's rows off the first page is
   exact as long as fewer than a page were raised today, and the tile says
   "100+" the moment that stops being true rather than quietly under-reporting.
   =========================================================================== */

async function opsInitDashboard() {
  const host = $('ops-dashboard');
  host.innerHTML = `
    <div class="ops-page-head">
      <div>
        <h1>Dashboard</h1>
        <p>Live counters for your queues. Every tile is clickable and lands on the
           filtered list behind it.</p>
      </div>
      <div class="ops-page-actions" id="opsDashActions"></div>
    </div>
    <div id="opsDashBody">${opsSpinner('Loading counters…')}</div>`;

  $('opsDashActions').innerHTML = `
    <button type="button" class="ops-btn ops-btn-sm" id="opsDashRefresh">↻ Refresh</button>`;
  $('opsDashRefresh').addEventListener('click', () => {
    opsInvalidate('dashboard');
    opsLoaded.add('dashboard');
    opsInitDashboard();
  });

  /* A merchant gets the agent's dashboard — their own queues, their own money,
     the four booking actions and a worklist. Platform staff continue down the
     original path below, unchanged: their dashboard aggregates up to three
     endpoints and is a different job. */
  if (opsIsMerchantWorkspace()) return opsRenderMerchantDash();

  const jobs = {
    merchant: opsCan('ticket.view') ? OpsApi.merchantDashboard() : null,
    admin: opsCan('merchant.view') ? OpsApi.adminDashboard() : null,
    superAdmin: opsCan('system.activity.view') ? OpsApi.superAdminDashboard() : null,
    /* Newest-first page 1, purely to count today's arrivals. */
    recent: opsCan('ticket.view') ? OpsApi.listRequests({ page_size: OPS_PAGE_MAX }) : null,
  };
  const keys = Object.keys(jobs).filter(k => jobs[k]);
  const results = await Promise.allSettled(keys.map(k => jobs[k]));
  const data = {};
  keys.forEach((k, i) => { data[k] = results[i].status === 'fulfilled' ? results[i].value : null; });

  const failed = keys.filter((k, i) => results[i].status === 'rejected');

  $('opsDashBody').innerHTML = [
    failed.length ? `<div class="ops-msg ops-msg-warn" style="margin:0 0 10px">
        ${escapeHtml(`Some counters are unavailable (${failed.join(', ')}). The rest are current.`)}
      </div>` : '',
    opsDashKpis(data),
    `<div class="ops-cols-2">
       <div>${opsDashQuickActions()}</div>
       <div>${opsDashNotificationsPanel()}</div>
     </div>`,
    opsDashRecent(data),
    opsDashActivity(data),
  ].join('');

  opsDashWire(data);
}

/* ------------------------------------------------------------------ tiles */

function opsKpi({ label, value, sub, tone, go, filter, title }) {
  const attrs = [
    go ? `data-ops-kpi="${escapeHtml(go)}"` : '',
    filter ? `data-ops-kpi-filter='${escapeHtml(JSON.stringify(filter))}'` : '',
    title ? `title="${escapeHtml(title)}"` : '',
  ].filter(Boolean).join(' ');
  return `<div class="ops-kpi ${tone || ''} ${go ? 'click' : ''}" ${attrs}>
    <div class="ops-kpi-label">${escapeHtml(label)}</div>
    <div class="ops-kpi-value">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="ops-kpi-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function opsDashKpis(data) {
  const strips = [];
  const m = data.merchant;
  const a = data.admin;
  const sa = data.superAdmin;

  /* --- today + the request pipeline ------------------------------------- */
  const by = (m && m.requests_by_status) || (a && a.requests_by_status) || null;
  if (by || data.recent) {
    const tiles = [];

    if (data.recent) {
      const items = data.recent.items || [];
      const todayCount = items.filter(r => opsIsToday(r.created_at)).length;
      const capped = todayCount >= OPS_PAGE_MAX;
      tiles.push(opsKpi({
        label: "Raised today", value: capped ? `${OPS_PAGE_MAX}+` : todayCount,
        sub: capped ? 'page limit reached' : 'new requests',
        go: 'requests',
        title: capped
          ? `Counted from the newest ${OPS_PAGE_MAX} requests, which are all from today — the true figure is higher.`
          : 'Counted client-side from the newest requests: the API has no created-date filter (date_from matches travel date).',
      }));
    }
    if (by) {
      tiles.push(
        opsKpi({ label: 'Pending', value: by.pending_approval || 0, tone: by.pending_approval ? 'warn' : '',
          sub: 'awaiting approval', go: 'bookings', filter: { status: 'pending_approval' } }),
        opsKpi({ label: 'Under review', value: by.in_review || 0, sub: 'with the team',
          go: 'bookings', filter: { status: 'in_review' } }),
        opsKpi({ label: 'Approved', value: by.approved || 0, sub: 'approved',
          go: 'bookings', filter: { status: 'approved' } }),
        opsKpi({ label: 'Payment pending', value: by.payment_pending || 0, tone: by.payment_pending ? 'warn' : '',
          sub: 'money owed', go: 'payments', filter: { status: 'payment_pending' } }),
        opsKpi({ label: 'Paid', value: by.paid || 0, tone: 'ok', sub: 'verified',
          go: 'bookings', filter: { status: 'paid' } }),
        opsKpi({ label: 'Ticket issued', value: by.ticket_issued || 0, tone: 'ok', sub: 'issued',
          go: 'bookings', filter: { status: 'ticket_issued' } }),
        opsKpi({ label: 'Completed', value: by.completed || 0, tone: 'ok', sub: 'closed',
          go: 'bookings', filter: { status: 'completed' } }),
        opsKpi({ label: 'Rejected', value: by.rejected || 0, tone: by.rejected ? 'err' : '',
          sub: 'declined', go: 'bookings', filter: { status: 'rejected' } }),
        opsKpi({ label: 'Draft', value: by.draft || 0, sub: 'not submitted',
          go: 'bookings', filter: { status: 'draft' } }),
        opsKpi({ label: 'Cancelled', value: by.cancelled || 0, sub: 'withdrawn',
          go: 'bookings', filter: { status: 'cancelled' } }),
      );
    }
    strips.push(`<div class="ops-panel"><div class="ops-panel-head">
        <h2>Requests</h2>
        <div class="ops-panel-tools ops-muted">${escapeHtml(opsIsStaff() ? 'All merchants' : (OpsSession.user?.merchant_name || 'Your company'))}</div>
      </div><div class="ops-panel-body"><div class="ops-kpis">${tiles.join('')}</div></div></div>`);
  }

  /* --- money ------------------------------------------------------------ */
  const moneyTiles = [];
  /* The wallet strip only means something for an account that HAS a merchant:
     merchant_dashboard reads merchant = db.get(Merchant, actor.merchant_id),
     which is None for platform staff, so both figures come back as 0. Showing
     "₹0 credit limit" to an admin would be a fabricated fact. */
  if (m && opsMerchantId()) {
    moneyTiles.push(
      opsKpi({ label: 'Wallet balance', value: money(Number(m.wallet_balance)), sub: 'available', go: 'wallet' }),
      opsKpi({ label: 'Credit limit', value: money(Number(m.credit_limit)), sub: 'sanctioned', go: 'wallet' }),
    );
  }
  if (m) {
    moneyTiles.push(opsKpi({
      label: 'Payments in verification', value: m.pending_payments_count || 0,
      tone: m.pending_payments_count ? 'warn' : '', sub: 'submitted, unverified', go: 'payments',
      title: 'Payments you have submitted that an administrator has not verified yet. This is NOT the amount you owe — that is the Payment Pending tile.',
    }));
  }
  if (a) {
    moneyTiles.push(
      opsKpi({ label: 'Awaiting verification', value: a.payments_pending_count || 0,
        tone: a.payments_pending_count ? 'warn' : '', sub: 'payments to check', go: 'payments' }),
      opsKpi({ label: 'Verified today', value: a.payments_verified_today || 0, tone: 'ok',
        sub: 'payments cleared', go: 'payments' }),
    );
  }
  if (moneyTiles.length) {
    strips.push(`<div class="ops-panel"><div class="ops-panel-head"><h2>Money</h2></div>
      <div class="ops-panel-body"><div class="ops-kpis">${moneyTiles.join('')}</div></div></div>`);
  }

  /* --- platform ---------------------------------------------------------- */
  const platTiles = [];
  if (a) {
    const mc = a.merchants || {};
    platTiles.push(
      opsKpi({ label: 'Merchants', value: mc.total || 0, sub: 'registered', go: 'merchants' }),
      opsKpi({ label: 'Pending approval', value: mc.pending_approval || 0,
        tone: mc.pending_approval ? 'warn' : '', sub: 'new applications', go: 'approvals' }),
      opsKpi({ label: 'Active', value: mc.active || 0, tone: 'ok', sub: 'trading',
        go: 'merchants', filter: { status: 'active' } }),
      opsKpi({ label: 'Suspended', value: mc.suspended || 0, tone: mc.suspended ? 'err' : '',
        sub: 'blocked', go: 'merchants', filter: { status: 'suspended' } }),
      opsKpi({ label: 'Open support', value: a.open_support_tickets || 0, sub: 'tickets', go: 'support' }),
      opsKpi({ label: 'Open chats', value: a.open_chat_threads || 0, sub: 'live chat', go: 'support' }),
    );
  }
  if (sa) {
    const ac = sa.admins || {};
    platTiles.push(
      opsKpi({ label: 'Administrators', value: ac.total || 0, sub: `${ac.active || 0} active`, go: 'users' }),
      opsKpi({ label: 'Merchant users', value: sa.total_merchant_users || 0, sub: 'across all companies', go: 'users' }),
    );
    if (!a) {
      const mc = sa.merchants || {};
      platTiles.push(
        opsKpi({ label: 'Merchants', value: mc.total || 0, sub: 'registered', go: 'merchants' }),
        opsKpi({ label: 'Pending approval', value: mc.pending_approval || 0,
          tone: mc.pending_approval ? 'warn' : '', sub: 'new applications', go: 'merchants' }),
        opsKpi({ label: 'Open chats', value: sa.open_chat_threads || 0, sub: 'live chat', go: 'support' }),
      );
    }
  }
  if (m && !opsIsStaff()) {
    platTiles.push(opsKpi({ label: 'Open chats', value: m.open_chat_threads_count || 0,
      sub: 'with our desk', go: 'support' }));
  }
  if (platTiles.length) {
    strips.push(`<div class="ops-panel"><div class="ops-panel-head"><h2>Platform</h2>
      ${sa ? `<div class="ops-panel-tools ops-muted">schema ${escapeHtml(sa.schema_version || '')}</div>` : ''}</div>
      <div class="ops-panel-body"><div class="ops-kpis">${platTiles.join('')}</div></div></div>`);
  }

  if (!strips.length) {
    strips.push(`<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-info" style="margin:0">Your account has no dashboard counters.
      Use the modules in the sidebar.</div></div></div>`);
  }
  return strips.join('');
}

/* ---------------------------------------------------------- quick actions */

function opsDashQuickActions() {
  const acts = [];
  if (opsCan('ticket.enquiry')) {
    OPS_TRAVEL_TYPES.forEach(t => acts.push({
      label: `New ${t} request`, section: `${t}s`, primary: t === 'flight',
    }));
  }
  if (opsCan('ticket.view')) acts.push({ label: 'Customer search', section: 'customers' });
  if (opsCan('merchant.view')) acts.push({ label: 'Merchant search', section: 'merchants' });
  if (opsCan('ticket.approve', 'merchant.approve', 'servicerequest.manage')) {
    acts.push({ label: 'Approval queue', section: 'approvals' });
  }
  if (opsCan('payment.verify')) acts.push({ label: 'Verify payments', section: 'payments' });
  if (opsCan('report.export')) acts.push({ label: 'Export a report', section: 'reports' });

  if (!acts.length) return '';
  return `<div class="ops-panel">
    <div class="ops-panel-head"><h2>Quick actions</h2>
      <div class="ops-panel-tools"><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">N</span></div>
    </div>
    <div class="ops-panel-body">
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${acts.map(a => `<button type="button" class="ops-btn ops-btn-sm ${a.primary ? 'ops-btn-primary' : ''}"
            data-ops-quick="${a.section}">${escapeHtml(a.label)}</button>`).join('')}
      </div>
    </div>
  </div>`;
}

function opsDashNotificationsPanel() {
  if (!opsCan('notification.view')) return '';
  return `<div class="ops-panel">
    <div class="ops-panel-head"><h2>System notifications</h2>
      <div class="ops-panel-tools">
        <button type="button" class="ops-btn ops-btn-sm" id="opsDashAllNotes">Open all</button>
      </div>
    </div>
    <div class="ops-panel-body ops-flush" id="opsDashNotes">${opsSpinner()}</div>
  </div>`;
}

/* --------------------------------------------------------- recent + activity */

function opsDashRecent(data) {
  const rows = data.merchant?.recent_requests || [];
  if (!opsCan('ticket.view')) return '';
  return `<div class="ops-panel">
    <div class="ops-panel-head"><h2>Recent requests</h2>
      <div class="ops-panel-tools">
        <button type="button" class="ops-btn ops-btn-sm" data-ops-quick="bookings">Open Bookings</button>
      </div>
    </div>
    <div class="ops-panel-body ops-flush">
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead><tr>
            <th>Request</th><th>Title</th>${opsIsStaff() ? '<th>Merchant</th>' : ''}
            <th>Type</th><th>Travel</th><th class="ops-num">Amount</th><th>Status</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map(r => `
            <tr class="click" data-ops-open="${r.id}">
              <td><span class="ops-ref">${escapeHtml(r.request_number)}</span></td>
              <td>${escapeHtml(r.title || '—')}</td>
              ${opsIsStaff() ? `<td>${escapeHtml(r.merchant_name || '—')}</td>` : ''}
              <td>${escapeHtml(opsLabel(r.request_type))}</td>
              <td class="ops-nowrap">${escapeHtml(fmtDate(r.travel_date))}</td>
              <td class="ops-num">${money(Number(r.total_amount))}</td>
              <td>${opsTag(r.status, r.status_label)}</td>
            </tr>`).join('') : opsEmptyRow(opsIsStaff() ? 7 : 6, 'No requests yet.')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function opsDashActivity(data) {
  const rows = data.admin?.recent_activity || data.superAdmin?.recent_activity || [];
  if (!rows.length) return '';
  return `<div class="ops-panel">
    <div class="ops-panel-head"><h2>Recent activity</h2>
      <div class="ops-panel-tools">
        ${opsCan('system.activity.view') ? '<button type="button" class="ops-btn ops-btn-sm" data-ops-quick="logs">Full log</button>' : ''}
      </div>
    </div>
    <div class="ops-panel-body ops-flush">
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead><tr><th>When</th><th>Who</th><th>Module</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>${rows.map(a => `
            <tr>
              <td class="ops-nowrap">${escapeHtml(fmtDateTime(a.created_at))}</td>
              <td>${escapeHtml(a.user_name || '—')}</td>
              <td>${escapeHtml(a.module || '—')}</td>
              <td>${escapeHtml(a.action || '—')}</td>
              <td>${escapeHtml(a.description || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------- wiring */

function opsDashWire(data) {
  /* Tiles that carry a filter hand it to the destination section, which reads
     it out of opsPendingFilter on its next render. */
  opsAll('[data-ops-kpi]').forEach(tile => {
    tile.addEventListener('click', () => {
      const section = tile.dataset.opsKpi;
      const raw = tile.dataset.opsKpiFilter;
      if (raw) {
        try { opsPendingFilter[section] = JSON.parse(raw); } catch { /* ignore */ }
        opsInvalidate(section);
      }
      opsGo(section);
    });
  });
  opsAll('[data-ops-quick]').forEach(b =>
    b.addEventListener('click', () => opsGo(b.dataset.opsQuick)));
  opsAll('[data-ops-open]', $('ops-dashboard')).forEach(tr =>
    tr.addEventListener('click', () => opsGo('bookings', () => opsOpenRequest(tr.dataset.opsOpen))));

  $('opsDashAllNotes')?.addEventListener('click', opsOpenDrawer);

  if (opsCan('notification.view')) {
    OpsApi.listNotifications({ page_size: 6 }).then(d => {
      const items = d.items || [];
      $('opsDashNotes').innerHTML = items.length
        ? items.map(n => `<div class="ops-note${n.is_read ? '' : ' unread'}" style="cursor:default">
             <b>${escapeHtml(n.title || 'Notification')}</b>${escapeHtml(n.message || '')}
             <time>${escapeHtml(fmtDateTime(n.created_at))}</time></div>`).join('')
        : '<div class="ops-empty">Nothing new.</div>';
    }).catch(err => {
      $('opsDashNotes').innerHTML = `<div class="ops-empty">${escapeHtml(opsError(err, 'Could not load notifications.'))}</div>`;
    });
  }
}

/* ===========================================================================
   THE MERCHANT DASHBOARD
   ===========================================================================
   The brief's tiles: Today's Bookings, Pending Requests, Pending Payments,
   Wallet Balance, Tickets Issued, Recent Activity, Quick Actions, To-do List.

   "TODAY'S BOOKINGS" IS TWO DIFFERENT QUESTIONS AND BOTH ARE SHOWN
   An agent asking it means either "what did we sell today" (created_at) or
   "who flies today" (travel_date). The API can only filter the second —
   date_from/date_to on /api/requests compare travel_date (ticket_service.py),
   there is no created-date filter at all. So:

     Departing today   exact, server-side: date_from=date_to=today, and the
                       tile reads `total` off the page rather than counting
                       rows, so it is right regardless of page size.
     Raised today      counted client-side off the newest page, because that
                       is the only way to get it. list_requests orders by
                       created_at desc, so this is exact while fewer than a
                       page were raised today, and it says "100+" the moment
                       that stops being true rather than under-reporting.

   PENDING PAYMENTS IS ALSO TWO NUMBERS, AND CONFLATING THEM IS A REAL BUG
   `pending_payments_count` counts payments the merchant has SUBMITTED that an
   admin has not verified. It is not what they owe. What they owe is the count
   of requests sitting in payment_pending. Both are shown, separately
   labelled, because an agent who reads "2 pending payments" and assumes it
   means money still to send will underpay.                                */

async function opsRenderMerchantDash() {
  const today = opsToday();

  /* Four independent reads. allSettled so one slow or failed call degrades a
     single tile rather than the screen. */
  const jobs = {
    dash: OpsApi.merchantDashboard(),
    recent: OpsApi.listRequests({ page_size: OPS_PAGE_MAX }),
    departing: OpsApi.listRequests({ date_from: today, date_to: today, page_size: 1 }),
  };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map(k => jobs[k]));
  const d = {};
  keys.forEach((k, i) => { d[k] = settled[i].status === 'fulfilled' ? settled[i].value : null; });

  const failed = keys.filter((k, i) => settled[i].status === 'rejected');
  const m = d.dash;
  const by = (m && m.requests_by_status) || {};

  $('opsDashBody').innerHTML = [
    failed.length ? `<div class="ops-msg ops-msg-warn" style="margin:0 0 10px">
        ${escapeHtml(`Some counters are unavailable (${failed.join(', ')}). The rest are current.`)}
      </div>` : '',
    opsMerchantKpis(d, by),
    `<div class="ops-cols-2">
       <div>${opsMerchantQuickActions()}</div>
       <div>${opsMerchantTodo(m, by)}</div>
     </div>`,
    opsDashRecent({ merchant: m }),
    opsDashNotificationsPanel(),
  ].join('');

  /* Same wiring the staff dashboard uses — tiles, quick actions, recent rows,
     notifications. Nothing merchant-specific to add beyond the to-do row that
     opens the drawer rather than a section. */
  opsDashWire({ merchant: m });
  $('opsTodoNotes')?.addEventListener('click', opsOpenDrawer);
}

function opsMerchantKpis(d, by) {
  const m = d.dash;
  const tiles = [];

  if (d.departing) {
    tiles.push(opsKpi({
      label: 'Departing today', value: d.departing.total || 0,
      sub: 'travelling today', go: 'bookings',
      filter: { date_from: opsToday(), date_to: opsToday() },
      title: 'Requests whose travel date is today. Exact — filtered server-side on travel_date.',
    }));
  }
  if (d.recent) {
    const items = d.recent.items || [];
    const raised = items.filter(r => opsIsToday(r.created_at)).length;
    const capped = raised >= OPS_PAGE_MAX;
    tiles.push(opsKpi({
      label: 'Raised today', value: capped ? `${OPS_PAGE_MAX}+` : raised,
      sub: 'new requests', go: 'requests',
      title: capped
        ? `Counted from the newest ${OPS_PAGE_MAX} requests, which are all from today — the true figure is higher.`
        : 'Counted in the browser from the newest requests: the API has no created-date filter.',
    }));
  }

  tiles.push(
    opsKpi({ label: 'Pending requests', value: by.pending_approval || 0,
      tone: by.pending_approval ? 'warn' : '', sub: 'awaiting approval',
      go: 'bookings', filter: { status: 'pending_approval' } }),
    opsKpi({ label: 'Payment due', value: by.payment_pending || 0,
      tone: by.payment_pending ? 'warn' : '', sub: 'approved, unpaid',
      go: 'payments', filter: { status: 'payment_pending' },
      title: 'Approved bookings you have not paid for yet. This is the money you owe.' }),
    opsKpi({ label: 'Tickets issued', value: by.ticket_issued || 0, tone: 'ok',
      sub: 'ready to travel', go: 'bookings', filter: { status: 'ticket_issued' } }),
  );

  if (m) {
    tiles.push(opsKpi({
      label: 'In verification', value: m.pending_payments_count || 0,
      tone: m.pending_payments_count ? 'warn' : '', sub: 'payments sent',
      go: 'payments',
      title: 'Payments you have already sent that an administrator has not verified yet. NOT the amount you owe — that is the Payment due tile.',
    }));
  }

  const account = [];
  if (m) {
    account.push(
      opsKpi({ label: 'Wallet balance', value: money(Number(m.wallet_balance)), sub: 'available', go: 'wallet' }),
      opsKpi({ label: 'Credit limit', value: money(Number(m.credit_limit)), sub: 'sanctioned', go: 'wallet' }),
      opsKpi({ label: 'Draft', value: by.draft || 0, sub: 'not submitted',
        go: 'bookings', filter: { status: 'draft' } }),
      opsKpi({ label: 'Completed', value: by.completed || 0, tone: 'ok', sub: 'closed',
        go: 'bookings', filter: { status: 'completed' } }),
    );
  }

  return `
    <div class="ops-panel">
      <div class="ops-panel-head">
        <h2>Today</h2>
        <div class="ops-panel-tools ops-muted">${escapeHtml(OpsSession.user?.merchant_name || 'Your company')}</div>
      </div>
      <div class="ops-panel-body"><div class="ops-kpis">${tiles.join('')}</div></div>
    </div>
    ${account.length ? `<div class="ops-panel">
      <div class="ops-panel-head"><h2>Account</h2></div>
      <div class="ops-panel-body"><div class="ops-kpis">${account.join('')}</div></div>
    </div>` : ''}`;
}

/* ---------------------------------------------------------- quick actions */

/* The brief's seven. Five are real; two have no endpoint and are rendered
   disabled with the reason on the button — the same rule the Profile and
   Wallet screens follow. */
function opsMerchantQuickActions() {
  const live = [];
  if (opsCan('ticket.enquiry')) {
    OPS_TRAVEL_TYPES.forEach(t => live.push({
      label: `New ${t} booking`, section: `${t}s`, primary: t === 'flight',
    }));
  }
  if (opsCan('payment.view')) live.push({ label: 'Payment history', section: 'payments' });

  const pending = [
    ['Upload documents', 'Document uploads are not yet supported — the documents endpoint is not built.'],
    ['Wallet top-up', 'Backend integration pending — no top-up endpoint exists yet.'],
  ];

  return `<div class="ops-panel">
    <div class="ops-panel-head"><h2>Quick actions</h2>
      <div class="ops-panel-tools"><span class="ops-kbd">Ctrl</span>+<span class="ops-kbd">N</span></div>
    </div>
    <div class="ops-panel-body">
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${live.map(a => `<button type="button" class="ops-btn ops-btn-sm ${a.primary ? 'ops-btn-primary' : ''}"
            data-ops-quick="${a.section}">${escapeHtml(a.label)}</button>`).join('')}
        ${pending.map(([label, why]) => `<button type="button" class="ops-btn ops-btn-sm" disabled
            title="${escapeHtml(why)}">${escapeHtml(label)}</button>`).join('')}
      </div>
      ${opsPendingNote('Upload documents and Wallet top-up are disabled until their endpoints exist — hover either for the reason.')}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- to-do */

/* Derived entirely from counters already fetched — no extra call, and nothing
   invented. Only non-zero items appear, so an empty list genuinely means
   there is nothing waiting. */
function opsMerchantTodo(m, by) {
  const items = [];
  const add = (n, label, section, filter) => {
    if (n > 0) items.push({ n, label, section, filter });
  };

  add(by.draft, 'draft request(s) not submitted', 'bookings', { status: 'draft' });
  add(by.payment_pending, 'approved booking(s) awaiting your payment', 'payments', { status: 'payment_pending' });
  add(by.rejected, 'rejected request(s) to review', 'bookings', { status: 'rejected' });
  add(by.ticket_issued, 'issued ticket(s) to pass to the traveller', 'bookings', { status: 'ticket_issued' });
  if (m) {
    add(m.open_chat_threads_count, 'open support conversation(s)', 'support');
    add(m.unread_notifications_count, 'unread notification(s)', null);
  }

  return `<div class="ops-panel">
    <div class="ops-panel-head"><h2>To-do</h2>
      <div class="ops-panel-tools ops-muted">${items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'clear'}</div>
    </div>
    <div class="ops-panel-body ops-flush">
      ${items.length ? `<ul class="ops-todo">
        ${items.map(i => `<li>
          <span class="ops-todo-n">${escapeHtml(String(i.n))}</span>
          <span class="ops-todo-txt">${escapeHtml(i.label)}</span>
          ${i.section
            ? `<button type="button" class="ops-btn ops-btn-sm" data-ops-kpi="${i.section}"
                 ${i.filter ? `data-ops-kpi-filter='${escapeHtml(JSON.stringify(i.filter))}'` : ''}>Open</button>`
            : '<button type="button" class="ops-btn ops-btn-sm" id="opsTodoNotes">Open</button>'}
        </li>`).join('')}
      </ul>` : `<div class="ops-empty">Nothing waiting on you. Every queue is clear.</div>`}
    </div>
    <div class="ops-panel-note">Built from your live counters — an item disappears as soon as the work behind it is done.</div>
  </div>`;
}

/* A tile or a search hit can ask a section to open with a filter already
   applied. The section clears its entry after reading it, so a later manual
   visit is not silently pre-filtered. */
const opsPendingFilter = {};
function opsTakePendingFilter(section) {
  const f = opsPendingFilter[section];
  delete opsPendingFilter[section];
  return f || null;
}
