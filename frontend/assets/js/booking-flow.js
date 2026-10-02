'use strict';
/* ===========================================================================
   booking-flow.js — the multi-step booking engine.
   ===========================================================================
   ONE ENGINE, FIVE PRODUCTS. Flights, hotels, cruises, packages and visa all
   have the same shape — choose, identify the travellers, add extras, confirm,
   pay, get a reference — so they share this and differ only in their step
   list. booking-products.js supplies those. Nothing about a seat map or a
   cabin grade is known here.

   It runs as a full-screen layer rather than its own page, on purpose: the
   draft lives in memory, so there is no half-finished booking to serialise
   between navigations and no way to land on step 4 with nothing in it.

   A STEP IS A PLAIN OBJECT:
     {
       id, label,
       async load(ctx)      optional — fetch what the step needs
       render(ctx) -> html  required
       mount(root, ctx)     optional — wire events after render
       validate(ctx)        optional — return true, or a message to show
       nextLabel            optional — defaults to "Continue"
       hideSummary          optional — full-width step (confirmation)
       hideBack             optional
     }

   THE ENGINE OWNS: navigation, validation, the progress rail, transitions,
   loading and error states, and the price rail. THE PRODUCT OWNS: what a step
   contains and how it is priced.
   =========================================================================== */

const BookingFlow = (function () {

  let flow = null;      // the active product definition
  let ctx = null;       // the draft being built
  let index = 0;
  let busy = false;
  let headerObserver = null;   // watches #spHeader so --bk-header-h tracks its real height

  /* ---------------------------------------------------------------------
     BROWSER HISTORY — one entry per booking step, over the page behind it.

     The flow is an in-page overlay, not a separate page per step, so without
     this the browser's Back button leaves the whole flow (back to the results
     page) from any step. This layer maps each step to its own history entry so
     Back/Forward walk the steps, and a Back from the FIRST step leaves to the
     results page exactly as before — the overlay is never a trap.

     THE MODEL, kept deliberately small:
       - entering the flow and every forward Continue PUSHES one entry;
       - the in-page Back button and Review's Edit links do history.back()/go(),
         so the browser's own stack is the single source of truth for position;
       - one popstate handler turns a browser Back/Forward into the existing
         goTo/paint, so there is no second navigation system and no duplicate
         rendering;
       - closing (X, Escape, Done) tears the overlay down and rewinds the stack
         to the results entry, so the entries we added never linger as dead
         Back presses.

     `teardown()` is the real cleanup; `close()` is the public/completion path
     that also rewinds history. `historyActive` guards against binding twice. */
  let historyActive = false;   // true between start() and teardown()
  let dormant = false;         // flow kept in memory but overlay hidden (Back landed on results)
  const HK = 'jpbk';           // marks a history entry as one of ours
  const PAY_BUSY = ['opening', 'processing', 'pending'];  // JPay states that must not be interrupted

  function stepEntry(i) {
    const s = flow && flow.steps[i];
    return { [HK]: true, step: i, id: s ? s.id : null };
  }

  function pushStep(i) {
    try { history.pushState(stepEntry(i), ''); } catch (e) { /* history unavailable */ }
  }

  /* An active, non-cancellable payment: only while the gateway screen itself is
     open AND the provider round-trip is in flight. Scoped to the payment step so
     a stale JPay instance left on ctx after backing out cannot lock an earlier
     step. */
  function paymentBusy() {
    const step = flow && flow.steps[index];
    if (!step || step.id !== 'payment') return false;
    return !!(ctx && ctx.jpay && typeof ctx.jpay.state === 'function'
      && PAY_BUSY.indexOf(ctx.jpay.state()) !== -1);
  }

  function onPopState(e) {
    if (!historyActive || !flow) return;   // no flow in memory — nothing of ours to drive
    const st = e.state;

    /* Popped onto the page the flow opened over (no step tag). The flow is NOT
       thrown away — the draft is kept in memory and the overlay only HIDDEN, so
       a browser Forward walks straight back into it with everything intact and
       no reload. It is discarded for real only by an explicit exit (the header
       X or Escape) or by leaving the page. */
    if (!st || !st[HK]) { if (!dormant) goDormant(); return; }

    /* NEVER move off the payment step while the bank round-trip is live. The
       Back already happened in the stack, so re-assert the payment entry to put
       the pointer back; JPay's own "do not go back" warning is already showing. */
    if (paymentBusy()) { pushStep(index); return; }

    const target = (typeof st.step === 'number')
      ? Math.max(0, Math.min(flow.steps.length - 1, st.step)) : index;

    /* Forward back INTO the flow from the hidden state: re-show the overlay. The
       entry we land on is the step we left from, so the preserved DOM already
       shows it — reopen() only re-arms the overlay, it does not repaint, so any
       half-typed field is still there. */
    if (dormant) { index = target; reopen(); return; }

    if (target === index) return;
    const dir = target < index ? 'back' : 'next';
    index = target;
    paint(dir);
  }

  /* Leave the flow cleanly: tear the overlay down, then rewind the stack to the
     results entry so the step entries we pushed do not survive as dead Back
     presses. teardown() runs FIRST and clears `flow`, so the popstate from the
     rewind below is ignored by onPopState rather than tearing down twice. */
  function exitFlow() {
    if (!historyActive) { teardown(); return; }   // nothing of ours left on the stack
    const depth = index + 1;   // entries pushed above the results page: S0..S_index
    teardown();
    try { if (depth > 0) history.go(-depth); } catch (e) { /* history unavailable */ }
  }

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const backArrow = '<i data-jp-icon="chevronLeft" class="jpi-meta"></i>';

  /* ---------------------------------------------------------------------
     Shell
     --------------------------------------------------------------------- */
  /* Mounted as a normal block right after the site's own sticky header,
     rather than as a fixed-position overlay — the reference layout keeps the
     header visible and the flow reads as the page, not a dialog on top of
     it. Every service page (flights/hotels/cruises/packages/visa/activities)
     shares the same `#spHeader` id, so this needs no per-page wiring. */
  function ensureRoot() {
    let el = document.getElementById('bkRoot');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bkRoot';
    el.className = 'bk-root';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Booking');
    const header = siteHeader();
    if (header && header.parentNode) header.insertAdjacentElement('afterend', el);
    else document.body.appendChild(el);
    return el;
  }

  /* The header is sticky but not a fixed height (its nav wraps on narrow
     widths), so the fare rail's sticky offset and the scroll-into-view math
     in paint() read it live off a CSS variable rather than a guessed pixel
     value. */
  /* Two shells, two ids: the standalone service pages use #spHeader and the
     landing-shell pages (index, flights) use #siteHeader. Everything that
     measures or positions against "the site header" goes through here. */
  function siteHeader() {
    return document.getElementById('spHeader') || document.getElementById('siteHeader');
  }

  function setHeaderHeightVar() {
    const header = siteHeader();
    document.documentElement.style.setProperty('--bk-header-h', (header ? header.offsetHeight : 0) + 'px');
  }

  /* THE ITINERARY CARD, shown above the stepper on every flight step.

     The markup lives in booking-products.js next to the Review screen that
     shares its segment helpers (rvSegments/bkfLogo), so there is one
     implementation of "what a leg looks like" rather than two that drift.
     Non-flight products have no itinerary strip and get an empty string. */
  function itineraryHtml(c, step) {
    if (!c || c.kind !== 'flight') return '';
    if (typeof BookingProducts === 'undefined' || !BookingProducts.itineraryHtml) return '';
    return BookingProducts.itineraryHtml(c, step);
  }

  /* One implementation of the step rail, used by both the first render and
     every repaint — they had drifted apart as two copies of the same markup.

     `flow.priorSteps` are stages the traveller has already cleared before the
     flow opened (flights list "Search", which happens on the results page), so
     they always render as done and are never navigable. They shift the
     numbering of the real steps, which is why the offset is threaded through
     rather than using the array index directly. */
  /* THE STEP RAIL IS GONE, from here and from every other screen.
     It used to render the whole journey across the top with the current step
     marked, and its cleared steps doubled as the way back — which is why
     removing it means the footer's Back has to work on the first step too.
     See the Back button in shellHtml's footer and back() below. */

  function shellHtml() {
    return `
      <div class="bk-sheet ${flow.kind === 'flight' ? 'is-flight' : ''}">
        <div class="bk-pagehead">
          <button type="button" class="bk-back" id="bkExit">${backArrow} Back to ${esc(flow.backLabel || 'results')}</button>
          <div class="bk-kicker">${esc(flow.kicker || 'Booking')}</div>
          <h1 class="bk-title">${esc(flow.title)}</h1>
        </div>

        <!-- THE PROGRESS RAIL, back by request but DISPLAY-ONLY. The old rail
             doubled as the way back, and that coupling was why it was removed;
             this one only shows where you are — Back stays in the footer. It is
             painted per step from the flow's own step list, so it can never
             disagree with the journey the engine is actually running. -->
        <nav class="bk-steps" id="bkSteps" aria-label="Booking progress"></nav>

        <div id="bkItin"></div>

        <div class="bk-body">
          <section class="bk-main" id="bkMain" aria-live="polite"></section>
          <aside class="bk-side" id="bkSide"></aside>
        </div>

        <footer class="bk-foot" id="bkFoot">
          <button type="button" class="bk-btn bk-btn-ghost" id="bkBack">Back</button>
          <!-- Steps that want the reference's wide action bar (the Review step
               does) fill this with their own trust mark + itinerary + total.
               Empty everywhere else, which leaves the original three-part
               footer exactly as it was. -->
          <div class="bk-foot-rich" id="bkFootRich"></div>
          <div class="bk-foot-total" id="bkFootTotal" aria-hidden="true"></div>
          <div class="bk-foot-msg" id="bkMsg" role="alert"></div>
          <div class="bk-foot-cta">
            <button type="button" class="bk-btn bk-btn-primary" id="bkNext">Continue</button>
            <span class="bk-foot-note" id="bkFootNote"></span>
          </div>
        </footer>
      </div>`;
  }

  /* The progress rail, painted from the flow's OWN steps so it is always the
     real journey — a product with an add-ons step shows one, a hotel that skips
     straight to confirmation shows two. `priorSteps` (a flight's Search, done on
     the results page) render as cleared dots ahead of the live ones. It is
     read-only: no dot is a link, so none of the back-navigation coupling that
     retired the first rail comes back with it. */
  const STEP_TICK = '<svg class="bk-step-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
  function renderSteps() {
    const el = document.getElementById('bkSteps');
    if (!el) return;
    /* Booking timeline/stepper removed per the UX pass — node kept but empty
       and hidden so layout/callers stay valid. */
    el.innerHTML = ''; el.style.display = 'none'; return;
    const prior = (flow.priorSteps || []).map(label => ({ label, state: 'done' }));
    const live = flow.steps.map((s, i) => ({
      label: s.label || s.id,
      state: i < index ? 'done' : (i === index ? 'current' : 'upcoming'),
    }));
    const items = prior.concat(live);
    const count = items.length;
    const pos = prior.length + index;           /* 0-based index of the live step */
    const now = items[pos] ? items[pos].label : '';
    el.style.setProperty('--bk-steps-count', count);
    el.style.setProperty('--bk-step-pos', pos);
    el.innerHTML = `
      <ol class="bk-steps-list">
        ${items.map((it, i) => `
          <li class="bk-step is-${it.state}"${it.state === 'current' ? ' aria-current="step"' : ''}>
            <span class="bk-step-dot">${it.state === 'done' ? STEP_TICK : (i + 1)}</span>
            <span class="bk-step-label">${esc(it.label)}</span>
          </li>`).join('')}
      </ol>
      <p class="bk-steps-now">Step ${pos + 1} of ${count} &middot; ${esc(now)}</p>`;
  }

  /* A skeleton, not a spinner: the block that is coming is a list of cards, so
     the placeholder is card-shaped. It stops the layout jumping when the real
     content lands. */
  function skeleton(rows) {
    return `<div class="bk-skeleton">${
      Array.from({ length: rows || 3 }, () => `
        <div class="bk-sk-card">
          <div class="bk-sk-line w40"></div>
          <div class="bk-sk-line w70"></div>
          <div class="bk-sk-line w55"></div>
        </div>`).join('')
    }</div>`;
  }

  /* ---------------------------------------------------------------------
     Price rail
     --------------------------------------------------------------------- */
  function recalc() {
    ctx.pricing = flow.price ? flow.price(ctx) : { lines: [], total: 0 };
    return ctx.pricing;
  }

  /* Ask the server what this costs, when the product has a backend that can
     answer. Flights do; the other four still price locally through recalc()
     above, so this returns their local answer unchanged.

     The local figure is painted first and replaced when the server responds:
     the Fare Summary must never sit blank while a quote is in flight, and the
     two agree anyway — the server's arithmetic is a port of the local one.
     If the request fails the local total simply stands, so a dropped
     connection cannot leave somebody unable to see a price. */
  /* What to SAY when the quote is refused, which is not the same as the fare
     service being unreachable.

     A 4xx means the server looked at the selection and rejected it — a seat
     someone else took while this booking was being filled in, an add-on that
     stopped being offered. That is actionable, and the traveller needs to know
     which part to go back and change. A network failure or a 5xx is not
     actionable, and the locally-computed estimate still stands.

     The server's own sentence is never printed: it is written for an API
     consumer ("Seat 11A is already taken."), and this is a booking screen. */
  function quoteErrorNote(err) {
    const status = err && (err.status || (err.response && err.response.status));
    const detail = String((err && err.message) || '').toLowerCase();
    if (status >= 400 && status < 500) {
      if (detail.includes('seat')) return 'One of your selected seats is no longer available. Please choose another.';
      if (detail.includes('add-on') || detail.includes('addon') || detail.includes('baggage') || detail.includes('meal')) {
        return 'One of your selected add-ons is no longer available. Please review your add-ons.';
      }
      if (detail.includes('coupon')) return 'That coupon could not be applied. Please review the total.';
      if (detail.includes('price') || detail.includes('fare')) return 'Your fare has changed. Please review the updated total.';
      return 'Something in this booking is no longer available. Please review your selections.';
    }
    return 'Showing an estimate — could not reach the fare service.';
  }

  async function recalcAsync() {
    recalc();
    if (!flow.priceAsync) return ctx.pricing;
    try {
      const priced = await flow.priceAsync(ctx);
      if (priced) ctx.pricing = priced;
    } catch (err) {
      const status = err && (err.status || (err.response && err.response.status));
      ctx.pricing.note = quoteErrorNote(err);
      /* A refusal is a problem to act on; an unreachable service is not. */
      ctx.pricing.noteIsError = status >= 400 && status < 500;
    }
    return ctx.pricing;
  }

  function sideHtml() {
    const step = flow.steps[index];
    if (step.hideSummary) return '';
    /* A step may render its own Fare Summary when the default breakdown is not
       enough — the Review step groups the fare by journey leg and adds the
       benefit cards. It still gets the coupon control from here, so there is
       only ever one implementation of applying a code. */
    const custom0 = step.sideHtml && step.sideHtml(ctx, { money, esc, couponHtml });
    if (custom0 != null && custom0 !== false) return custom0;   // null = "fall through"
    /* A product may also own the rail for ALL of its steps — flights do, so
       the Fare Summary card is the same on Traveller Details, Seats, Add-ons
       and Review rather than four near-copies. */
    if (flow.sideHtml) {
      const custom = flow.sideHtml(ctx, { money, esc, couponHtml }, step);
      if (custom != null) return custom;
    }
    const p = ctx.pricing || { lines: [], total: 0 };
    const lines = p.lines.map(l => `
      <div class="bk-price-line ${l.muted ? 'is-muted' : ''}">
        <span>${esc(l.label)}</span><span>${l.free ? 'Included' : esc(money(l.amount))}</span>
      </div>`).join('');
    return `
      <div class="bk-price">
        <h3>Fare summary</h3>
        ${lines || '<p class="bk-price-empty">Choose an option to see the fare.</p>'}
        <div class="bk-price-total"><span>Total amount</span><span>${esc(money(p.total))}</span></div>
        ${couponHtml()}
        ${p.note ? `<p class="bk-price-note">${esc(p.note)}</p>` : ''}
        ${ctx && ctx.gatewayLive
          ? `<p class="bk-price-note">Paid securely at the next step. Nothing is charged until you approve it.</p>`
          : `<p class="bk-price-note">No payment gateway is connected — nothing is charged.</p>`}
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Coupon entry, inside the Fare Summary card rather than beside it.

     The discount itself is NOT rendered here — the server already returns it
     as a line in `pricing.lines` ("Discount (FLYHIGH30)"), so it appears in
     the breakdown above like every other line. This block is only the control
     for entering, viewing and removing a code.

     Nothing here does arithmetic. Applying sets ctx.couponCode and asks the
     flow to re-price; the total that comes back is the server's.
     --------------------------------------------------------------------- */
  function couponHtml() {
    if (!flow || !flow.supportsCoupons) return '';
    const applied = ctx.couponCode;
    if (applied) {
      return `
        <div class="bk-coupon is-applied">
          <div class="bk-coupon-applied">
            <span class="bk-coupon-tag">Coupon</span>
            <b>${esc(applied)}</b>
            <button type="button" class="bk-coupon-remove" id="bkCouponRemove">Remove</button>
          </div>
          ${ctx.couponTitle ? `<p class="bk-coupon-note">${esc(ctx.couponTitle)}</p>` : ''}
        </div>`;
    }
    return `
      <div class="bk-coupon">
        <label class="bk-coupon-label" for="bkCouponInput">Have a coupon?</label>
        <div class="bk-coupon-row">
          <input type="text" id="bkCouponInput" placeholder="Enter coupon code"
                 autocomplete="off" spellcheck="false" aria-describedby="bkCouponMsg">
          <button type="button" class="bk-btn bk-btn-primary bk-coupon-apply" id="bkCouponApply">Apply</button>
        </div>
        <button type="button" class="bk-coupon-link" id="bkCouponView"
                aria-expanded="false" aria-controls="bkCouponList">View available coupons</button>
        <div class="bk-coupon-list" id="bkCouponList" hidden></div>
        <p class="bk-coupon-msg" id="bkCouponMsg" role="status" aria-live="polite"></p>
      </div>`;
  }

  /** Wire the coupon controls. Called after every side-panel render, because
   *  re-pricing replaces the panel's markup along with its listeners. */
  function mountSide() {
    /* The Fare Summary's own collapse control lives in this panel, not in the
       step's root — so the step's mount() never sees it. Wired here, on every
       side render, because re-pricing replaces this markup and its listeners.
       Must come BEFORE the coupon early-return below. */
    const side = document.getElementById('bkSide');
    if (side && typeof BookingProducts !== 'undefined' && BookingProducts.wireFolds) {
      BookingProducts.wireFolds(side, ctx);
    }
    if (!flow || !flow.supportsCoupons) return;
    const msg = document.getElementById('bkCouponMsg');
    const say = (text, ok) => {
      if (!msg) return;
      msg.textContent = text || '';
      msg.className = 'bk-coupon-msg' + (text ? (ok ? ' is-ok' : ' is-error') : '');
    };

    const remove = document.getElementById('bkCouponRemove');
    if (remove) {
      remove.addEventListener('click', async () => {
        ctx.couponCode = null;
        ctx.couponTitle = null;
        await refreshPrice();
      });
      return;
    }

    const input = document.getElementById('bkCouponInput');
    const apply = document.getElementById('bkCouponApply');
    const view = document.getElementById('bkCouponView');
    const list = document.getElementById('bkCouponList');

    async function applyCode(raw) {
      const code = (raw || '').trim().toUpperCase();
      if (!code) { say('Enter a coupon code.', false); return; }
      say('Checking…', true);
      try {
        if (ctx.kind === 'flight') {
          /* Checked before it is applied, so an unusable code never sits on
             the draft quietly failing on every later re-price. */
          const res = await BookingApi.validateCoupon(
            code, BookingApi.flightPayload(ctx), BookingApi.passengerTypes(ctx)
          );
          if (!res.applies) { say(res.message || 'That coupon cannot be used here.', false); return; }
          ctx.couponCode = res.code;
          ctx.couponTitle = res.title;
          await refreshPrice();        // re-prices on the server and repaints
          return;
        }
        /* Other live products (hotels) have no separate validate endpoint —
           the quote itself already checks the coupon as part of pricing, so
           apply it optimistically and let the quote's own answer say whether
           it actually applied. */
        ctx.couponCode = code;
        ctx.couponTitle = null;
        await refreshPrice();
        if (ctx.couponError) {
          say(ctx.couponError, false);
          ctx.couponCode = null;
          ctx.couponTitle = null;
          await refreshPrice();
          return;
        }
        ctx.couponTitle = (ctx.quote && ctx.quote.coupon_title) || null;
        say(`${code} applied.`, true);
      } catch (err) {
        say(BookingApi.errorText(err, 'Could not check that coupon.'), false);
      }
    }

    if (apply) apply.addEventListener('click', () => applyCode(input && input.value));
    if (input) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); applyCode(input.value); }
      });
    }

    if (view && list) {
      view.addEventListener('click', async () => {
        const open = list.hasAttribute('hidden');
        if (!open) { list.setAttribute('hidden', ''); view.setAttribute('aria-expanded', 'false'); return; }
        list.removeAttribute('hidden');
        view.setAttribute('aria-expanded', 'true');
        list.innerHTML = '<p class="bk-coupon-note">Loading…</p>';
        try {
          const offers = await BookingApi.coupons(ctx.kind);
          list.innerHTML = offers.length ? offers.map(c => `
            <button type="button" class="bk-coupon-offer" data-code="${esc(c.code)}">
              <b>${esc(c.code)}</b>
              <span>${esc(c.title)}</span>
            </button>`).join('')
            : '<p class="bk-coupon-note">No coupons are available right now.</p>';
          list.querySelectorAll('[data-code]').forEach(b => {
            b.addEventListener('click', () => {
              if (input) input.value = b.dataset.code;
              applyCode(b.dataset.code);
            });
          });
        } catch (err) {
          list.innerHTML = `<p class="bk-coupon-note">${esc(BookingApi.errorText(err, 'Could not load coupons.'))}</p>`;
        }
      });
    }
  }

  /* ---------------------------------------------------------------------
     Rendering a step
     --------------------------------------------------------------------- */
  async function paint(direction) {
    /* An in-place repaint (picking a seat, ticking an add-on) is NOT a step
       change: the step's data is already on ctx. It must not flash the
       skeleton, re-run load(), replay the entrance animation, or scroll the
       page — those are step-transition effects, and running them on every
       seat tap is what made selecting a seat look like a full page reload. */
    const inPlace = direction === 'repaint';
    const step = flow.steps[index];
    const main = document.getElementById('bkMain');
    const root = document.getElementById('bkRoot');

    /* The itinerary card, repainted per step: the Review step's version names
       the party and cabin and offers "Edit Search", the others "Change
       Flights", so it cannot be rendered once at start(). */
    const itin = root.querySelector('#bkItin');
    if (itin) itin.innerHTML = itineraryHtml(ctx, step);

    /* The progress rail tracks the step we are painting. Cheap, so it repaints
       every step rather than trying to diff which dot changed. */
    renderSteps();

    if (!inPlace) main.className = 'bk-main ' + (direction === 'back' ? 'bk-in-back' : 'bk-in');
    if (!inPlace && step.load) main.innerHTML = skeleton(3);

    try {
      if (!inPlace && step.load) await step.load(ctx);
    } catch (err) {
      main.innerHTML = `
        <div class="bk-error">
          <b>We could not load this step</b>
          <p>${esc(err.message || 'Please try again.')}</p>
          <button type="button" class="bk-btn bk-btn-ghost" id="bkRetry">Try again</button>
        </div>`;
      main.querySelector('#bkRetry').addEventListener('click', () => paint(direction));
      return;
    }

    const p = await recalcAsync();
    main.innerHTML = step.render(ctx);
    document.getElementById('bkSide').innerHTML = sideHtml();
    mountSide();

    /* The mobile-only echo of the fare total in the sticky footer (see
       booking.css) — the full breakdown above stops being sticky once the
       layout drops to one column, so this is what keeps the running total in
       view next to Continue without it. Empty wherever the side panel itself
       is hidden (step.hideSummary), for the same reason it is hidden there. */
    const footTotal = document.getElementById('bkFootTotal');
    if (footTotal) {
      footTotal.innerHTML = (step.hideSummary || !p) ? '' : `
        <span class="bk-foot-total-label">Total</span>
        <span class="bk-foot-total-amt">${esc(money(p.total))}</span>`;
    }

    /* The wide action bar, for steps that ask for one. `is-rich` is what
       switches .bk-foot from the three-part layout to the reference's
       trust-mark / itinerary / total / CTA row, so a step that supplies
       nothing here keeps the footer it always had. */
    const footRich = document.getElementById('bkFootRich');
    const foot = document.getElementById('bkFoot');
    if (footRich) {
      const owner = step.footHtml || flow.footHtml;
      const rich = (!step.hideSummary && owner) ? owner(ctx, { money, esc }, step) : '';
      footRich.innerHTML = rich;
      if (foot) foot.classList.toggle('is-rich', !!rich);
    }
    const footNote = document.getElementById('bkFootNote');
    /* Redundant step-transition text ("Next: who is travelling", etc.) removed
       per the UX pass — the note under the button is always blank now. */
    if (footNote) { footNote.textContent = ''; footNote.style.display = 'none'; }
    if (step.mount) step.mount(main, ctx);
    /* #bkItin sits outside the step's own root, so its Modify Flights / Edit
       Search button has to be wired from here. */
    root.querySelectorAll('#bkItin [data-bk-exit]').forEach(b => {
      b.addEventListener('click', confirmClose);
    });
    if (typeof JPIcon !== 'undefined') JPIcon.mount(root);

    /* Buttons reflect where we are: no Back on the first step, and the last
       step is a dismissal rather than a Continue. */
    const back = document.getElementById('bkBack');
    const next = document.getElementById('bkNext');
    /* BACK IS ALWAYS THERE ON THE FIRST STEP NOW. It used to be hidden, on the
       reasoning that there was nowhere behind it — but back() leaves the flow
       entirely from step 0, which IS where the traveller came from, and with
       the rail gone this is the only way back that is left. `hideBack` is
       still honoured: a step that owns its own navigation says so. */
    back.style.visibility = step.hideBack ? 'hidden' : 'visible';
    back.textContent = index === 0
      ? ('Back to ' + (flow.backLabel || 'results')) : 'Back';
    /* The pagehead's top Back doubles as step navigation: on an inner step it
       names and returns to the previous step, exactly like the hotel screens'
       top back; on the first step it stays the exit to the results list.
       (onExitClick carries the matching action.) Flights never see it — their
       pagehead is display:none. Only the trailing text node is touched so the
       already-mounted chevron icon is left intact. */
    const exitBtn = document.getElementById('bkExit');
    if (exitBtn && exitBtn.lastChild) {
      const stepBackable = index > 0 && !step.hideBack;
      const prevLabel = stepBackable
        ? (flow.steps[index - 1].label || flow.steps[index - 1].id)
        : (flow.backLabel || 'results');
      exitBtn.lastChild.textContent = ' Back to ' + prevLabel;
    }
    /* A step that carries its own call to action hides the shell's. The
       gateway payment screen is the one that does: its button opens the
       provider's checkout and must not be duplicated by a Continue that would
       skip past the payment entirely. Set in the step's load(), so it can
       depend on whether a provider is configured. */
    next.style.visibility = step.hideNext ? 'hidden' : 'visible';
    next.textContent = step.nextLabel || 'Continue';
    next.className = 'bk-btn ' + (step.primaryDanger ? 'bk-btn-danger' : 'bk-btn-primary');
    /* The reference's CTA carries a trailing arrow. The label itself stays
       whatever the step named, so no wording changes — this only appends the
       glyph, and only on flights. */
    if (flow.kind === 'flight' && !step.hideSummary
        && typeof BookingProducts !== 'undefined' && BookingProducts.svg) {
      next.innerHTML = esc(next.textContent) + BookingProducts.svg('arrowRight');
    }
    setMsg('');

    /* The flow is real page content now, not a modal with its own scroll
       box — so a step change scrolls the page itself back to the top of the
       sheet (just clear of the sticky header) rather than resetting an
       internal scrollTop that no longer does anything. */
    if (!inPlace) {
      const sheet = root.querySelector('.bk-sheet');
      if (sheet) {
        const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bk-header-h')) || 0;
        const top = sheet.getBoundingClientRect().top + window.scrollY - headerH - 12;
        window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
      }
    }
  }

  function setMsg(text, tone) {
    const el = document.getElementById('bkMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'bk-foot-msg' + (text ? ' is-' + (tone || 'error') : '');
  }

  /* ---------------------------------------------------------------------
     Navigation
     --------------------------------------------------------------------- */
  async function next() {
    if (busy) return;
    const step = flow.steps[index];

    if (step.validate) {
      const ok = step.validate(ctx);
      if (ok !== true) {
        setMsg(typeof ok === 'string' ? ok : 'Please complete this step.');
        /* Take the traveller to the problem rather than leaving them to find
           it — the forms here are long. */
        const bad = document.querySelector('#bkMain .is-invalid');
        if (bad) { bad.scrollIntoView({ block: 'center', behavior: 'smooth' }); bad.focus?.(); }
        return;
      }
    }

    if (step.onNext) {
      busy = true;
      const btn = document.getElementById('bkNext');
      const label = btn.textContent;
      btn.textContent = step.busyLabel || 'Please wait…';
      btn.disabled = true;
      try {
        await step.onNext(ctx);
      } catch (err) {
        setMsg(err.message || 'Something went wrong. Please try again.');
        btn.textContent = label; btn.disabled = false; busy = false;
        return;
      }
      btn.textContent = label; btn.disabled = false; busy = false;
    }

    if (index >= flow.steps.length - 1) { close(); return; }
    index += 1;
    paint('next');
    /* One new history entry for the step just entered, so browser Back returns
       to the step before it rather than leaving the flow. */
    pushStep(index);
  }

  function back() {
    if (busy) return;
    /* While the bank round-trip is live the gateway screen owns navigation; the
       Back button does nothing rather than abandoning a charge mid-flight. */
    if (paymentBusy()) return;
    /* ONE path for every Back, step 0 included. The browser moves the pointer
       back one entry and onPopState does the rest: from an inner step that is the
       previous step; from the first step it is the results page, where onPopState
       hides the overlay (keeping the draft) rather than destroying it — so the
       in-page Back, the browser Back button, and a Forward back in all agree. The
       header X / Escape are the explicit "leave and discard" path (confirmClose). */
    history.back();
  }

  /* The pagehead's top Back is step-aware: on an inner step it returns to the
     previous step (like the hotel screens' top back); on the first step it is
     the exit to the results list. paint() relabels it to match. */
  function onExitClick() {
    const step = flow.steps[index];
    if (index > 0 && !(step && step.hideBack)) { back(); return; }
    confirmClose();
  }

  /* ---------------------------------------------------------------------
     Open / close
     --------------------------------------------------------------------- */
  /* Build (or rebuild) the overlay shell and arm its controls. Shared by start()
     and reopen() so the markup and the listeners exist in exactly one place. */
  function buildShell() {
    const root = ensureRoot();
    root.innerHTML = shellHtml();
    root.classList.add('is-open');
    document.body.classList.add('bk-inpage');

    setHeaderHeightVar();
    const header = siteHeader();
    if (header && 'ResizeObserver' in window) {
      headerObserver = new ResizeObserver(setHeaderHeightVar);
      headerObserver.observe(header);
    } else {
      window.addEventListener('resize', setHeaderHeightVar);
    }

    root.querySelector('#bkExit').addEventListener('click', onExitClick);
    root.querySelector('#bkBack').addEventListener('click', back);
    root.querySelector('#bkNext').addEventListener('click', next);
    document.addEventListener('keydown', onKey);
  }

  function start(definition, seed) {
    flow = definition;
    ctx = Object.assign({
      kind: definition.kind,
      passengers: [],
      seats: [],
      addons: [],
      payment: {},
      pricing: { lines: [], total: 0 },
      booking: null,
    }, seed || {});
    index = 0;
    dormant = false;

    buildShell();
    paint('next');

    /* First history entry, pushed OVER the results page that opened the flow, so
       a Back from this step lands back on those results. Every forward step adds
       one more in next(); the popstate handler walks them. */
    historyActive = true;
    pushStep(0);
  }

  /* HIDE the overlay but keep the draft alive, for a Back that landed on the
     results page. The markup is left in place (not cleared) so a Forward back
     into the flow restores the exact screen — including anything half-typed —
     without a repaint. Listeners that only make sense while the overlay is shown
     are detached so the results page behind it behaves normally. */
  function goDormant() {
    const root = document.getElementById('bkRoot');
    if (root) root.classList.remove('is-open');
    document.body.classList.remove('bk-inpage');
    if (headerObserver) { headerObserver.disconnect(); headerObserver = null; }
    window.removeEventListener('resize', setHeaderHeightVar);
    document.removeEventListener('keydown', onKey);
    dormant = true;
  }

  /* Re-show a hidden overlay (browser Forward back into the flow). The step DOM
     was kept by goDormant(), so this only re-arms the shell — no repaint, so no
     typed-but-uncommitted field is lost. The index was already set by the caller
     to the entry we landed on. */
  function reopen() {
    dormant = false;
    const root = document.getElementById('bkRoot');
    /* Normal path: the markup is still there, just hidden — re-show and re-arm. */
    if (root && root.children.length) {
      root.classList.add('is-open');
      document.body.classList.add('bk-inpage');
      setHeaderHeightVar();
      const header = siteHeader();
      if (header && 'ResizeObserver' in window) {
        headerObserver = new ResizeObserver(setHeaderHeightVar);
        headerObserver.observe(header);
      } else {
        window.addEventListener('resize', setHeaderHeightVar);
      }
      document.addEventListener('keydown', onKey);
      return;
    }
    /* Defensive: the markup was cleared somehow — rebuild and paint from ctx. */
    buildShell();
    paint('next');
  }

  function onKey(e) {
    if (e.key === 'Escape' && document.getElementById('bkRoot')?.classList.contains('is-open')) {
      confirmClose();
    }
  }

  /** Closing after a confirmed booking is just closing. Closing halfway
   *  through throws the draft away, so it asks first. */
  function confirmClose() {
    /* Never abandon the booking while a charge is being confirmed. */
    if (paymentBusy()) return;
    const done = ctx && ctx.booking;
    if (done || index === 0) return close();
    if (window.confirm('Leave this booking? Your details will not be saved.')) close();
  }

  /* The real cleanup. Idempotent: a second call (the popstate from exitFlow's
     rewind can arrive after flow is already cleared) does nothing. */
  function teardown() {
    if (!historyActive && !flow) return;
    historyActive = false;
    const root = document.getElementById('bkRoot');
    if (root) { root.classList.remove('is-open'); root.innerHTML = ''; }
    document.body.classList.remove('bk-inpage');
    if (headerObserver) { headerObserver.disconnect(); headerObserver = null; }
    window.removeEventListener('resize', setHeaderHeightVar);
    document.documentElement.style.removeProperty('--bk-header-h');
    document.removeEventListener('keydown', onKey);
    const after = flow && flow.onClose;
    const finished = ctx && ctx.booking;
    flow = null; ctx = null; index = 0; busy = false; dormant = false;
    if (after) after(finished);
  }

  /* Public close, and the completion path (Done on the confirmation step). Tears
     the overlay down and rewinds the booking entries off the history stack so
     they do not linger as dead Back presses — see exitFlow. */
  function close() { exitFlow(); }

  /** Recompute the fare and repaint the rail WITHOUT re-rendering the step.
   *  Ticking an add-on has to move the total immediately; re-rendering the
   *  step to achieve that would throw away scroll position and focus. */
  async function refreshPrice() {
    if (!flow || !ctx) return;
    await recalcAsync();
    const side = document.getElementById('bkSide');
    if (side) { side.innerHTML = sideHtml(); mountSide(); }
    /* Some steps print the total in the body too (payment). Keep it in step. */
    document.querySelectorAll('[data-bk-total]').forEach(el => {
      el.textContent = money(ctx.pricing.total);
    });
    /* The Review step embeds its own copy of the fare summary (so the page
       reads standalone). Re-render just that step's body — using the
       ctx.pricing already refreshed above, not a second recalc — or applying
       a coupon there leaves it showing the pre-coupon total until the
       traveller leaves and comes back. */
    const step = flow.steps[index];
    if (step && step.id === 'summary') {
      const main = document.getElementById('bkMain');
      if (main) {
        main.innerHTML = step.render(ctx);
        if (step.mount) step.mount(main, ctx);
        if (typeof JPIcon !== 'undefined') JPIcon.mount(main);
      }
    }
  }

  /** Re-render the current step in place. The traveller step calls this when
   *  a traveller is added or removed: the card list changes shape, so a
   *  re-render is the honest way to redraw it. The draft is read off the
   *  screen first by the caller, so nothing typed is lost. */
  function repaint() {
    if (flow && ctx) paint('repaint');
  }

  /** Jump to a named step. Used by the Review step's Edit links.
   *
   *  Deliberately does NOT re-run validation on the way back: the draft is
   *  already on ctx and the traveller is returning to change one thing, so
   *  losing what they typed would be the opposite of what Edit promises. */
  function goTo(stepId) {
    if (!flow || !ctx) return;
    if (paymentBusy()) return;
    const target = flow.steps.findIndex(s => s.id === stepId);
    if (target < 0 || target === index) return;
    if (target < index) {
      /* Edit links jump BACK to an earlier step. Move the history pointer back
         the matching number of entries so this jump lives in the browser's own
         stack — onPopState performs the paint. The forward entries are rebuilt
         as the traveller Continues back to Review, so Back afterwards walks the
         steps cleanly with no duplicate entries. */
      try { history.go(target - index); return; } catch (e) { /* fall through */ }
    }
    /* A forward jump is not used by the Edit links; keep it correct anyway and
       add the entry the push-per-step model expects. */
    index = target;
    paint(target < index ? 'back' : 'next');
    pushStep(index);
  }

  /* ONE popstate listener for the whole page. It is inert (returns immediately)
     until a flow is open, so there is no per-flow add/remove to leak or
     double-bind, and it never competes with the results page's own popstate
     handler — that one ignores our entries (see travel-explore.js). */
  window.addEventListener('popstate', onPopState);

  return { start, close, skeleton, money, esc, refreshPrice, repaint, goTo,
           get context() { return ctx; },
           get stepIndex() { return index; } };
})();
