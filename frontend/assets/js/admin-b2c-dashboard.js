/* Admin — B2C Dashboard (the B2C Admin Portal landing)
   ===================================================
   THE OPERATIONAL "WHAT NEEDS ME NOW" SNAPSHOT — deliberately not B2C
   Analytics (period trends, charts). One call:

     GET /api/admin/b2c-dashboard/summary   (b2c.reports.view)

   THE BROWSER ONLY DRAWS. Every count and every rupee figure arrives from the
   server already computed (money as decimal strings, rendered with moneyStr).
   Nothing here is hard-coded, cached across visits or derived into a new
   stored number; the only arithmetic is a donut arc length and a share-of-total
   label drawn from counts that arrived.

   2026-11-23 UI REDESIGN (visual only): the markup this file renders was
   restyled to the owner's reference — icon KPI cards, a Bookings-by-Status
   donut with legend, Customer Overview / Customer Support / Needs Attention /
   Financial Overview cards. NO new data, NO new endpoint, NO new field is read:
   every figure below is one the `summary` response already carried and the
   previous layout already showed. The reference's Booking-Trend and
   Bookings-by-Product charts, its System/Supplier status panel and its
   Recent-Bookings table have no data source in this snapshot, so they are not
   drawn (fabricating them would be inventing metrics). Dashboard-only classes
   are prefixed `b2cd-`; the shared `.b2ca-*` tiles/cards (also used by B2C
   Analytics) are deliberately left alone. Styles live under `.b2cd` in
   admin.css.

   BOOKED VALUE IS NOT MONEY RECEIVED. "Booked value" is what is on the books
   (cancelled excluded), "Collected" is every payment that was captured (money
   received, before refunds — a payment later refunded in full still counts, so
   refunds never make it shrink) — both are shown and labelled as such, never
   subtracted from each other (a captured payment on a since-cancelled booking
   would make any "outstanding" figure wrong).

   STATES: loading (skeleton), error (server's message + Retry; a 403 says
   which permission is missing), empty (a brand-new desk with no customers or
   bookings yet), and the populated view. Refetches on every visit (it is in
   B2C_RELOAD_ON_VISIT) and on Refresh.

   QUEUE LINKS pre-filter the destination screen through that module's own
   state object (bkgState / rvwState / custState), guarded with typeof so a
   missing module degrades to plain navigation.

   Loaded after admin.js (navigateToSection, statGridSkeleton, authHeaders,
   API_BASE), shared/formatters.js (moneyStr) and admin-b2c-catalogue-common.js
   (catErr, catE, catWhen). */

let b2cdWired = false;
let b2cdSeq = 0;

const b2cdNum = n => Number(n || 0).toLocaleString('en-IN');
const b2cdPlural = (n, one, many) => `${b2cdNum(n)} ${n === 1 ? one : many}`;

async function initB2CDashboard() {
  if (!b2cdWired) {
    b2cdWired = true;
    document.getElementById('b2cdRefresh').addEventListener('click', () => loadB2CDashboard());
    const host = document.getElementById('b2cdBody');
    host.addEventListener('click', e => {
      const retry = e.target.closest('[data-b2cd-retry]');
      if (retry) { loadB2CDashboard(); return; }
      const go = e.target.closest('[data-b2cd-go]');
      if (go) { e.preventDefault(); b2cdGo(go.dataset.b2cdGo, go.dataset.b2cdFilter || ''); }
    });
  }
  await loadB2CDashboard();
}

