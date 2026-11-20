/* Admin — B2C Dashboard (the B2C Admin Portal landing)
   ===================================================
   THE OPERATIONAL "WHAT NEEDS ME NOW" SNAPSHOT — deliberately not B2C
   Analytics (period trends, charts). One call:

     GET /api/admin/b2c-dashboard/summary   (b2c.reports.view)

   THE BROWSER ONLY DRAWS. Every count and every rupee figure arrives from the
   server already computed (money as decimal strings, rendered with moneyStr).
   Nothing here is hard-coded, cached across visits or derived into a new
   stored number; the only arithmetic is a bar length and a share-of-total
   label drawn from counts that arrived.

   BOOKED VALUE IS NOT MONEY RECEIVED. "Booked value" is what is on the books
   (cancelled excluded), "Collected" is every payment that was captured (money
   received, before refunds — a payment later refunded in full still counts, so
   refunds never make it shrink) — both are shown and
   labelled as such, never subtracted from each other (a captured payment on a
   since-cancelled booking would make any "outstanding" figure wrong).

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
    stamp.textContent = `Updated ${catWhen(data.generated_at)}`;
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

const b2cdKpi = (label, value, sub, hint) => `
  <div class="b2ca-tile" ${hint ? `title="${catE(hint)}"` : ''}>
    <span class="detail-label">${escapeHtml(label)}</span>
    <span class="b2ca-hero">${value}</span>
    ${sub ? `<span class="cell-sub">${sub}</span>` : ''}
  </div>`;

/* One actionable row: a count, what it means, and where to deal with it. */
function b2cdQueueItem({ count, label, detail, section, filter, cta }) {
  const live = count > 0;
  return `
    <li class="b2cd-queue-item${live ? ' is-live' : ''}">
      <span class="b2cd-queue-count" aria-hidden="true">${b2cdNum(count)}</span>
      <span class="b2cd-queue-text">
        <strong>${escapeHtml(label)}</strong>
        <span class="cell-sub">${live ? escapeHtml(detail) : 'Nothing waiting.'}</span>
      </span>
      <a href="#" class="btn ${live ? 'btn-navy' : 'btn-ghost'} btn-sm" data-b2cd-go="${catE(section)}"
         data-b2cd-filter="${catE(filter || '')}" aria-label="${catE(`${cta}: ${count} ${label}`)}">${escapeHtml(cta)}</a>
    </li>`;
}

const B2CD_STATUS = [
  ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['completed', 'Completed'], ['cancelled', 'Cancelled'],
];

