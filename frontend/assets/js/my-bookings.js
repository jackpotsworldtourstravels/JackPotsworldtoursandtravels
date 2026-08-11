'use strict';
/* ===========================================================================
   my-bookings.js — the list of everything booked.
   ===========================================================================
   Reads BookingStore, which is the same seam the booking flow writes through,
   so this page needs no knowledge of how a booking was made — a flight, a
   cruise and a visa application all render from one shape.
   =========================================================================== */

const MyBookings = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const icon = n => (typeof JPIcon !== 'undefined' ? JPIcon.html(n, { size: 'sm' }) : '');

  function fmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso.length > 10 ? iso : iso + 'T00:00:00');
    return isNaN(d) ? iso
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  let rows = [];
  let filter = 'all';

  function card(b) {
    const cancelled = b.status === 'Cancelled';
    return `<article class="mb-card ${cancelled ? 'is-cancelled' : ''}">
      <div class="mb-kind">${icon(b.icon || 'flights')}<span>${esc(b.kindLabel || b.kind)}</span></div>

      <div class="mb-main">
        <h3>${esc(b.title || '—')}</h3>
        <p>${esc(b.subtitle || '')}</p>
        <div class="mb-facts">
          <span><b>${esc(b.id)}</b> booking ID</span>
          ${b.pnr ? `<span><b>${esc(b.pnr)}</b> PNR</span>` : ''}
          <span><b>${esc(fmt(b.travelDate))}</b> travel date</span>
          <span><b>${esc((b.passengers || []).length || 1)}</b> traveller(s)</span>
        </div>
      </div>

      <div class="mb-right">
        <span class="mb-status is-${cancelled ? 'cancelled' : 'confirmed'}">${esc(b.status)}</span>
        <b class="mb-total">${esc(money(b.total))}</b>
        <div class="mb-actions">
          <button type="button" class="tx-btn tx-btn-ghost" data-mb="view" data-id="${esc(b.id)}">View</button>
          <button type="button" class="tx-btn tx-btn-ghost" data-mb="ticket" data-id="${esc(b.id)}">Ticket</button>
          ${cancelled ? '' :
            `<button type="button" class="tx-btn tx-btn-ghost is-danger" data-mb="cancel" data-id="${esc(b.id)}">Cancel</button>`}
        </div>
      </div>
    </article>`;
  }

  function emptyState() {
    return `<div class="mb-empty">
        <div class="mb-empty-mark">${typeof JPIcon !== 'undefined' ? JPIcon.html('packages', { size: 'xl' }) : ''}</div>
        <h2>No bookings yet</h2>
        <p>Once you book a flight, hotel, cruise or tour it will appear here with
           its reference, ticket and cancellation options.</p>
        <div class="mb-empty-cta">
          <a class="tx-btn tx-btn-primary" href="flights.html">Search flights</a>
          <a class="tx-btn tx-btn-ghost" href="packages.html">Browse packages</a>
        </div>
      </div>`;
  }

  function render() {
    const host = document.getElementById('mbList');
    if (!host) return;
    const shown = filter === 'all' ? rows : rows.filter(b => b.kind === filter);

    document.getElementById('mbCount').textContent = rows.length
      ? `${shown.length} of ${rows.length} booking${rows.length === 1 ? '' : 's'}` : '';

    if (!rows.length) { host.innerHTML = emptyState(); armIcons(host); return; }
    host.innerHTML = shown.length
      ? shown.map(card).join('')
      : `<div class="mb-empty"><h2>Nothing in this category</h2>
           <p>Try another filter to see your other bookings.</p></div>`;
    armIcons(host);
  }

  function armIcons(scope) {
    if (typeof JPIcon !== 'undefined') JPIcon.mount(scope || document);
  }

  function renderTabs() {
    const host = document.getElementById('mbTabs');
    if (!host) return;
    const kinds = [['all', 'All']].concat(
      Object.entries(BookingStore.KINDS).map(([k, v]) => [k, v.label + 's']));
    host.innerHTML = kinds.map(([k, label]) => {
      const n = k === 'all' ? rows.length : rows.filter(b => b.kind === k).length;
      /* A filter that can only ever show nothing is noise — hide empty ones. */
      if (k !== 'all' && !n) return '';
      return `<button type="button" class="mb-tab ${filter === k ? 'is-on' : ''}" data-kind="${esc(k)}">
        ${esc(label)}<span>${n}</span></button>`;
    }).join('');
    host.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      filter = b.dataset.kind;
      renderTabs(); render();
    }));
  }

  async function refresh() {
    rows = await BookingStore.list();
    renderTabs();
    render();
  }

  function detailHtml(b) {
    const pax = (b.passengers || []).map((p, i) =>
      `<li>${esc(p.title)} ${esc(p.first)} ${esc(p.last)}
         <span>${esc(p.kind || 'Adult')}${b.seats && b.seats[i] ? ' · Seat ' + esc(b.seats[i]) : ''}</span></li>`).join('');
    const addons = (b.addons || []).length
      ? b.addons.map(a => `<li>${esc(a.name)}<span>${a.price ? esc(money(a.price)) : 'Free'}</span></li>`).join('')
      : '<li class="is-muted">None</li>';
    const fare = ((b.pricing || {}).lines || []).map(l =>
      `<div class="bk-price-line"><span>${esc(l.label)}</span><span>${l.free ? 'Included' : esc(money(l.amount))}</span></div>`).join('');

    return `<div class="mb-detail">
        <header>
          <div><span class="mb-kind-tag">${esc(b.kindLabel)}</span>
            <h2>${esc(b.title)}</h2><p>${esc(b.subtitle || '')}</p></div>
          <button type="button" class="bk-close" data-mb="close" aria-label="Close">&times;</button>
        </header>
        <div class="bk-refs">
          <div class="bk-ref"><span>Booking ID</span><b>${esc(b.id)}</b></div>
          ${b.pnr ? `<div class="bk-ref"><span>PNR</span><b>${esc(b.pnr)}</b></div>` : ''}
          ${b.ticketNumber ? `<div class="bk-ref"><span>Ticket</span><b>${esc(b.ticketNumber)}</b></div>` : ''}
          <div class="bk-ref"><span>Status</span><b>${esc(b.status)}</b></div>
          <div class="bk-ref"><span>Travel date</span><b>${esc(fmt(b.travelDate))}</b></div>
          <div class="bk-ref"><span>Booked on</span><b>${esc(fmt(b.bookedAt))}</b></div>
        </div>
        <section class="bk-panel"><h3>Travellers</h3><ul class="bk-list">${pax || '<li class="is-muted">—</li>'}</ul></section>
        <section class="bk-panel"><h3>Add-ons</h3><ul class="bk-list">${addons}</ul></section>
        <section class="bk-panel"><h3>Fare</h3>${fare}
          <div class="bk-price-total"><span>Total</span><span>${esc(money(b.total))}</span></div></section>
        <div class="mb-detail-actions">
          <button type="button" class="tx-btn tx-btn-primary" data-mb="ticket" data-id="${esc(b.id)}">Download ticket</button>
          <button type="button" class="tx-btn tx-btn-ghost" data-mb="close">Close</button>
        </div>
      </div>`;
  }

  function openDetail(b) {
    const ov = document.getElementById('mbOverlay');
    ov.innerHTML = detailHtml(b);
    ov.classList.add('is-open');
    document.body.classList.add('bk-locked');
    armIcons(ov);
  }
  function closeDetail() {
    const ov = document.getElementById('mbOverlay');
    ov.classList.remove('is-open');
    ov.innerHTML = '';
    document.body.classList.remove('bk-locked');
  }

  function bind() {
    document.addEventListener('click', async e => {
      const btn = e.target.closest('[data-mb]');
      if (!btn) return;
      const act = btn.dataset.mb;
      if (act === 'close') return closeDetail();

      const b = rows.find(x => x.id === btn.dataset.id);
      if (!b) return;

      if (act === 'view') return openDetail(b);
      if (act === 'ticket') return BookingTicket.handle('download', b);
      if (act === 'cancel') {
        /* Demo cancellation is still destructive from the user's point of
           view — it flips the row to Cancelled and hides the ticket path. */
        if (!window.confirm(`Cancel booking ${b.id}? This cannot be undone in the demo.`)) return;
        await BookingStore.cancel(b.id);
        showToast(`${b.id} cancelled. A refund would be processed to the original payment method.`);
        await refresh();
      }
    });

    document.getElementById('mbOverlay').addEventListener('click', e => {
      if (e.target.id === 'mbOverlay') closeDetail();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeDetail();
    });
  }

  async function init() {
    if (!document.getElementById('mbList')) return;
    bind();
    await refresh();
  }

  return { init, refresh };
})();

document.addEventListener('DOMContentLoaded', MyBookings.init);
if (document.readyState !== 'loading') MyBookings.init();
