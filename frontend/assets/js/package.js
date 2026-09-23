'use strict';
/* ===========================================================================
   package.js — one tour package: what it is, day by day, and what it costs.
   ===========================================================================
   THE FOURTH STEP of Tour Packages -> a shelf -> the list -> this -> the
   booking flow. Until now a package had no page at all: "Explore Package"
   opened the booking card straight from a tile, so everything a traveller
   wants before deciding — where they sleep, what happens on day three, what
   is not included — had nowhere to be.

   ONE REQUEST DECIDES THE WHOLE PAGE:

       GET /api/customer/packages/{id}

   name, destination, nights, price, the next departure, inclusions,
   exclusions, the day-by-day, the hotels and the policy all come from that
   one answer. Nothing about a particular trip is written here.

   BOOK NOW OPENS THE FLOW THAT ALREADY EXISTS. BookingFlows.open('package',
   item) is the same departure -> travellers -> add-ons -> payment ->
   confirmation card packages.html has always opened, backed by the same
   quote, booking and payment endpoints. This page is the step in front of
   it, not a second implementation of it.

   WHAT IT WILL NOT DRAW:

     an itinerary    customer_package_itinerary ships EMPTY (0083). A
                     day-by-day is a promise about what a traveller will be
                     given; the section is absent until somebody writes one,
                     and is never filled with "Day 1: Arrival".
     a hotel list    Same: customer_package_hotels is empty, and a plausible
                     hotel name is a lie about where somebody will sleep.
     a rating        Served only with its source. Nothing has rated these
                     packages, so no stars appear.
     reviews         There are none. The section stays out of the document
                     rather than saying "no reviews yet" under a heading.
   =========================================================================== */
