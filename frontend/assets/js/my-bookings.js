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

  /* WHICH BOOKINGS CAN STILL BE PAID.
     A booking only reaches this page unpaid when no gateway was available at
     the time it was made -- which is exactly the pilot case, where the
     deployment offers no payment but one named booking can still be collected
     for. All three B2C products are wired to a payment provider now; the
     BookingPay decides, so a product without endpoints cannot be given a
     button that could only fail.

     Whether a provider will ACTUALLY take it is not decided here. That is asked
     of the server, per booking, when the button is pressed -- see startPayment.
     Drawing the button is cheap; guessing the answer is not. */
  /* BookingPay owns the list of products with a checkout and a reconcile
     endpoint. Asking it, rather than keeping a second table here, is what stops
     the button and the thing behind the button disagreeing. */
  function payable(b) {
    if (!BookingPay.supports(b.kind)) return false;
    if (b.status !== 'Pending') return false;
    // Money taken and returned: the booking is finished, whatever its status.
    if (BookingPay.isRefunded(b.payments)) return false;
    // Held, not paid for, and the hold has run out.
    if (BookingPay.windowClosed(b.bookedAt)) return false;
    return true;
  }

  /** Why a pending booking cannot be paid, for the traveller. Null when it can. */
  function unpayableReason(b) {
    if (!BookingPay.supports(b.kind)) return null;
    if (b.status !== 'Pending') return null;
    if (BookingPay.isRefunded(b.payments)) return 'Refunded';
    if (BookingPay.windowClosed(b.bookedAt)) return 'Payment window closed';
    return null;
  }

  /* Pay a booking that already exists.

     THE REFERENCE IS THE POINT. paymentConfig() asked without one answers for
     the deployment, and a pilot booking looks unpayable. Asked with this
     booking's reference it answers for this booking, which is the only question
     worth asking here.

     The idempotency key is derived from the reference and never varies, so a
     second click, a reload or a return visit all resolve to the one order
     rather than opening another against the same booking. */
  async function startPayment(b) {
    const ref = b.ref || b.id;

    /* The overlay is this page's own; BookingPay draws into it rather than
       making one, so the detail modal's close and lock behaviour still apply. */
    const ov = document.getElementById('mbOverlay');
    ov.innerHTML = '';
    ov.classList.add('is-open');
    document.body.classList.add('bk-locked');

    await BookingPay.open({
      ref: ref,
      kind: b.kind,
      title: b.title || b.id,
      host: ov,
      onUnavailable: (msg) => {
        ov.classList.remove('is-open');
        document.body.classList.remove('bk-locked');
        showToast(msg);
      },
      onDone: async () => { closeDetail(); await refresh(); },
    });
  }

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
          ${payable(b)
            ? `<button type="button" class="tx-btn tx-btn-primary" data-mb="pay" data-id="${esc(b.id)}">Pay now</button>`
            : (unpayableReason(b)
                ? `<span class="mb-unpayable">${esc(unpayableReason(b))}</span>` : '')}
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
    /* Flights are real server bookings now; the other four products are still
       local demo rows. Label the list only when it actually contains one,
       rather than calling a booking with a real reference a demo. */
    const badge = document.getElementById('mbDemoBadge');
    if (badge) badge.hidden = !rows.some(b => b.demo !== false);
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

      if (act === 'pay') return startPayment(b);
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

    /* ?pay=REF -- open payment for one booking on arrival.

       The account panel lists bookings but deliberately has no payment screen
       of its own, so its Pay button sends the traveller here. Dropping them on
       the list and leaving them to find the same booking again is a worse
       answer than carrying the reference across.

       Ignored in silence when the booking is missing or not payable: the list
       is already on screen and is the honest fallback, and a reference in a URL
       is not evidence of anything -- payable() and the server's own
       paymentConfig(ref) still decide. */
    const want = new URLSearchParams(window.location.search).get('pay');
    if (!want) return;
    const b = rows.find(r => String(r.ref || r.id) === want);
    if (b && payable(b)) startPayment(b);
  }

  return { init, refresh };
})();

document.addEventListener('DOMContentLoaded', MyBookings.init);
if (document.readyState !== 'loading') MyBookings.init();
