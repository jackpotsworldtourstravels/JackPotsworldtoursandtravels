'use strict';
/* ===========================================================================
   booking-products.js — what each product's booking actually contains.
   ===========================================================================
   BookingFlow owns navigation, validation, the progress rail and the price
   rail. This file owns the steps. Five products, one engine.

   Most steps are shared: travellers, add-ons, summary, payment and
   confirmation are built once here and reused, which is why a hotel booking
   and a cruise booking feel like the same product. Only the genuinely
   different steps — the seat map, the room grid, the cabin grid, the visa
   requirements — are written per product.

   NO CARD DETAILS ARE COLLECTED, ANYWHERE. The payment step chooses a method
   and simulates the result. A realistic card form is not needed to demonstrate
   a booking flow, and building one — even labelled demo — creates a screen
   that looks exactly like a real one for anybody who later screenshots it or
   copies the markup.
   =========================================================================== */

const BookingProducts = (function () {

  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const icon = n => (typeof JPIcon !== 'undefined' ? JPIcon.html(n, { size: 'sm' }) : '');

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso.length > 10 ? iso : iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-IN',
      { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* ---------------------------------------------------------------------
     Form helpers — one definition, so every field in every product matches.
     --------------------------------------------------------------------- */
  function field(o) {
    const id = esc(o.id);
    const req = o.required ? ' required' : '';
    const opt = o.required ? '' : ' <span class="bk-opt">optional</span>';
    let control;
    if (o.type === 'select') {
      control = `<select id="${id}" name="${id}"${req}>
          <option value="">${esc(o.placeholder || 'Select…')}</option>
          ${(o.options || []).map(v => {
            const val = typeof v === 'string' ? v : v.value;
            const lab = typeof v === 'string' ? v : v.label;
            return `<option value="${esc(val)}"${o.value === val ? ' selected' : ''}>${esc(lab)}</option>`;
          }).join('')}
        </select>`;
    } else if (o.type === 'textarea') {
      control = `<textarea id="${id}" name="${id}" rows="3" placeholder="${esc(o.placeholder || '')}"${req}>${esc(o.value || '')}</textarea>`;
    } else {
      control = `<input id="${id}" name="${id}" type="${esc(o.type || 'text')}"
        value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}"
        ${o.max ? `max="${esc(o.max)}"` : ''} ${o.min ? `min="${esc(o.min)}"` : ''}
        ${o.inputmode ? `inputmode="${esc(o.inputmode)}"` : ''}
        ${o.autocomplete ? `autocomplete="${esc(o.autocomplete)}"` : ''}${req}>`;
    }
    return `<div class="bk-field ${o.wide ? 'is-wide' : ''}">
        <label for="${id}">${esc(o.label)}${opt}</label>${control}
      </div>`;
  }

  const val = (root, id) => (root.querySelector('#' + id)?.value || '').trim();

  /** Mark the first empty required control and hand back its label, so the
   *  engine's message names the field instead of saying "check the form". */
  function firstMissing(root, specs) {
    for (const s of specs) {
      if (!s.required) continue;
      const el = root.querySelector('#' + s.id);
      if (el && !el.value.trim()) {
        root.querySelectorAll('.is-invalid').forEach(e => e.classList.remove('is-invalid'));
        el.classList.add('is-invalid');
        return s.label;
      }
    }
    return null;
  }

  /* =====================================================================
     SHARED STEP — travellers
     ===================================================================== */
  function travellerSpecs(i, opts) {
    const p = `p${i}_`;
    const base = [
      { id: p + 'title', label: 'Title', type: 'select', required: true, options: BookingData.TITLES },
      { id: p + 'first', label: 'First name', required: true, autocomplete: 'given-name' },
      { id: p + 'last',  label: 'Last name',  required: true, autocomplete: 'family-name' },
      { id: p + 'gender', label: 'Gender', type: 'select', required: true, options: BookingData.GENDERS },
      { id: p + 'dob',   label: 'Date of birth', type: 'date', required: true, max: new Date().toISOString().slice(0, 10) },
      { id: p + 'nat',   label: 'Nationality', type: 'select', required: true, options: BookingData.NATIONALITIES, value: 'India' },
    ];
    const passport = [
      { id: p + 'ppno',  label: 'Passport number', required: true, placeholder: 'e.g. M1234567' },
      { id: p + 'ppexp', label: 'Passport expiry', type: 'date', required: true, min: new Date().toISOString().slice(0, 10) },
      { id: p + 'ppiss', label: 'Issuing country', type: 'select', required: true, options: BookingData.NATIONALITIES, value: 'India' },
    ];
    const contact = i === 0 ? [
      { id: p + 'mobile', label: 'Mobile number', type: 'tel', required: true, inputmode: 'numeric', autocomplete: 'tel' },
      { id: p + 'email',  label: 'Email address', type: 'email', required: true, autocomplete: 'email' },
    ] : [];
    const ff = opts.frequentFlyer
      ? [{ id: p + 'ff', label: 'Frequent flyer number', required: false, wide: true }] : [];
    return [...base, ...(opts.passport ? passport : []), ...contact, ...ff];
  }

  function travellersStep(opts) {
    const o = Object.assign({ passport: true, frequentFlyer: true, noun: 'Traveller' }, opts);
    return {
      id: 'travellers',
      label: o.noun + 's',
      render(ctx) {
        const n = Math.max(1, ctx.paxCount || 1);
        const cards = Array.from({ length: n }, (_, i) => {
          const kindLabel = ctx.paxKinds ? ctx.paxKinds[i] : null;
          return `<section class="bk-pax">
            <header class="bk-pax-head">
              <h3>${esc(o.noun)} ${i + 1}${kindLabel ? ` <span class="bk-tag">${esc(kindLabel)}</span>` : ''}</h3>
              ${i === 0 ? '<span class="bk-pax-note">Contact details for the whole booking</span>' : ''}
            </header>
            <div class="bk-grid">${travellerSpecs(i, o).map(field).join('')}</div>
          </section>`;
        }).join('');
        return `<div class="bk-step">
            <h2 class="bk-step-title">Who is travelling?</h2>
            <p class="bk-step-sub">Names must match the photo ID used at the airport.</p>
            ${cards}
          </div>`;
      },
      validate(ctx) {
        const root = document.getElementById('bkMain');
        const n = Math.max(1, ctx.paxCount || 1);
        for (let i = 0; i < n; i++) {
          const specs = travellerSpecs(i, o);
          const missing = firstMissing(root, specs);
          if (missing) return `${o.noun} ${i + 1}: ${missing} is required.`;
          const p = `p${i}_`;
          if (o.passport) {
            const exp = root.querySelector('#' + p + 'ppexp')?.value;
            /* Six months' validity is the rule most destinations actually
               apply, and catching it here beats catching it at immigration. */
            if (exp) {
              const sixMonths = new Date(); sixMonths.setMonth(sixMonths.getMonth() + 6);
              if (new Date(exp) < sixMonths) {
                root.querySelector('#' + p + 'ppexp').classList.add('is-invalid');
                return `${o.noun} ${i + 1}: passport should be valid at least six months beyond travel.`;
              }
            }
          }
          if (i === 0) {
            const email = root.querySelector('#' + p + 'email').value.trim();
            const mob = root.querySelector('#' + p + 'mobile').value.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              root.querySelector('#' + p + 'email').classList.add('is-invalid');
              return 'Enter a valid email address.';
            }
            if (!/^\d{10,15}$/.test(mob.replace(/[\s-]/g, ''))) {
              root.querySelector('#' + p + 'mobile').classList.add('is-invalid');
              return 'Enter a valid mobile number.';
            }
          }
        }
        /* Read the forms into the draft only once they are known good. */
        ctx.passengers = Array.from({ length: n }, (_, i) => {
          const p = `p${i}_`;
          return {
            title: val(root, p + 'title'), first: val(root, p + 'first'), last: val(root, p + 'last'),
            gender: val(root, p + 'gender'), dob: val(root, p + 'dob'), nationality: val(root, p + 'nat'),
            passportNumber: o.passport ? val(root, p + 'ppno') : null,
            passportExpiry: o.passport ? val(root, p + 'ppexp') : null,
            issuingCountry: o.passport ? val(root, p + 'ppiss') : null,
            frequentFlyer: o.frequentFlyer ? val(root, p + 'ff') : null,
            mobile: i === 0 ? val(root, p + 'mobile') : null,
            email: i === 0 ? val(root, p + 'email') : null,
            kind: ctx.paxKinds ? ctx.paxKinds[i] : 'Adult',
          };
        });
        return true;
      },
    };
  }

  /* =====================================================================
     SHARED STEP — add-ons
     ===================================================================== */
  function addonsStep(productType) {
    return {
      id: 'addons',
      label: 'Add-ons',
      async load(ctx) { ctx.addonCatalogue = await BookingData.addons(productType); },
      render(ctx) {
        const chosen = new Set(ctx.addons.map(a => a.id));
        const cards = ctx.addonCatalogue.map(a => `
          <label class="bk-addon ${chosen.has(a.id) ? 'is-on' : ''}" data-addon="${esc(a.id)}">
            <input type="checkbox" data-addon-cb="${esc(a.id)}" ${chosen.has(a.id) ? 'checked' : ''}>
            <span class="bk-addon-icon">${icon(a.icon)}</span>
            <span class="bk-addon-body">
              <b>${esc(a.name)}</b>
              <span>${a.note ? esc(a.note) : (a.per === 'passenger' ? 'Per traveller' : 'Per booking')}</span>
            </span>
            <span class="bk-addon-price">${a.price ? esc(money(a.price)) : 'Free'}</span>
          </label>`).join('');
        return `<div class="bk-step">
            <h2 class="bk-step-title">Anything else?</h2>
            <p class="bk-step-sub">Every extra can be removed later — nothing here is final.</p>
            <div class="bk-addons">${cards}</div>
          </div>`;
      },
      mount(root, ctx) {
        root.querySelectorAll('[data-addon-cb]').forEach(cb => {
          cb.addEventListener('change', () => {
            const id = cb.dataset.addonCb;
            const item = ctx.addonCatalogue.find(a => a.id === id);
            ctx.addons = cb.checked
              ? [...ctx.addons.filter(a => a.id !== id), item]
              : ctx.addons.filter(a => a.id !== id);
            cb.closest('.bk-addon').classList.toggle('is-on', cb.checked);
            /* The rail is the whole point of this step — it has to move as
               boxes are ticked, not only when the step changes. */
            BookingFlow.refreshPrice();
          });
        });
      },
    };
  }

  /* =====================================================================
     SHARED STEP — summary
     ===================================================================== */
  function summaryStep(describe) {
    return {
      id: 'summary',
      label: 'Review',
      nextLabel: 'Continue to payment',
      render(ctx) {
        const pax = ctx.passengers.map((p, i) => `
          <tr><td>${i + 1}</td><td>${esc(p.title)} ${esc(p.first)} ${esc(p.last)}</td>
              <td>${esc(p.kind || 'Adult')}</td>
              <td>${esc(ctx.seats[i] ? ctx.seats[i].id : '—')}</td></tr>`).join('');
        const addons = ctx.addons.length
          ? ctx.addons.map(a => `<li>${esc(a.name)} <span>${a.price ? esc(money(a.price)) : 'Free'}</span></li>`).join('')
          : '<li class="is-muted">None selected</li>';
        const lines = (ctx.pricing.lines || []).map(l =>
          `<div class="bk-price-line"><span>${esc(l.label)}</span><span>${l.free ? 'Included' : esc(money(l.amount))}</span></div>`).join('');

        return `<div class="bk-step">
            <h2 class="bk-step-title">Check everything over</h2>
            <p class="bk-step-sub">Nothing is charged until you confirm on the next step.</p>

            <section class="bk-panel">${describe(ctx)}</section>

            <section class="bk-panel">
              <h3>${esc(ctx.passengers.length)} ${ctx.passengers.length === 1 ? 'traveller' : 'travellers'}</h3>
              <div class="bk-table-wrap">
                <table class="bk-table">
                  <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Seat</th></tr></thead>
                  <tbody>${pax}</tbody>
                </table>
              </div>
            </section>

            <section class="bk-panel">
              <h3>Add-ons</h3>
              <ul class="bk-list">${addons}</ul>
            </section>

            <section class="bk-panel">
              <h3>Fare breakdown</h3>
              ${lines}
              <div class="bk-price-total"><span>Total payable</span><span>${esc(money(ctx.pricing.total))}</span></div>
            </section>
          </div>`;
      },
    };
  }

  /* =====================================================================
     SHARED STEP — payment (simulated)
     ===================================================================== */
  const PAY_METHODS = [
    { id: 'card',    name: 'Credit card',  note: 'Visa, Mastercard, Amex, RuPay' },
    { id: 'debit',   name: 'Debit card',   note: 'All major Indian banks' },
    { id: 'upi',     name: 'UPI',          note: 'GPay, PhonePe, Paytm, BHIM' },
    { id: 'netbank', name: 'Net banking',  note: '50+ banks supported' },
    { id: 'wallet',  name: 'Wallet',       note: 'Paytm, Amazon Pay, Mobikwik' },
  ];

  function paymentStep() {
    return {
      id: 'payment',
      label: 'Payment',
      nextLabel: 'Pay now',
      busyLabel: 'Processing…',
      render(ctx) {
        const methods = PAY_METHODS.map((m, i) => `
          <label class="bk-pay ${i === 0 ? 'is-on' : ''}">
            <input type="radio" name="bkPay" value="${esc(m.id)}" ${i === 0 ? 'checked' : ''}>
            <span class="bk-pay-body"><b>${esc(m.name)}</b><span>${esc(m.note)}</span></span>
          </label>`).join('');
        return `<div class="bk-step">
            <h2 class="bk-step-title">How would you like to pay?</h2>

            <!-- No card number, no expiry, no CVV. This is a demo of a booking
                 flow, not of a payment form, and a realistic card screen is
                 exactly the thing that should not exist in a demo build. -->
            <div class="bk-demo-note">
              ${icon('insurance')}
              <div>
                <b>Demo payment</b>
                <p>No gateway is connected and no card details are collected.
                   Choosing a method and continuing will simulate a successful payment.</p>
              </div>
            </div>

            <div class="bk-pays">${methods}</div>

            <div class="bk-paytotal">
              <span>Amount payable</span><b>${esc(money(ctx.pricing.total))}</b>
            </div>
          </div>`;
      },
      mount(root) {
        root.querySelectorAll('.bk-pay input').forEach(r => r.addEventListener('change', () => {
          root.querySelectorAll('.bk-pay').forEach(l => l.classList.toggle('is-on', l.contains(r) && r.checked));
        }));
      },
      async onNext(ctx) {
        const picked = document.querySelector('input[name="bkPay"]:checked');
        ctx.payment = {
          method: picked ? picked.value : 'card',
          methodLabel: (PAY_METHODS.find(m => m.id === (picked && picked.value)) || PAY_METHODS[0]).name,
          amount: ctx.pricing.total,
          simulated: true,
        };
        /* A beat of latency, because an instant confirmation does not read as
           a payment and the demo is about how it feels. */
        await new Promise(r => setTimeout(r, 900));
        ctx.booking = await BookingStore.create(flowDraft(ctx));
      },
    };
  }

  /** The shape handed to BookingStore. Kept in one place so every product
   *  stores the same thing and My Bookings can render any of them. */
  function flowDraft(ctx) {
    return {
      kind: ctx.kind,
      title: ctx.summaryTitle,
      subtitle: ctx.summarySubtitle,
      travelDate: ctx.travelDate,
      total: ctx.pricing.total,
      currency: 'INR',
      airlineCode: ctx.item && ctx.item.airlineCode,
      passengers: ctx.passengers,
      seats: ctx.seats.map(s => s && s.id).filter(Boolean),
      addons: ctx.addons.map(a => ({ id: a.id, name: a.name, price: a.price })),
      payment: ctx.payment,
      pricing: ctx.pricing,
      item: ctx.item ? { id: ctx.item.id, name: ctx.summaryTitle } : null,
    };
  }

  /* =====================================================================
     SHARED STEP — confirmation
     ===================================================================== */
  function confirmationStep() {
    return {
      id: 'done',
      label: 'Confirmed',
      hideSummary: true,
      hideBack: true,
      nextLabel: 'Done',
      render(ctx) {
        const b = ctx.booking || {};
        const refs = [
          ['Booking reference', b.id],
          b.pnr ? ['PNR', b.pnr] : null,
          b.ticketNumber ? ['Ticket number', b.ticketNumber] : null,
          ['Booked on', fmtDate(b.bookedAt)],
          ['Paid with', (b.payment || {}).methodLabel],
          ['Total paid', money(b.total)],
        ].filter(Boolean).map(([k, v]) =>
          `<div class="bk-ref"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

        const pax = (b.passengers || []).map((p, i) =>
          `<li>${esc(p.title)} ${esc(p.first)} ${esc(p.last)}
             <span>${esc(p.kind || 'Adult')}${b.seats && b.seats[i] ? ' · Seat ' + esc(b.seats[i]) : ''}</span></li>`).join('');

        return `<div class="bk-step bk-done">
            <div class="bk-done-mark">${typeof JPIcon !== 'undefined' ? JPIcon.html('insurance', { size: 'xl' }) : ''}</div>
            <h2>Booking confirmed</h2>
            <p class="bk-step-sub">${esc(ctx.summaryTitle || '')} — a confirmation has been recorded against your account.</p>

            <div class="bk-refs">${refs}</div>

            <section class="bk-panel">
              <h3>Travellers</h3>
              <ul class="bk-list">${pax || '<li class="is-muted">—</li>'}</ul>
            </section>

            <div class="bk-done-actions">
              <button type="button" class="bk-btn bk-btn-primary" data-act="download">Download ticket</button>
              <button type="button" class="bk-btn bk-btn-ghost" data-act="print">Print</button>
              <button type="button" class="bk-btn bk-btn-ghost" data-act="email">Email ticket</button>
              <a class="bk-btn bk-btn-ghost" href="my-bookings.html">View my bookings</a>
            </div>
            <p class="bk-demo-foot">Demo booking — no payment was taken and no ticket has been issued by an airline.</p>
          </div>`;
      },
      mount(root, ctx) {
        root.querySelectorAll('[data-act]').forEach(btn => {
          btn.addEventListener('click', () => BookingTicket.handle(btn.dataset.act, ctx.booking));
        });
      },
    };
  }

  /* =====================================================================
     PRICING
     ===================================================================== */
  function addonTotal(ctx) {
    const pax = Math.max(1, ctx.paxCount || 1);
    return ctx.addons.reduce((sum, a) => sum + (a.price || 0) * (a.per === 'passenger' ? pax : 1), 0);
  }

  function flightPrice(ctx) {
    const f = ctx.item;
    const pax = Math.max(1, ctx.paxCount || 1);
    const mult = (BookingData.CABIN_CLASSES.find(c => c.id === (ctx.cabin || 'economy')) || {}).multiplier || 1;
    const base = Math.round(f.fare * mult) * pax;
    const taxes = Math.round(f.taxes * mult) * pax;
    const seats = ctx.seats.reduce((s, x) => s + (x ? x.price : 0), 0);
    const extras = addonTotal(ctx);
    const lines = [
      { label: `Base fare × ${pax}`, amount: base },
      { label: 'Taxes & fees', amount: taxes },
    ];
    if (seats) lines.push({ label: 'Seat selection', amount: seats });
    if (extras) lines.push({ label: 'Add-ons', amount: extras });
    return { lines, total: base + taxes + seats + extras };
  }

  function nightsBetween(a, b) {
    if (!a || !b) return 1;
    const ms = new Date(b) - new Date(a);
    return Math.max(1, Math.round(ms / 86400000));
  }

  function hotelPrice(ctx) {
    const room = ctx.room;
    if (!room) return { lines: [], total: 0 };
    const nights = nightsBetween(ctx.checkIn, ctx.checkOut);
    const rooms = Math.max(1, ctx.roomCount || 1);
    const base = room.price * nights * rooms;
    const taxes = Math.round(base * 0.12);
    const extras = addonTotal(ctx);
    const lines = [
      { label: `${esc(room.name)} × ${nights} ${nights === 1 ? 'night' : 'nights'}${rooms > 1 ? ` × ${rooms} rooms` : ''}`, amount: base },
      { label: 'Taxes & service', amount: taxes },
    ];
    if (extras) lines.push({ label: 'Add-ons', amount: extras });
    return { lines, total: base + taxes + extras };
  }

  function cruisePrice(ctx) {
    const cab = ctx.cabin_;
    if (!cab) return { lines: [], total: 0 };
    const pax = Math.max(1, ctx.paxCount || 1);
    const base = cab.price * pax;
    const port = 2400 * pax;
    const extras = addonTotal(ctx);
    const lines = [
      { label: `${esc(cab.name)} × ${pax}`, amount: base },
      { label: 'Port charges & gratuities', amount: port },
    ];
    if (extras) lines.push({ label: 'Add-ons', amount: extras });
    return { lines, total: base + port + extras };
  }

  function packagePrice(ctx) {
    const dep = ctx.departure;
    if (!dep) return { lines: [], total: 0 };
    const pax = Math.max(1, ctx.paxCount || 1);
    const base = dep.price * pax;
    const taxes = Math.round(base * 0.05);
    const extras = addonTotal(ctx);
    const lines = [
      { label: `${esc(ctx.item.name)} × ${pax}`, amount: base },
      { label: 'GST', amount: taxes },
    ];
    if (extras) lines.push({ label: 'Add-ons', amount: extras });
    return { lines, total: base + taxes + extras };
  }

  function visaPrice(ctx) {
    const t = ctx.visaType;
    if (!t) return { lines: [], total: 0 };
    const pax = Math.max(1, ctx.paxCount || 1);
    const base = t.fee * pax;
    const service = 1200 * pax;
    return {
      lines: [
        { label: `${esc(t.name)} × ${pax}`, amount: base },
        { label: 'Service charge', amount: service },
      ],
      total: base + service,
    };
  }

  return {
    // shared pieces, exported so product files stay short
    field, val, firstMissing, fmtDate, money, icon, esc,
    travellersStep, addonsStep, summaryStep, paymentStep, confirmationStep,
    addonTotal, nightsBetween,
    flightPrice, hotelPrice, cruisePrice, packagePrice, visaPrice,
    PAY_METHODS,
  };
})();
