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

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const backArrow = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    const step = flow.steps[index];
    const main = document.getElementById('bkMain');
    const root = document.getElementById('bkRoot');

    /* The itinerary card, repainted per step: the Review step's version names
       the party and cabin and offers "Edit Search", the others "Change
       Flights", so it cannot be rendered once at start(). */
    const itin = root.querySelector('#bkItin');
    if (itin) itin.innerHTML = itineraryHtml(ctx, step);

    main.className = 'bk-main ' + (direction === 'back' ? 'bk-in-back' : 'bk-in');
    if (step.load) main.innerHTML = skeleton(3);

    try {
      if (step.load) await step.load(ctx);
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
    if (footNote) footNote.textContent = step.ctaNote || '';
    if (step.mount) step.mount(main, ctx);
    /* #bkItin sits outside the step's own root, so its Change Flights / Edit
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
    const sheet = root.querySelector('.bk-sheet');
    if (sheet) {
      const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bk-header-h')) || 0;
      const top = sheet.getBoundingClientRect().top + window.scrollY - headerH - 12;
      window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
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
  }

  function back() {
    if (busy) return;
    /* From the first step there is no earlier step — going back means leaving
       the flow, which is where the traveller was before it opened. Same thing
       the page head's exit does, so the two cannot disagree. */
    if (index === 0) { confirmClose(); return; }
    index -= 1;
    paint('back');
  }

  /* ---------------------------------------------------------------------
     Open / close
     --------------------------------------------------------------------- */
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

    root.querySelector('#bkExit').addEventListener('click', confirmClose);
    root.querySelector('#bkBack').addEventListener('click', back);
    root.querySelector('#bkNext').addEventListener('click', next);
    document.addEventListener('keydown', onKey);

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
    const done = ctx && ctx.booking;
    if (done || index === 0) return close();
    if (window.confirm('Leave this booking? Your details will not be saved.')) close();
  }

  function close() {
    const root = document.getElementById('bkRoot');
    if (root) { root.classList.remove('is-open'); root.innerHTML = ''; }
    document.body.classList.remove('bk-inpage');
    if (headerObserver) { headerObserver.disconnect(); headerObserver = null; }
    window.removeEventListener('resize', setHeaderHeightVar);
    document.documentElement.style.removeProperty('--bk-header-h');
    document.removeEventListener('keydown', onKey);
    const after = flow && flow.onClose;
    const finished = ctx && ctx.booking;
    flow = null; ctx = null; index = 0; busy = false;
    if (after) after(finished);
  }

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
    if (flow && ctx) paint(0);
  }

  /** Jump to a named step. Used by the Review step's Edit links.
   *
   *  Deliberately does NOT re-run validation on the way back: the draft is
   *  already on ctx and the traveller is returning to change one thing, so
   *  losing what they typed would be the opposite of what Edit promises. */
  function goTo(stepId) {
    if (!flow || !ctx) return;
    const target = flow.steps.findIndex(s => s.id === stepId);
    if (target < 0) return;
    const back = target < index;
    index = target;
    paint(back ? -1 : 1);
  }

  return { start, close, skeleton, money, esc, refreshPrice, repaint, goTo,
           get context() { return ctx; },
           get stepIndex() { return index; } };
})();
