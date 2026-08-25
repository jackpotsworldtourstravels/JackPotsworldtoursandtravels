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
    const hint = o.hint ? `<small class="bk-field-hint" id="${id}-hint">${esc(o.hint)}</small>` : '';
    return `<div class="bk-field ${o.wide ? 'is-wide' : ''}">
        <label for="${id}">${esc(o.label)}${opt}</label>${control}${hint}
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

     THE CARD IS SPLIT IN TWO ON PURPOSE. What an airline needs to sell a seat
     is a name and a gender; everything else — passport, nationality, date of
     birth, title — is either situational or only needed for international
     travel. Putting all of it in one grid made a domestic hop ask for a
     passport, so the rarely-needed half now lives behind OTHER DETAILS, shut
     by default and opened by the traveller (or opened automatically when the
     itinerary genuinely requires it).

     There is no timeline and no stepper here: the flow's existing horizontal
     rail already says where we are, and this step renders inside it.
     ===================================================================== */

  /* Dialling codes for the countries the portal actually sells to. Kept short
     for the same reason NATIONALITIES is — a credible dropdown, not ISO 3166. */
  const COUNTRY_CODES = [
    '+91 India', '+971 UAE', '+966 Saudi Arabia', '+65 Singapore', '+66 Thailand',
    '+44 United Kingdom', '+1 USA / Canada', '+61 Australia', '+49 Germany',
    '+33 France', '+60 Malaysia', '+94 Sri Lanka', '+977 Nepal', '+974 Qatar',
    '+968 Oman', '+973 Bahrain', '+965 Kuwait', '+960 Maldives', '+62 Indonesia',
  ];

  /** Fields inside the main (always-visible) half of a traveller card. */
  function primarySpecs(i, o) {
    const p = `p${i}_`;
    const contact = i === 0 ? [
      { id: p + 'ccode', label: 'Country code', type: 'select', required: false,
        options: COUNTRY_CODES, value: '+91 India' },
      { id: p + 'mobile', label: 'Mobile number', type: 'tel', required: false,
        inputmode: 'numeric', autocomplete: 'tel' },
      { id: p + 'email', label: 'Email', type: 'email', required: false,
        autocomplete: 'email', wide: true },
    ] : [];
    return [
      { id: p + 'first', label: 'First name', required: true, autocomplete: 'given-name',
        hint: 'Enter as mentioned on your passport' },
      { id: p + 'last', label: 'Last name', required: true, autocomplete: 'family-name' },
      { id: p + 'gender', label: 'Gender', type: 'select', required: true,
        options: ['Male', 'Female'] },
      ...contact,
    ];
  }

  /** Fields inside OTHER DETAILS -> Passport Details. */
  function passportSpecs(i) {
    const p = `p${i}_`;
    return [
      { id: p + 'ppno', label: 'Passport number', required: false, placeholder: 'e.g. M1234567' },
      { id: p + 'ppexp', label: 'Passport expiry', type: 'date', required: false,
        min: new Date().toISOString().slice(0, 10) },
      { id: p + 'ppiss', label: 'Issuing country', type: 'select', required: false,
        options: BookingData.NATIONALITIES, value: 'India' },
      { id: p + 'nat', label: 'Nationality', type: 'select', required: false,
        options: BookingData.NATIONALITIES, value: 'India' },
      { id: p + 'dob', label: 'Date of birth', type: 'date', required: false,
        max: new Date().toISOString().slice(0, 10) },
      { id: p + 'title', label: 'Title', type: 'select', required: false,
        options: BookingData.TITLES },
    ];
  }

  function frequentFlyerSpecs(i) {
    const p = `p${i}_`;
    return [
      { id: p + 'ffair', label: 'Frequent flyer airline', type: 'select', required: false,
        options: ['', ...FREQUENT_FLYER_AIRLINES] },
      { id: p + 'ff', label: 'Frequent flyer number', required: false },
    ];
  }

  const FREQUENT_FLYER_AIRLINES = [
    'Air India', 'IndiGo', 'Vistara', 'SpiceJet', 'Akasa Air',
    'Emirates', 'Qatar Airways', 'Singapore Airlines', 'Etihad Airways',
    'British Airways', 'Lufthansa', 'Thai Airways', 'Malaysia Airlines',
  ];

  /** A disclosure section: a button that opens a panel, using the flow's own
   *  card and button styling rather than introducing a new widget. */
  function disclosure(id, label, hint, bodyHtml, opts) {
    const open = !!(opts && opts.open);
    return `
      <div class="bk-disclose ${open ? 'is-open' : ''}" data-disclose="${id}">
        <button type="button" class="bk-disclose-btn" aria-expanded="${open}"
                aria-controls="${id}-panel" id="${id}-btn">
          <span class="bk-disclose-sign" aria-hidden="true">${open ? '&minus;' : '+'}</span>
          <span class="bk-disclose-label">${esc(label)}</span>
          ${hint ? `<span class="bk-disclose-hint">${esc(hint)}</span>` : ''}
        </button>
        <div class="bk-disclose-panel" id="${id}-panel" role="region"
             aria-labelledby="${id}-btn" ${open ? '' : 'hidden'}>
          ${bodyHtml}
        </div>
      </div>`;
  }

  function travellersStep(opts) {
    const o = Object.assign({ passport: true, frequentFlyer: true, noun: 'Traveller' }, opts);

    /* Whether the passport half is required at all. International travel needs
       it; a domestic hop does not, and demanding it there would be the app
       inventing a rule the airline did not ask for. */
    const needsPassport = ctx =>
      o.passport && !!(typeof BookingApi !== 'undefined' && BookingApi.isInternational(ctx.item));

    /** A traveller counts as complete once the fields the airline actually
     *  needs are on the draft — the same set validate() enforces, checked
     *  here only to decide what the status pill says. */
    function paxComplete(ctx, i, intl) {
      const p = (ctx.passengers && ctx.passengers[i]) || {};
      if (!p.first || !p.last || !p.gender) return false;
      if (intl && (!p.passportNumber || !p.passportExpiry)) return false;
      return true;
    }

    function cardHtml(i, ctx) {
      const kind = (ctx.paxKinds && ctx.paxKinds[i]) || 'Adult';
      const intl = needsPassport(ctx);
      const p = `p${i}_`;
      const open = !!(ctx.paxOpen && ctx.paxOpen[i]);
      const complete = paxComplete(ctx, i, intl);

      const passportBody = `
        <p class="bk-disclose-note" id="${p}ppnote" role="status" aria-live="polite"></p>
        <div class="bk-grid">${passportSpecs(i).map(field).join('')}</div>`;

      const ffBody = `<div class="bk-grid">${frequentFlyerSpecs(i).map(field).join('')}</div>`;

      return `<section class="bk-pax ${open ? 'is-open' : ''}" data-pax="${i}">
        <header class="bk-pax-head">
          <button type="button" class="bk-pax-toggle" data-pax-toggle="${i}"
                  aria-expanded="${open}" aria-controls="pax${i}-body">
            <span class="bk-pax-chev" aria-hidden="true">${icon('arrowUp')}</span>
            <h3>${esc(o.noun)} ${i + 1} <span class="bk-tag">${esc(kind)}</span></h3>
          </button>
          <span class="bk-pax-status ${complete ? 'is-done' : ''}">${complete ? '&#10003; Details completed' : 'Details required'}</span>
          ${i > 0 ? `<button type="button" class="bk-pax-remove" data-remove="${i}"
                       aria-label="Remove ${esc(o.noun)} ${i + 1}">Remove</button>` : ''}
        </header>

        <div class="bk-pax-body" id="pax${i}-body" ${open ? '' : 'hidden'}>
          ${i === 0 ? '<p class="bk-pax-note">Contact details for the whole booking</p>' : ''}
          <div class="bk-grid">${primarySpecs(i, o).map(field).join('')}</div>

          ${o.frequentFlyer ? disclosure(
            `${p}ff`, 'Frequent flyer number', 'Avail extra benefits & earn points', ffBody
          ) : ''}

          ${o.passport ? `
            <div class="bk-subcard">
              <h4 class="bk-subcard-title">OTHER DETAILS</h4>
              ${disclosure(`${p}pp`, 'Passport details',
                intl ? 'Required for international travel' : 'Optional for domestic travel',
                passportBody, { open: intl })}
            </div>` : ''}
        </div>
      </section>`;
    }

    return {
      id: 'travellers',
      label: o.noun + 's',

      render(ctx) {
        /* The party size is the traveller's to change from here on, so it is
           held on the draft rather than recomputed from the search each time. */
        if (!Array.isArray(ctx.paxKinds) || !ctx.paxKinds.length) {
          ctx.paxKinds = Array.from({ length: Math.max(1, ctx.paxCount || 1) }, () => 'Adult');
        }
        ctx.paxCount = ctx.paxKinds.length;
        /* Traveller 1 opens by default — there is always something to fill in.
           Anyone already in the party beyond that starts collapsed, per the
           reference; a traveller added just now via "+ Add" opens instead
           (that push happens in mount(), not here). */
        if (!Array.isArray(ctx.paxOpen)) ctx.paxOpen = [];
        ctx.paxKinds.forEach((_, i) => { if (ctx.paxOpen[i] === undefined) ctx.paxOpen[i] = i === 0; });

        const cards = ctx.paxKinds.map((_, i) => cardHtml(i, ctx)).join('');
        const intl = needsPassport(ctx);
        /* 9 is the party size every airline caps a single booking at. */
        const canAdd = ctx.paxKinds.length < 9;

        return `<div class="bk-step">
          <h2 class="bk-step-title">Who is travelling?</h2>
          <p class="bk-step-sub">Please enter the traveller details as per the travel document.</p>
          ${intl ? `<p class="bk-note bk-note-info">This is an international itinerary, so
            passport details are required and must be valid for at least six months from the
            travel date.</p>` : ''}
          <div id="bkPaxList">${cards}</div>
          ${canAdd ? `<div class="bk-addpax">
            <button type="button" class="bk-btn bk-btn-ghost bk-btn-sm" id="bkAddAdult">+ Add Adult</button>
            <button type="button" class="bk-btn bk-btn-ghost bk-btn-sm" id="bkAddChild">+ Add Child</button>
            <button type="button" class="bk-btn bk-btn-ghost bk-btn-sm" id="bkAddInfant">+ Add Infant</button>
          </div>` : ''}
          <label class="bk-check bk-savelist">
            <input type="checkbox" id="bkSaveTravellers" ${ctx.saveTravellers ? 'checked' : ''}>
            <span>
              <b>Add these travellers to My Traveller List</b>
              <em>You won't have to fill traveller info on your next visit.</em>
            </span>
          </label>
        </div>`;
      },

      mount(root, ctx) {
        /* --- disclosure open/close, and the + / − it shows --- */
        root.querySelectorAll('.bk-disclose-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const wrap = btn.closest('.bk-disclose');
            const panel = wrap.querySelector('.bk-disclose-panel');
            const open = wrap.classList.toggle('is-open');
            panel.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
            wrap.querySelector('.bk-disclose-sign').innerHTML = open ? '&minus;' : '+';
          });
        });

        /* --- collapse/expand a whole traveller card --- */
        root.querySelectorAll('[data-pax-toggle]').forEach(btn => {
          btn.addEventListener('click', () => {
            const i = Number(btn.dataset.paxToggle);
            readInto(ctx, root);                 // keep what is on screen in every card
            ctx.paxOpen[i] = !ctx.paxOpen[i];
            BookingFlow.repaint();
          });
        });

        /* --- restore anything already typed, so Back does not lose it --- */
        (ctx.passengers || []).forEach((pax, i) => {
          const set = (suffix, value) => {
            const el = root.querySelector(`#p${i}_${suffix}`);
            if (el && value != null && value !== '') el.value = value;
          };
          set('first', pax.first); set('last', pax.last); set('gender', pax.gender);
          set('ccode', pax.countryCode); set('mobile', pax.mobile); set('email', pax.email);
          set('ppno', pax.passportNumber); set('ppexp', pax.passportExpiry);
          set('ppiss', pax.issuingCountry); set('nat', pax.nationality);
          set('dob', pax.dob); set('title', pax.title);
          set('ffair', pax.frequentFlyerAirline); set('ff', pax.frequentFlyer);
        });

        /* --- passport auto-fetch --------------------------------------
           Looks the number up in THIS customer's own saved travellers and
           fills back what they saved before. It never derives anything from
           the number itself: a passport number does not encode a name or a
           date of birth, and a form that appeared to know them would be
           making them up. Nothing found means nothing is filled in. */
        root.querySelectorAll('[id$="_ppno"]').forEach(input => {
          const i = input.id.match(/^p(\d+)_/)[1];
          const note = root.querySelector(`#p${i}_ppnote`);

          input.addEventListener('change', async () => {
            const number = input.value.trim();
            if (note) { note.textContent = ''; note.className = 'bk-disclose-note'; }
            if (!number || typeof BookingApi === 'undefined' || !BookingApi.isSignedIn()) return;

            try {
              const found = await BookingApi.lookupPassport(number);
              if (!found) return;                       // unknown passport: say nothing
              const fill = (suffix, value) => {
                const el = root.querySelector(`#p${i}_${suffix}`);
                /* Only fill blanks — never overwrite something the traveller
                   has already typed on this screen. */
                if (el && value != null && value !== '' && !el.value) el.value = value;
              };
              fill('first', found.first_name); fill('last', found.last_name);
              fill('gender', found.gender); fill('title', found.title);
              fill('dob', found.date_of_birth); fill('nat', found.nationality);
              fill('ppexp', found.passport_expiry); fill('ppiss', found.issuing_country);
              fill('ffair', found.frequent_flyer_airline); fill('ff', found.frequent_flyer_number);
              if (note) {
                note.textContent = 'Passenger details found — check them and edit if anything has changed.';
                note.className = 'bk-disclose-note is-ok';
              }
            } catch { /* a lookup failure must never block the booking */ }
          });
        });

        /* --- add / remove travellers --- */
        const add = kind => {
          readInto(ctx, root);                 // keep what is on screen
          ctx.paxKinds.push(kind);
          ctx.paxOpen.push(true);              // open the one just added — it's empty
          ctx.paxCount = ctx.paxKinds.length;
          BookingFlow.repaint();
        };
        const btnAdult = root.querySelector('#bkAddAdult');
        const btnChild = root.querySelector('#bkAddChild');
        const btnInfant = root.querySelector('#bkAddInfant');
        if (btnAdult) btnAdult.addEventListener('click', () => add('Adult'));
        if (btnChild) btnChild.addEventListener('click', () => add('Child'));
        if (btnInfant) btnInfant.addEventListener('click', () => add('Infant'));

        root.querySelectorAll('[data-remove]').forEach(btn => {
          btn.addEventListener('click', () => {
            readInto(ctx, root);
            const i = Number(btn.dataset.remove);
            ctx.paxKinds.splice(i, 1);
            (ctx.passengers || []).splice(i, 1);
            if (Array.isArray(ctx.paxOpen)) ctx.paxOpen.splice(i, 1);
            /* A seat belonged to the traveller who just left, not to the
               position, so drop it rather than shifting it onto someone else. */
            if (Array.isArray(ctx.seats)) ctx.seats.splice(i, 1);
            ctx.paxCount = ctx.paxKinds.length;
            BookingFlow.repaint();
          });
        });

        const save = root.querySelector('#bkSaveTravellers');
        if (save) save.addEventListener('change', () => { ctx.saveTravellers = save.checked; });
      },

      validate(ctx) {
        const root = document.getElementById('bkMain');
        const n = ctx.paxKinds.length;
        const intl = needsPassport(ctx);
        const travelDate = ctx.item && ctx.item.date ? new Date(ctx.item.date) : null;

        const flag = (id, message) => {
          root.querySelectorAll('.is-invalid').forEach(e => e.classList.remove('is-invalid'));
          const el = root.querySelector('#' + id);
          if (el) {
            el.classList.add('is-invalid');
            /* Open the traveller card itself first — a field inside a
               collapsed card cannot be focused at all — then the disclosure
               panel inside it, or the traveller is told to fix something
               they cannot see. */
            const card = el.closest('.bk-pax');
            const body = card && card.querySelector('.bk-pax-body');
            if (body && body.hidden) {
              body.hidden = false;
              card.classList.add('is-open');
              const toggle = card.querySelector('.bk-pax-toggle');
              if (toggle) toggle.setAttribute('aria-expanded', 'true');
              const i = card.dataset.pax;
              if (i != null && ctx.paxOpen) ctx.paxOpen[i] = true;
            }
            const panel = el.closest('.bk-disclose-panel');
            if (panel && panel.hidden) {
              const wrap = panel.closest('.bk-disclose');
              wrap.classList.add('is-open');
              panel.hidden = false;
              wrap.querySelector('.bk-disclose-btn').setAttribute('aria-expanded', 'true');
              wrap.querySelector('.bk-disclose-sign').innerHTML = '&minus;';
            }
            el.focus({ preventScroll: false });
          }
          return message;
        };

        for (let i = 0; i < n; i++) {
          const p = `p${i}_`;
          const who = `${o.noun} ${i + 1}`;

          if (!val(root, p + 'first')) return flag(p + 'first', `${who}: first name is required.`);
          if (!val(root, p + 'last')) return flag(p + 'last', `${who}: last name is required.`);
          if (!val(root, p + 'gender')) return flag(p + 'gender', `${who}: gender is required.`);

          /* Contact is optional per the form, but a value that IS given has to
             be usable — a typo'd email is worse than a blank one, because the
             ticket goes to it. */
          if (i === 0) {
            const email = val(root, p + 'email');
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              return flag(p + 'email', 'Enter a valid email address, or leave it blank.');
            }
            const mob = val(root, p + 'mobile').replace(/[\s-]/g, '');
            if (mob && !/^\d{8,15}$/.test(mob)) {
              return flag(p + 'mobile', 'Enter a valid mobile number, or leave it blank.');
            }
          }

          if (!intl) continue;

          const ppno = val(root, p + 'ppno');
          const ppexp = val(root, p + 'ppexp');
          if (!ppno) {
            return flag(p + 'ppno', `${who}: passport number is required for international travel.`);
          }
          if (!ppexp) {
            return flag(p + 'ppexp', `${who}: passport expiry is required for international travel.`);
          }
          /* Six months FROM THE TRAVEL DATE, which is the rule border control
             actually applies — not six months from today, which would pass a
             passport that expires mid-trip on a booking made far enough ahead. */
          if (travelDate && !isNaN(travelDate)) {
            const sixMonthsOn = new Date(travelDate);
            sixMonthsOn.setMonth(sixMonthsOn.getMonth() + 6);
            if (new Date(ppexp) < sixMonthsOn) {
              return flag(p + 'ppexp',
                `${who}: passport must be valid for at least 6 months from the travel date.`);
            }
          }
        }

        readInto(ctx, root);
        return true;
      },
    };
  }

  /** Read every traveller card off the screen into the draft.
   *  Called before a repaint and again on validate, so nothing typed is lost
   *  when a traveller is added, removed, or the step is revisited via Back. */
  function readInto(ctx, root) {
    root = root || document.getElementById('bkMain');
    if (!root) return;
    const n = (ctx.paxKinds || []).length || Math.max(1, ctx.paxCount || 1);
    ctx.passengers = Array.from({ length: n }, (_, i) => {
      const p = `p${i}_`;
      const prev = (ctx.passengers && ctx.passengers[i]) || {};
      const pick = (suffix, fallback) => {
        const el = root.querySelector(`#${p}${suffix}`);
        return el ? el.value.trim() : (fallback || '');
      };
      return {
        title: pick('title', prev.title),
        first: pick('first', prev.first),
        last: pick('last', prev.last),
        gender: pick('gender', prev.gender),
        dob: pick('dob', prev.dob),
        nationality: pick('nat', prev.nationality),
        passportNumber: pick('ppno', prev.passportNumber),
        passportExpiry: pick('ppexp', prev.passportExpiry),
        issuingCountry: pick('ppiss', prev.issuingCountry),
        frequentFlyerAirline: pick('ffair', prev.frequentFlyerAirline),
        frequentFlyer: pick('ff', prev.frequentFlyer),
        countryCode: i === 0 ? pick('ccode', prev.countryCode) : null,
        mobile: i === 0 ? pick('mobile', prev.mobile) : null,
        email: i === 0 ? pick('email', prev.email) : null,
        kind: (ctx.paxKinds && ctx.paxKinds[i]) || 'Adult',
      };
    });
    const save = root.querySelector('#bkSaveTravellers');
    if (save) ctx.saveTravellers = save.checked;
  }

  /* =====================================================================
     SHARED STEP — add-ons
     ===================================================================== */
  function addonsStep(productType) {
    /* Headings in the order the step reads. The server groups the catalogue
       (baggage / meal / service) and each row carries its group, so this does
       not need a second opinion about what a thing is. */
    const GROUPS = [
      { key: 'baggage', title: 'Additional baggage' },
      { key: 'meal', title: 'Meals' },
      { key: 'service', title: 'Other services' },
    ];

    return {
      id: 'addons',
      label: 'Add-ons',
      async load(ctx) { ctx.addonCatalogue = await BookingData.addons(productType); },
      render(ctx) {
        const chosen = new Set(ctx.addons.map(a => a.id));
        const cat = ctx.addonCatalogue || [];

        const card = a => `
          <label class="bk-addon ${chosen.has(a.id) ? 'is-on' : ''}" data-addon="${esc(a.id)}">
            <input type="checkbox" data-addon-cb="${esc(a.id)}" ${chosen.has(a.id) ? 'checked' : ''}>
            <span class="bk-addon-icon">${icon(a.icon)}</span>
            <span class="bk-addon-body">
              <b>${esc(a.name)}</b>
              <span>${a.note ? esc(a.note) : (a.per === 'passenger' ? 'Per traveller' : 'Per booking')}</span>
            </span>
            <span class="bk-addon-price">${a.price ? esc(money(a.price)) : 'Free'}</span>
          </label>`;

        /* WHAT THE FARE ALREADY BUYS, BEFORE WHAT IT DOES NOT. A traveller
           being sold extra baggage should first be able to see the allowance
           they already have — otherwise "add 10 kg" is a number with nothing
           to add to. Values come from the API (included_baggage); nothing here
           hardcodes an allowance. */
        const included = (cat.included || []).map(b => `
          <div class="bk-included">
            <span class="bk-addon-icon">${icon('transfers')}</span>
            <span class="bk-addon-body">
              <b>${esc(b.name)}${b.allowance ? ` · ${esc(b.allowance)}` : ''}</b>
              <span>${esc(b.description || '')}</span>
            </span>
            <span class="bk-included-tag">Included</span>
          </div>`).join('');

        /* Grouped where the catalogue says which group a row is in (flights,
           from the server). The other products still return a flat list with
           no group, and fall back to one ungrouped block. */
        const grouped = cat.some(a => a.group);
        const body = grouped
          ? GROUPS.map(g => {
              const rows = cat.filter(a => a.group === g.key);
              if (!rows.length) return '';
              return `<section class="bk-addon-group">
                  <h3 class="bk-addon-group-title">${esc(g.title)}</h3>
                  <div class="bk-addons">${rows.map(card).join('')}</div>
                </section>`;
            }).join('')
          : `<div class="bk-addons">${cat.map(card).join('')}</div>`;

        return `<div class="bk-step">
            <h2 class="bk-step-title">Anything else?</h2>
            <p class="bk-step-sub">Every extra can be removed later — nothing here is final.</p>
            ${included ? `<section class="bk-addon-group">
              <h3 class="bk-addon-group-title">Baggage included in your fare</h3>
              <div class="bk-includes">${included}</div>
            </section>` : ''}
            ${body}
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
    /* Every figure on this screen comes from ctx.pricing, which is the last
       answer the server gave. Nothing here adds anything up. */
    return {
      id: 'summary',
      label: 'Review',
      nextLabel: 'Continue to payment',
      render(ctx) {
        const kinds = ctx.paxKinds || [];
        const editable = typeof BookingFlow !== 'undefined' && BookingFlow.goTo;
        const edit = (stepId, label) => editable
          ? `<button type="button" class="bk-edit" data-edit="${esc(stepId)}">Edit ${esc(label)}</button>`
          : '';

        /* An add-on priced per traveller is bought for the whole party, so it
           is listed under each of them; one priced per booking is listed once,
           below. This mirrors how the server charges them (`per`), rather than
           showing a meal on the booking and leaving who eats it unstated. */
        const addonsFor = i => (ctx.addons || []).filter(
          a => a.passengerIndex === i || (a.passengerIndex == null && a.per === 'passenger'));
        const bookingAddons = (ctx.addons || []).filter(
          a => a.passengerIndex == null && a.per !== 'passenger');

        const travellers = (ctx.passengers || []).map((p, i) => {
          const mine = addonsFor(i);
          /* Seats get their own dedicated panel below (flights only), so this
             card stays about who the traveller is, not where they sit. */
          const rows = [
            ...mine.map(a => [a.group === 'meal' ? 'Meal' : a.group === 'baggage' ? 'Baggage' : 'Service',
                              `${esc(a.name)} — ${a.price ? esc(money(a.price)) : 'Free'}`]),
          ];
          /* Passport status, not passport contents: the number is on file and
             does not need reprinting on a review screen. */
          if (p.passportNumber) {
            rows.push(['Passport', `On file${p.passportExpiry ? ` · expires ${esc(fmtDate(p.passportExpiry))}` : ''}`]);
          } else if (ctx.item && typeof BookingApi !== 'undefined' && BookingApi.isInternational(ctx.item)) {
            rows.push(['Passport', 'Not provided']);
          }

          return `<article class="bk-review-pax">
              <header>
                <div>
                  <b>Traveller ${i + 1}</b>
                  <span>${esc([p.title, p.first, p.last].filter(Boolean).join(' '))}</span>
                </div>
                <span class="bk-tag">${esc(kinds[i] || p.kind || 'Adult')}</span>
              </header>
              <dl class="bk-review-dl">
                ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
              </dl>
            </article>`;
        }).join('');

        const addonList = bookingAddons.length
          ? bookingAddons.map(a => `
              <li><span>${esc(a.name)}</span>
                  <span>${a.price ? esc(money(a.price)) : 'Free'}</span></li>`).join('')
          : '<li class="is-muted">None selected</li>';

        const lines = (ctx.pricing.lines || []).map(l =>
          `<div class="bk-price-line"><span>${esc(l.label)}</span><span>${l.free ? 'Included' : esc(money(l.amount))}</span></div>`).join('');

        return `<div class="bk-step">
            <h2 class="bk-step-title">Check everything over</h2>
            <p class="bk-step-sub">Nothing is charged until you confirm on the next step.</p>

            <section class="bk-panel">
              <div class="bk-panel-head"><h3>${ctx.kind === 'flight' ? 'Flight' : 'Journey details'}</h3></div>
              ${describe(ctx)}
            </section>

            <section class="bk-panel">
              <div class="bk-panel-head">
                <h3>${esc(ctx.passengers.length)} ${ctx.passengers.length === 1 ? 'traveller' : 'travellers'}</h3>
                ${edit('travellers', 'travellers')}
              </div>
              <div class="bk-review-paxlist">${travellers}</div>
            </section>

            ${ctx.kind === 'flight' ? `
            <section class="bk-panel">
              <div class="bk-panel-head"><h3>Seats</h3>${edit('seats', 'seats')}</div>
              <div class="bk-review-seats">
                ${(ctx.passengers || []).map((p, i) => {
                  const seat = ctx.seats && ctx.seats[i];
                  return `<div class="bk-review-seat">
                      <span>Traveller ${i + 1}</span>
                      ${seat
                        ? `<b>${esc(seat.id)}</b><span>${seat.price ? esc(money(seat.price)) : 'No extra charge'}</span>`
                        : '<span class="is-muted">Assigned at check-in</span>'}
                    </div>`;
                }).join('')}
              </div>
            </section>` : ''}

            <section class="bk-panel">
              <div class="bk-panel-head"><h3>Add-ons</h3>${edit('addons', 'add-ons')}</div>
              <ul class="bk-list">${addonList}</ul>
            </section>

            <section class="bk-panel">
              <div class="bk-panel-head"><h3>Fare summary</h3></div>
              ${lines}
              <div class="bk-price-total"><span>Total amount</span><span>${esc(money(ctx.pricing.total))}</span></div>
            </section>
          </div>`;
      },
      mount(root) {
        root.querySelectorAll('[data-edit]').forEach(btn => {
          btn.addEventListener('click', () => BookingFlow.goTo(btn.dataset.edit));
        });
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

      /* The methods, and whether a gateway exists at all, come from the server.
         PAY_METHODS below is the fallback for the four products with no backend
         — it is no longer what a flight renders. */
      async load(ctx) {
        if (typeof BookingApi === 'undefined' || !BookingApi.isLive(ctx.kind)) {
          ctx.payMethods = PAY_METHODS;
          ctx.gatewayConfigured = false;
          return;
        }
        try {
          const res = await BookingApi.paymentMethods();
          ctx.payMethods = (res.methods || []).length ? res.methods : PAY_METHODS;
          ctx.gatewayConfigured = !!res.gateway_configured;
        } catch {
          ctx.payMethods = PAY_METHODS;
          ctx.gatewayConfigured = false;
        }
      },

      render(ctx) {
        const list = ctx.payMethods || PAY_METHODS;
        const methods = list.map((m, i) => `
          <label class="bk-pay ${i === 0 ? 'is-on' : ''}">
            <input type="radio" name="bkPay" value="${esc(m.id)}" ${i === 0 ? 'checked' : ''}>
            <span class="bk-pay-body"><b>${esc(m.name)}</b><span>${esc(m.note || '')}</span></span>
          </label>`).join('');

        /* WHEN THERE IS NO GATEWAY, SAY WHAT IS TRUE WITHOUT NAMING PLUMBING.
           The traveller is told nothing will be charged and the booking is
           held — which is exactly what happens — rather than being shown a
           fake success or a sentence about unconfigured providers. */
        const notice = ctx.gatewayConfigured ? '' : `
            <div class="bk-demo-note">
              ${icon('insurance')}
              <div>
                <b>No payment is taken yet</b>
                <p>Online payment is not available on this booking. Choose how you
                   intend to pay and we will hold your booking — nothing is charged
                   now, and no card details are collected.</p>
              </div>
            </div>`;

        return `<div class="bk-step">
            <h2 class="bk-step-title">How would you like to pay?</h2>
            ${notice}
            <div class="bk-pays">${methods}</div>
            <div class="bk-paytotal">
              <span>Amount payable</span><b data-bk-total>${esc(money(ctx.pricing.total))}</b>
            </div>
          </div>`;
      },

      mount(root) {
        root.querySelectorAll('.bk-pay input').forEach(r => r.addEventListener('change', () => {
          root.querySelectorAll('.bk-pay').forEach(l => l.classList.toggle('is-on', l.contains(r) && r.checked));
        }));
      },

      async onNext(ctx) {
        const list = ctx.payMethods || PAY_METHODS;
        const picked = document.querySelector('input[name="bkPay"]:checked');
        const id = picked ? picked.value : list[0].id;
        ctx.payment = {
          method: id,
          methodLabel: (list.find(m => m.id === id) || list[0]).name,
          amount: ctx.pricing.total,
          /* Only true where nothing real is happening. A flight booking is
             genuinely written to the server, so it is not "simulated" — it is
             an unpaid booking, which is a different and honest thing. */
          simulated: !BookingApi || !BookingApi.isLive(ctx.kind),
        };
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
      /* For flights and hotels, what the server is actually asked to book.
         Note it names choices only — no prices — so the total is the
         server's arithmetic and not something this page could dictate.
         Absent for cruises/packages/visa, which BookingStore keeps local. */
      apiPayload: (ctx.kind === 'flight' && typeof BookingApi !== 'undefined')
        ? {
            flight: BookingApi.flightPayload(ctx),
            passengers: (ctx.passengers || []).map((p, i) => ({
              traveller_type: String(p.kind || 'Adult').toLowerCase(),
              title: p.title || null,
              first_name: p.first,
              last_name: p.last,
              gender: p.gender || null,
              date_of_birth: p.dob || null,
              nationality: p.nationality || null,
              passport_number: p.passportNumber || null,
              passport_expiry: p.passportExpiry || null,
              issuing_country: p.issuingCountry || null,
              frequent_flyer_airline: p.frequentFlyerAirline || null,
              frequent_flyer_number: p.frequentFlyer || null,
              /* The first traveller carries the booking contact, which is the
                 only place the form asks for a mobile and an email. */
              is_contact: i === 0,
              mobile: i === 0 && p.mobile
                ? `${(p.countryCode || '+91 India').split(' ')[0]}${p.mobile}` : null,
              email: i === 0 ? (p.email || null) : null,
            })),
            seats: BookingApi.seatPayload(ctx),
            addons: BookingApi.addonPayload(ctx),
            coupon_code: ctx.couponCode || null,
            save_travellers: !!ctx.saveTravellers,
          }
        : (ctx.kind === 'hotel' && typeof BookingApi !== 'undefined' && ctx.room)
        ? {
            stay: BookingApi.hotelPayload(ctx),
            guests: (ctx.passengers || []).map((p, i) => ({
              guest_type: String(p.kind || 'Adult').toLowerCase() === 'child' ? 'child' : 'adult',
              title: p.title || null,
              first_name: p.first,
              last_name: p.last,
              gender: p.gender || null,
              date_of_birth: p.dob || null,
              nationality: p.nationality || null,
              is_contact: i === 0,
              mobile: i === 0 && p.mobile
                ? `${(p.countryCode || '+91 India').split(' ')[0]}${p.mobile}` : null,
              email: i === 0 ? (p.email || null) : null,
            })),
            addons: BookingApi.hotelAddonPayload(ctx),
            special_requests: ctx.requests || [],
            notes: ctx.notes || null,
            coupon_code: ctx.couponCode || null,
          }
        : (ctx.kind === 'package' && typeof BookingApi !== 'undefined' && ctx.departure)
        ? {
            trip: BookingApi.packagePayload(ctx),
            travellers: (ctx.passengers || []).map((p, i) => ({
              traveller_type: String(p.kind || 'Adult').toLowerCase(),
              title: p.title || null,
              first_name: p.first,
              last_name: p.last,
              gender: p.gender || null,
              date_of_birth: p.dob || null,
              nationality: p.nationality || null,
              passport_number: p.passportNumber || null,
              passport_expiry: p.passportExpiry || null,
              issuing_country: p.issuingCountry || null,
              is_contact: i === 0,
              mobile: i === 0 && p.mobile
                ? `${(p.countryCode || '+91 India').split(' ')[0]}${p.mobile}` : null,
              email: i === 0 ? (p.email || null) : null,
            })),
            addons: BookingApi.packageAddonPayload(ctx),
            coupon_code: ctx.couponCode || null,
          }
        : null,
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
        /* A server booking carries its own reference and status; a local demo
           booking (the four products with no backend) still carries the ones
           booking-store.js stamps. */
        const live = b.demo === false;
        const isHotel = ctx.kind === 'hotel';
        const isPackage = ctx.kind === 'package';
        const isFlight = ctx.kind === 'flight';
        const refs = [
          ['Booking ID', b.id],
          /* PNR IS SHOWN AS PENDING, NOT AS A NUMBER WE MADE UP. An airline
             issues it through a GDS and none is integrated, so a string
             invented here would be quoted at a check-in desk and rejected.
             There is no such concept for a hotel stay or a tour package, so
             it is skipped entirely rather than shown as "Pending" for
             something that will never exist. */
          (live && isFlight)
            ? ['PNR', b.pnr || 'Pending — issued by the airline on ticketing']
            : (b.pnr ? ['PNR', b.pnr] : null),
          b.ticketNumber ? ['Ticket number', b.ticketNumber] : null,
          [isHotel ? 'Hotel' : isPackage ? 'Package' : 'Airline', b.title],
          !isPackage ? [isHotel ? 'Location' : 'Route', b.subtitle] : null,
          isPackage && b.days ? ['Duration', `${b.days} day${b.days === 1 ? '' : 's'}`] : null,
          isHotel && b.checkIn ? ['Check-in', fmtDate(b.checkIn)] : null,
          isHotel && b.checkOut ? ['Check-out', fmtDate(b.checkOut)] : null,
          isHotel && b.nights ? ['Nights', b.nights] : null,
          isHotel && b.roomName ? ['Room', b.roomName] : null,
          !isHotel && b.travelDate ? [isPackage ? 'Departure date' : 'Travel date', fmtDate(b.travelDate)] : null,
          (isFlight && (b.departure || b.arrival)) ? ['Departure / arrival',
            `${b.departure || '—'} → ${b.arrival || '—'}`] : null,
          (isFlight && b.seats && b.seats.length) ? ['Seat' + (b.seats.length > 1 ? 's' : ''),
            b.seats.join(', ')] : null,
          ['Booked on', fmtDate(b.bookedAt)],
          ['Payment method', (b.payment || {}).methodLabel || (b.payments && b.payments[0] && b.payments[0].method) || '—'],
          ['Total amount', money(b.total)],
          ['Booking status', b.status || 'Pending'],
        ].filter(Boolean).map(([k, v]) =>
          `<div class="bk-ref"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

        const pax = (b.passengers || []).map((p, i) =>
          `<li>${esc(p.title)} ${esc(p.first)} ${esc(p.last)}
             <span>${esc(p.kind || 'Adult')}${b.seats && b.seats[i] ? ' · Seat ' + esc(b.seats[i]) : ''}</span></li>`).join('');

        return `<div class="bk-step bk-done">
            <div class="bk-done-mark">${typeof JPIcon !== 'undefined' ? JPIcon.html('insurance', { size: 'xl' }) : ''}</div>
            <h2>Booking confirmed</h2>
            <p class="bk-step-sub">Your booking has been successfully confirmed.
              ${esc(ctx.summaryTitle || '')} — recorded against your account.</p>

            <div class="bk-refs">${refs}</div>

            <section class="bk-panel">
              <h3>${isHotel ? 'Guests' : 'Travellers'}</h3>
              <ul class="bk-list">${pax || '<li class="is-muted">—</li>'}</ul>
            </section>

            <div class="bk-done-actions">
              <a class="bk-btn bk-btn-primary" href="my-bookings.html">View booking</a>
              <button type="button" class="bk-btn bk-btn-ghost" data-act="download">Download ticket</button>
              <button type="button" class="bk-btn bk-btn-ghost" data-act="email">Email ticket</button>
              <button type="button" class="bk-btn bk-btn-ghost" data-act="print">Print</button>
            </div>
            <p class="bk-demo-foot">${b.demo === false
              ? (isFlight
                  ? 'No payment gateway is connected, so nothing has been charged and no ticket has been issued by an airline yet. Your booking reference above is real and can be quoted to support.'
                  : 'No payment gateway is connected, so nothing has been charged yet. Your booking reference above is real and can be quoted to support.')
              : 'Demo booking — no payment was taken and no ticket has been issued by an airline.'}</p>
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
    readTravellersInto: readInto,
    addonTotal, nightsBetween,
    flightPrice, hotelPrice, cruisePrice, packagePrice, visaPrice,
    PAY_METHODS,
  };
})();