(function () {
  const statusEl = document.getElementById('pkStatus');
  const body = document.getElementById('pkBody');
  if (!statusEl || !body) return;

  /* /package-details/7 -> '7' (and /package/7, which app.main.py still
     serves for anything linked before the URL was renamed). */
  const id = decodeURIComponent(
    location.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''
  ).trim();

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const icon = (name, size) => (typeof JPIcon !== 'undefined' && JPIcon.html)
    ? JPIcon.html(name, { size: size || 16 }) : '';

  const show = (el, on) => { if (el) el.hidden = !on; };

  /* One resolver per manifest, all on the same contract: a KEY the API sent,
     present in the artwork that shipped with this build, or no picture. A
     path is never built from a name. */
  const fromManifest = (key, files, dir, fallbackDir) => {
    if (!key || typeof files !== 'object' || !files || !files[key]) return null;
    const d = (typeof dir === 'string') ? dir : fallbackDir;
    return { src: d + key + '.webp', small: d + key + '-480.webp' };
  };
  /* A package's key is a city ("goa") OR one place in it ("goa__fort-aguada"),
     so both manifests are tried in that order - which is what lets four Goa
     packages carry four different photographs. */
  const destArt = key => fromManifest(
    key, typeof DESTINATION_IMAGE_FILES !== 'undefined' ? DESTINATION_IMAGE_FILES : null,
    typeof DESTINATION_IMAGE_DIR !== 'undefined' ? DESTINATION_IMAGE_DIR : null, 'assets/destinations/')
    || fromManifest(
      key, typeof LOCATION_IMAGE_FILES !== 'undefined' ? LOCATION_IMAGE_FILES : null,
      typeof LOCATION_IMAGE_DIR !== 'undefined' ? LOCATION_IMAGE_DIR : null, 'assets/locations/');
  const placeArt = key => fromManifest(
    key, typeof LOCATION_IMAGE_FILES !== 'undefined' ? LOCATION_IMAGE_FILES : null,
    typeof LOCATION_IMAGE_DIR !== 'undefined' ? LOCATION_IMAGE_DIR : null, 'assets/locations/');
  const hotelArt = key => fromManifest(
    key, typeof HOTEL_IMAGE_FILES !== 'undefined' ? HOTEL_IMAGE_FILES : null,
    typeof HOTEL_IMAGE_DIR !== 'undefined' ? HOTEL_IMAGE_DIR : null, 'assets/hotels/');

  const money = n => {
    if (n == null) return null;
    if (typeof formatMoney === 'function') return formatMoney(n);
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: 0,
      }).format(n);
    } catch { return '₹' + Math.round(n); }
  };

  const longDate = iso => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const TRIP_LABEL = {
    domestic: 'Domestic package',
    pilgrimage: 'Pilgrimage package',
    international: 'International package',
  };

  const paras = text => String(text || '')
    .split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  /* ======================================================================
     THE HERO
     ====================================================================== */
  function renderHero(p) {
    document.getElementById('pkTitle').textContent = p.name;
    document.title = p.name + ' tour package — JackPots World Tours & Travels';

    const shelf = p.trip_type ? `packages.html?trip=${encodeURIComponent(p.trip_type)}` : 'packages.html';
    const crumbs = document.getElementById('pkCrumbs');
    crumbs.innerHTML = [
      '<a href="index.html">Home</a>',
      '<a href="packages.html">Tour packages</a>',
      p.trip_type ? `<a href="${esc(shelf)}">${esc(TRIP_LABEL[p.trip_type] || p.trip_type)}</a>` : '',
      `<span aria-current="page">${esc(p.name)}</span>`,
    ].filter(Boolean).join('<span class="lp-crumb-sep" aria-hidden="true">/</span>');
    show(crumbs, true);

    if (p.destination) {
      const badge = document.getElementById('pkBadge');
      badge.innerHTML = icon('mapPin', 15) + `<span>${esc(p.destination)}</span>`;
      show(badge, true);
    }
    if (p.blurb) {
      const lead = document.getElementById('pkLead');
      lead.textContent = p.blurb;
      show(lead, true);
    }

    const art = destArt(p.image);
    if (art) {
      const img = document.createElement('img');
      img.className = 'lp-hero-img';
      img.src = art.src;
      img.srcset = art.small + ' 480w, ' + art.src + ' 960w';
      img.sizes = '100vw';
      img.alt = '';
      img.decoding = 'async';
      img.fetchPriority = 'high';
      img.addEventListener('error', () => img.remove());
      document.getElementById('pkHero').insertBefore(img, document.getElementById('pkHero').firstChild);
    }

    /* The strip: how long, what standard of hotel, what anybody has scored it,
       and when it next leaves. Each chip appears only if the answer exists. */
    let any = false;
    if (p.days) {
      const el = document.getElementById('pkDuration');
      /* NIGHTS COME FROM THE COLUMN, not from days - 1 computed here: 0083
         seeded it that way for every row but it is editable, because a trip
         can have a night count that is not that. */
      const nights = (p.nights != null) ? p.nights : null;
      el.innerHTML = icon('calendarDays', 14)
        + `<span>${esc(p.days)} Days${nights != null ? ' / ' + esc(nights) + ' Nights' : ''}</span>`;
      show(el, true); any = true;
    }
    if (p.hotel_category) {
      const el = document.getElementById('pkHotelStd');
      el.innerHTML = icon('bedDouble', 14) + `<span>${esc(p.hotel_category)}-star hotels</span>`;
      show(el, true); any = true;
    }
    if (p.rating != null && p.rating_source) {
      const el = document.getElementById('pkRating');
      const count = p.rating_count
        ? ` <span class="lp-rating-count">(${p.rating_count.toLocaleString('en-IN')})</span>` : '';
      el.innerHTML = icon('star', 14)
        + `<span><strong>${esc(Number(p.rating).toFixed(1))}</strong>${count}</span>`
        + `<span class="lp-rating-src">${esc(p.rating_source)}</span>`;
      show(el, true); any = true;
    }
    if (p.next_departure) {
      const el = document.getElementById('pkNextDate');
      el.innerHTML = icon('planeTakeoff', 14) + `<span>Next departure ${esc(longDate(p.next_departure))}</span>`;
      show(el, true); any = true;
    }
    show(document.getElementById('pkHeroMeta'), any);

    /* THE PRICE IS THE NEXT DEPARTURE'S WHERE THERE IS ONE. `priceFrom` is
       the shelf price; the date somebody would actually book may cost more,
       and a page that shows the lower of the two and charges the higher at
       the payment step is the oldest trick on a travel site. */
    const price = (p.price_next != null) ? p.price_next : p.priceFrom;
    document.getElementById('pkPrice').textContent = money(price) || '';
    show(document.getElementById('pkHeroCta'), price != null);

    /* NO DATES MEANS NO "BOOK NOW". The booking card opens by choosing a
       departure, so a Book now on a package with none walks somebody into an
       empty list and a dead end. A trip we have not scheduled is a trip we
       arrange on request, and the button says that and goes somewhere that
       can actually help. */
    if (!(p.departures || []).some(d => d.date >= new Date().toISOString().slice(0, 10))) {
      const btn = document.getElementById('pkBookTop');
      btn.outerHTML = `<a class="disc-btn pk-book" id="pkBookTop"
          href="contact-us.html?package=${encodeURIComponent(p.name)}">
          Enquire about dates ${icon('arrowRight', 15)}</a>`;
      const note = document.createElement('p');
      note.className = 'pk-dates-note';
      note.textContent = 'This trip has no scheduled departures at the moment — tell us when you '
        + 'want to travel and we will price those dates.';
      document.getElementById('pkHeroCta').insertAdjacentElement('afterend', note);
    }
  }

  /* ======================================================================
     OVERVIEW, and the facts beside it
     ====================================================================== */
  function renderOverview(p) {
    const text = p.description || p.blurb;
    const facts = [];
    if (p.destination) facts.push(['Destination', p.destination]);
    if (p.days) {
      facts.push(['Duration', `${p.days} Days${p.nights != null ? ` / ${p.nights} Nights` : ''}`]);
    }
    if (p.trip_type) facts.push(['Package type', TRIP_LABEL[p.trip_type] || p.trip_type]);
    if (p.hotel_category) facts.push(['Hotel standard', `${p.hotel_category}-star`]);
    if (p.departures && p.departures.length) {
      facts.push(['Departures listed', String(p.departures.length)]);
    }
    if (!text && !facts.length) return;

    const box = document.getElementById('pkOverview');
    box.innerHTML = text ? paras(text) : '';
    if (text) {
      box.classList.add('is-clamped');
      const btn = document.getElementById('pkReadMore');
      requestAnimationFrame(() => {
        if (box.scrollHeight - box.clientHeight < 24) { box.classList.remove('is-clamped'); return; }
        show(btn, true);
        btn.addEventListener('click', () => {
          const clamped = box.classList.toggle('is-clamped');
          btn.textContent = clamped ? 'Read more' : 'Read less';
          btn.setAttribute('aria-expanded', String(!clamped));
        });
      });
    }
    if (facts.length) {
      document.getElementById('pkFactsList').innerHTML = facts
        .map(f => `<div><dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd></div>`).join('');
      show(document.getElementById('pkFacts'), true);
    }
    show(document.getElementById('pkOverviewSec'), true);
  }

  /* ======================================================================
     THE DAY-BY-DAY
     ====================================================================== */
  function renderItinerary(p) {
    const days = p.itinerary || [];
    if (!days.length) return;          /* no section rather than "Day 1: TBC" */
    document.getElementById('pkItineraryLine').textContent =
      `${days.length} day${days.length === 1 ? '' : 's'} planned out, in order.`;
    document.getElementById('pkItinerary').innerHTML = days.map(d => {
      const art = placeArt(d.image) || destArt(d.image);
      const meals = (d.meals || []).length
        ? `<p class="pk-day-meals">${icon('utensils', 13)}<span>${d.meals.map(esc).join(', ')}</span></p>` : '';
      const where = d.location ? `<span class="pk-day-where">${icon('mapPin', 13)}${esc(d.location)}</span>` : '';
      return `<li class="pk-day">
        <div class="pk-day-mark"><span>Day</span><strong>${esc(d.day_number)}</strong></div>
        <div class="lp-card pk-day-card">
          <div class="pk-day-head">
            <h3>${esc(d.title)}</h3>
            ${where}
          </div>
          ${d.description ? `<div class="pk-day-text">${paras(d.description)}</div>` : ''}
          ${meals}
        </div>
        ${art ? `<figure class="pk-day-art"><img src="${esc(art.small)}" alt="" loading="lazy"
                 decoding="async" onerror="this.closest('figure').remove()"></figure>` : ''}
      </li>`;
    }).join('');
    show(document.getElementById('pkItinerarySec'), true);
  }

  /* ======================================================================
     WHERE YOU SLEEP
     ====================================================================== */
  function renderHotels(p) {
    const rows = p.hotels || [];
    if (!rows.length) return;
    const nights = rows.reduce((n, h) => n + (h.nights || 0), 0);
    document.getElementById('pkHotelsLine').textContent = nights
      ? `${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}, ${nights} night${nights === 1 ? '' : 's'} in total.`
      : `${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} on this itinerary.`;

    document.getElementById('pkHotels').innerHTML = rows.map(h => {
      const art = hotelArt(h.image);
      /* THE STARS ARE THE OPERATOR'S CLAIM ABOUT THE PROPERTY and are shown
         only where the row states one. A missing star rating is not four. */
      const stars = h.star_rating
        ? `<span class="pk-hotel-stars">${icon('star', 13)}${esc(h.star_rating)}-star</span>` : '';
      const bits = [h.city, h.room_type, h.nights ? `${h.nights} night${h.nights === 1 ? '' : 's'}` : null]
        .filter(Boolean).map(esc).join(' · ');
      return `<article class="lp-hotel pk-hotel" role="listitem">
        <div class="lp-hotel-art">${art
          ? `<img src="${esc(art.small)}" srcset="${esc(art.small)} 480w, ${esc(art.src)} 960w"
                 sizes="(max-width: 640px) 100vw, 280px" alt="${esc(h.hotel_name)}"
                 loading="lazy" decoding="async" onerror="this.remove()">`
          : `<span class="lp-hero-pin">${icon('bedDouble', 22)}</span>`}</div>
        <div class="lp-hotel-body">
          <h3 class="lp-hotel-name">${esc(h.hotel_name)}</h3>
          ${stars}
          ${bits ? `<p class="lp-hotel-where">${bits}</p>` : ''}
        </div>
      </article>`;
    }).join('');
    show(document.getElementById('pkHotelsSec'), true);
  }

  /* ======================================================================
     INCLUSIONS AND EXCLUSIONS
     ====================================================================== */
  function renderIncludes(p) {
    const incl = p.inclusions || [];
    const excl = p.exclusions || [];
    if (!incl.length && !excl.length) return;
    if (incl.length) {
      document.getElementById('pkInclusions').innerHTML =
        incl.map(i => `<li>${icon('circleCheck', 15)}<span>${esc(i)}</span></li>`).join('');
      show(document.getElementById('pkInclCard'), true);
    }
    if (excl.length) {
      document.getElementById('pkExclusions').innerHTML =
        excl.map(i => `<li>${icon('circleMinus', 15)}<span>${esc(i)}</span></li>`).join('');
      show(document.getElementById('pkExclCard'), true);
    }
    show(document.getElementById('pkIncludesSec'), true);
  }

  /* ======================================================================
     DEPARTURES — real dates, real seats, and they open the booking card
     ====================================================================== */
  function renderDates(p) {
    const rows = (p.departures || []).filter(d => d.seats_left == null || d.seats_left >= 0);
    if (!rows.length) return;
    document.getElementById('pkDatesLine').textContent =
      'Group departures currently on sale. Seats shown are what is left.';
    document.getElementById('pkDates').innerHTML = rows.map(d => `
      <button type="button" class="pk-date" role="listitem" data-departure="${esc(d.id)}">
        <span class="pk-date-when">${esc(longDate(d.date))}</span>
        <span class="pk-date-price">${esc(money(d.price))}<small>per person</small></span>
        <span class="pk-date-seats${d.seats_left <= 4 ? ' is-low' : ''}">${esc(d.seats_left)} seats left</span>
      </button>`).join('');
    show(document.getElementById('pkDatesSec'), true);
  }

  /* ======================================================================
     MORE OF THE SAME DESTINATION
     ======================================================================
     THE SAME QUERY THE LISTING RUNS, narrowed to this destination and with
     this package taken out - so the row cannot show a trip the listing would
     not, and cannot disagree with it about a price. Silent on failure and
     hidden when there is nothing else: one Goa package means no "Top Goa tour
     packages" heading over an empty row. */
  async function renderMore(p) {
    if (!p.destination) return;
    let rows;
    try {
      rows = await getJson('/api/customer/packages?category=holiday&destination='
        + encodeURIComponent(p.destination));
    } catch { return; }

    const others = (rows || []).filter(r => String(r.id) !== String(p.id));
    if (!others.length) return;

    document.getElementById('pkMoreH').textContent = `Top ${p.destination} tour packages`;
    document.getElementById('pkMoreLine').textContent =
      `${others.length} more trip${others.length === 1 ? '' : 's'} to ${p.destination}, from the same catalogue.`;
    document.getElementById('pkMoreAll').href =
      'packages.html?destination=' + encodeURIComponent(p.destination);

    document.getElementById('pkMore').innerHTML = others.map(o => {
      const art = destArt(o.image);
      const price = (o.price_next != null) ? o.price_next : o.priceFrom;
      const ticks = (o.highlights && o.highlights.length ? o.highlights : (o.inclusions || [])).slice(0, 3);
      /* Stars only with a source, the same rule the rest of the site follows -
         so these cards carry none today. */
      const rating = (o.rating != null && o.rating_source)
        ? `<span class="pkl-card-rate">${icon('star', 13)}<b>${esc(Number(o.rating).toFixed(1))}</b>
             <em>${esc(o.rating_source)}</em></span>` : '';
      const dates = o.next_departure
        ? `<span class="pkl-card-next">${icon('calendarDays', 13)}Next ${esc(shortDate(o.next_departure))}</span>`
        : `<span class="pkl-card-next is-none">${icon('mail', 13)}Dates on request</span>`;
      return `<article class="pkl-card">
        <a class="pkl-card-art" href="package-details/${esc(o.id)}" aria-label="${esc(o.name)}">
          ${art ? `<img src="${esc(art.small)}" srcset="${esc(art.small)} 480w, ${esc(art.src)} 960w"
                   sizes="(max-width: 700px) 92vw, 340px" alt="" loading="lazy" decoding="async"
                   onerror="this.remove()">`
                : `<span class="pkl-card-pin">${icon('packages', 26)}</span>`}
          <span class="pkl-card-tag">${esc((o.trip_type || '').replace(/^\w/, c => c.toUpperCase()))}</span>
        </a>
        <div class="pkl-card-body">
          <div class="pkl-card-top"><h3><a href="package-details/${esc(o.id)}">${esc(o.name)}</a></h3>${rating}</div>
          <p class="pkl-card-where">${icon('mapPin', 13)}<span>${esc([o.destination, o.country].filter(Boolean).join(', '))}</span></p>
          <p class="pkl-card-days">${esc(o.days)} Days${o.nights != null ? ' / ' + esc(o.nights) + ' Nights' : ''}</p>
          ${ticks.length ? `<ul class="pkl-card-ticks">${ticks
            .map(t => `<li>${icon('circleCheck', 13)}<span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
          <div class="pkl-card-foot">
            <div class="pkl-card-price"><b>${esc(money(price))}</b><small>per person</small></div>
            ${dates}
          </div>
          <a class="disc-btn pkl-card-btn" href="package-details/${esc(o.id)}">View details ${icon('arrowRight', 15)}</a>
        </div>
      </article>`;
    }).join('');
    show(document.getElementById('pkMoreSec'), true);
    if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(document.getElementById('pkMoreSec'));
  }

  const shortDate = iso => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  /* ======================================================================
     POLICIES
     ====================================================================== */
  function renderPolicies(p) {
    const blocks = [];
    if (p.cancellation_policy) {
      blocks.push(`<div class="lp-card pk-policy"><h3>${icon('rotateCcw', 17)} Cancellation</h3>
        <p>${esc(p.cancellation_policy)}</p></div>`);
    }
    /* THE PAYMENT LINE IS NOT A POLICY SOMEBODY WROTE - it is what the
       booking flow actually does: the whole amount is taken at the payment
       step through the gateway, and there is no deposit scheme in this
       system. Said plainly rather than left for the payment page to reveal. */
    blocks.push(`<div class="lp-card pk-policy"><h3>${icon('creditCard', 17)} Payment</h3>
      <p>The full amount is paid at the time of booking, through the secure gateway.
         Your seats are held only once payment succeeds.</p></div>`);
    if (p.is_international) {
      blocks.push(`<div class="lp-card pk-policy"><h3>${icon('fileText', 17)} Passports</h3>
        <p>Every traveller on an international package needs a passport valid for at least six
           months beyond the return date. The booking form asks for those details and checks the
           expiry before it will continue.</p></div>`);
    }
    document.getElementById('pkPolicies').innerHTML = blocks.join('');
    show(document.getElementById('pkPolicySec'), true);
  }

  /* ======================================================================
     BOOKING — the flow that already exists, opened from here
     ====================================================================== */
  function bookingItem(p) {
    /* The shape BookingFlows.package() reads. Deliberately the API's own
       numbers: the card prices every step server-side from the package and
       departure ids, so nothing here can disagree with what is charged. */
    return {
      id: String(p.id), name: p.name, days: p.days, priceFrom: Number(p.priceFrom),
      blurb: p.blurb, is_international: !!p.is_international, category: p.category || 'holiday',
    };
  }

  function wireBooking(p) {
    const item = bookingItem(p);
    const open = departureId => {
      if (typeof BookingFlows === 'undefined' || !BookingFlows.open) {
        /* The booking card did not load. Say so rather than doing nothing
           under a finger — the one thing worse than a broken button is a
           silent one. */
        if (typeof Toast !== 'undefined' && Toast.show) {
          Toast.show('The booking form could not be opened. Please reload the page.');
        }
        return;
      }
      BookingFlows.open('package', item, departureId ? { departureId } : undefined);
    };

    /* Only when it is still a button: with no departures the hero's CTA has
       become an enquiry link (see renderHero) and has nothing to open. */
    const top = document.getElementById('pkBookTop');
    if (top && top.tagName === 'BUTTON') top.addEventListener('click', () => open(null));
    /* A departure tile is the same Book now with the date already chosen -
       the flow still shows the departure step, and the date is simply the
       one already selected there. */
    const dates = document.getElementById('pkDates');
    if (dates) {
      dates.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-departure]');
        if (btn) open(btn.dataset.departure);
      });
    }
  }

  /* ====================================================================== */
  function render(p) {
    renderHero(p);
    renderOverview(p);
    renderItinerary(p);
    renderHotels(p);
    renderIncludes(p);
    renderDates(p);
    renderPolicies(p);
    wireBooking(p);
    /* Not awaited: the page is complete without it and a second catalogue
       query should not hold up the trip somebody is already reading. */
    renderMore(p);

    statusEl.textContent = '';
    statusEl.hidden = true;
    body.hidden = false;
    body.classList.add('disc-in');
    if (typeof JPIcon !== 'undefined' && JPIcon.mount) JPIcon.mount(body);
  }

  function failed(text, retry) {
    body.hidden = true;
    statusEl.hidden = false;
    statusEl.textContent = text;
    const old = document.getElementById('pkRetry');
    if (old) old.remove();
    if (!retry) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pkRetry';
    btn.className = 'dh-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { btn.remove(); load(); });
    statusEl.insertAdjacentElement('afterend', btn);
  }

  async function load() {
    if (!id) { failed('We could not find that package.', false); return; }
    statusEl.hidden = false;
    statusEl.textContent = 'Loading this package…';
    try {
      render(await getJson('/api/customer/packages/' + encodeURIComponent(id)));
    } catch (err) {
      if (err.status === 404) { failed('We could not find that package.', false); return; }
      failed('We could not load this package just now.', true);
    }
  }

  load();
})();
