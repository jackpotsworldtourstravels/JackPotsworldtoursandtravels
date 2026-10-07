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

  /* =====================================================================
     THE COMMAND CENTRE
     =====================================================================
     SERVER BOOKINGS ONLY. BookingStore.list() also returns local demo rows
     (localStorage) for products that were not live when they were made;
     this page lists what the server holds — a reference someone can quote
     to support — and nothing else. The Account Center's own list is
     unchanged.

     Every count, the next trip and each card's status tone come from the
     rows' own fields: `status` (the server's), `travelDate`, `payments`.
     ===================================================================== */
  const today = () => new Date().toISOString().slice(0, 10);
  const isCancelled = b => /^cancel/i.test(String(b.status || ''));
  const isPast = b => !!b.travelDate && String(b.travelDate).slice(0, 10) < today();
  const needsPay = b => payable(b);
  const isUpcoming = b => !isCancelled(b) && !isPast(b);

  /* status -> the tone a traveller should read it in. Pending is gold
     (waiting), confirmed and completed green, cancelled grey. It used to be
     green for everything that was not cancelled, Pending included. */
  function tone(b) {
    const s = String(b.status || '').toLowerCase();
    if (isCancelled(b)) return 'cancelled';
    if (s === 'confirmed' || s === 'completed' || s === 'ticketed') return 'ok';
    return 'wait';
  }

  const SEGMENTS = [
    ['all', 'All', () => true],
    ['upcoming', 'Upcoming', isUpcoming],
    ['pay', 'Awaiting payment', needsPay],
    ['past', 'Past', b => isPast(b) && !isCancelled(b)],
    ['cancelled', 'Cancelled', isCancelled],
  ];
  let segment = 'all';

  function daysUntil(iso) {
    if (!iso) return null;
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00'), t = new Date(today() + 'T00:00:00');
    return Math.round((d - t) / 86400000);
  }
  function whenWord(n) {
    if (n == null || n < 0) return '';
    return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : 'In ' + n + ' days';
  }

  function card(b) {
    const t = tone(b);
    const cancelled = isCancelled(b);
    const when = cancelled ? '' : whenWord(daysUntil(b.travelDate));
    return `<article class="mb-card mbc is-${t}">
      <div class="mbc-kind">${icon(b.icon || 'flights')}<span>${esc(b.kindLabel || b.kind)}</span></div>

      <div class="mbc-main">
        ${when ? `<p class="mbc-when">${esc(when)}</p>` : ''}
        <h3 class="mbc-title">${esc(b.title || '—')}</h3>
        ${b.subtitle ? `<p class="mbc-sub">${esc(b.subtitle)}</p>` : ''}
        <dl class="mbc-facts">
          <div><dt>Reference</dt><dd>${esc(b.ref || b.id)}</dd></div>
          ${b.pnr ? `<div><dt>PNR</dt><dd>${esc(b.pnr)}</dd></div>` : ''}
          <div><dt>Travel date</dt><dd>${esc(fmt(b.travelDate))}</dd></div>
          <div><dt>Travellers</dt><dd>${esc((b.passengers || []).length || 1)}</dd></div>
          ${b.bookedAt ? `<div><dt>Booked</dt><dd>${esc(fmt(b.bookedAt))}</dd></div>` : ''}
        </dl>
      </div>

      <div class="mbc-folio">
        <span class="mbc-status is-${t}">${esc(b.status)}</span>
        <b class="mbc-total">${esc(money(b.total))}</b>
        <div class="mbc-actions">
          ${payable(b)
            ? `<button type="button" class="ds-btn ds-btn--primary ds-btn--sm" data-mb="pay" data-id="${esc(b.id)}">Pay now</button>`
            : (unpayableReason(b) ? `<span class="mb-unpayable">${esc(unpayableReason(b))}</span>` : '')}
          <button type="button" class="mbc-link" data-mb="view" data-id="${esc(b.id)}">Details</button>
          <button type="button" class="mbc-link" data-mb="ticket" data-id="${esc(b.id)}">Ticket</button>
          ${cancelled ? '' : `<button type="button" class="mbc-link is-danger" data-mb="cancel" data-id="${esc(b.id)}">Cancel</button>`}
        </div>
      </div>
    </article>`;
  }

  function state(host, opts) {
    if (typeof DS !== 'undefined') { DS.state(host, opts); return; }
    host.innerHTML = `<div class="mb-empty"><h2>${esc(opts.title)}</h2><p>${esc(opts.body || '')}</p></div>`;
  }

  function emptyState(host) {
    state(host, { kind: 'empty', kicker: 'Nothing booked yet', title: 'No bookings yet',
      body: 'Once you book a flight, a hotel or a tour it appears here with its reference, its ticket and its cancellation options.',
      actions: [{ label: 'Search flights', href: 'flights.html' }, { label: 'Browse hotels', href: 'hotels.html' }] });
  }

  function paintHero() {
    const stats = document.getElementById('mbStats');
    const next = document.getElementById('mbNext');
    if (!stats || !next) return;
    const counts = [
      ['Upcoming', rows.filter(isUpcoming).length],
      ['Awaiting payment', rows.filter(needsPay).length],
      ['Past', rows.filter(b => isPast(b) && !isCancelled(b)).length],
      ['Cancelled', rows.filter(isCancelled).length],
    ];
    stats.innerHTML = counts.map(c => `<div><dt>${c[0]}</dt><dd>${c[1]}</dd></div>`).join('');
    stats.hidden = !rows.length;

    const up = rows.filter(isUpcoming).filter(b => b.travelDate)
      .sort((x, y) => String(x.travelDate).localeCompare(String(y.travelDate)))[0];
    if (up) {
      const w = whenWord(daysUntil(up.travelDate));
      next.innerHTML = `<span class="mb-next-k">Next trip</span>
        <b class="mb-next-t">${esc(up.title || up.id)}</b>
        <span class="mb-next-d">${esc(fmt(up.travelDate))}${w ? ' · ' + esc(w.toLowerCase()) : ''} · ${esc(up.status)}</span>`;
      next.hidden = false;
    } else next.hidden = true;
  }

  function render() {
    const host = document.getElementById('mbList');
    if (!host) return;
    host.removeAttribute('aria-busy');
    const segFn = (SEGMENTS.find(x => x[0] === segment) || SEGMENTS[0])[2];
    const shown = rows.filter(segFn).filter(b => filter === 'all' || b.kind === filter);

    document.getElementById('mbCount').textContent = rows.length
      ? `${shown.length} of ${rows.length} booking${rows.length === 1 ? '' : 's'}` : '';

    if (!rows.length) { emptyState(host); armIcons(host); return; }
    if (!shown.length) {
      state(host, { kind: 'empty', kicker: 'Nothing here', title: 'Nothing in this view',
        body: 'Try another filter to see your other bookings.' });
      return;
    }
    host.innerHTML = shown.map(card).join('');
    armIcons(host);
  }

  function armIcons(scope) {
    if (typeof JPIcon !== 'undefined') JPIcon.mount(scope || document);
  }

  function renderSegments() {
    const host = document.getElementById('mbSeg');
    if (!host) return;
    host.innerHTML = SEGMENTS.map(([k, label, fn]) => {
      const n = rows.filter(fn).length;
      if (k !== 'all' && !n) return '';
      return `<button type="button" class="ds-tab" data-seg="${esc(k)}" aria-selected="${segment === k}">${esc(label)} <span class="mb-seg-n">${n}</span></button>`;
    }).join('');
    host.hidden = !rows.length;
    delete host.dataset.dsTabs;
    if (typeof DS !== 'undefined') DS.tabs(host, t => { segment = t.dataset.seg; render(); });
    else host.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => { segment = b.dataset.seg; renderSegments(); render(); }));
  }

  function renderTabs() {
    const host = document.getElementById('mbTabs');
    if (!host) return;
    const kinds = [['all', 'All products']].concat(
      Object.entries(BookingStore.KINDS).map(([k, v]) => [k, v.label + 's']));
    const chips = kinds.map(([k, label]) => {
      const n = k === 'all' ? rows.length : rows.filter(b => b.kind === k).length;
      /* A filter that can only ever show nothing is noise — hide empty ones. */
      if (k !== 'all' && !n) return '';
      return `<button type="button" class="ds-chip mb-tab" aria-pressed="${filter === k}" data-kind="${esc(k)}">
        ${esc(label)}<span class="ds-chip__count">${n}</span></button>`;
    }).filter(Boolean);
    /* One product only: a single chip beside "All" is not a choice. */
    host.innerHTML = chips.length > 2 ? chips.join('') : '';
    host.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      filter = b.dataset.kind;
      renderTabs(); render();
    }));
  }

  async function refresh() {
    const host = document.getElementById('mbList');
    const signedIn = typeof BookingApi !== 'undefined' && BookingApi.isSignedIn();
    if (!signedIn) {
      rows = [];
      paintHero(); renderSegments(); renderTabs();
      if (host) state(host, { kind: 'expired', kicker: 'Signed out', title: 'Sign in to see your bookings',
        body: 'Your bookings are kept with your account, so they are the same on every device.',
        actions: [{ label: 'Sign in', href: 'login.html' }] });
      return;
    }
    if (host && typeof DS !== 'undefined' && !rows.length) DS.skeleton(host, 'row', 3);
    try {
      rows = (await BookingStore.list()).filter(b => b.demo === false);
    } catch (err) {
      if (host) state(host, { kind: navigator.onLine === false ? 'offline' : 'error', title: 'We could not load your bookings',
        actions: [{ label: 'Try again', onClick: () => refresh() }] });
      return;
    }
    paintHero();
    renderSegments();
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
        /* A server booking: the server cancels it and says what state it is
           in. No refund is promised here — whether one is due is the fare's
           and the policy's answer, not this button's. */
        if (!window.confirm(`Cancel booking ${b.ref || b.id}? This cannot be undone.`)) return;
        try {
          await BookingStore.cancel(b.id);
          showToast(`${b.ref || b.id} is cancelled.`);
        } catch (err) {
          showToast((err && err.message) || 'We could not cancel this booking. Please try again or contact support.');
        }
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

  /* ?payment_return=hdfc&kind=...&ref=... -- back from a hosted payment page.

     Our server put these here after asking the provider about the order, so
     they say only WHICH booking to show; the screen then asks the server again,
     through reconcile, what happened to it. Removed from the address bar at
     once so a reload or a shared link does not replay the confirming screen. */
  let returnHandled = false;
  function handlePaymentReturn() {
    const q = new URLSearchParams(window.location.search);
    const from = q.get('payment_return');
    if (!from || returnHandled) return null;
    returnHandled = true;
    const back = { from, ref: q.get('ref') || '', kind: q.get('kind') || '' };
    try {
      q.delete('payment_return'); q.delete('kind'); q.delete('ref');
      const rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
    } catch { /* cosmetic only */ }
    return back;
  }

  async function init() {
    if (!document.getElementById('mbList')) return;
    const back = handlePaymentReturn();
    bind();
    await refresh();

    if (back) {
      const b = rows.find(r => String(r.ref || r.id) === back.ref);
      if (b && BookingPay.supports(back.kind || b.kind)) {
        const ov = document.getElementById('mbOverlay');
        ov.innerHTML = '';
        ov.classList.add('is-open');
        document.body.classList.add('bk-locked');
        BookingPay.resume({
          ref: back.ref, kind: back.kind || b.kind, title: b.title || b.id, host: ov,
          onDone: async () => { closeDetail(); await refresh(); },
        });
      } else {
        showToast('We are confirming your payment with the bank. Your booking will '
          + 'update here as soon as it is confirmed.');
      }
      return;
    }

    /* ?pay=REF -- open payment for one booking on arrival.

       The account panel lists bookings but deliberately has no payment screen
       of its own, so its Pay button sends the traveller here. Dropping them on
       the list and leaving them to find the same booking again is a worse
       answer than carrying the reference across.

       Ignored in silence when the booking is missing or not payable: the list
       is already on screen and is the honest fallback, and a reference in a URL
       is not evidence of anything -- payable() and the server's own
       paymentConfig(ref) still decide. */
    /* ?open=REF -- a notification sent the traveller here for one booking.
       Shows that booking's own detail view; a reference that is not in the
       traveller's list is ignored, same as ?pay. */
    const openRef = new URLSearchParams(window.location.search).get('open');
    if (openRef) {
      const ob = rows.find(r => String(r.ref || r.id) === openRef);
      if (ob) openDetail(ob);
    }

    const want = new URLSearchParams(window.location.search).get('pay');
    if (!want) return;
    const b = rows.find(r => String(r.ref || r.id) === want);
    if (b && payable(b)) startPayment(b);
  }

  return { init, refresh };
})();

document.addEventListener('DOMContentLoaded', MyBookings.init);
if (document.readyState !== 'loading') MyBookings.init();
