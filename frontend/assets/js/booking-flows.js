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

  /** The aircraft. Occupied seats come from BookingData and are stable. */
  const seatStep = {
    id: 'seats',
    label: 'Seats',
    async load(ctx) { ctx.seatMap = await BookingData.seatMap(ctx.item); },
    render(ctx) {
      const pax = Math.max(1, ctx.paxCount || 1);
      const chosen = new Set(ctx.seats.filter(Boolean).map(s => s.id));
      const rows = ctx.seatMap.rows.map(r => `
        <div class="bk-seatrow ${r.exit ? 'is-exit' : ''}">
          <span class="bk-seatno">${r.row}</span>
          ${r.seats.map((s, i) => `${i === 3 ? '<span class="bk-aisle"></span>' : ''}
            <button type="button" class="bk-seat is-${s.type} ${s.occupied ? 'is-taken' : ''} ${chosen.has(s.id) ? 'is-mine' : ''}"
              data-seat="${esc(s.id)}" ${s.occupied ? 'disabled aria-label="Occupied"' : `aria-label="Seat ${esc(s.id)}, ${esc(s.type)}, ${esc(money(s.price))}"`}>
              ${esc(s.letter)}</button>`).join('')}
          ${r.exit ? '<span class="bk-exit-tag">Exit</span>' : ''}
        </div>`).join('');

      return `<div class="bk-step">
          <h2 class="bk-step-title">Choose your seats</h2>
          <p class="bk-step-sub">${esc(ctx.seatMap.aircraft)} · ${esc(ctx.seatMap.layout)} ·
             pick ${pax} ${pax === 1 ? 'seat' : 'seats'}. Skipping this assigns seats at check-in.</p>

          <div class="bk-seat-legend">
            <span><i class="bk-seat is-window"></i> Window</span>
            <span><i class="bk-seat is-middle"></i> Middle</span>
            <span><i class="bk-seat is-aisle"></i> Aisle</span>
            <span><i class="bk-seat is-taken"></i> Occupied</span>
            <span><i class="bk-seat is-mine"></i> Yours</span>
          </div>

          <div class="bk-cabin">
            <div class="bk-nose">Front of aircraft</div>
            ${rows}
          </div>
          <p class="bk-seat-count" id="bkSeatCount"></p>
        </div>`;
    },
    mount(root, ctx) {
      const pax = Math.max(1, ctx.paxCount || 1);
      const count = root.querySelector('#bkSeatCount');
      const paint = () => {
        const n = ctx.seats.filter(Boolean).length;
        count.textContent = n
          ? `${n} of ${pax} selected — ${ctx.seats.filter(Boolean).map(s => s.id).join(', ')}`
          : 'No seats selected yet.';
      };
      paint();

      root.querySelectorAll('[data-seat]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.seat;
          const seat = ctx.seatMap.rows.flatMap(r => r.seats).find(s => s.id === id);
          const already = ctx.seats.findIndex(s => s && s.id === id);
          if (already > -1) {
            ctx.seats.splice(already, 1);
            btn.classList.remove('is-mine');
          } else {
            /* Silently swapping a seat when the limit is reached is worse than
               saying so — the traveller loses a choice they made on purpose. */
            if (ctx.seats.filter(Boolean).length >= pax) {
              showToast(`You have already chosen ${pax} ${pax === 1 ? 'seat' : 'seats'}. Deselect one first.`, true);
              return;
            }
            ctx.seats.push(seat);
            btn.classList.add('is-mine');
          }
          paint();
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
      kicker: `${item.origin.code} → ${item.destination.code}`,
      title: `${item.airline} ${item.flightNumber}`,
      price: P.flightPrice,
      steps: [
        P.travellersStep({ passport: true, frequentFlyer: true, noun: 'Traveller' }),
        seatStep,
        P.addonsStep('flight'),
        P.summaryStep(ctx => `
          <h3>Flight</h3>
          <div class="bk-itin">
            <div><span>${esc(ctx.item.departure)}</span><b>${esc(ctx.item.origin.city)} (${esc(ctx.item.origin.code)})</b></div>
            <div class="bk-itin-mid">${icon('flights')}<span>${esc(ctx.item.durationLabel || 'Non-stop')}</span></div>
            <div class="is-end"><span>${esc(ctx.item.arrival || 'TBA')}</span><b>${esc(ctx.item.destination.city)} (${esc(ctx.item.destination.code)})</b></div>
          </div>
          <div class="bk-meta">
            <span>${esc(ctx.item.airline)} ${esc(ctx.item.flightNumber)}</span>
            <span>${esc(fmtDate(ctx.item.date))}</span>
            <span>${esc((BookingData.CABIN_CLASSES.find(c => c.id === ctx.cabin) || {}).label || 'Economy')}</span>
            <span>${esc(ctx.item.fareType)}</span>
            <span>Cabin ${esc(ctx.item.baggage.cabin)} · Check-in ${esc(ctx.item.baggage.checkIn)}</span>
          </div>`),
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
      kicker: esc(item.location),
      title: item.name,
      price: P.hotelPrice,
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
      kicker: `${item.days} days`,
      title: item.name,
      price: P.packagePrice,
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