function b2cdStatusBars(b) {
  const max = Math.max(1, ...B2CD_STATUS.map(([k]) => b.by_status[k] || 0));
  const share = n => (b.total ? `${(n / b.total * 100).toFixed(1)}%` : '—');
  return `<div class="b2ca-hbars">${B2CD_STATUS.map(([k, label]) => {
    const n = b.by_status[k] || 0;
    return `
      <a href="#" class="b2ca-hrow b2cd-hlink" data-b2cd-go="b2c-bookings" data-b2cd-filter="${k}"
         title="${catE(`${label}: ${n} booking${n === 1 ? '' : 's'} (${share(n)}) — open in Bookings`)}">
        <span class="b2ca-hlabel">${escapeHtml(label)}</span>
        <span class="b2ca-htrack"><span class="b2ca-hfill" style="width:${Math.round(n / max * 100)}%"></span></span>
        <span class="b2ca-hvalue">${b2cdNum(n)}</span>
      </a>`;
  }).join('')}</div>
  <details class="b2ca-table"><summary>View as table</summary>
    <div class="table-wrap"><table><thead><tr><th>Status</th><th class="num">Bookings</th><th class="num">Share</th></tr></thead><tbody>
      ${B2CD_STATUS.map(([k, label]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${b2cdNum(b.by_status[k] || 0)}</td>
        <td class="num">${share(b.by_status[k] || 0)}</td></tr>`).join('')}
    </tbody></table></div>
  </details>`;
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
      ${b2cdLinksCard()}`;
  }

  const kpis = `
    <div class="b2ca-tiles">
      ${b2cdKpi('Customers', b2cdNum(c.total), `${b2cdNum(c.registered)} registered · ${b2cdPlural(c.guests, 'guest', 'guests')}`)}
      ${b2cdKpi('New in 30 days', b2cdNum(c.new_30d), 'Registrations and guest sign-ups')}
      ${b2cdKpi('Bookings', b2cdNum(b.total), 'All time · flights, hotels, packages')}
      ${b2cdKpi('Booked value', escapeHtml(moneyStr(b.booked_value)), 'On the books, cancelled excluded — not money received',
        'Total amount of every booking that is not cancelled, paid or not.')}
      ${b2cdKpi('Collected', escapeHtml(moneyStr(b.collected)), 'Money received, all time · before refunds',
        'Every payment that was captured, including payments later refunded. Refunds are not subtracted — see Analytics for money returned.')}
      ${b2cdKpi('Open conversations', b2cdNum(s.open_conversations), `${b2cdPlural(s.admin_unread, 'unread message', 'unread messages')}`)}
    </div>`;

  const queue = `
    <section class="b2ca-card">
      <h3>Needs attention</h3>
      <p class="cell-sub">Open work across the B2C desk, right now. Each link opens the screen where it is handled.</p>
      <ul class="b2cd-queue">
        ${b2cdQueueItem({ count: s.waiting_unassigned, label: 'Unassigned chats waiting',
          detail: 'Customers waiting in Live Support with no agent assigned.', section: 'live-support', cta: 'Open Live Support' })}
        ${b2cdQueueItem({ count: s.admin_unread, label: 'Unread support messages',
          detail: `Across ${b2cdPlural(s.open_conversations, 'open conversation', 'open conversations')}.`, section: 'live-support', cta: 'Reply' })}
        ${b2cdQueueItem({ count: b.by_status.pending || 0, label: 'Pending bookings',
          detail: 'Bookings not yet confirmed.', section: 'b2c-bookings', filter: 'pending', cta: 'Review bookings' })}
        ${b2cdQueueItem({ count: r.pending, label: 'Reviews awaiting moderation',
          detail: 'Not shown publicly until approved.', section: 'b2c-reviews', filter: 'pending', cta: 'Moderate' })}
        ${b2cdQueueItem({ count: c.blocked, label: 'Blocked customers',
          detail: 'Accounts that cannot sign in or book.', section: 'b2c-customers', filter: 'blocked', cta: 'View' })}
      </ul>
    </section>`;

  const bookings = `
    <section class="b2ca-card">
      <h3>Bookings by status</h3>
      <p class="cell-sub">${b2cdPlural(b.total, 'booking', 'bookings')}, all time, across flights, hotels and tour packages. Select a row to open it in Bookings.</p>
      ${b.total ? b2cdStatusBars(b) : '<p class="empty-state">No bookings yet.</p>'}
      <dl class="b2cd-money">
        <div><dt>Booked value</dt><dd>${escapeHtml(moneyStr(b.booked_value))}</dd></div>
        <div><dt>Collected</dt><dd>${escapeHtml(moneyStr(b.collected))}</dd></div>
      </dl>
      <p class="cell-sub" style="margin:6px 0 0;"><strong>Booked value</strong> is what customers have agreed to pay — not money received.
        <strong>Collected</strong> is every payment that was captured — money actually received, before refunds
        (a payment later refunded still counts here; Analytics shows what was returned).</p>
    </section>`;

  const community = `
    <section class="b2ca-card">
      <h3>Customers &amp; reviews</h3>
      <div class="table-wrap"><table><tbody>
        <tr><td>Registered customers</td><td class="num">${b2cdNum(c.registered)}</td></tr>
        <tr><td>Guest customers</td><td class="num">${b2cdNum(c.guests)}</td></tr>
        <tr><td>Blocked</td><td class="num">${b2cdNum(c.blocked)}</td></tr>
        <tr><td>Joined in the last 30 days</td><td class="num">${b2cdNum(c.new_30d)}</td></tr>
        <tr><td>Reviews approved (public)</td><td class="num">${b2cdNum(r.approved)}</td></tr>
        <tr><td>Reviews pending moderation</td><td class="num">${b2cdNum(r.pending)}</td></tr>
      </tbody></table></div>
    </section>`;

  return `${kpis}
    <div class="b2ca-grid2">
      ${queue}
      ${bookings}
      ${community}
      ${b2cdLinksCard()}
    </div>`;
}

function b2cdLinksCard() {
  return `
    <section class="b2ca-card">
      <h3>Go to</h3>
      <ul class="b2cd-links">
        ${B2CD_LINKS.map(([section, label, sub]) => `
          <li><a href="#" data-b2cd-go="${catE(section)}"><strong>${escapeHtml(label)}</strong>
            <span class="cell-sub">${escapeHtml(sub)}</span></a></li>`).join('')}
      </ul>
    </section>`;
}
