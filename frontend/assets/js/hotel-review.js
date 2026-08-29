'use strict';
/* ===========================================================================
   hotel-review.js — the Review screen.
   ===========================================================================
   Step 6, and the last screen before money is discussed. Its job is to let
   somebody CHECK a booking, not fill one in: every section is a summary with
   an Edit that returns to the step that owns it. The only things editable
   here are the two that genuinely belong to the whole booking rather than to
   an earlier step — the extras, and a coupon.

   THE TOTAL IS ALWAYS THE SERVER'S.
   Every change on this screen (an extra added, a coupon applied or removed)
   re-asks `POST /hotel-bookings/quote` and shows what comes back. Nothing is
   added up here. The one number this file computes is a per-room nightly
   subtotal for the room list, which is presentation of a rate the server
   already gave, not a price.

   AND IF THAT TOTAL MOVES, IT IS SAID OUT LOUD.
   `lastSeenTotal` remembers what the traveller was last shown. When a fresh
   quote disagrees — a coupon expiring between screens, a rate changing — the
   screen says the price changed, shows both numbers, and makes them
   acknowledge it before Continue works again. Quietly swapping the number
   would mean charging for something they never agreed to.

   WHERE THE EXTRAS LIVE, AND WHY HERE.
   The add-on catalogue (breakfast, airport pickup, late checkout, insurance)
   is real and priced server-side, but the approved hotel journey has no
   Add-ons step — so it had nowhere to be chosen and was unreachable. Rather
   than invent a step the reference does not have, they are a compact Extras
   section on this screen. Nothing about the catalogue or its pricing changed.
   =========================================================================== */