async function loadB2CDashboard() {
  const seq = ++b2cdSeq;
  const host = document.getElementById('b2cdBody');
  const stamp = document.getElementById('b2cdStamp');
  const refresh = document.getElementById('b2cdRefresh');
  host.setAttribute('aria-busy', 'true');
  refresh.disabled = true;
  stamp.textContent = 'Loading…';
  host.innerHTML = statGridSkeleton(6);
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/b2c-dashboard/summary`, { headers: authHeaders() });
    if (seq !== b2cdSeq) return; // a newer load superseded this one
    host.innerHTML = b2cdRender(data);
    stamp.textContent = `As of ${catWhen(data.generated_at)}`;
  } catch (err) {
    if (seq !== b2cdSeq) return;
    const status = err && err.response && err.response.status;
    const msg = status === 403
      ? 'You do not have access to the B2C dashboard. It needs the "B2C reports — view" permission (b2c.reports.view); ask a super admin to grant it.'
      : catErr(err, 'Could not load the B2C dashboard.');
    host.innerHTML = `
      <div class="b2cd-state b2cd-error" role="alert">
        <p class="msg error" style="margin:0;">${escapeHtml(msg)}</p>
        ${status === 403 ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-b2cd-retry>Retry</button>'}
      </div>`;
    stamp.textContent = 'Not loaded';
  } finally {
    if (seq === b2cdSeq) {
      host.removeAttribute('aria-busy');
      refresh.disabled = false;
    }
  }
}

/* ---------- navigation from a queue / link ---------- */

function b2cdSyncTabs(selector, attr, value) {
  document.querySelectorAll(selector).forEach(t => t.classList.toggle('active', (t.dataset[attr] || '') === value));
}

function b2cdGo(section, filter) {
  if (section === 'b2c-bookings' && typeof bkgState !== 'undefined') {
    bkgState.status = filter; bkgState.page = 1;
    const sel = document.getElementById('bkgStatusFilter');
    if (sel) sel.value = filter;
  } else if (section === 'b2c-reviews' && typeof rvwState !== 'undefined') {
    rvwState.status = filter; rvwState.page = 1;
  } else if (section === 'b2c-customers' && typeof custState !== 'undefined') {
    custState.filter = filter; custState.page = 1;
    b2cdSyncTabs('#custTabs [data-cust-tab]', 'custTab', filter);
  }
  navigateToSection(section);
}

/* ---------- pieces ---------- */

/* Share of a total, as a %, from counts that already arrived — the only
   arithmetic this page does (see the file header). */
function b2cdShare(n, total) {
  if (!total) return '—';
  const pct = n / total * 100;
  if (n > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/* Inline stroke icons, drawn in the shared `.icon` style. Keyed by name so a
   card just asks for the one it wants. */
const B2CD_ICONS = {
  bookings: '<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cancel: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  coins: '<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v6c0 1.7 2.7 3 6 3s6-1.3 6-3V6"/><path d="M21 10v4c0 1.7-2.7 3-6 3-1 0-2-.1-2.8-.3"/><path d="M15 10c2.9 0 6-1 6-3"/>',
  ledger: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2Z"/><path d="M9 4v16M12.5 9h3M12.5 13h3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>',
  star: '<path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7-5.4-4.7 7.1-.6z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
};
const b2cdIcon = name => `<svg class="icon" viewBox="0 0 24 24">${B2CD_ICONS[name] || ''}</svg>`;

/* KPI stat card — icon chip + value + label + a truthful sub-line. `money`
   values get a slightly smaller type so a full rupee figure fits the card. */
function b2cdKpi({ icon, tone, label, value, sub, hint, money }) {
  return `
    <div class="b2cd-kpi"${hint ? ` title="${catE(hint)}"` : ''}>
      <span class="b2cd-kpi-ic tone-${tone}">${b2cdIcon(icon)}</span>
      <span class="b2cd-kpi-label">${escapeHtml(label)}</span>
      <span class="b2cd-kpi-val${money ? ' is-money' : ''}">${value}</span>
      ${sub ? `<span class="b2cd-kpi-sub">${sub}</span>` : ''}
    </div>`;
}

/* Status buckets, in the order the donut and legend draw them. The third
   entry is the colour tone (see the `.tone-*` rules in admin.css). */
const B2CD_STATUS = [
  ['confirmed', 'Confirmed', 'green'],
  ['pending', 'Pending', 'amber'],
  ['completed', 'Completed', 'blue'],
  ['cancelled', 'Cancelled', 'red'],
];

/* Bookings-by-Status donut + clickable legend. Arc lengths are shares of the
   booking total (the one bit of arithmetic allowed here); each legend row
   opens Bookings pre-filtered to that status. */
function b2cdDonut(b) {
  const total = b.total || 0;
  const r = 54, CIRC = 2 * Math.PI * r;
  let acc = 0;
  const arcs = B2CD_STATUS.map(([k, , tone]) => {
    const v = b.by_status[k] || 0;
    if (!v || !total) return '';
    const len = v / total * CIRC;
    const el = `<circle class="b2cd-arc tone-${tone}" r="${r}" cx="80" cy="80" fill="none" stroke-width="20"
      stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"/>`;
    acc += len;
    return el;
  }).join('');
  const legend = B2CD_STATUS.map(([k, label, tone]) => {
    const v = b.by_status[k] || 0;
    return `
      <li><a href="#" class="b2cd-legend-row" data-b2cd-go="b2c-bookings" data-b2cd-filter="${k}"
        title="${catE(`${label}: ${v} (${b2cdShare(v, total)}) — open in Bookings`)}">
        <span class="b2cd-dot tone-${tone}"></span>
        <span class="b2cd-legend-label">${escapeHtml(label)}</span>
        <span class="b2cd-legend-val">${b2cdNum(v)}</span>
        <span class="b2cd-legend-share">${b2cdShare(v, total)}</span>
      </a></li>`;
  }).join('');
  return `
    <div class="b2cd-donut">
      <svg viewBox="0 0 160 160" class="b2cd-donut-svg" role="img"
           aria-label="Bookings by status: ${catE(B2CD_STATUS.map(([k, l]) => `${l} ${b.by_status[k] || 0}`).join(', '))}">
        <circle r="${r}" cx="80" cy="80" fill="none" stroke="var(--border-color)" stroke-width="20"/>
        <g transform="rotate(-90 80 80)">${arcs}</g>
        <text x="80" y="75" class="b2cd-donut-num">${b2cdNum(total)}</text>
        <text x="80" y="96" class="b2cd-donut-cap">bookings</text>
      </svg>
      <ul class="b2cd-legend">${legend}</ul>
    </div>`;
}

