'use strict';
/* ===========================================================================
   booking-flows.js — the five products, assembled from shared steps.
   ===========================================================================
   Each export returns a definition BookingFlow.start() can run. The shared
   steps come from booking-products.js; only the genuinely product-specific
   screens are written here — the seat map, the room grid, the cabin grid, the
   departure picker and the visa requirements.

   Read one of these top to bottom and you have the whole customer journey for
   that product in about forty lines. That is the payoff for having one engine.
   =========================================================================== */

const BookingFlows = (function () {

  const P = BookingProducts;
  const esc = P.esc, money = P.money, icon = P.icon, fmtDate = P.fmtDate;

  /* =====================================================================
     FLIGHTS
     ===================================================================== */

  /** The aircraft, and who is sitting where.

      SEATS BELONG TO A TRAVELLER, NOT TO THE BOOKING. The step used to say
      "pick 2 seats" and collect them into a list, which meant the party knew
      it had 12A and 12B but not which of them was in which. The backend has
      always taken {passenger_index, seat_number}, so this assigns against
      that shape directly rather than inventing a second model.

      An infant is not allocated a seat — they travel on an adult's lap — so
      they are absent from the traveller list rather than listed with nothing
      to choose.

      THE MAP IS THE SERVER'S. Rows, letters, prices, which seats are taken and
      which are exit rows all come from GET /flights/seatmap; the four bands
      below (available / preferred / extra legroom / occupied) are read off
      that response, not decided here.
   */
  const SEAT_BANDS = [
    { key: 'selected', label: 'Selected' },
    { key: 'available', label: 'Available' },
    { key: 'occupied', label: 'Occupied' },
    { key: 'preferred', label: 'Preferred Seat' },
    { key: 'legroom', label: 'Extra Legroom' },
  ];

  /** Which band a seat falls in.

      BANDED BY POSITION, NOT BY "COSTS SOMETHING". The catalogue prices every
      seat (middle 150, aisle 300, window 350, +450 in an exit row, +200 in the
      first four rows — customer_catalog_service.seat_map), so a
      `price > 0 ? preferred : available` test put the WHOLE cabin in one band
      and the map came out a flat wash. The server's own `type` and `exit` are
      what the three bands actually mean: an exit row is the legroom, a window
      or an aisle is the preferred position, and a middle seat is a plain one.
      The legend prints each band's real entry price beside it. */
  function seatBand(s, selected) {
    if (selected) return 'selected';
    if (s.occupied) return 'occupied';
    if (s.exit) return 'legroom';
    if (s.type === 'window' || s.type === 'aisle') return 'preferred';
    return 'available';
  }

  const seatStep = {
    id: 'seats',
    label: 'Seats',
    async load(ctx) { ctx.seatMap = await BookingData.seatMap(ctx.item); },
    render(ctx) {
      /* Indexed by passenger, sparse, so seats[2] is traveller 3's whatever
         travellers 1 and 2 have done. BookingApi.seatPayload() reads the index
         off the position, which is why this must not be compacted. */
      if (!Array.isArray(ctx.seats)) ctx.seats = [];

      const kinds = ctx.paxKinds || [];
      const seatable = (ctx.passengers || []).map((p, i) => ({ p, i }))
        .filter(({ i }) => String(kinds[i] || 'Adult').toLowerCase() !== 'infant');
      /* Before the traveller step has been filled in there are no names yet;
         fall back to the party size so the map is still browsable. */
      const people = seatable.length ? seatable
        : Array.from({ length: Math.max(1, ctx.paxCount || 1) }, (_, i) => ({ p: null, i }));

      if (ctx.activeSeatPax === undefined
          || !people.some(x => x.i === ctx.activeSeatPax)) {
        ctx.activeSeatPax = people[0].i;
      }

      const nameOf = (p, i) => {
        const n = p ? `${p.first || ''} ${p.last || ''}`.trim() : '';
        return n || `Traveller ${i + 1}`;
      };

      const item = ctx.item || {};
      const sub = [
        item.origin && item.destination ? `${item.origin.code} → ${item.destination.code}` : '',
        [item.airline, item.flightNumber].filter(Boolean).join(' '),
        P.bkfDate ? P.bkfDate(ctx.travelDate || item.date) : '',
      ].filter(Boolean).join(' · ');

      const paxRows = people.map(({ p, i }) => {
        const seat = ctx.seats[i];
        const active = i === ctx.activeSeatPax;
        return `
          <button type="button" class="bkf-seatpax ${active ? 'is-active' : ''}"
                  data-paxseat="${i}" aria-pressed="${active}">
            <i class="bkf-n">${i + 1}</i>
            <span class="bkf-seatpax-body">
              <b>${esc(nameOf(p, i))}</b>
              <span>${esc(kinds[i] || 'Adult')}</span>
            </span>
            <span class="bkf-seatpax-seat ${seat ? '' : 'is-empty'}">${
              seat ? esc(seat.id) : 'Not selected'}</span>
          </button>`;
      }).join('');

      /* The legend names the bands this aircraft actually has, and prints the
         real entry price of each — not a fixed list. */
      const all = ctx.seatMap.rows.flatMap(r => r.seats);
      const cheapest = key => {
        const prices = all.filter(x => seatBand(x, false) === key && x.price > 0).map(x => x.price);
        return prices.length ? Math.min(...prices) : 0;
      };
      const present = key => key === 'selected' || all.some(x => seatBand(x, false) === key);
      const legend = SEAT_BANDS.filter(present2 => present(present2.key)).map(b => {
        const from = b.key === 'selected' || b.key === 'occupied' ? 0 : cheapest(b.key);
        return `<div><i class="bkf-sw-${b.key}"></i>${esc(b.label)}${
          from ? `<b>${esc(money(from))}</b>` : ''}</div>`;
      }).join('');

      const mineBySeat = new Map();
      ctx.seats.forEach((s, i) => { if (s) mineBySeat.set(s.id, i); });

      const letters = (ctx.seatMap.rows[0] || { seats: [] }).seats.map(s => s.letter);
      const half = Math.ceil(letters.length / 2);
      const cols = `<span></span>${letters.slice(0, half).map(l => `<span>${esc(l)}</span>`).join('')}
        <span></span>${letters.slice(half).map(l => `<span>${esc(l)}</span>`).join('')}<span></span>`;

      const rows = ctx.seatMap.rows.map(r => {
        const cells = r.seats.map((s, n) => {
          const owner = mineBySeat.get(s.id);
          const selected = owner !== undefined;
          const band = seatBand(s, selected);
          const label = s.occupied ? `Seat ${s.id}, occupied`
            : selected ? `Seat ${s.id}, selected for traveller ${owner + 1}`
            : `Seat ${s.id}, ${s.type}${s.exit ? ', extra legroom' : ''}, ${s.price ? money(s.price) : 'no extra charge'}`;
          const gap = n === half ? `<span class="bkf-rowno">${r.row}</span>` : '';
          return `${gap}<button type="button" class="bkf-seat is-${band} bkf-sw-${band}"
              data-seat="${esc(s.id)}" ${s.occupied ? 'disabled' : ''}
              title="${esc(label)}" aria-label="${esc(label)}">${selected ? owner + 1 : esc(s.letter)}</button>`;
        }).join('');
        return `<div class="bkf-seatrow2">
            ${r.exit ? '<span class="bkf-exit">EXIT</span>' : '<span></span>'}
            ${cells}
            ${r.exit ? '<span class="bkf-exit">EXIT</span>' : '<span></span>'}
          </div>`;
      }).join('');

      /* The blue strip describes the seat that is actually selected. With none
         chosen there is nothing true to say, so there is no strip. */
      const chosen = ctx.seats[ctx.activeSeatPax];
      const tip = (chosen && !ctx.seatTipClosed) ? `
        <div class="bkf-strip is-info" id="bkfSeatTip">
          ${P.svg('info')}
          <span><b>${esc(P.seatTypeLabel(chosen))} seat${chosen.exit ? ' with extra legroom' : ''}</b>
            ${chosen.exit ? 'Enjoy more comfort for your journey.'
              : chosen.price ? 'A preferred position on this aircraft.'
              : 'No extra charge for this seat.'}</span>
          <button type="button" class="bkf-strip-x" id="bkfSeatTipX" aria-label="Dismiss">&times;</button>
        </div>` : '';

      return `<div class="bk-step bkf-step">
        <section class="bkf-card">
          <div class="bkf-card-head has-rule">
            <div>
              <h2 class="bkf-h2">Select Seats</h2>
              <p class="bkf-sub">${esc(sub)}</p>
            </div>
            <div class="bkf-paxpick">
              <span>Passenger</span>
              <select id="bkfSeatPax" aria-label="Traveller to seat">
                ${people.map(({ p, i }) => `<option value="${i}"${
                  i === ctx.activeSeatPax ? ' selected' : ''}>${i + 1}. ${esc(nameOf(p, i))}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="bkf-card-body">
            <div class="bkf-seatwrap">
              <div class="bkf-seatside">
                <div class="bkf-box">
                  <h4>Passenger</h4>
                  ${paxRows}
                  <button type="button" class="bkf-clear" id="bkfClearSeat">Clear Seat</button>
                </div>
                <div class="bkf-box">
                  <h4>Seat Legend</h4>
                  <div class="bkf-legend">${legend}</div>
                </div>
              </div>
              <div>
                ${tip}
                <div class="bkf-cabin">
                  <div class="bkf-plane">
                    <div class="bkf-nose"><span></span></div>
                    <div class="bkf-cols">${cols}</div>
                    <div class="bkf-planerows">${rows}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="bkf-strip is-warn" style="margin-top:16px">
              ${P.svg('warn')}
              <span>Seats are held for this booking only and can be changed until check-in.</span>
            </div>
          </div>
        </section>
      </div>`;
    },
    mount(root, ctx) {
      const kinds = ctx.paxKinds || [];

      const pick = i => { ctx.activeSeatPax = Number(i); BookingFlow.repaint(); };
      root.querySelectorAll('[data-paxseat]').forEach(btn => {
        btn.addEventListener('click', () => pick(btn.dataset.paxseat));
      });
      const sel = root.querySelector('#bkfSeatPax');
      if (sel) sel.addEventListener('change', () => pick(sel.value));

      const clear = root.querySelector('#bkfClearSeat');
      if (clear) clear.addEventListener('click', () => {
        ctx.seats[ctx.activeSeatPax] = null;
        BookingFlow.repaint();
        BookingFlow.refreshPrice();
      });

      const tipX = root.querySelector('#bkfSeatTipX');
      if (tipX) tipX.addEventListener('click', () => {
        ctx.seatTipClosed = true;
        const tip = root.querySelector('#bkfSeatTip');
        if (tip) tip.remove();
      });

      root.querySelectorAll('[data-seat]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.seat;
          const seat = ctx.seatMap.rows.flatMap(r => r.seats).find(s => s.id === id);
          const active = ctx.activeSeatPax;
          const ownerIdx = ctx.seats.findIndex(s => s && s.id === id);

          if (ownerIdx === active) {
            ctx.seats[active] = null;             // tapping your own seat frees it
          } else if (ownerIdx > -1) {
            /* Held by someone else on this booking. Moving it silently would
               leave that traveller seatless without saying so. */
            showToast(`Seat ${id} is already assigned to Traveller ${ownerIdx + 1}.`, true);
            return;
          } else {
            /* An exit row is the one seat an infant's adult may not take. */
            if (seat.infant_allowed === false
                && String(kinds[active] || 'Adult').toLowerCase() === 'infant') {
              showToast(`Seat ${id} is an exit row and cannot be used by an infant.`, true);
              return;
            }
            ctx.seats[active] = seat;
            ctx.seatTipClosed = false;            // a new seat has something new to say
          }

          BookingFlow.repaint();
          BookingFlow.refreshPrice();
        });
      });
    },
    /* Deliberately no validate(): seats are optional everywhere in the world. */
  };

  function flight(item, search) {
    const pax = (search && search.pax) || { adults: 1, children: 0, infants: 0 };
    const paxCount = pax.adults + pax.children + pax.infants;
    const paxKinds = [
      ...Array(pax.adults).fill('Adult'),
      ...Array(pax.children).fill('Child'),
      ...Array(pax.infants).fill('Infant'),
    ];
    return {
      kind: 'flight',
      /* The traveller chose the flight on the results page, so the reference's
         first step is behind them before this flow ever opens. */
      priorSteps: ['Search'],
      /* Flights are the only product with a coupon backend, so the Fare
         Summary shows the coupon controls here and nowhere else. */
      supportsCoupons: true,
      kicker: `${item.origin.code} → ${item.destination.code}`,
      title: `${item.airline} ${item.flightNumber}`,
      backLabel: 'flight results',
      /* Kept as the offline fallback and the first paint. The server's answer
         below replaces it, and the two agree — customer_pricing_service.py is
         a port of P.flightPrice, verified against it. */
      price: P.flightPrice,
      /* WHAT THE FLIGHT ACTUALLY COSTS. The request names what was chosen —
         the flight, the cabin, the party, seat ids, add-on codes, a coupon —
         and carries no money at all, so the total cannot be dictated from
         here. The same endpoint prices the real booking, which is what stops
         the reviewed total and the charged total drifting apart. */
      async priceAsync(ctx) {
        if (typeof BookingApi === 'undefined' || !BookingApi.isLive('flight')) return null;
        const q = await BookingApi.quote(
          BookingApi.flightPayload(ctx),
          BookingApi.passengerTypes(ctx),
          BookingApi.seatPayload(ctx),
          BookingApi.addonPayload(ctx),
          ctx.couponCode || null,
        );
        /* Hold the server's own breakdown on the draft: the Review step and
           the confirmation both read it rather than re-deriving anything. */
        ctx.quote = q;
        ctx.couponError = q.coupon_error || null;
        return {
          lines: (q.lines || []).map(l => ({ label: l.label, amount: Number(l.amount) })),
          total: Number(q.total_amount),
          note: q.coupon_error || null,
        };
      },
      /* THE SAME FARE SUMMARY AND THE SAME ACTION BAR ON EVERY STEP, which is
         what the reference shows. Owned by the flow rather than repeated on
         four steps; booking-flow.js falls through to these whenever the step
         itself does not supply one. */
      sideHtml: (ctx, h, step) => P.fareHtml(ctx, h, step),
      footHtml: ctx => P.footHtml(ctx),
      steps: [
        Object.assign(
          P.travellersStep({ passport: true, frequentFlyer: true, noun: 'Traveller',
                             stepLabel: 'Traveller Details', reference: true }),
          { nextLabel: 'Continue to Seats', ctaNote: 'You can review your booking next' }),
        Object.assign({}, seatStep,
          { nextLabel: 'Continue to Add-ons', ctaNote: 'You can add baggage, meals & more' }),
        Object.assign(P.addonsStep('flight'),
          { nextLabel: 'Continue to Review', ctaNote: 'Review your booking details' }),
        /* The full journey, spelled out. The itinerary strip stays — it is the
           fastest way to read a flight — and every field the review needs is
           named beneath it rather than left to be inferred from it. */
        P.summaryStep(ctx => {
          const stops = ctx.item.stops
            ? `${ctx.item.stops} stop${ctx.item.stops > 1 ? 's' : ''}`
            : 'Non-stop';
          const cabin = (BookingData.CABIN_CLASSES.find(c => c.id === ctx.cabin) || {}).label || 'Economy';
          const facts = [
            ['Airline', ctx.item.airline],
            ['Flight number', ctx.item.flightNumber],
            ['Departure airport', `${ctx.item.origin.city} (${ctx.item.origin.code})`],
            ['Arrival airport', `${ctx.item.destination.city} (${ctx.item.destination.code})`],
            ['Departure date', fmtDate(ctx.item.date)],
            ['Departure time', ctx.item.departure || 'TBA'],
            ['Arrival time', ctx.item.arrival || 'TBA'],
            ['Flight duration', ctx.item.durationLabel || '—'],
            ['Stops', stops],
            ['Cabin class', cabin],
            ['Fare type', ctx.item.fareType],
          ];
          return `
          <div class="bk-itin">
            <div><span>${esc(ctx.item.departure)}</span><b>${esc(ctx.item.origin.city)} (${esc(ctx.item.origin.code)})</b></div>
            <div class="bk-itin-mid">${icon('flights')}<span>${esc(ctx.item.durationLabel || 'Non-stop')}</span></div>
            <div class="is-end"><span>${esc(ctx.item.arrival || 'TBA')}</span><b>${esc(ctx.item.destination.city)} (${esc(ctx.item.destination.code)})</b></div>
          </div>
          <dl class="bk-review-dl bk-journey">
            ${facts.filter(([, v]) => v !== undefined && v !== null && v !== '')
                   .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
          </dl>
          <div class="bk-meta">
            <span>Cabin ${esc(ctx.item.baggage.cabin)} · Check-in ${esc(ctx.item.baggage.checkIn)}</span>
          </div>`;
        }),
        P.paymentStep(),
        P.confirmationStep(),
      ],
      seed: {
        item, paxCount, paxKinds,
        cabin: (search && search.cabin) || 'economy',
        travelDate: item.date,
        summaryTitle: `${item.airline} ${item.flightNumber} · ${item.origin.code} → ${item.destination.code}`,
        summarySubtitle: fmtDate(item.date),
      },
    };
  }

  /* =====================================================================
     HOTELS
     ===================================================================== */
  const roomStep = {
    id: 'room',
    label: 'Room',
    async load(ctx) { ctx.roomOptions = await BookingData.rooms(ctx.item); },
    render(ctx) {
      const nights = P.nightsBetween(ctx.checkIn, ctx.checkOut);
      const cards = ctx.roomOptions.map(r => `
        <label class="bk-choice ${ctx.room && ctx.room.id === r.id ? 'is-on' : ''}">
          <input type="radio" name="bkRoom" value="${esc(r.id)}" ${ctx.room && ctx.room.id === r.id ? 'checked' : ''}>
          <span class="bk-choice-body">
            <b>${esc(r.name)}</b>
            <span class="bk-choice-meta">${esc(r.beds)} · ${esc(r.size)} · up to ${esc(r.maxGuests)} guests</span>
            <span class="bk-chips">${r.perks.map(p => `<i>${esc(p)}</i>`).join('')}</span>
            ${r.left <= 3 ? `<span class="bk-scarce">Only ${esc(r.left)} left</span>` : ''}
          </span>
          <span class="bk-choice-price"><b>${esc(money(r.price))}</b><span>per night</span></span>
        </label>`).join('');
      return `<div class="bk-step">
          <h2 class="bk-step-title">Choose a room</h2>
          <p class="bk-step-sub">${esc(fmtDate(ctx.checkIn))} → ${esc(fmtDate(ctx.checkOut))} ·
             ${nights} ${nights === 1 ? 'night' : 'nights'}</p>
          <div class="bk-choices">${cards}</div>
        </div>`;
    },
    mount(root, ctx) {
      root.querySelectorAll('input[name="bkRoom"]').forEach(r => r.addEventListener('change', () => {
        ctx.room = ctx.roomOptions.find(x => x.id === r.value);
        root.querySelectorAll('.bk-choice').forEach(l => l.classList.toggle('is-on', l.contains(r) && r.checked));
        BookingFlow.refreshPrice();
      }));
    },
    validate(ctx) { return ctx.room ? true : 'Choose a room to continue.'; },
  };

  const requestsStep = {
    id: 'requests',
    label: 'Requests',
    render(ctx) {
      const opts = ['Early check-in', 'Late checkout', 'High floor', 'Away from lift',
                    'Twin beds', 'Airport pickup', 'Non-smoking room', 'Adjoining rooms'];
      return `<div class="bk-step">
          <h2 class="bk-step-title">Any special requests?</h2>
          <p class="bk-step-sub">Requests are passed to the property and are not guaranteed.</p>
          <div class="bk-tickgrid">${opts.map(o => `
            <label class="bk-tick"><input type="checkbox" value="${esc(o)}"
              ${(ctx.requests || []).includes(o) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}
          </div>
          ${P.field({ id: 'bkNotes', label: 'Anything else', type: 'textarea', wide: true,
                      placeholder: 'Tell the property anything they should know…', value: ctx.notes || '' })}
        </div>`;
    },
    validate(ctx) {
      const root = document.getElementById('bkMain');
      ctx.requests = [...root.querySelectorAll('.bk-tick input:checked')].map(i => i.value);
      ctx.notes = P.val(root, 'bkNotes');
      return true;
    },
  };

  function hotel(item, search) {
    const guests = (search && search.guests) || 2;
    return {
      kind: 'hotel',
      /* Hotels have a real coupon backend now too (STAYMORE, seeded in 0053
         and already returned by /coupons?product_type=hotel) — same reason
         flights show this and nothing else used to. */
      supportsCoupons: true,
      kicker: esc(item.location),
      title: item.name,
      backLabel: 'hotel results',
      /* Kept as the offline fallback and the first paint, same relationship
         as flights: customer_hotel_pricing_service.py is a verified port of
         P.hotelPrice, and the server's answer below replaces it. */
      price: P.hotelPrice,
      async priceAsync(ctx) {
        if (typeof BookingApi === 'undefined' || !BookingApi.isLive('hotel') || !ctx.room) return null;
        const q = await BookingApi.quoteHotel(
          BookingApi.hotelPayload(ctx),
          BookingApi.hotelAddonPayload(ctx),
          ctx.couponCode || null,
        );
        ctx.quote = q;
        ctx.couponError = q.coupon_error || null;
        return {
          lines: (q.lines || []).map(l => ({ label: l.label, amount: Number(l.amount) })),
          total: Number(q.total_amount),
          note: q.coupon_error || null,
        };
      },
      steps: [
        roomStep,
        P.travellersStep({ passport: false, frequentFlyer: false, noun: 'Guest' }),
        requestsStep,
        P.addonsStep('hotel'),
        P.summaryStep(ctx => `
          <h3>Stay</h3>
          <div class="bk-meta">
            <span><b>${esc(ctx.item.name)}</b></span>
            <span>${esc(ctx.item.location)}</span>
            <span>${esc(fmtDate(ctx.checkIn))} → ${esc(fmtDate(ctx.checkOut))}</span>
            <span>${esc(ctx.room ? ctx.room.name : '')}</span>
            <span>${esc(ctx.roomCount || 1)} room(s) · ${esc(ctx.paxCount)} guest(s)</span>
          </div>
          ${(ctx.requests || []).length ? `<p class="bk-req">Requests: ${esc(ctx.requests.join(', '))}</p>` : ''}`),
        P.paymentStep(),
        P.confirmationStep(),
      ],
      seed: (() => {
        const today = new Date();
        const inD = new Date(today); inD.setDate(inD.getDate() + 7);
        const outD = new Date(inD); outD.setDate(outD.getDate() + 2);
        return {
          item,
          paxCount: guests,
          roomCount: (search && search.rooms) || 1,
          checkIn: (search && search.checkIn) || inD.toISOString().slice(0, 10),
          checkOut: (search && search.checkOut) || outD.toISOString().slice(0, 10),
          travelDate: (search && search.checkIn) || inD.toISOString().slice(0, 10),
          summaryTitle: item.name,
          summarySubtitle: item.location,
        };
      })(),
    };
  }

  /* =====================================================================
     CRUISES
     ===================================================================== */
  const cabinStep = {
    id: 'cabin',
    label: 'Cabin',
    async load(ctx) { ctx.cabinOptions = await BookingData.cabins(ctx.item); },
    render(ctx) {
      const cards = ctx.cabinOptions.map(c => `
        <label class="bk-choice ${ctx.cabin_ && ctx.cabin_.id === c.id ? 'is-on' : ''}">
          <input type="radio" name="bkCabin" value="${esc(c.id)}" ${ctx.cabin_ && ctx.cabin_.id === c.id ? 'checked' : ''}>
          <span class="bk-choice-body">
            <b>${esc(c.name)}</b>
            <span class="bk-choice-meta">${esc(c.size)} · sleeps ${esc(c.occupancy)}</span>
            <span class="bk-chips">${c.perks.map(p => `<i>${esc(p)}</i>`).join('')}</span>
            ${c.left <= 3 ? `<span class="bk-scarce">Only ${esc(c.left)} left</span>` : ''}
          </span>
          <span class="bk-choice-price"><b>${esc(money(c.price))}</b><span>per person</span></span>
        </label>`).join('');
      return `<div class="bk-step">
          <h2 class="bk-step-title">Choose a cabin</h2>
          <p class="bk-step-sub">${esc(ctx.item.route)} · ${esc(ctx.item.nights)} nights</p>
          <div class="bk-choices">${cards}</div>
        </div>`;
    },
    mount(root, ctx) {
      root.querySelectorAll('input[name="bkCabin"]').forEach(r => r.addEventListener('change', () => {
        ctx.cabin_ = ctx.cabinOptions.find(x => x.id === r.value);
        root.querySelectorAll('.bk-choice').forEach(l => l.classList.toggle('is-on', l.contains(r) && r.checked));
        BookingFlow.refreshPrice();
      }));
    },
    validate(ctx) { return ctx.cabin_ ? true : 'Choose a cabin to continue.'; },
  };

  function cruise(item) {
    return {
      kind: 'cruise',
      kicker: esc(item.route),
      title: item.name,
      backLabel: 'cruise results',
      price: P.cruisePrice,
      steps: [
        cabinStep,
        P.travellersStep({ passport: true, frequentFlyer: false, noun: 'Passenger' }),
        P.addonsStep('cruise'),
        P.summaryStep(ctx => `
          <h3>Sailing</h3>
          <div class="bk-meta">
            <span><b>${esc(ctx.item.name)}</b></span>
            <span>${esc(ctx.item.route)}</span>
            <span>${esc(ctx.item.nights)} nights</span>
            <span>${esc(ctx.cabin_ ? ctx.cabin_.name : '')}</span>
          </div>`),
        P.paymentStep(),
        P.confirmationStep(),
      ],
      seed: (() => {
        const d = new Date(); d.setDate(d.getDate() + 45);
        return { item, paxCount: 2, travelDate: d.toISOString().slice(0, 10),
                 summaryTitle: item.name, summarySubtitle: item.route };
      })(),
    };
  }

  /* =====================================================================
     TOUR PACKAGES
     ===================================================================== */
  const departureStep = {
    id: 'departure',
    label: 'Departure',
    async load(ctx) { ctx.departures = await BookingData.departures(ctx.item); },
    render(ctx) {
      const cards = ctx.departures.map(d => `
        <label class="bk-choice ${ctx.departure && ctx.departure.date === d.date ? 'is-on' : ''}">
          <input type="radio" name="bkDep" value="${esc(d.date)}" ${ctx.departure && ctx.departure.date === d.date ? 'checked' : ''}>
          <span class="bk-choice-body">
            <b>${esc(fmtDate(d.date))}</b>
            <span class="bk-choice-meta">${esc(ctx.item.days)} days · ${esc(ctx.item.name)}</span>
            ${d.seatsLeft <= 5 ? `<span class="bk-scarce">Only ${esc(d.seatsLeft)} places left</span>` : ''}
          </span>
          <span class="bk-choice-price"><b>${esc(money(d.price))}</b><span>per person</span></span>
        </label>`).join('');
      return `<div class="bk-step">
          <h2 class="bk-step-title">When would you like to travel?</h2>
          <p class="bk-step-sub">Group departures leave on Saturdays.</p>
          <div class="bk-choices">${cards}</div>
          <div class="bk-inline">
            ${P.field({ id: 'bkPax', label: 'Travellers', type: 'select', required: true,
                        options: ['1','2','3','4','5','6'], value: String(ctx.paxCount || 2) })}
          </div>
        </div>`;
    },
    mount(root, ctx) {
      root.querySelectorAll('input[name="bkDep"]').forEach(r => r.addEventListener('change', () => {
        ctx.departure = ctx.departures.find(x => x.date === r.value);
        ctx.travelDate = ctx.departure.date;
        root.querySelectorAll('.bk-choice').forEach(l => l.classList.toggle('is-on', l.contains(r) && r.checked));
        BookingFlow.refreshPrice();
      }));
      root.querySelector('#bkPax').addEventListener('change', e => {
        ctx.paxCount = Number(e.target.value) || 1;
        BookingFlow.refreshPrice();
      });
    },
    validate(ctx) { return ctx.departure ? true : 'Choose a departure date to continue.'; },
  };

  function pkg(item) {
    return {
      kind: 'package',
      /* Packages have a real coupon backend now too (FAMILYFUN/TOGETHER25,
         seeded in 0053 and already returned by /coupons?product_type=package). */
      supportsCoupons: true,
      kicker: `${item.days} days`,
      title: item.name,
      backLabel: 'tour packages',
      /* Kept as the offline fallback and the first paint, same relationship
         as flights and hotels: customer_package_pricing_service.py is a
         verified port of P.packagePrice. */
      price: P.packagePrice,
      async priceAsync(ctx) {
        if (typeof BookingApi === 'undefined' || !BookingApi.isLive('package') || !ctx.departure) return null;
        const q = await BookingApi.quotePackage(
          BookingApi.packagePayload(ctx),
          BookingApi.packageAddonPayload(ctx),
          ctx.couponCode || null,
        );
        ctx.quote = q;
        ctx.couponError = q.coupon_error || null;
        return {
          lines: (q.lines || []).map(l => ({ label: l.label, amount: Number(l.amount) })),
          total: Number(q.total_amount),
          note: q.coupon_error || null,
        };
      },
      steps: [
        departureStep,
        P.travellersStep({ passport: true, frequentFlyer: false, noun: 'Traveller' }),
        P.addonsStep('package'),
        P.summaryStep(ctx => `
          <h3>Package</h3>
          <div class="bk-meta">
            <span><b>${esc(ctx.item.name)}</b></span>
            <span>${esc(ctx.item.days)} days</span>
            <span>Departs ${esc(fmtDate(ctx.travelDate))}</span>
            <span>${esc(ctx.paxCount)} traveller(s)</span>
          </div>
          <p class="bk-req">${esc(ctx.item.blurb)}</p>`),
        P.paymentStep(),
        P.confirmationStep(),
      ],
      seed: { item, paxCount: 2, summaryTitle: item.name, summarySubtitle: `${item.days} days` },
    };
  }

  /* =====================================================================
     VISA
     ===================================================================== */
  const visaTypeStep = {
    id: 'visatype',
    label: 'Visa',
    async load(ctx) {
      ctx.visaCountryList = await BookingData.visaCountries();
      if (ctx.country) ctx.visaReq = await BookingData.visaRequirements(ctx.country);
    },
    render(ctx) {
      const types = (ctx.visaReq && ctx.visaReq.types) || [];
      return `<div class="bk-step">
          <h2 class="bk-step-title">Where are you travelling?</h2>
          <div class="bk-inline">
            ${P.field({ id: 'bkCountry', label: 'Destination country', type: 'select', required: true,
                        options: ctx.visaCountryList, value: ctx.country || '' })}
            ${P.field({ id: 'bkApplicants', label: 'Applicants', type: 'select', required: true,
                        options: ['1','2','3','4','5'], value: String(ctx.paxCount || 1) })}
          </div>
          <div id="bkVisaTypes">${types.length ? `
            <h3 class="bk-sub-h">Visa type</h3>
            <div class="bk-choices">${types.map(t => `
              <label class="bk-choice ${ctx.visaType && ctx.visaType.id === t.id ? 'is-on' : ''}">
                <input type="radio" name="bkVisaType" value="${esc(t.id)}" ${ctx.visaType && ctx.visaType.id === t.id ? 'checked' : ''}>
                <span class="bk-choice-body"><b>${esc(t.name)}</b>
                  <span class="bk-choice-meta">Processing ${esc(t.processing)}</span></span>
                <span class="bk-choice-price"><b>${esc(money(t.fee))}</b><span>per applicant</span></span>
              </label>`).join('')}</div>`
            : '<p class="bk-step-sub">Choose a country to see the visa types we handle.</p>'}
          </div>
        </div>`;
    },
    mount(root, ctx) {
      root.querySelector('#bkCountry').addEventListener('change', async e => {
        ctx.country = e.target.value;
        ctx.visaType = null;
        ctx.visaReq = ctx.country ? await BookingData.visaRequirements(ctx.country) : null;
        /* Re-render just this step so the type list follows the country. */
        root.innerHTML = visaTypeStep.render(ctx);
        visaTypeStep.mount(root, ctx);
        BookingFlow.refreshPrice();
      });
      root.querySelector('#bkApplicants').addEventListener('change', e => {
        ctx.paxCount = Number(e.target.value) || 1;
        BookingFlow.refreshPrice();
      });
      root.querySelectorAll('input[name="bkVisaType"]').forEach(r => r.addEventListener('change', () => {
        ctx.visaType = ctx.visaReq.types.find(t => t.id === r.value);
        ctx.summaryTitle = `${ctx.visaType.name} — ${ctx.country}`;
        root.querySelectorAll('.bk-choice').forEach(l => l.classList.toggle('is-on', l.contains(r) && r.checked));
        BookingFlow.refreshPrice();
      }));
    },
    validate(ctx) {
      if (!ctx.country) return 'Choose a destination country.';
      if (!ctx.visaType) return 'Choose a visa type.';
      return true;
    },
  };

  const documentsStep = {
    id: 'docs',
    label: 'Documents',
    render(ctx) {
      const docs = (ctx.visaReq.documents || []).map((d, i) => `
        <label class="bk-tick"><input type="checkbox" data-doc="${i}"><span>${esc(d)}</span></label>`).join('');
      return `<div class="bk-step">
          <h2 class="bk-step-title">What you will need</h2>
          <p class="bk-step-sub">Confirm you can supply each of these for every applicant.
             Nothing is uploaded in this demo.</p>
          <div class="bk-tickgrid is-stack">${docs}</div>
        </div>`;
    },
    validate(ctx) {
      const root = document.getElementById('bkMain');
      const boxes = [...root.querySelectorAll('[data-doc]')];
      if (boxes.some(b => !b.checked)) return 'Confirm every document before continuing.';
      ctx.documentsConfirmed = boxes.length;
      return true;
    },
  };

  function visa() {
    return {
      kind: 'visa',
      kicker: 'Visa services',
      title: 'Apply for a visa',
      backLabel: 'visa services',
      price: P.visaPrice,
      steps: [
        visaTypeStep,
        documentsStep,
        P.travellersStep({ passport: true, frequentFlyer: false, noun: 'Applicant' }),
        P.summaryStep(ctx => `
          <h3>Application</h3>
          <div class="bk-meta">
            <span><b>${esc(ctx.country)}</b></span>
            <span>${esc(ctx.visaType.name)}</span>
            <span>Processing ${esc(ctx.visaType.processing)}</span>
            <span>${esc(ctx.paxCount)} applicant(s)</span>
          </div>`),
        Object.assign({}, P.paymentStep(), { nextLabel: 'Pay & submit' }),
        P.confirmationStep(),
      ],
      seed: { paxCount: 1, summaryTitle: 'Visa application', summarySubtitle: '' },
    };
  }

  /* =====================================================================
     Launcher — one entry point every product page uses.
     ===================================================================== */
  const BUILDERS = { flight, hotel, cruise, package: pkg, visa };

  function open(kind, item, search) {
    const build = BUILDERS[kind];
    if (!build) { console.warn('[booking] unknown product', kind); return; }
    const def = build(item, search);
    BookingFlow.start(def, def.seed);
  }

  return { open, flight, hotel, cruise, package: pkg, visa };
})();