const HotelReview = (function () {

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rupees = n => (typeof money === 'function' ? money(n)
    : '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'));
  const icon = (name, cls) => (typeof HotelResults !== 'undefined' && HotelResults.icon)
    ? HotelResults.icon(name, cls) : '';

  let detail = null;
  let shell = null;
  let picks = [];
  let guestData = null;      // what Guest Details produced
  let addonCatalogue = null; // { meal: [...], service: [...] }
  let chosenAddons = [];     // codes
  let couponCode = null;
  let couponError = null;
  let quote = null;
  let quoteBusy = false;
  let quoteError = null;
  let addonsError = null;
  let lastSeenTotal = null;  // the total the traveller has actually seen
  let priceChanged = null;   // { from, to } until acknowledged
  let bound = false;
  let handlers = {};
  let token = 0;

  /* ---------------------------------------------------------------------
     Stay maths — presentation only.
     --------------------------------------------------------------------- */
  function nights() {
    const a = shell && shell.checkIn ? new Date(shell.checkIn) : null;
    const b = shell && shell.checkOut ? new Date(shell.checkOut) : null;
    if (!a || !b || isNaN(a) || isNaN(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }
  const roomCount = () => Math.max(1, picks.length);
  const guests = () => (guestData && guestData.party) || [];
  const adults = () => guests().filter(g => g.kind === 'adult').length;
  const children = () => guests().filter(g => g.kind === 'child').length;

  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-IN',
      { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  function isInclusion(meal) { return !/^\s*room only\s*$/i.test(String(meal || '')); }
  function ratingWord(r) {
    const n = Number(r) || 0;
    if (n >= 4.5) return 'Excellent';
    if (n >= 4.0) return 'Very Good';
    if (n >= 3.5) return 'Good';
    return 'Pleasant';
  }
  function heroSlug() {
    const known = typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : {};
    return (detail.image && known[detail.image]) ? detail.image
      : (typeof HOTEL_IMAGE_DEFAULT === 'string' ? HOTEL_IMAGE_DEFAULT : 'default-hotel');
  }
  const imgDir = () => (typeof HOTEL_IMAGE_DIR === 'string') ? HOTEL_IMAGE_DIR : 'assets/hotels/';

  /* ---------------------------------------------------------------------
     The quote — the only source of a total.
     --------------------------------------------------------------------- */
  function stayPayload() {
    return {
      hotel_id: Number(detail.id),
      room_id: Number(picks[0].id),
      room_ids: picks.map(p => Number(p.id)),
      check_in: shell.checkIn,
      check_out: shell.checkOut,
      rooms_count: picks.length,
      adults: adults() || 1,
      children: children(),
      child_ages: guests().filter(g => g.kind === 'child').map(g => g.age),
    };
  }

  async function refreshQuote(opts) {
    if (!picks.length || typeof BookingApi === 'undefined' || !BookingApi.isLive('hotel')) return;
    const mine = ++token;
    quoteBusy = true; quoteError = null;
    paintExtras(); paintSummary(); paintActionbar();

    try {
      const q = await BookingApi.quoteHotel(
        stayPayload(),
        chosenAddons.map(code => ({ code })),
        couponCode || null,
      );
      if (mine !== token) return;

      couponError = q.coupon_error || null;
      /* A coupon the server refuses is not applied, so it must not keep
         looking applied on screen. */
      if (couponError) couponCode = null;

      const next = Number(q.total_amount);
      /* Only a change the traveller did NOT cause counts as a price change.
         Adding an extra obviously moves the total; that is not a surprise. */
      if (!opts || !opts.expected) {
        if (lastSeenTotal != null && Math.abs(next - lastSeenTotal) > 0.5) {
          priceChanged = { from: lastSeenTotal, to: next };
        }
      }
      quote = q;
      lastSeenTotal = next;
    } catch (err) {
      if (mine !== token) return;
      quote = null;
      quoteError = (BookingApi.errorText && BookingApi.errorText(err))
        || "We couldn't price your booking just now.";
    } finally {
      if (mine === token) {
        quoteBusy = false;
        paintExtras(); paintSummary(); paintActionbar();
      }
    }
  }

  /* ---------------------------------------------------------------------
     Sections
     --------------------------------------------------------------------- */
  function section(id, title, bodyHtml, editStep, editLabel) {
    return `
      <section class="hr-rvsec" aria-labelledby="hrRv-${id}">
        <div class="hr-rvsec-head">
          <h2 id="hrRv-${id}">${esc(title)}</h2>
          ${editStep ? `<button type="button" class="hr-editbtn" data-edit="${esc(editStep)}">
            ${icon('tag')} ${esc(editLabel || 'Edit')}
          </button>` : ''}
        </div>
        <div class="hr-rvsec-body">${bodyHtml}</div>
      </section>`;
  }

  function hotelSection() {
    const n = nights();
    return section('stay', 'Hotel details', `
      <div class="hr-rv-hotel">
        <img class="hr-rv-thumb" src="${esc(imgDir() + heroSlug() + '-480.webp')}"
             alt="${esc(detail.name)}" loading="lazy">
        <div class="hr-rv-hotel-body">
          <div class="hr-name-row">
            <h3 class="hr-rv-name">${esc(detail.name)}</h3>
            ${detail.stars ? `<span class="hr-stars" role="img"
              aria-label="${esc(detail.stars)} star hotel">${'★'.repeat(detail.stars)}</span>` : ''}
          </div>
          <p class="hr-loc">${icon('pin')} ${esc(detail.location)}</p>
          ${detail.guest_rating != null ? `
            <div class="hr-rating-row">
              <span class="hr-rating">${esc(Number(detail.guest_rating).toFixed(1))}</span>
              <span class="hr-rating-word">${esc(ratingWord(detail.guest_rating))}</span>
            </div>` : ''}
          <dl class="hr-rv-facts">
            <div><dt>Check-in</dt><dd>${esc(fmtDay(shell.checkIn))}</dd></div>
            <div><dt>Check-out</dt><dd>${esc(fmtDay(shell.checkOut))}</dd></div>
            <div><dt>Nights</dt><dd>${n}</dd></div>
            <div><dt>Rooms</dt><dd>${roomCount()}</dd></div>
            <div><dt>Guests</dt><dd>${adults()} adult${adults() === 1 ? '' : 's'}${
              children() ? `, ${children()} child${children() === 1 ? '' : 'ren'}` : ''}</dd></div>
          </dl>
        </div>
      </div>`, 'rooms', 'Edit stay');
  }

  /** One block per room. Mixed selections stay separate — collapsing a
   *  Superior and an Executive Suite into "2 rooms" would hide what was
   *  actually booked. */
  function roomsSection() {
    const n = nights();
    return section('rooms', 'Room details', picks.map((p, i) => {
      const members = guests().filter(g => g.roomIndex === i);
      const a = members.filter(g => g.kind === 'adult').length;
      const c = members.filter(g => g.kind === 'child').length;
      return `
        <div class="hr-rv-room">
          <div class="hr-rv-room-head">
            <b>Room ${i + 1}</b>
            <span class="hr-rv-room-type">${esc(p.name)}</span>
          </div>
          <dl class="hr-rv-facts">
            ${p.beds ? `<div><dt>Bed</dt><dd>${esc(p.beds)}</dd></div>` : ''}
            ${p.size ? `<div><dt>Room size</dt><dd>${esc(p.size)}</dd></div>` : ''}
            <div><dt>Guests</dt><dd>${a} adult${a === 1 ? '' : 's'}${c ? `, ${c} child${c === 1 ? '' : 'ren'}` : ''}</dd></div>
            ${p.mealPlan ? `<div><dt>Meal plan</dt><dd>${esc(p.mealPlan)}</dd></div>` : ''}
          </dl>
          ${(p.perks || []).length ? `<div class="hr-roomcard-perks">${
            p.perks.map(x => `<i>${esc(x)}</i>`).join('')}</div>` : ''}
          ${p.cancellationPolicy
            ? `<p class="hr-note-plain">${esc(p.cancellationPolicy)}</p>` : ''}
          <div class="hr-rv-room-price">
            <span>${esc(rupees(p.price))} per night × ${n} night${n > 1 ? 's' : ''}</span>
            <b>${esc(rupees(Number(p.price) * n))}</b>
          </div>
        </div>`;
    }).join(''), 'rooms', 'Edit rooms');
  }

  /** Guests, under the room they are actually staying in — the assignment
   *  that `room_index` persists. */
  function guestsSection() {
    return section('guests', 'Guest details', picks.map((p, i) => {
      const members = guests().map((g, idx) => ({ g, idx })).filter(x => x.g.roomIndex === i);
      return `
        <div class="hr-rv-guestroom">
          <div class="hr-rv-room-head"><b>Room ${i + 1}</b>
            <span class="hr-rv-room-type">${esc(p.name)}</span></div>
          <ul class="hr-rv-guestlist">
            ${members.map(({ g, idx }) => `
              <li>
                <span class="hr-rv-guestname">
                  ${esc([g.title, g.first, g.last].filter(Boolean).join(' ')) || 'Guest'}
                </span>
                <span class="hr-rv-guestmeta">
                  ${g.kind === 'child'
                    ? `Child${g.childAge != null ? ` · age ${esc(g.childAge)}` : ''}`
                    : 'Adult'}
                  ${idx === 0 ? ' · Lead guest' : ''}
                </span>
                ${idx === 0 && (g.email || g.mobile) ? `
                  <span class="hr-rv-guestcontact">
                    ${g.email ? esc(g.email) : ''}${g.email && g.mobile ? ' · ' : ''}${
                      g.mobile ? esc(`${g.countryCode || ''} ${g.mobile}`.trim()) : ''}
                  </span>` : ''}
              </li>`).join('')}
          </ul>
        </div>`;
    }).join(''), 'guests', 'Edit guests');
  }

  function requestsSection() {
    const text = (guestData && guestData.notes) || '';
    if (!text.trim()) return '';
    return section('requests', 'Special requests', `
      <p class="hr-prose">${esc(text)}</p>
      <p class="hr-panel-note">
        Passed to the property. Requests are not guaranteed and are subject to
        availability on arrival.
      </p>`, 'guests', 'Edit requests');
  }

  /* ---- Extras ------------------------------------------------------------ */
  function addonRows() {
    if (!addonCatalogue) return [];
    return [].concat(addonCatalogue.meal || [], addonCatalogue.service || []);
  }

  function extrasBody() {
    if (addonsError) {
      return `<p class="hr-sum-error">${esc(addonsError)}</p>
        <button type="button" class="hr-btn hr-btn-ghost" data-retry-addons>Try again</button>`;
    }
    if (!addonCatalogue) {
      return `<div class="hr-skeleton hr-skeleton-line"></div>`;
    }
    const rows = addonRows();
    if (!rows.length) {
      return `<p class="hr-panel-note">No extras are offered for this stay.</p>`;
    }
    return `
      <div class="hr-extras">
        ${rows.map(a => {
          const on = chosenAddons.includes(a.code);
          return `
            <label class="hr-extra ${on ? 'is-on' : ''} ${quoteBusy ? 'is-busy' : ''}">
              <input type="checkbox" data-addon="${esc(a.code)}" ${on ? 'checked' : ''}
                     ${quoteBusy ? 'disabled' : ''}>
              <span class="hr-extra-body">
                <b>${esc(a.name)}</b>
                ${a.description ? `<span>${esc(a.description)}</span>` : ''}
              </span>
              <span class="hr-extra-price">${esc(rupees(a.price))}</span>
            </label>`;
        }).join('')}
      </div>
      <p class="hr-panel-note">Charged once per booking, not per guest.</p>`;
  }

  function extrasSection() {
    return `
      <section class="hr-rvsec" aria-labelledby="hrRv-extras" id="hrRvExtras">
        <div class="hr-rvsec-head">
          <h2 id="hrRv-extras">Extras <span class="hr-optional">(optional)</span></h2>
        </div>
        <div class="hr-rvsec-body">${extrasBody()}</div>
      </section>`;
  }

  /* ---- Coupon ------------------------------------------------------------ */
  function couponBody() {
    const applied = quote && quote.coupon_code && Number(quote.discount) > 0;
    if (applied) {
      return `
        <div class="hr-coupon-on">
          ${icon('check')}
          <div>
            <b>${esc(quote.coupon_code)} applied</b>
            <span>You saved ${esc(rupees(quote.discount))}${
              quote.coupon_title ? ` · ${esc(quote.coupon_title)}` : ''}</span>
          </div>
          <button type="button" class="hr-linkbtn" id="hrCouponRemove">Remove</button>
        </div>`;
    }
    return `
      <div class="hr-coupon">
        <label class="hr-sr" for="hrCouponInput">Coupon code</label>
        <input id="hrCouponInput" class="hr-input" type="text" autocomplete="off"
               placeholder="Enter coupon code" value="${esc(couponCode || '')}"
               ${couponError ? 'aria-invalid="true" aria-describedby="hrCouponErr"' : ''}>
        <button type="button" class="hr-btn hr-btn-primary" id="hrCouponApply"
                ${quoteBusy ? 'disabled' : ''}>Apply</button>
      </div>
      ${couponError ? `<span class="hr-err" id="hrCouponErr">${esc(couponError)}</span>` : ''}`;
  }

  function couponSection() {
    return `
      <section class="hr-rvsec" aria-labelledby="hrRv-coupon" id="hrRvCoupon">
        <div class="hr-rvsec-head"><h2 id="hrRv-coupon">Have a coupon?</h2></div>
        <div class="hr-rvsec-body">${couponBody()}</div>
      </section>`;
  }

  /* ---- Price-change notice ----------------------------------------------- */
  function priceNoticeHtml() {
    if (!priceChanged) return '';
    const up = priceChanged.to > priceChanged.from;
    return `
      <div class="hr-pricechange" role="alert">
        ${icon('shield')}
        <div>
          <b>Your price has changed.</b>
          <span>
            This booking was ${esc(rupees(priceChanged.from))} and is now
            ${esc(rupees(priceChanged.to))}${up ? '' : ' — in your favour'}.
            Please review the new total before continuing.
          </span>
        </div>
        <button type="button" class="hr-btn hr-btn-ghost" id="hrAckPrice">
          I understand
        </button>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Summary + action bar
     --------------------------------------------------------------------- */
  function summaryHtml() {
    const n = nights();
    return `
      <div class="hr-summary">
        <div class="hr-sum-head"><h2>Booking Summary</h2></div>
        <div class="hr-sum-body">
          <div class="hr-sum-hotel">
            <img class="hr-sum-thumb" src="${esc(imgDir() + heroSlug() + '-480.webp')}" alt="" loading="lazy">
            <div>
              <p class="hr-sum-hotel-name">${esc(detail.name)}</p>
              ${detail.stars ? `<span class="hr-stars" role="img"
                aria-label="${esc(detail.stars)} star hotel">${'★'.repeat(detail.stars)}</span>` : ''}
              <p class="hr-sum-hotel-loc">${esc(detail.location)}</p>
            </div>
          </div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-line"><span>Check-in</span><b>${esc(fmtDay(shell.checkIn))}</b></div>
          <div class="hr-sum-line"><span>Check-out</span><b>${esc(fmtDay(shell.checkOut))}</b></div>
          <div class="hr-sum-meta">${roomCount()} Room${roomCount() > 1 ? 's' : ''} · ${guests().length} Guest${guests().length > 1 ? 's' : ''}</div>
          <div class="hr-sum-meta">${n} Night${n > 1 ? 's' : ''}</div>
          <div class="hr-sum-rule"></div>
          <div class="hr-sum-sec-title">Price Details</div>
          ${quoteError ? `<p class="hr-sum-error">${esc(quoteError)}</p>` : ''}
          ${quoteBusy && !quote ? `<div class="hr-sum-line"><span>Pricing…</span><b>—</b></div>` : ''}
          ${quote ? `
            ${(quote.lines || []).map(l => {
              const neg = Number(l.amount) < 0;
              return `<div class="hr-sum-line ${neg ? 'is-discount' : ''}">
                <span>${esc(l.label)}</span>
                <b>${neg ? '−' : ''}${esc(rupees(Math.abs(Number(l.amount))))}</b></div>`;
            }).join('')}
            <div class="hr-sum-total">
              <span class="hr-sum-total-label">Total Amount</span>
              <span class="hr-sum-total-value">${esc(rupees(quote.total_amount))}</span>
            </div>
            <span class="hr-sum-note">Inclusive of all taxes.</span>` : ''}
        </div>
        <div class="hr-trust">
          <div class="hr-trust-row">${icon('shield')}
            <div><b>Secure booking</b><span>Your data is protected</span></div></div>
          <div class="hr-trust-row">${icon('headset')}
            <div><b>24/7 customer support</b><span>We're here to help you anytime</span></div></div>
        </div>
      </div>`;
  }

  function actionbarHtml() {
    const ready = !!quote && !quoteBusy && !priceChanged;
    const n = nights();
    let note;
    if (priceChanged) note = 'Review the new total to continue';
    else if (quoteBusy) note = 'Updating your total…';
    else if (quoteError) note = 'We could not price your booking';
    else note = 'Nothing is charged until you confirm';

    return `
      <div class="hr-actionbar-inner">
        <div class="hr-ab-item hr-ab-hide-sm">${icon('shield')}
          <div><b>${esc(detail.name)}</b><span>${esc(detail.location)}</span></div></div>
        <span class="hr-ab-sep" aria-hidden="true"></span>
        <div class="hr-ab-item">${icon('calendar')}
          <div><b>${esc(fmtDay(shell.checkIn))} → ${esc(fmtDay(shell.checkOut))}</b>
          <span>${n} night${n > 1 ? 's' : ''} · ${roomCount()} room${roomCount() > 1 ? 's' : ''}</span></div></div>
        <div class="hr-ab-total">
          <b>${quote ? esc(rupees(quote.total_amount)) : '—'}</b>
          <span>${quote ? 'Inclusive of all taxes' : 'Total pending'}</span>
        </div>
        <div class="hr-ab-cta">
          <button type="button" class="hr-btn hr-btn-primary hr-btn-lg" id="hrToPayment"
                  ${ready ? '' : 'disabled'}>Continue to Payment</button>
          <span>${esc(note)}</span>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Paint
     --------------------------------------------------------------------- */
  function paintChrome() {
    const HR = typeof HotelResults !== 'undefined' ? HotelResults : null;
    const sb = $('hvSearchbar');
    if (sb && HR && HR.searchbarHtml) sb.innerHTML = HR.searchbarHtml();
    const st = $('hvStepper');
    if (st && HR && HR.stepperHtml) st.innerHTML = HR.stepperHtml(5);
  }

  function paintMain() {
    const main = $('hvMain');
    if (!main) return;
    main.innerHTML = `
      <button type="button" class="hr-backlink" data-review-back>
        ${icon('chevron', 'hr-back-ico')} Back to Guest Details
      </button>
      <div class="hr-hd-head">
        <div class="hr-name-row"><h1 class="hr-hd-name">Review your booking</h1></div>
        <p class="hr-panel-note">
          Please check everything below before continuing. Nothing is charged on
          this screen.
        </p>
      </div>
      <div id="hvNotice">${priceNoticeHtml()}</div>
      ${hotelSection()}
      ${roomsSection()}
      ${guestsSection()}
      ${requestsSection()}
      ${extrasSection()}
      ${couponSection()}`;
  }

  /* Only the two interactive sections are repainted on a price refresh, so a
     coupon field being typed into is not torn out from under the caret. */
  function paintExtras() {
    const ex = $('hrRvExtras');
    if (ex) {
      const body = ex.querySelector('.hr-rvsec-body');
      if (body) body.innerHTML = extrasBody();
    }
    const cp = $('hrRvCoupon');
    if (cp && document.activeElement && document.activeElement.id !== 'hrCouponInput') {
      const body = cp.querySelector('.hr-rvsec-body');
      if (body) body.innerHTML = couponBody();
    }
    const notice = $('hvNotice');
    if (notice) notice.innerHTML = priceNoticeHtml();
  }
  function paintSummary() {
    const el = $('hvSummary');
    if (el && detail) el.innerHTML = summaryHtml();
  }
  function paintActionbar() {
    const el = $('hrActionbar');
    if (el && detail) { el.innerHTML = actionbarHtml(); el.hidden = false; }
  }
  function paint() { paintChrome(); paintMain(); paintSummary(); paintActionbar(); }

  /* ---------------------------------------------------------------------
     Events
     --------------------------------------------------------------------- */
  function bind() {
    if (bound) return;
    const root = $('hvRoot');
    if (!root) return;
    bound = true;

    root.addEventListener('click', e => {
      if (e.target.closest('[data-review-back]')) { if (handlers.back) handlers.back(); return; }
      if (e.target.closest('#hrModify')) {
        if (typeof HotelResults !== 'undefined' && HotelResults.modifySearch) HotelResults.modifySearch();
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) { if (handlers.edit) handlers.edit(edit.getAttribute('data-edit')); return; }
      if (e.target.closest('#hrAckPrice')) { priceChanged = null; paintExtras(); paintActionbar(); return; }
      if (e.target.closest('[data-retry-addons]')) { loadAddons(); return; }
      if (e.target.closest('#hrCouponApply')) { applyCoupon(); return; }
      if (e.target.closest('#hrCouponRemove')) {
        couponCode = null; couponError = null;
        refreshQuote({ expected: true });
        return;
      }
    });

    root.addEventListener('change', e => {
      const box = e.target.closest('[data-addon]');
      if (!box) return;
      const code = box.getAttribute('data-addon');
      chosenAddons = box.checked
        ? chosenAddons.concat([code])
        : chosenAddons.filter(c => c !== code);
      /* The traveller caused this, so the new total is not a surprise. */
      refreshQuote({ expected: true });
    });

    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'hrCouponInput') { e.preventDefault(); applyCoupon(); }
    });

    const bar = $('hrActionbar');
    if (bar) bar.addEventListener('click', e => {
      if (!e.target.closest('#hrToPayment')) return;
      if (!quote || quoteBusy || priceChanged) return;
      goToPayment();
    });
  }

  function applyCoupon() {
    const el = $('hrCouponInput');
    const code = el ? el.value.trim() : '';
    if (!code) { couponError = 'Enter a coupon code to apply.'; paintExtras(); return; }
    couponCode = code;
    couponError = null;
    refreshQuote({ expected: true });
  }

  /** Confirm the price one last time against the server, then hand over.
   *  If that final answer differs from what is on screen the handoff is
   *  cancelled and the change is shown instead — the traveller must never
   *  reach Payment holding a number the server no longer agrees with. */
  async function goToPayment() {
    const before = quote ? Number(quote.total_amount) : null;
    await refreshQuote({ expected: true });
    const after = quote ? Number(quote.total_amount) : null;

    if (after == null) { paintActionbar(); return; }
    if (before != null && Math.abs(after - before) > 0.5) {
      priceChanged = { from: before, to: after };
      paintExtras(); paintActionbar();
      const notice = $('hvNotice');
      if (notice) notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (handlers.payment) {
      handlers.payment({
        picks, guestData,
        addons: chosenAddons.slice(),
        couponCode: (quote && quote.coupon_code) || null,
        quote,
      });
    }
  }

  async function loadAddons() {
    addonsError = null;
    paintExtras();
    try {
      addonCatalogue = await BookingApi.hotelAddons();
    } catch (err) {
      addonCatalogue = null;
      addonsError = "We couldn't load the extras for this stay.";
    }
    paintExtras();
  }

  /* ---------------------------------------------------------------------
     Entry
     --------------------------------------------------------------------- */
  async function show(hotelRow, sharedState, hs, roomPicks, guests_) {
    shell = sharedState || {};
    picks = (roomPicks || []).filter(Boolean);
    guestData = guests_ || { party: [], notes: '' };
    handlers = hs || {};

    const root = $('hvRoot');
    if (root) root.hidden = false;
    bind();

    if (!detail || String(detail.id) !== String(hotelRow.id)) {
      try { detail = await BookingApi.getHotelDetail(hotelRow.id); }
      catch {
        detail = { id: hotelRow.id, name: hotelRow.name, location: hotelRow.location,
                   stars: hotelRow.stars, image: hotelRow.imageKey };
      }
    }

    paint();
    if (!addonCatalogue) loadAddons();
    refreshQuote({ expected: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function hide() {
    const root = $('hvRoot');
    if (root) root.hidden = true;
  }

  /** Extras and coupon survive leaving and returning to this screen. */
  function state() { return { addons: chosenAddons.slice(), coupon: couponCode }; }

  return { show, hide, state };
})();
