/* Admin — B2C Dashboard (the B2C Admin Portal landing)
   ===================================================
   The operational snapshot, deliberately lean: count-first KPI cards (Total
   bookings, Service level, Payments collected, Booked value), a Bookings-by-
   status donut, and the Customer Support queue. Every card is clickable through
   to its screen. One call, windowed by the date filter beside Refresh:

     GET /api/admin/b2c-dashboard/summary?days=7   (b2c.reports.view)

   DATE FILTER: 1 day / 1 week (default) / 1 month, or a custom range via the
   calendar. The period scopes the booking/money/service-level figures; the
   support queue is always "right now". Refresh reloads the current filter.

   THE BROWSER ONLY DRAWS — every count and rupee figure is computed server-side
   (money as decimal strings, rendered with moneyStr). The only arithmetic here
   is the donut arc length and the share-of-total label, from counts that
   arrived. Loaded after admin.js (navigateToSection, statGridSkeleton,
   authHeaders, API_BASE), shared/formatters.js (moneyStr) and
   admin-b2c-catalogue-common.js (catErr, catE, catWhen). */

let b2cdWired = false;
let b2cdSeq = 0;
/* Default filter: last 1 week (#9). start/end set only for a custom range. */
const b2cdFilter = { days: 7, start: null, end: null };

const b2cdNum = n => Number(n || 0).toLocaleString('en-IN');

const B2CD_ICONS = {
  bookings: '<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  coins: '<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v6c0 1.7 2.7 3 6 3s6-1.3 6-3V6"/><path d="M21 10v4c0 1.7-2.7 3-6 3-1 0-2-.1-2.8-.3"/><path d="M15 10c2.9 0 6-1 6-3"/>',
  ledger: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2Z"/><path d="M9 4v16M12.5 9h3M12.5 13h3"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>',
};
const b2cdIcon = name => `<svg class="icon" viewBox="0 0 24 24">${B2CD_ICONS[name] || ''}</svg>`;

const B2CD_STATUS = [
  ['confirmed', 'Confirmed', 'green'],
  ['pending', 'Pending', 'amber'],
  ['completed', 'Completed', 'blue'],
  ['cancelled', 'Cancelled', 'red'],
];

function b2cdShare(n, total) {
  if (!total) return '—';
  const pct = n / total * 100;
  if (n > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/* ---------- init + load ---------- */

async function initB2CDashboard() {
  if (!b2cdWired) {
    b2cdWired = true;
    document.getElementById('b2cdRefresh').addEventListener('click', () => loadB2CDashboard());

    const range = document.getElementById('b2cdRange');
    range.addEventListener('change', () => {
      if (range.value === 'custom') { b2cdShowCustom(true); return; }
      b2cdShowCustom(false);
      b2cdFilter.days = Number(range.value);
      b2cdFilter.start = b2cdFilter.end = null;
      loadB2CDashboard();
    });
    document.getElementById('b2cdCal').addEventListener('click', () => {
      range.value = 'custom';
      b2cdShowCustom(true);
    });
    document.getElementById('b2cdApply').addEventListener('click', () => {
      const s = document.getElementById('b2cdStart').value;
      const e = document.getElementById('b2cdEnd').value;
      if (!s || !e) return;
      b2cdFilter.days = null; b2cdFilter.start = s; b2cdFilter.end = e;
      loadB2CDashboard();
    });

    document.getElementById('b2cdBody').addEventListener('click', e => {
      if (e.target.closest('[data-b2cd-retry]')) { loadB2CDashboard(); return; }
      const go = e.target.closest('[data-b2cd-go]');
      if (go) { e.preventDefault(); b2cdGo(go.dataset.b2cdGo, go.dataset.b2cdFilter || ''); }
    });
    document.getElementById('b2cdBody').addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-b2cd-go]')) {
        e.preventDefault(); const go = e.target.closest('[data-b2cd-go]');
        b2cdGo(go.dataset.b2cdGo, go.dataset.b2cdFilter || '');
      }
    });
  }
  await loadB2CDashboard();
}

function b2cdShowCustom(show) {
  const c = document.getElementById('b2cdCustom');
  if (c) c.style.display = show ? 'flex' : 'none';
}

async function loadB2CDashboard() {
  const seq = ++b2cdSeq;
  const host = document.getElementById('b2cdBody');
  const stamp = document.getElementById('b2cdStamp');
  const refresh = document.getElementById('b2cdRefresh');
  if (!host) return;
  host.setAttribute('aria-busy', 'true');
  refresh.disabled = true;
  stamp.textContent = 'Loading…';
  host.innerHTML = statGridSkeleton(4);
  const params = b2cdFilter.start
    ? { start_date: b2cdFilter.start, end_date: b2cdFilter.end }
    : { days: b2cdFilter.days };
  try {
    const { data } = await axios.get(`${API_BASE}/api/admin/b2c-dashboard/summary`, { headers: authHeaders(), params });
    if (seq !== b2cdSeq) return;
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

/* ---------- navigation from a card / link ---------- */

function b2cdGo(section, filter) {
  if (section === 'b2c-bookings' && typeof bkgState !== 'undefined') {
    bkgState.status = filter; bkgState.page = 1;
    const sel = document.getElementById('bkgStatusFilter');
    if (sel) sel.value = filter;
  }
  navigateToSection(section);
}

/* ---------- pieces ---------- */

/* Count-only KPI card (#8) — no description line, not clickable (a plain
   figure, by owner request). `money` values get the smaller type so a full
   rupee figure fits. */
function b2cdKpi({ icon, tone, label, value, money }) {
  return `
    <div class="b2cd-kpi">
      <span class="b2cd-kpi-ic tone-${tone}">${b2cdIcon(icon)}</span>
      <span class="b2cd-kpi-label">${escapeHtml(label)}</span>
      <span class="b2cd-kpi-val${money ? ' is-money' : ''}">${value}</span>
    </div>`;
}

/* Bookings-by-status donut + clickable legend (no surrounding description, #10). */
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
      <li><a href="#" class="b2cd-legend-row" data-b2cd-go="b2c-bookings" data-b2cd-filter="${k}">
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

function b2cdTile(label, value, tone) {
  return `
    <div class="b2cd-tile tone-${value > 0 ? tone : 'slate'}">
      <div class="b2cd-tile-val">${b2cdNum(value)}</div>
      <div class="b2cd-tile-label">${escapeHtml(label)}</div>
    </div>`;
}

function b2cdRender(d) {
  const b = d.bookings;
  const s = d.support;

  const kpis = `
    <div class="b2cd-kpis">
      ${b2cdKpi({ icon: 'bookings', tone: 'blue', label: 'Total bookings', value: b2cdNum(b.total) })}
      ${b2cdKpi({ icon: 'check', tone: 'green', label: 'Service level', value: `${d.service_level}%` })}
      ${b2cdKpi({ icon: 'coins', tone: 'teal', label: 'Payments collected', value: escapeHtml(moneyStr(b.collected)), money: true })}
      ${b2cdKpi({ icon: 'ledger', tone: 'indigo', label: 'Booked value', value: escapeHtml(moneyStr(b.booked_value)), money: true })}
    </div>`;

  const chart = `
    <section class="b2cd-card">
      <div class="b2cd-card-head"><span class="b2cd-card-ic tone-blue">${b2cdIcon('bookings')}</span><h3>Bookings by status</h3></div>
      ${b.total ? b2cdDonut(b) : '<p class="b2cd-empty">No bookings in this period.</p>'}
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
    </section>`;

  return kpis + `<div class="b2cd-cards">${chart}${support}</div>`;
}