/* A label/value row for the Customer Overview list; `flag` reddens the value
   (used for Blocked > 0). */
function b2cdStatRow(label, value, tone, flag) {
  return `
    <li class="${flag ? 'is-flag' : ''}">
      <span class="b2cd-stat-label"><span class="b2cd-stat-dot tone-${tone}"></span>${escapeHtml(label)}</span>
      <span class="b2cd-stat-val">${b2cdNum(value)}</span>
    </li>`;
}

/* A coloured tile for the Customer Support card; goes neutral at zero so a
   quiet queue does not read as an alert. */
function b2cdTile(label, value, tone) {
  return `
    <div class="b2cd-tile tone-${value > 0 ? tone : 'slate'}">
      <div class="b2cd-tile-val">${b2cdNum(value)}</div>
      <div class="b2cd-tile-label">${escapeHtml(label)}</div>
    </div>`;
}

/* One row of Needs Attention: an icon, what it is, how many, and a link to the
   screen that handles it. Goes quiet (neutral icon, "Nothing waiting") at zero. */
function b2cdAction({ count, label, detail, section, filter, icon, tone }) {
  const live = count > 0;
  return `
    <li class="b2cd-action${live ? ' is-live' : ''}" style="--tone:var(--t-${tone}); --tone-bg:var(--tb-${tone});">
      <span class="b2cd-action-ic">${b2cdIcon(icon)}</span>
      <span class="b2cd-action-txt">
        <strong>${escapeHtml(label)}</strong>
        <span class="b2cd-action-sub">${live ? escapeHtml(detail) : 'Nothing waiting.'}</span>
      </span>
      <a href="#" class="b2cd-action-go" data-b2cd-go="${catE(section)}" data-b2cd-filter="${catE(filter || '')}"
         aria-label="${catE(`${label}: ${count}`)}">
        <span class="b2cd-action-count">${b2cdNum(count)}</span>
        <svg class="icon" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </a>
    </li>`;
}

