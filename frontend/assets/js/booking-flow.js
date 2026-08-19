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

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  /* ---------------------------------------------------------------------
     Shell
     --------------------------------------------------------------------- */
  function ensureRoot() {
    let el = document.getElementById('bkRoot');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'bkRoot';
    el.className = 'bk-root';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Booking');
    document.body.appendChild(el);
    return el;
  }

  function shellHtml() {
    const steps = flow.steps.map((s, i) => `
      <li class="bk-rail-step ${i < index ? 'is-done' : ''} ${i === index ? 'is-now' : ''}">
        <span class="bk-rail-dot">${i < index ? '&#10003;' : i + 1}</span>
        <span class="bk-rail-label">${esc(s.label)}</span>
      </li>`).join('');

    return `
      <div class="bk-sheet">
        <header class="bk-head">
          <div>
            <div class="bk-kicker">${esc(flow.kicker || 'Booking')}</div>
            <h2 class="bk-title">${esc(flow.title)}</h2>
          </div>
          <button type="button" class="bk-close" id="bkClose" aria-label="Close booking">&times;</button>
        </header>

        <ol class="bk-rail" aria-label="Booking steps">${steps}</ol>

        <div class="bk-body">
          <section class="bk-main" id="bkMain" aria-live="polite"></section>
          <aside class="bk-side" id="bkSide"></aside>
        </div>

        <footer class="bk-foot">
          <button type="button" class="bk-btn bk-btn-ghost" id="bkBack">Back</button>
          <div class="bk-foot-msg" id="bkMsg" role="alert"></div>
          <button type="button" class="bk-btn bk-btn-primary" id="bkNext">Continue</button>
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

  function sideHtml() {
    const step = flow.steps[index];
    if (step.hideSummary) return '';
    const p = ctx.pricing || { lines: [], total: 0 };
    const lines = p.lines.map(l => `
      <div class="bk-price-line ${l.muted ? 'is-muted' : ''}">
        <span>${esc(l.label)}</span><span>${l.free ? 'Included' : esc(money(l.amount))}</span>
      </div>`).join('');
    return `
      <div class="bk-price">
        <h3>Fare summary</h3>
        ${lines || '<p class="bk-price-empty">Choose an option to see the fare.</p>'}
        <div class="bk-price-total"><span>Total</span><span>${esc(money(p.total))}</span></div>
        <p class="bk-price-note">Demo booking — no payment is taken.</p>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     Rendering a step
     --------------------------------------------------------------------- */
  async function paint(direction) {
    const step = flow.steps[index];
    const main = document.getElementById('bkMain');
    const root = document.getElementById('bkRoot');

    /* Re-render the rail so the tick marks and the "now" highlight move. */
    root.querySelector('.bk-rail').innerHTML = flow.steps.map((s, i) => `
      <li class="bk-rail-step ${i < index ? 'is-done' : ''} ${i === index ? 'is-now' : ''}">
        <span class="bk-rail-dot">${i < index ? '&#10003;' : i + 1}</span>
        <span class="bk-rail-label">${esc(s.label)}</span>
      </li>`).join('');

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

    recalc();
    main.innerHTML = step.render(ctx);
    document.getElementById('bkSide').innerHTML = sideHtml();
    if (step.mount) step.mount(main, ctx);
    if (typeof JPIcon !== 'undefined') JPIcon.mount(root);

    /* Buttons reflect where we are: no Back on the first step, and the last
       step is a dismissal rather than a Continue. */
    const back = document.getElementById('bkBack');
    const next = document.getElementById('bkNext');
    back.style.visibility = (index === 0 || step.hideBack) ? 'hidden' : 'visible';
    next.textContent = step.nextLabel || 'Continue';
    next.className = 'bk-btn ' + (step.primaryDanger ? 'bk-btn-danger' : 'bk-btn-primary');
    setMsg('');

    main.scrollTop = 0;
    root.querySelector('.bk-sheet').scrollTop = 0;
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
    if (busy || index === 0) return;
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
    document.body.classList.add('bk-locked');

    root.querySelector('#bkClose').addEventListener('click', confirmClose);
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
    document.body.classList.remove('bk-locked');
    document.removeEventListener('keydown', onKey);
    const after = flow && flow.onClose;
    const finished = ctx && ctx.booking;
    flow = null; ctx = null; index = 0; busy = false;
    if (after) after(finished);
  }

  /** Recompute the fare and repaint the rail WITHOUT re-rendering the step.
   *  Ticking an add-on has to move the total immediately; re-rendering the
   *  step to achieve that would throw away scroll position and focus. */
  function refreshPrice() {
    if (!flow || !ctx) return;
    recalc();
    const side = document.getElementById('bkSide');
    if (side) side.innerHTML = sideHtml();
    /* Some steps print the total in the body too (payment). Keep it in step. */
    document.querySelectorAll('[data-bk-total]').forEach(el => {
      el.textContent = money(ctx.pricing.total);
    });
  }

  return { start, close, skeleton, money, esc, refreshPrice,
           get context() { return ctx; },
           get stepIndex() { return index; } };
})();