const B2CD_LINKS = [
  ['b2c-customers', 'Customers', 'Profiles, booking and payment history'],
  ['b2c-bookings', 'Bookings', 'Flights, hotels and tour packages'],
  ['b2c-refunds', 'Cancellations & Refunds', 'Requests and the refund workflow'],
  ['b2c-reconciliation', 'Payment Reconciliation', 'Check payments against the gateway'],
  ['b2c-reviews', 'Reviews & Ratings', 'Moderate and reply'],
  ['live-support', 'Live Support', 'Customer chat queue'],
  ['b2c-communication', 'Communication', 'Notifications and email records'],
  ['b2c-reports', 'Reports', 'Exports'],
  ['b2c-analytics', 'Analytics', 'Trends over a period'],
];

/* ---------- the page ---------- */

function b2cdRender(d) {
  const c = d.customers, b = d.bookings, r = d.reviews, s = d.support;

  if (c.total === 0 && b.total === 0 && r.pending === 0 && r.approved === 0 && s.open_conversations === 0) {
    return `
      <div class="b2cd-state">
        <p class="empty-state" style="padding:8px 0;">No B2C activity yet — no customers, bookings, reviews or open support conversations.
          Figures will appear here as soon as the first customer signs up or books.</p>
      </div>
      ${b2cdQuickLinks()}`;
  }

  const kpis = `
    <div class="b2cd-kpis">
      ${b2cdKpi({ icon: 'bookings', tone: 'blue', label: 'Total Bookings', value: b2cdNum(b.total),
        sub: 'Flights, hotels &amp; tour packages' })}
      ${b2cdKpi({ icon: 'check', tone: 'green', label: 'Confirmed', value: b2cdNum(b.by_status.confirmed || 0),
        sub: `${b2cdShare(b.by_status.confirmed || 0, b.total)} of bookings` })}
      ${b2cdKpi({ icon: 'clock', tone: 'amber', label: 'Pending', value: b2cdNum(b.by_status.pending || 0),
        sub: `${b2cdShare(b.by_status.pending || 0, b.total)} of bookings` })}
      ${b2cdKpi({ icon: 'cancel', tone: 'red', label: 'Cancelled', value: b2cdNum(b.by_status.cancelled || 0),
        sub: `${b2cdShare(b.by_status.cancelled || 0, b.total)} of bookings` })}
      ${b2cdKpi({ icon: 'coins', tone: 'teal', label: 'Payments Collected', value: escapeHtml(moneyStr(b.collected)), money: true,
        sub: 'Captured, all time · before refunds',
        hint: 'Every payment that was captured, including payments later refunded in full. Refunds are not subtracted — see Analytics for money returned.' })}
      ${b2cdKpi({ icon: 'ledger', tone: 'indigo', label: 'Booked Value', value: escapeHtml(moneyStr(b.booked_value)), money: true,
        sub: 'On the books · not money received',
        hint: 'Total amount of every booking that is not cancelled, paid or not.' })}
    </div>`;

  const chart = `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-blue">${b2cdIcon('bookings')}</span><h3>Bookings by Status</h3></div>
      ${b.total ? b2cdDonut(b) : '<p class="b2cd-empty">No bookings yet.</p>'}
      <p class="b2cd-note">All time, across flights, hotels and tour packages. Select a status to open it in Bookings.</p>
    </section>`;

  const customers = `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-indigo">${b2cdIcon('users')}</span><h3>Customer Overview</h3></div>
      <ul class="b2cd-stats">
        ${b2cdStatRow('Total customers', c.total, 'indigo')}
        ${b2cdStatRow('New in 30 days', c.new_30d, 'green')}
        ${b2cdStatRow('Registered', c.registered, 'blue')}
        ${b2cdStatRow('Guests', c.guests, 'teal')}
        ${b2cdStatRow('Blocked', c.blocked, 'red', c.blocked > 0)}
      </ul>
    </section>`;

  const support = `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-teal">${b2cdIcon('chat')}</span><h3>Customer Support</h3>
        <a href="#" class="b2cd-card-link" data-b2cd-go="live-support">Open Live Support →</a></div>
      <div class="b2cd-tiles">
        ${b2cdTile('Open conversations', s.open_conversations, 'blue')}
        ${b2cdTile('Waiting unassigned', s.waiting_unassigned, 'amber')}
        ${b2cdTile('Unread messages', s.admin_unread, 'red')}
      </div>
      <p class="b2cd-note">Open = waiting or active (not resolved or closed). Unread is across every open conversation.</p>
    </section>`;

  const needs = `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-amber">${b2cdIcon('alert')}</span><h3>Needs Attention</h3></div>
      <ul class="b2cd-actions">
        ${b2cdAction({ count: s.waiting_unassigned, label: 'Unassigned chats waiting', tone: 'red', icon: 'chat',
          detail: 'Customers in Live Support with no agent assigned.', section: 'live-support' })}
        ${b2cdAction({ count: s.admin_unread, label: 'Unread support messages', tone: 'amber', icon: 'chat',
          detail: `Across ${b2cdPlural(s.open_conversations, 'open conversation', 'open conversations')}.`, section: 'live-support' })}
        ${b2cdAction({ count: b.by_status.pending || 0, label: 'Pending bookings', tone: 'amber', icon: 'clock',
          detail: 'Bookings not yet confirmed.', section: 'b2c-bookings', filter: 'pending' })}
        ${b2cdAction({ count: r.pending, label: 'Reviews awaiting moderation', tone: 'blue', icon: 'star',
          detail: 'Not shown publicly until approved.', section: 'b2c-reviews', filter: 'pending' })}
        ${b2cdAction({ count: c.blocked, label: 'Blocked customers', tone: 'red', icon: 'users',
          detail: 'Accounts that cannot sign in or book.', section: 'b2c-customers', filter: 'blocked' })}
      </ul>
    </section>`;

  const finance = `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-green">${b2cdIcon('coins')}</span><h3>Financial Overview</h3></div>
      <ul class="b2cd-fin">
        <li class="tone-green"><span class="b2cd-fin-ic">${b2cdIcon('check')}</span>
          <span class="b2cd-fin-label">Payments collected</span><span class="b2cd-fin-val">${escapeHtml(moneyStr(b.collected))}</span></li>
        <li class="tone-indigo"><span class="b2cd-fin-ic">${b2cdIcon('ledger')}</span>
          <span class="b2cd-fin-label">Booked value</span><span class="b2cd-fin-val">${escapeHtml(moneyStr(b.booked_value))}</span></li>
      </ul>
      <p class="b2cd-note"><strong>Collected</strong> is money actually received, before refunds (a payment later refunded still counts here).
        <strong>Booked value</strong> is what customers have agreed to pay, cancelled excluded — not money received. Analytics shows what was returned.</p>
    </section>`;

  return `${kpis}
    <div class="b2cd-cards">
      ${chart}
      ${customers}
      ${support}
      ${needs}
      ${finance}
      ${b2cdQuickLinks()}
    </div>`;
}

function b2cdQuickLinks() {
  return `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-blue">${b2cdIcon('bookings')}</span><h3>Go to</h3></div>
      <ul class="b2cd-links">
        ${B2CD_LINKS.map(([section, label, sub]) => `
          <li><a href="#" data-b2cd-go="${catE(section)}"><strong>${escapeHtml(label)}</strong>
            <span class="cell-sub">${escapeHtml(sub)}</span></a></li>`).join('')}
      </ul>
    </section>`;
}
