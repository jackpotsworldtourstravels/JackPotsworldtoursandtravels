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

  /** Whether the traveller step may offer "Upload Passport" at all.
   *  `undefined` = not asked yet, `false`/`true` once the server has answered.
   *  Asked once per page load and cached module-wide — this is a deployment
   *  fact, not something that varies per traveller or repaint — and a
   *  deployment with no provider configured must render no control at all,
   *  never one that fails when pressed. */
  let _ocrAvailable;

  function checkOcrAvailability() {
    if (_ocrAvailable !== undefined) return;
    if (typeof BookingApi === 'undefined') { _ocrAvailable = false; return; }
    _ocrAvailable = false; // hidden until proven otherwise
    BookingApi.ocrAvailability().then(v => {
      if (v) { _ocrAvailable = true; BookingFlow.repaint(); }
    });
  }

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

    /** The "Upload Passport" control shown above the passport fields — absent
     *  entirely on a deployment with no OCR provider configured (see
     *  `checkOcrAvailability`), so there is never a button that fails when
     *  pressed. States: idle, busy (reading), done (fields filled — the
     *  traveller still reviews and edits them below, this only reports what
     *  happened), error (a message the form can show without blocking manual
     *  entry). No provider name ever appears here. */
    function scanControlHtml(i, ctx) {
      if (!_ocrAvailable) return '';
      const scan = (ctx.paxScan && ctx.paxScan[i]) || { status: 'idle' };
      const busy = scan.status === 'busy';
      const done = scan.status === 'done';
      const failed = scan.status === 'error';

      if (done) {
        return `<div class="bk-scan is-done">
          <p class="bk-scan-msg is-ok">&#10003; Passport details detected</p>
          <button type="button" class="bk-btn bk-btn-ghost bk-btn-sm" data-scan-edit="${i}">Edit Details</button>
        </div>`;
      }

      return `<div class="bk-scan ${failed ? 'is-error' : ''}">
        <input type="file" id="${scanId(i)}" class="bk-scan-input" data-scan-input="${i}"
               accept="image/jpeg,image/png,image/webp,application/pdf" ${busy ? 'disabled' : ''}>
        <label class="bk-scan-btn ${busy ? 'is-busy' : ''}" for="${scanId(i)}">
          ${icon('upload')}<span>${busy ? 'Reading your passport…' : 'Upload Passport'}</span>
        </label>
        <p class="bk-scan-hint">Upload a clear passport image to automatically fill your details.</p>
        ${failed ? `<p class="bk-scan-msg is-bad" role="alert">${esc(scan.message)}</p>` : ''}
      </div>`;
    }

    const scanId = i => `p${i}_ppscan`;

    function cardHtml(i, ctx) {
      const kind = (ctx.paxKinds && ctx.paxKinds[i]) || 'Adult';
      const intl = needsPassport(ctx);
      const p = `p${i}_`;
      const open = !!(ctx.paxOpen && ctx.paxOpen[i]);
      const complete = paxComplete(ctx, i, intl);

      const passportBody = `
        ${scanControlHtml(i, ctx)}
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
      label: o.stepLabel || (o.noun + 's'),

      render(ctx) {
        if (o.passport) checkOcrAvailability();

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

        /* Flights wear the supplied reference (booking-ref.css). The other
           four products keep the split card this step has always had. */
        if (o.reference) return bkfTravellersHtml(ctx, o);

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
        /* (absent on the reference layout, where nothing is collapsed) */
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
          set('first', pax.first); set('middle', pax.middle);
          set('last', pax.last); set('gender', pax.gender);
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
            if (note) { note.textContent = ''; note.className = o.reference ? 'bkf-note' : 'bk-disclose-note'; }
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
                note.className = (o.reference ? 'bkf-note' : 'bk-disclose-note') + ' is-ok';
              }
            } catch { /* a lookup failure must never block the booking */ }
          });
        });

        /* --- passport scan: upload a photo, fill blanks from what it read --
           Same "only fill blanks" rule as the lookup above, and the same
           tolerance for failure: a bad scan reports itself and leaves the
           form exactly as usable as it was before the upload. */
        root.querySelectorAll('[data-scan-input]').forEach(input => {
          const i = Number(input.dataset.scanInput);

          input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            readInto(ctx, root);
            if (!Array.isArray(ctx.paxScan)) ctx.paxScan = [];
            ctx.paxScan[i] = { status: 'busy' };
            BookingFlow.repaint();

            try {
              const result = await BookingApi.extractPassport(file);
              const fields = (result && result.fields) || {};
              const fill = (suffix, key) => {
                const el = root.querySelector(`#p${i}_${suffix}`);
                const value = fields[key] && fields[key].value;
                if (el && value && !el.value) el.value = value;
              };
              fill('first', 'first_name'); fill('last', 'last_name');
              fill('gender', 'gender'); fill('title', 'title');
              fill('dob', 'date_of_birth'); fill('nat', 'nationality');
              fill('ppno', 'passport_number'); fill('ppexp', 'passport_expiry');
              fill('ppiss', 'issuing_country');
              readInto(ctx, root);
              ctx.paxScan[i] = { status: 'done' };
            } catch (err) {
              const message = (typeof BookingApi.errorText === 'function')
                ? BookingApi.errorText(err, 'We could not read that passport. Please enter the details by hand.')
                : 'We could not read that passport. Please enter the details by hand.';
              ctx.paxScan[i] = { status: 'error', message };
            }
            BookingFlow.repaint();
          });
        });

        root.querySelectorAll('[data-scan-edit]').forEach(btn => {
          btn.addEventListener('click', () => {
            const i = Number(btn.dataset.scanEdit);
            readInto(ctx, root);
            if (Array.isArray(ctx.paxScan)) ctx.paxScan[i] = { status: 'idle' };
            BookingFlow.repaint();
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
            if (Array.isArray(ctx.paxScan)) ctx.paxScan.splice(i, 1);
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
          const who = o.reference
            ? `${(ctx.paxKinds || [])[i] || 'Adult'} ${bkfKindNo(ctx, i)}`
            : `${o.noun} ${i + 1}`;

          if (!val(root, p + 'first')) return flag(p + 'first', `${who}: first name is required.`);
          if (!val(root, p + 'last')) return flag(p + 'last', `${who}: last name is required.`);
          if (!val(root, p + 'gender')) return flag(p + 'gender', `${who}: gender is required.`);

          /* The reference's form marks Date of Birth, Nationality, Email ID and
             Mobile Number with an asterisk. A required marker that is not
             enforced is a lie, so on that layout they are enforced; the other
             four products keep the looser rule they had. */
          if (o.reference) {
            if (!val(root, p + 'dob')) return flag(p + 'dob', `${who}: date of birth is required.`);
            if (!val(root, p + 'nat')) return flag(p + 'nat', `${who}: nationality is required.`);
          }

          /* A contact value that IS given has to be usable — a typo'd email is
             worse than a blank one, because the ticket goes to it. */
          if (i === 0) {
            const email = val(root, p + 'email');
            if (o.reference && !email) return flag(p + 'email', 'An email address is required — your ticket is sent to it.');
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              return flag(p + 'email', 'Enter a valid email address, or leave it blank.');
            }
            const mob = val(root, p + 'mobile').replace(/[\s-]/g, '');
            if (o.reference && !mob) return flag(p + 'mobile', 'A mobile number is required for booking updates.');
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
        middle: pick('middle', prev.middle),
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
        /* Flights wear the supplied reference; the other four products keep
           the tile grid this step has always had. */
        if (productType === 'flight') return bkfAddonsHtml(ctx);
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
        if (productType === 'flight') return bkfMountAddons(root, ctx);
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
     REVIEW — the flight Review screen
     ---------------------------------------------------------------------
     Built to the supplied reference: itinerary strip, then one card per thing
     the traveller can still change, a grouped Fare Summary in the sticky rail
     and a wide action bar pinned to the bottom.

     EVERY FIGURE COMES FROM ctx.pricing / ctx.quote — the server's answer.
     Nothing on this screen adds anything up.

     SEGMENTS. The screen renders a LIST of legs and is correct for any length,
     but the booking flow carries exactly one flight (`ctx.item`), and
     `customer_bookings` stores one flight per row — singular `flight_number`,
     `origin_code`, `destination_code`, with no segments table. So a real
     booking is one segment today. `ctx.segments` is read first, so the day the
     flow carries several this screen renders them without further change.
     ===================================================================== */

  function rvSegments(ctx) {
    if (Array.isArray(ctx.segments) && ctx.segments.length) return ctx.segments;
    const it = ctx.item || {};
    if (!it.origin) return [];
    return [{
      origin: it.origin, destination: it.destination,
      date: ctx.travelDate || it.date, departure: it.departure, arrival: it.arrival,
      airline: it.airline, airlineCode: it.airlineCode, flightNumber: it.flightNumber,
      stops: it.stops, durationLabel: it.durationLabel, fare: it.price,
    }];
  }

  const rvTripLabel = n => (n > 2 ? 'Multi City Trip' : n === 2 ? 'Round Trip' : 'One Way Trip');

  const rvStops = s => (s ? `${s} stop${s > 1 ? 's' : ''}` : 'Non Stop');

  /* Window / Aisle / Middle from the column letter, when the seat map did not
     already say. A 3-3 cabin is the assumption the seat step also makes. */
  function rvSeatType(seat) {
    if (!seat) return '';
    /* The seat map returns 'window' / 'aisle' / 'middle' in lower case. */
    if (seat.type) return seat.type.charAt(0).toUpperCase() + seat.type.slice(1);
    const col = String(seat.id || '').slice(-1).toUpperCase();
    if ('AF'.includes(col)) return 'Window';
    if ('CD'.includes(col)) return 'Aisle';
    if ('BE'.includes(col)) return 'Middle';
    return '';
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
      nextLabel: 'Continue to Payment',
      render(ctx) {
        const kinds = ctx.paxKinds || [];
        const editable = typeof BookingFlow !== 'undefined' && BookingFlow.goTo;
        const edit = (stepId, label) => editable
          ? `<button type="button" class="bk-edit" data-edit="${esc(stepId)}">Edit ${esc(label)}</button>`
          : '';

        /* Flights get the reference Review screen. The other four products keep
           the original panel layout below — none of them has segments, seats or
           a per-leg fare, which is most of what the reference screen is for. */
        if (ctx.kind === 'flight') return bkfReviewHtml(ctx);

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
      /* The flight rail and action bar are the flow's now (booking-flows.js),
         because the reference uses the same two on every step. Returning null
         here lets every product fall through to whatever owns them. */
      ctaNote: "You won't be charged yet",
      mount(root, ctx) {
        root.querySelectorAll('[data-edit]').forEach(btn => {
          btn.addEventListener('click', () => BookingFlow.goTo(btn.dataset.edit));
        });
        bkfWireFolds(root, ctx);
      },
    };
  }

  /* =====================================================================
     THE FLIGHT SCREENS, BUILT TO THE SUPPLIED REFERENCE
     ---------------------------------------------------------------------
     Traveller Details, Seats, Add-ons and Review share one shell: an
     itinerary card under the stepper, one white card in the main column, the
     same Fare Summary rail, and the same wide action bar. Only the card body
     changes per step, which is why these helpers live together.

     NOTHING HERE IS SPECIFIC TO THE SAMPLE DATA IN THE REFERENCE. Every
     figure, name, airline, seat and price is read off ctx / the server's
     quote; the reference supplies layout, not content.

     ICONS. JPIcon's family is the six product marks plus a handful of UI
     glyphs — it has no seat, suitcase, passport or headset — so the marks the
     reference puts on these screens are drawn here as plain inline SVG. They
     are decorative and inherit currentColor.
     ===================================================================== */

  const SVG_PATHS = {
    edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5l4 4"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0"/><path d="M16.2 5.2a3.2 3.2 0 0 1 0 5.9"/><path d="M17.6 14.4a6.2 6.2 0 0 1 3.6 5.1"/>',
    child: '<circle cx="12" cy="7" r="3"/><path d="M9 20v-4.5L7 13l1.6-2.6h6.8L17 13l-2 2.5V20"/>',
    infant: '<circle cx="12" cy="7.5" r="3.2"/><path d="M8 20c0-3 1.8-5.2 4-5.2S16 17 16 20"/>',
    seat: '<path d="M6.5 4h2.2a2 2 0 0 1 2 1.8l.7 6.2H8.4a2 2 0 0 1-2-1.8L6.5 4Z"/><path d="M11.4 12h4.4a2.4 2.4 0 0 1 0 4.8h-6a3 3 0 0 1-3-2.7"/><path d="M5 10v9"/>',
    bag: '<rect x="3.5" y="7" width="17" height="13" rx="2.2"/><path d="M9 7V5.2A1.7 1.7 0 0 1 10.7 3.5h2.6A1.7 1.7 0 0 1 15 5.2V7"/><path d="M9 11v5M15 11v5"/>',
    meal: '<path d="M6 3v7a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3"/><path d="M8 12v9"/><path d="M17.5 3c-1.4 1-2.2 2.6-2.2 4.6 0 1.6.7 2.7 2.2 3.1V21"/>',
    shield: '<path d="M12 3l7.2 3v5.3c0 4.3-3 8-7.2 9.4-4.2-1.4-7.2-5.1-7.2-9.4V6L12 3Z"/>',
    shieldCheck: '<path d="M12 3l7.2 3v5.3c0 4.3-3 8-7.2 9.4-4.2-1.4-7.2-5.1-7.2-9.4V6L12 3Z"/><path d="m9.2 11.8 2 2 3.6-3.8"/>',
    phone: '<path d="M21 16.9v2.6a2 2 0 0 1-2.2 2 19.4 19.4 0 0 1-8.5-3A19.1 19.1 0 0 1 4.4 12 19.4 19.4 0 0 1 1.5 3.4 2 2 0 0 1 3.5 1.2h2.6a2 2 0 0 1 2 1.7c.12.8.34 1.6.66 2.3a2 2 0 0 1-.45 2.1L7.2 8.5a15.6 15.6 0 0 0 6 6l1.2-1.1a2 2 0 0 1 2.1-.45c.74.32 1.52.54 2.32.66a2 2 0 0 1 1.7 2Z"/>',
    mail: '<rect x="2.8" y="5" width="18.4" height="14" rx="2.2"/><path d="m3.4 6.6 8.6 6 8.6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><path d="M12 7.7h.01"/>',
    warn: '<path d="M12 3.6 21 19.4H3L12 3.6Z"/><path d="M12 9.6v4.2"/><path d="M12 16.7h.01"/>',
    chevDown: '<path d="m5 8.5 7 7 7-7"/>',
    arrowRight: '<path d="M4.5 12h14.4"/><path d="m13 6 6 6-6 6"/>',
    plane: '<path d="M12 2.4c.88 0 1.6 1.06 1.6 2.37v3.6l7.4 4.32v2.1l-7.4-2.2v3.94l2.4 1.78v1.6L12 18.9l-4 1.2v-1.6l2.4-1.78V12.8l-7.4 2.2v-2.1l7.4-4.32v-3.6C10.4 3.46 11.12 2.4 12 2.4Z"/>',
    refresh: '<path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.1"/><path d="M20.6 4v5h-5"/><path d="M9.4 13.2a3.6 3.6 0 0 0 5.2 0"/><path d="M9 10h.01M15 10h.01"/>',
    support: '<path d="M4.4 15v-3a7.6 7.6 0 0 1 15.2 0v3"/><rect x="2.6" y="13.4" width="3.6" height="5.6" rx="1.6"/><rect x="17.8" y="13.4" width="3.6" height="5.6" rx="1.6"/><path d="M19.6 19a3.6 3.6 0 0 1-3.6 2.6h-1.8"/>',
    tag: '<path d="M3.6 11.4V4.4a.8.8 0 0 1 .8-.8h7l9 9-7.8 7.8-9-9Z"/><circle cx="7.8" cy="7.8" r="1.3"/>',
    upload: '<path d="M12 15.5V4"/><path d="m7.5 8.2 4.5-4.4 4.5 4.4"/><path d="M4.5 15.4v3.1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.1"/>',
    check: '<path d="m5 12.6 4.6 4.6L19 7.6"/>',
  };

  /** One decorative inline glyph. Unknown names render nothing rather than a
   *  broken box, matching JPIcon.html's contract. */
  function svg(name, cls) {
    const d = SVG_PATHS[name];
    if (!d) return '';
    return `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  }

  /* The reference prints "04 Jul, 2026" — no weekday. fmtDate() above is the
     flow's long form and is still what every other product uses. */
  function bkfDate(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00:00');
    if (isNaN(d)) return String(iso);
    const m = d.toLocaleDateString('en-IN', { month: 'short' });
    return `${String(d.getDate()).padStart(2, '0')} ${m}, ${d.getFullYear()}`;
  }

  const bkfInitials = p =>
    [p && p.first, p && p.last].filter(Boolean).map(s => s[0]).join('').toUpperCase() || '—';

  const bkfName = p => [p && p.title, p && p.first, p && p.middle, p && p.last]
    .filter(Boolean).join(' ').trim();

  /** How many travellers of each kind, and this one's number within its kind —
   *  the reference labels cards "Adult 1", "Child 1", not "Traveller 3". */
  function bkfKindNo(ctx, i) {
    const kinds = ctx.paxKinds || [];
    const mine = String(kinds[i] || 'Adult');
    let n = 0;
    for (let k = 0; k <= i; k++) if (String(kinds[k] || 'Adult') === mine) n++;
    return n;
  }

  /* ---- the itinerary card, above every flight step -------------------- */
  function itineraryHtml(ctx, step) {
    const segs = rvSegments(ctx);
    if (!segs.length) return '';
    const review = !!(step && step.id === 'summary');
    const n = segs.length;
    const flights = `${n} ${n === 1 ? 'Flight' : 'Flights'}`;
    const paxCount = Math.max(1, (ctx.paxKinds || []).length || ctx.paxCount || 1);
    const cabin = (typeof BookingData !== 'undefined'
      && (BookingData.CABIN_CLASSES.find(c => c.id === (ctx.cabin || 'economy')) || {}).label) || 'Economy';
    const party = (ctx.paxKinds || []).length
      ? ['Adult', 'Child', 'Infant']
          .map(k => {
            const c = ctx.paxKinds.filter(x => String(x || 'Adult') === k).length;
            return c ? `${c} ${k}${c > 1 ? (k === 'Child' ? 'ren' : 's') : ''}` : '';
          }).filter(Boolean).join(', ')
      : `${paxCount} Adult${paxCount > 1 ? 's' : ''}`;

    const cells = segs.map((s, i) => `
      <div class="bkf-seg">
        <div class="bkf-seg-top">
          <i class="bkf-n">${i + 1}</i>
          <span class="bkf-seg-route">${esc(s.origin.code)}
            <span class="bkf-arrow" aria-hidden="true">&#8594;</span>
            ${esc(s.destination.code)}</span>
        </div>
        <div class="bkf-seg-when">${esc(bkfDate(s.date))}${
          s.departure ? ` &middot; ${esc(s.departure)}${s.arrival ? ` &ndash; ${esc(s.arrival)}` : ''}` : ''}</div>
        <div class="bkf-seg-air">
          ${bkfLogo(s)}
          <span class="bkf-airline">${esc(s.airline || '')}</span>
          <span>${esc(s.flightNumber || '')}</span>
          <span class="bkf-dot" aria-hidden="true">&bull;</span>
          <span>${esc(rvStops(s.stops))}</span>
        </div>
      </div>`).join('<div class="bkf-seg-link">' + svg('plane') + '</div>');

    return `
      <section class="bkf-itin ${review ? 'is-review' : ''}" aria-label="Your itinerary">
        <div class="bkf-itin-head">
          <div class="bkf-itin-titles">
            <h2 class="bkf-itin-title">${esc(rvTripLabel(n))}</h2>
            <span class="bkf-chip">${review ? `(${flights})` : flights}</span>
            ${review ? `<span class="bkf-itin-meta">${esc(party)}<i>&middot;</i>${esc(cabin)}</span>` : ''}
          </div>
          <button type="button" class="bkf-obtn" data-bk-exit="1">
            ${svg('edit')}<span>${review ? 'Edit Search' : 'Change Flights'}</span>
          </button>
        </div>
        <div class="bkf-itin-segs">${cells}</div>
      </section>`;
  }

  function bkfLogo(seg) {
    const code = seg.airlineCode
      || (typeof TravelData !== 'undefined' && TravelData.airlineCode ? TravelData.airlineCode(seg.flightNumber) : '');
    const files = (typeof AIRLINE_LOGO_FILES !== 'undefined') ? AIRLINE_LOGO_FILES : null;
    if (files && code && files[code]) {
      const dir = (typeof AIRLINE_LOGO_DIR === 'string') ? AIRLINE_LOGO_DIR : 'assets/images/airlines/';
      return `<span class="bkf-logo"><img src="${esc(dir + files[code])}" alt=""
        width="26" height="26" decoding="async" loading="lazy"></span>`;
    }
    return `<span class="bkf-logo"><span class="bkf-logo-fb">${esc(code || '✈')}</span></span>`;
  }

  /* ---- the Fare Summary rail, identical on every flight step ---------- */
  /* THE SERVER'S OWN BREAKDOWN, GROUPED. Nothing here adds anything up: the
     lines, their labels and the total are whatever the last quote returned
     (customer_pricing_service.py). The grouping is presentational. */
  function bkfFareHtml(ctx, h, step) {
    /* The reference draws no coupon entry box on Traveller Details, Seats or
       Add-ons — only the applied state, on Review. So the control lives on
       Review, and the three steps before it look exactly as supplied. */
    const onReview = !!(step && step.id === 'summary');
    const segs = rvSegments(ctx);
    const p = ctx.pricing || { lines: [], total: 0 };
    const lines = p.lines || [];

    const isSeat = l => /seat/i.test(l.label || '');
    const isDiscount = l => Number(l.amount) < 0 || /discount/i.test(l.label || '');
    const isAddon = l => !isSeat(l) && !isDiscount(l)
      && /baggage|meal|priorit|service|add-?on/i.test(l.label || '');

    const seatLines = lines.filter(isSeat);
    const discountLines = lines.filter(isDiscount);
    const addonLines = lines.filter(isAddon);
    const mainLines = lines.filter(l => !isSeat(l) && !isDiscount(l) && !isAddon(l));
    const addonSum = addonLines.reduce((t, l) => t + Number(l.amount || 0), 0);

    const money2 = n => money(Math.abs(Number(n || 0)));
    const rule = '<div class="bkf-rule"></div>';

    const segRows = segs.length > 1 ? segs.map((s, i) => `
      <div class="bkf-fare-seg">
        <span><i class="bkf-n">${i + 1}</i>${esc(s.origin.code)}
          <span class="bkf-arrow" aria-hidden="true">&#8594;</span> ${esc(s.destination.code)}</span>
        <span>${s.fare ? esc(money(s.fare)) : ''}${svg('chevDown')}</span>
      </div>`).join('') : '';

    const seatBlock = seatLines.length ? `
      <div class="bkf-fare-trip">Seat(s)</div>
      ${seatLines.map(l => `
        <div class="bk-price-line"><span>${esc(bkfSeatScope(ctx))}</span>
          <span>${esc(money(l.amount))}</span></div>`).join('')}
      ${rule}` : '';

    const addonBlock = addonLines.length ? `
      ${rule}
      <details class="bkf-fare-group" open>
        <summary><span>Add-ons</span>
          <span class="bkf-amt">${esc(money(addonSum))}${svg('chevDown')}</span></summary>
        ${addonLines.map(l => `
          <div class="bk-price-line is-sub"><span>${esc(l.label)}</span>
            <span>${l.free ? 'Included' : esc(money(l.amount))}</span></div>`).join('')}
      </details>` : '';

    /* The applied coupon: its value is the server's Discount line, the pill
       and Remove are the control. #bkCouponRemove is what mountSide() wires,
       so applying and removing stay one implementation. */
    const discountBlock = discountLines.length ? `
      ${rule}
      ${discountLines.map(l => `
        <div class="bk-price-line is-discount"><span>Discount</span>
          <span>&minus; ${esc(money2(l.amount))}</span></div>`).join('')}
      ${ctx.couponCode ? `
        <div class="bkf-coupon-row">
          <span class="bkf-coupon-tag">${esc(ctx.couponCode)} Applied</span>
          <button type="button" class="bkf-edit" id="bkCouponRemove">Remove</button>
        </div>` : ''}` : '';

    return `
      <div class="bk-price bkf-fare">
        <div class="bkf-fare-head">
          <h3 class="bkf-fare-title">Fare Summary</h3>
          <button type="button" class="bkf-chev" data-bkf-fold="fare"
                  aria-label="Collapse fare summary">${svg('chevDown')}</button>
        </div>
        <div class="bkf-fare-body">
          ${segs.length ? `<div class="bkf-fare-trip">${esc(rvTripLabel(segs.length))}
            <span style="font-weight:500">(${segs.length} ${segs.length === 1 ? 'Flight' : 'Flights'})</span></div>` : ''}
          ${segRows}
          ${segRows ? rule : ''}
          ${seatBlock}
          ${mainLines.map(l => `
            <div class="bk-price-line"><span>${esc(l.label)}</span>
              <span>${l.free ? 'Included' : esc(money(l.amount))}</span></div>`).join('')
            || '<p class="bk-price-empty">Choose an option to see the fare.</p>'}
          ${addonBlock}
          ${discountBlock}
          <div class="bk-price-total"><span>Total Amount</span><span>${esc(money(p.total))}</span></div>
          <p class="bkf-incl">Inclusive of all taxes</p>
          ${(ctx.couponCode || !onReview) ? '' : h.couponHtml()}
          ${p.note ? `<p class="bk-price-note ${p.noteIsError ? 'is-error' : ''}"
              ${p.noteIsError ? 'role="alert"' : ''}>${esc(p.note)}</p>` : ''}
        </div>
      </div>
      <div class="bkf-assure">
        ${svg('refresh')}
        <div><b>Free Cancellation</b><span>Cancel within 24 hours of booking</span></div>
      </div>
      <ul class="bkf-benefits">
        <li>${svg('tag')}<div><b>Best Price Guarantee</b><span>We promise you the lowest price</span></div></li>
        <li>${svg('shieldCheck')}<div><b>Secure Booking</b><span>Your data is 100% protected</span></div></li>
        <li>${svg('support')}<div><b>24/7 Customer Support</b><span>We're here to help you anytime</span></div></li>
      </ul>`;
  }

  function bkfSeatScope(ctx) {
    const n = (ctx.seats || []).filter(Boolean).length || 1;
    return `${n} Traveller${n > 1 ? 's' : ''}`;
  }

  /* ---- the wide action bar, identical on every flight step ------------ */
  function bkfFootHtml(ctx) {
    const segs = rvSegments(ctx);
    const p = ctx.pricing || { total: 0 };
    const legs = segs.map((s, i) => `
      <div class="bkf-foot-leg">
        <i class="bkf-n">${i + 1}</i>
        <div><b>${esc(s.origin.code)} <span aria-hidden="true">&#8594;</span> ${esc(s.destination.code)}</b>
          <span>${esc(bkfDate(s.date))}</span></div>
      </div>`).join('');
    return `
      <div class="bkf-foot-trust">
        ${svg('shieldCheck')}
        <div><b>Secure Booking</b><span>Your data is 100% protected</span></div>
      </div>
      <div class="bkf-foot-legs">${legs}</div>
      <div class="bkf-foot-total">
        <span>Total Amount</span>
        <b>${esc(money(p.total))}</b>
        <span class="bkf-foot-incl">Inclusive of all taxes ${svg('info')}</span>
      </div>`;
  }

  /* ---- fields, the reference's shape: label above a 42px control -------- */
  function bkfField(o) {
    const id = esc(o.id);
    const req = o.required ? '<span class="req">*</span>' : '';
    const opt = o.optional ? ' <span class="opt">(Optional)</span>' : '';
    let control;
    if (o.type === 'select') {
      control = `<select id="${id}" name="${id}">
          ${o.placeholder !== false ? `<option value="">${esc(o.placeholder || 'Select')}</option>` : ''}
          ${(o.options || []).map(v => {
            const value = typeof v === 'string' ? v : v.value;
            const label = typeof v === 'string' ? v : v.label;
            return `<option value="${esc(value)}"${o.value === value ? ' selected' : ''}>${esc(label)}</option>`;
          }).join('')}
        </select>`;
    } else {
      control = `<input id="${id}" name="${id}" type="${esc(o.type || 'text')}"
        value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}"
        ${o.max ? `max="${esc(o.max)}"` : ''} ${o.min ? `min="${esc(o.min)}"` : ''}
        ${o.inputmode ? `inputmode="${esc(o.inputmode)}"` : ''}
        ${o.autocomplete ? `autocomplete="${esc(o.autocomplete)}"` : ''}>`;
    }
    return `<div class="bkf-f ${o.span ? 'span' + o.span : ''}">
        <label for="${id}">${esc(o.label)}${req}${opt}</label>${control}
        ${o.note ? `<p class="bkf-note" id="${id}-note" role="status" aria-live="polite"></p>` : ''}
      </div>`;
  }

  /** The mobile field: dial code + number in one grid slot, one label. */
  function bkfTelField(i) {
    const p = `p${i}_`;
    return `<div class="bkf-f span2">
        <label for="${p}mobile">Mobile Number<span class="req">*</span></label>
        <div class="bkf-tel">
          <select id="${p}ccode" name="${p}ccode" aria-label="Country dialling code">
            ${COUNTRY_CODES.map(c => {
              const dial = c.split(' ')[0];
              return `<option value="${esc(c)}"${c === '+91 India' ? ' selected' : ''}>${esc(dial)}</option>`;
            }).join('')}
          </select>
          <input id="${p}mobile" name="${p}mobile" type="tel" inputmode="numeric"
                 autocomplete="tel" placeholder="Enter mobile number">
        </div>
      </div>`;
  }

  /* ---- one traveller card ---------------------------------------------- */
  function bkfPaxCard(i, ctx, o) {
    const p = `p${i}_`;
    const kind = String((ctx.paxKinds || [])[i] || 'Adult');
    const intl = !!(o.passport && typeof BookingApi !== 'undefined' && BookingApi.isInternational(ctx.item));
    const lead = i === 0;
    const icons = { Adult: 'user', Child: 'child', Infant: 'infant' };

    const fields = [
      bkfField({ id: p + 'title', label: 'Title', type: 'select',
                 options: BookingData.TITLES, placeholder: 'Mr' }),
      bkfField({ id: p + 'first', label: 'First Name', required: true, autocomplete: 'given-name',
                 placeholder: 'Enter first name' }),
      bkfField({ id: p + 'middle', label: 'Middle Name', optional: true,
                 autocomplete: 'additional-name', placeholder: 'Enter middle name' }),
      bkfField({ id: p + 'last', label: 'Last Name', required: true, autocomplete: 'family-name',
                 placeholder: 'Enter last name' }),
      bkfField({ id: p + 'dob', label: 'Date of Birth', required: true, type: 'date',
                 max: new Date().toISOString().slice(0, 10) }),
      bkfField({ id: p + 'gender', label: 'Gender', type: 'select', required: true,
                 options: BookingData.GENDERS, placeholder: 'Select' }),
      bkfField({ id: p + 'nat', label: 'Nationality', type: 'select', required: true,
                 options: BookingData.NATIONALITIES, value: 'India' }),
      o.frequentFlyer
        ? bkfField({ id: p + 'ff', label: 'Frequent Flyer', optional: true,
                     placeholder: 'Enter FF number' })
        : '',
      lead ? bkfField({ id: p + 'email', label: 'Email ID', required: true, type: 'email',
                        autocomplete: 'email', placeholder: 'Enter email address', span: 2 }) : '',
      lead ? bkfTelField(i) : '',
    ].join('');

    /* Passport is asked for where it is actually needed. The reference is a
       domestic itinerary and shows no passport block; an international one
       requires the details, and that is the case OCR exists for. */
    const passport = intl ? `
      <div class="bkf-passport">
        <div class="bkf-group-head">${bkfIc('shield')}<h3>Passport Details</h3></div>
        ${bkfScanHtml(i, ctx)}
        <p class="bkf-note" id="${p}ppnote" role="status" aria-live="polite"></p>
        <div class="bkf-grid">
          ${bkfField({ id: p + 'ppno', label: 'Passport Number', required: true, placeholder: 'e.g. M1234567' })}
          ${bkfField({ id: p + 'ppexp', label: 'Passport Expiry', required: true, type: 'date',
                       min: new Date().toISOString().slice(0, 10) })}
          ${bkfField({ id: p + 'ppiss', label: 'Issuing Country', type: 'select',
                       options: BookingData.NATIONALITIES, value: 'India' })}
        </div>
      </div>` : '';

    return `<div class="bkf-pax" data-pax="${i}">
        <div class="bkf-pax-head">
          <div class="bkf-pax-who">
            ${bkfIc(icons[kind] || 'user')}
            <h3>${esc(kind)} ${bkfKindNo(ctx, i)}</h3>
            ${lead ? '<span class="bkf-pill">Lead Traveller</span>' : ''}
          </div>
          <div class="bkf-pax-right">
            ${lead ? `<label class="bkf-switch">
              <span>Save to my profile</span>
              <input type="checkbox" id="bkSaveTravellers" ${ctx.saveTravellers ? 'checked' : ''}><i></i>
            </label>` : `<button type="button" class="bkf-pax-remove" data-remove="${i}">Remove</button>`}
          </div>
        </div>
        <div class="bkf-pax-body">
          <div class="bkf-grid">${fields}</div>
          ${passport}
        </div>
      </div>`;
  }

  const bkfIc = name => `<span class="bkf-ic">${svg(name)}</span>`;

  /** "Upload Passport" — absent entirely where no OCR provider is configured,
   *  so there is never a control that fails when pressed. Same states and the
   *  same ids as before; only the styling is the reference's. */
  function bkfScanHtml(i, ctx) {
    if (!_ocrAvailable) return '';
    const scan = (ctx.paxScan && ctx.paxScan[i]) || { status: 'idle' };
    const busy = scan.status === 'busy';
    if (scan.status === 'done') {
      return `<div class="bkf-scan">
        <p class="bkf-scan-msg is-ok">&#10003; Passport details detected</p>
        <button type="button" class="bkf-obtn" data-scan-edit="${i}">Edit Details</button>
      </div>`;
    }
    return `<div class="bkf-scan">
      <input type="file" id="p${i}_ppscan" data-scan-input="${i}"
             accept="image/jpeg,image/png,image/webp,application/pdf" ${busy ? 'disabled' : ''}>
      <label class="bkf-scan-btn ${busy ? 'is-busy' : ''}" for="p${i}_ppscan">
        ${svg('upload')}<span>${busy ? 'Reading your passport…' : 'Upload Passport'}</span>
      </label>
      <span class="bkf-scan-hint">Upload a clear passport image to fill these details automatically.</span>
      ${scan.status === 'error' ? `<p class="bkf-scan-msg is-bad" role="alert">${esc(scan.message)}</p>` : ''}
    </div>`;
  }

  /* ---- the whole Traveller Details step -------------------------------- */
  function bkfTravellersHtml(ctx, o) {
    const kinds = ctx.paxKinds || [];
    const idx = kind => kinds.map((k, i) => [k, i])
      .filter(([k]) => String(k || 'Adult') === kind).map(([, i]) => i);
    const cards = list => list.map(i => bkfPaxCard(i, ctx, o)).join('');
    const canAdd = kinds.length < 9;

    const group = (kind, icon, heading, addId, addLabel) => `
      <div class="bkf-group">
        <div class="bkf-group-head">${bkfIc(icon)}<h3>${esc(heading)}</h3></div>
        ${cards(idx(kind))}
        ${canAdd ? `<div class="bkf-add"><button type="button" class="bkf-addbtn" id="${addId}">+ ${esc(addLabel)}</button></div>` : ''}
      </div>`;

    return `<div class="bk-step bkf-step">
      <section class="bkf-card">
        <div class="bkf-card-head has-rule">
          <div>
            <h2 class="bkf-h2">Traveller Details</h2>
            <p class="bkf-sub">Enter details as per government ID proof</p>
          </div>
        </div>
        <div class="bkf-card-body">
          ${cards(idx('Adult'))}
          ${canAdd ? `<div class="bkf-add"><button type="button" class="bkf-addbtn" id="bkAddAdult">+ Add Adult</button></div>` : ''}
          ${group('Child', 'child', 'Children', 'bkAddChild', 'Add Child')}
          ${group('Infant', 'infant', 'Infants', 'bkAddInfant', 'Add Infant')}
          <div class="bkf-strip is-warn" style="margin-top:20px">
            ${svg('info')}
            <span>Names must match government-issued ID proof. Corrections are not allowed after booking.</span>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* =====================================================================
     ADD-ONS, the reference's "Customize your journey"
     ---------------------------------------------------------------------
     The catalogue is the server's (GET /api/customer/addons): baggage, meal
     and service rows with their own codes and prices. Baggage and meals are
     one-of within their group, as the reference's radio cards are; the other
     services are independent, which is why they keep tick boxes.

     PER PASSENGER IS REAL. The quote endpoint already takes
     {code, passenger_index} and charges qty 1 when an index is named
     (customer_pricing_service.price_addons), so the Passenger selector picks
     who an extra is bought for rather than decorating the screen.
     ===================================================================== */
  const BKF_ADDON_TABS = [
    { key: 'baggage', label: 'Baggage', title: 'Baggage', icon: 'bag' },
    { key: 'meal', label: 'Meals', title: 'Meals', icon: 'meal' },
    { key: 'service', label: 'Other Add-ons', title: 'Other Add-ons', icon: 'shield' },
  ];

  const bkfAddonKey = (a, i) => `${a.id}#${i == null ? '' : i}`;

  /** Illustration for an option card. No photography exists in this project,
   *  so these are drawn — a case whose size tracks the allowance, a tray for
   *  a meal, a mark for everything else. */
  function bkfArt(group, n, tone) {
    const fills = ['#C9CFD8', '#8FB6E8', '#6E9BE0', '#A98BD8', '#E8A05C'];
    const c = fills[Math.min(n, fills.length - 1)];
    if (group === 'baggage') {
      const h = 26 + Math.min(n, 4) * 4;
      return `<svg width="46" height="52" viewBox="0 0 46 52" fill="none" aria-hidden="true">
        <rect x="17" y="${44 - h - 8}" width="12" height="8" rx="3" stroke="#98A2B3" stroke-width="2"/>
        <rect x="8" y="${44 - h}" width="30" height="${h}" rx="4" fill="${c}"/>
        <rect x="14" y="${44 - h}" width="3" height="${h}" fill="rgba(255,255,255,.5)"/>
        <rect x="29" y="${44 - h}" width="3" height="${h}" fill="rgba(255,255,255,.5)"/>
        <rect x="11" y="44" width="4" height="4" rx="1.4" fill="#98A2B3"/>
        <rect x="31" y="44" width="4" height="4" rx="1.4" fill="#98A2B3"/>
      </svg>`;
    }
    if (group === 'meal') {
      const food = tone || '#E8A05C';
      return `<svg width="52" height="44" viewBox="0 0 52 44" fill="none" aria-hidden="true">
        <rect x="4" y="10" width="44" height="26" rx="4" fill="#EEF1F5"/>
        <rect x="8" y="14" width="20" height="18" rx="3" fill="${food}"/>
        <circle cx="38" cy="20" r="5" fill="#9CC98A"/>
        <rect x="32" y="27" width="12" height="5" rx="2.5" fill="#D8DEE7"/>
      </svg>`;
    }
    return `<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <circle cx="22" cy="22" r="16" fill="#EEF1F5"/>
      <g transform="translate(11,11)" stroke="#7E8CA0" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round" fill="none">${SVG_PATHS.shieldCheck}</g>
    </svg>`;
  }

  function bkfAddonsHtml(ctx) {
    const cat = ctx.addonCatalogue || [];
    const segs = rvSegments(ctx);
    const chosen = new Map((ctx.addons || []).map(a => [bkfAddonKey(a, a.passengerIndex), a]));
    /* MUST default the same way bkfMountAddons does (0, not null): the mount
       stores `passengerIndex: 0` on the chosen add-on, so a render that looked
       for `passengerIndex: null` matched nothing and every group kept showing
       its "none" card as selected. */
    const who = ctx.addonPax == null ? 0 : Number(ctx.addonPax);
    const people = (ctx.paxKinds || ['Adult']).map((k, i) => {
      const p = (ctx.passengers || [])[i] || {};
      const name = [p.first, p.last].filter(Boolean).join(' ').trim();
      return { i, label: `${i + 1}. ${name || `${k} ${bkfKindNo(ctx, i)}`}` };
    });
    const active = ctx.addonSector == null ? 0 : Number(ctx.addonSector);

    const sectorRow = segs.length ? `
      <div class="bkf-sectors" role="tablist" aria-label="Flight">
        ${segs.map((s, i) => `
          <button type="button" class="bkf-sector ${i === active ? 'is-on' : ''}"
                  data-sector="${i}" role="tab" aria-selected="${i === active}">
            <b>${esc(s.origin.code)} <span aria-hidden="true">&#8594;</span> ${esc(s.destination.code)}</b>
            <span>${esc([s.airline, s.flightNumber].filter(Boolean).join(' '))}</span>
          </button>`).join('')}
      </div>` : '';

    /* "Best Value" goes to the cheapest rupee per kilo the catalogue offers —
       derived, not decided here. */
    const kg = a => { const m = /(\d+)\s*kg/i.exec(a.name || ''); return m ? Number(m[1]) : 0; };
    const bagRows = cat.filter(a => a.group === 'baggage');
    let bestId = null;
    bagRows.forEach(a => {
      if (!kg(a) || !a.price) return;
      const rate = a.price / kg(a);
      if (bestId === null || rate < bestId.rate) bestId = { id: a.id, rate };
    });

    const noneCard = (group, title, note) => `
      <label class="bkf-opt ${!bkfGroupPick(ctx, group, who) ? 'is-on' : ''}" data-none="${group}">
        <input type="radio" name="bkf-${group}" ${!bkfGroupPick(ctx, group, who) ? 'checked' : ''}>
        <span class="bkf-opt-top"><span class="bkf-radio"></span>
          <span class="bkf-opt-txt"><b>${esc(title)}</b><span>${esc(note)}</span></span></span>
        <span class="bkf-opt-art">${bkfArt(group, 0)}</span>
        <span class="bkf-opt-foot"><span class="bkf-opt-price is-free">Included</span></span>
      </label>`;

    const optCard = (a, n, single) => {
      const on = chosen.has(bkfAddonKey(a, who));
      return `
      <label class="bkf-opt ${on ? 'is-on' : ''}" data-addon="${esc(a.id)}" data-group="${esc(a.group)}">
        <input type="${single ? 'radio' : 'checkbox'}" ${single ? `name="bkf-${esc(a.group)}"` : ''} ${on ? 'checked' : ''}>
        <span class="bkf-opt-top">
          <span class="bkf-radio ${single ? '' : 'is-box'}"></span>
          <span class="bkf-opt-txt"><b>${esc(bkfShortName(a))}</b><span>${esc(a.note || '')}</span></span>
        </span>
        <span class="bkf-opt-art">${bkfArt(a.group, n + 1, bkfMealTone(a))}</span>
        <span class="bkf-opt-foot">
          <span class="bkf-opt-price ${a.price ? '' : 'is-free'}">${a.price ? esc(money(a.price)) : 'Free'}</span>
          ${bestId && bestId.id === a.id ? '<span class="bkf-best">Best Value</span>' : ''}
        </span>
      </label>`;
    };

    const section = tab => {
      const rows = cat.filter(a => a.group === tab.key);
      if (!rows.length) return '';
      const single = tab.key !== 'service';
      const none = tab.key === 'baggage'
        ? noneCard('baggage', 'No Extra Baggage', bkfIncludedNote(cat, 'baggage'))
        : tab.key === 'meal' ? noneCard('meal', 'No Meal', 'Complimentary') : '';
      return `
        <section class="bkf-sect" data-sect="${esc(tab.key)}">
          <div class="bkf-sect-head">
            ${bkfIc(tab.icon)}<h3>${esc(tab.title)}</h3>
            <span class="bkf-hint">Prices are per passenger per sector</span>
          </div>
          ${sectorRow}
          <div class="bkf-opts">${none}${rows.map((a, n) => optCard(a, n, single)).join('')}</div>
          ${bkfApplyAllHtml(segs, tab)}
        </section>`;
    };

    return `<div class="bk-step bkf-step">
      <section class="bkf-card">
        <div class="bkf-card-head">
          <div>
            <h2 class="bkf-h2">Customize your journey</h2>
            <p class="bkf-sub">Add baggage, meals and other services for a more comfortable trip.</p>
          </div>
          <div class="bkf-paxpick">
            <span>Passenger</span>
            <select id="bkfAddonPax" aria-label="Passenger these add-ons are for">
              ${people.map(x => `<option value="${x.i}"${x.i === who ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="bkf-tabs" role="tablist" aria-label="Add-on type">
          ${BKF_ADDON_TABS.filter(t => cat.some(a => a.group === t.key)).map((t, i) => `
            <button type="button" class="bkf-tab ${i === 0 ? 'is-on' : ''}" data-tab="${esc(t.key)}"
                    role="tab" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}
        </div>
        ${BKF_ADDON_TABS.map(section).join('')}
      </section>
    </div>`;
  }


  /* "Apply to all flights" is in the reference, and it cannot be honest here:
     an add-on in this backend carries a code and (optionally) a passenger, and
     no segment at all — customer_pricing_service.price_addons has no per-leg
     dimension to apply anything TO. So it is rendered only once a booking
     genuinely carries more than one leg, and until then there is no switch
     that silently does nothing. See docs/ for the multi-city note. */
  function bkfApplyAllHtml(segs, tab) {
    if (segs.length < 2) return '';
    return `
      <div class="bkf-applyall">
        <span class="bkf-bullet" aria-hidden="true"></span>
        <p>Add ${esc(tab.title.toLowerCase())} for all remaining flights in this trip.</p>
        <label class="bkf-switch"><span>Apply to all flights</span>
          <input type="checkbox" data-applyall="${esc(tab.key)}"><i></i></label>
      </div>`;
  }

  /** What is already in the fare, in the reference's short form. */
  function bkfIncludedNote(cat, group) {
    const inc = (cat.included || []).map(b => b.allowance).filter(Boolean);
    return inc.length ? `${inc.join(' + ')} included` : 'Included in your fare';
  }

  /** The catalogue names things for an API ("Extra baggage 10 kg"); the
   *  reference's card leads with the number. Nothing is invented — this only
   *  moves the allowance to the front of the name the server gave. */
  function bkfShortName(a) {
    const m = /(\d+\s*kg)/i.exec(a.name || '');
    if (a.group === 'baggage' && m) return `+${m[1].replace(/\s+/g, ' ')}`;
    return a.name || '';
  }

  function bkfMealTone(a) {
    const n = (a.name || '').toLowerCase();
    if (n.includes('non-veg') || n.includes('non veg')) return '#C4603F';
    if (n.includes('special')) return '#D7B45A';
    return '#7FA96A';
  }

  /** The add-on currently chosen in a one-of group, for this passenger. */
  function bkfGroupPick(ctx, group, who) {
    return (ctx.addons || []).find(a => a.group === group
      && Number(a.passengerIndex == null ? 0 : a.passengerIndex) === Number(who == null ? 0 : who));
  }

  /* ---- Add-ons: wiring ------------------------------------------------
     Every change writes to ctx.addons and asks the flow to re-price, so the
     rail moves as boxes are ticked. `passengerIndex` is what the quote
     endpoint already understands, so who an extra is for survives all the way
     to the booking. */
  function bkfMountAddons(root, ctx) {
    const cat = ctx.addonCatalogue || [];
    const who = () => (ctx.addonPax == null ? 0 : Number(ctx.addonPax));
    const mine = a => Number(a.passengerIndex == null ? 0 : a.passengerIndex) === who();

    const pax = root.querySelector('#bkfAddonPax');
    if (pax) pax.addEventListener('change', () => {
      ctx.addonPax = Number(pax.value);
      BookingFlow.repaint();
    });

    /* The tabs are jump links, not filters: the reference shows every section
       on the page with the tab marking where you are. */
    root.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('[data-tab]').forEach(b => {
          const on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-selected', String(on));
        });
        const sect = root.querySelector(`[data-sect="${btn.dataset.tab}"]`);
        if (sect) sect.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });

    root.querySelectorAll('[data-sector]').forEach(btn => {
      btn.addEventListener('click', () => {
        ctx.addonSector = Number(btn.dataset.sector);
        BookingFlow.repaint();
      });
    });

    const drop = group => {
      ctx.addons = (ctx.addons || []).filter(a => !(a.group === group && mine(a)));
    };

    root.querySelectorAll('[data-none]').forEach(label => {
      const input = label.querySelector('input');
      if (!input) return;
      input.addEventListener('change', () => {
        drop(label.dataset.none);
        BookingFlow.repaint();
        BookingFlow.refreshPrice();
      });
    });

    root.querySelectorAll('[data-addon]').forEach(label => {
      const input = label.querySelector('input');
      if (!input) return;
      input.addEventListener('change', () => {
        const item = cat.find(a => a.id === label.dataset.addon);
        if (!item) return;
        const picked = Object.assign({}, item, { passengerIndex: who() });
        if (input.type === 'radio') {
          drop(item.group);                       // one baggage, one meal
          ctx.addons.push(picked);
        } else if (input.checked) {
          ctx.addons.push(picked);
        } else {
          ctx.addons = ctx.addons.filter(a => !(a.id === item.id && mine(a)));
        }
        BookingFlow.repaint();
        BookingFlow.refreshPrice();
      });
    });
  }

  /* =====================================================================
     REVIEW, the reference's "Review your booking"
     ---------------------------------------------------------------------
     One card per thing that can still be changed, each with an Edit that
     jumps back to the step that owns it. The itinerary card above it is the
     shell's (see itineraryHtml) — the Review variant, which is the one that
     names the party and the cabin and offers "Edit Search".
     ===================================================================== */
  function bkfReviewHtml(ctx) {
    const editable = typeof BookingFlow !== 'undefined' && BookingFlow.goTo;
    const segs = rvSegments(ctx);
    const edit = (stepId, what) => editable
      ? `<button type="button" class="bkf-edit" data-edit="${esc(stepId)}"
           aria-label="Edit ${esc(what)}">Edit</button>` : '';
    const fold = key => `<button type="button" class="bkf-chev" data-bkf-fold="${esc(key)}"
        aria-label="Collapse section">${svg('chevDown')}</button>`;

    return `<div class="bk-step bkf-step bk-rv">
      <div class="bkf-rv-head">
        <div>
          <h2 class="bkf-h2">Review your booking</h2>
          <p class="bkf-sub">Please review your details before proceeding to payment.</p>
        </div>
        ${editable ? `<button type="button" class="bkf-obtn" data-edit="travellers"
            aria-label="Edit all booking details">${svg('edit')}<span>Edit All</span></button>` : ''}
      </div>
      ${bkfRvTravellerHtml(ctx, edit)}
      ${bkfRvSeatsHtml(ctx, segs, edit, fold)}
      ${bkfRvAddonsHtml(ctx, segs, edit, fold)}
      ${bkfRvContactHtml(ctx, edit)}
      ${bkfRvInfoHtml(ctx)}
    </div>`;
  }

  function bkfRvTravellerHtml(ctx, edit) {
    const p = (ctx.passengers || [])[0] || {};
    const kinds = ctx.paxKinds || [];
    /* "Verified" has to mean verified: this reports whether the fields the
       traveller step requires are actually on the draft, rather than assuming
       that reaching Review implies they are. */
    const intl = ctx.item && typeof BookingApi !== 'undefined' && BookingApi.isInternational
      ? BookingApi.isInternational(ctx.item) : false;
    const missing = [];
    if (!p.first || !p.last) missing.push('name');
    if (!p.dob) missing.push('date of birth');
    if (!p.nationality) missing.push('nationality');
    if (intl && !p.passportNumber) missing.push('passport');
    const ok = missing.length === 0;

    const meta = [kinds[0] || p.kind || 'Adult', p.gender, p.dob ? bkfDate(p.dob) : '',
                  p.nationality ? bkfNationalityAdj(p.nationality) : ''].filter(Boolean);
    const email = (ctx.contact && ctx.contact.email) || p.email || '';
    const phone = bkfPhone(p, ctx);

    const others = (ctx.passengers || []).slice(1).map((q, i) => `
      <div class="bkf-rvpax-more">
        <span class="bkf-avatar is-sm">${esc(bkfInitials(q))}</span>
        <div><b>${esc(bkfName(q))}</b>
          <span>${esc([kinds[i + 1] || q.kind || 'Adult', q.gender,
                       q.dob ? bkfDate(q.dob) : ''].filter(Boolean).join(' · '))}</span></div>
      </div>`).join('');

    return `
      <section class="bkf-card bkf-rvcard">
        <div class="bkf-card-head">
          <h3 class="bkf-rvtitle">${bkfIc('users')}<span>Traveller Details</span></h3>
          <div class="bkf-rvright">
            <span class="bkf-verified ${ok ? '' : 'is-warn'}">${ok ? '&#10003; Details Verified' : 'Needs attention'}</span>
            ${edit('travellers', 'traveller details')}
          </div>
        </div>
        <div class="bkf-card-body">
          <div class="bkf-rvpax">
            <span class="bkf-avatar">${esc(bkfInitials(p))}</span>
            <div class="bkf-rvpax-main">
              <div class="bkf-rvpax-name"><b>${esc(bkfName(p) || 'Traveller 1')}</b>
                <span class="bkf-pill">Lead Traveller</span></div>
              <div class="bkf-rvpax-meta">${meta.map(esc).join('<i aria-hidden="true">·</i>')}</div>
              ${!ok ? `<p class="bkf-warn">Missing: ${esc(missing.join(', '))}</p>` : ''}
              ${(email || phone) ? `<div class="bkf-rvpax-contact">
                ${email ? `<span>${svg('mail')}${esc(email)}</span>` : ''}
                ${phone ? `<span>${svg('phone')}${esc(phone)}</span>` : ''}
              </div>` : ''}
            </div>
          </div>
          ${others}
        </div>
      </section>`;
  }

  /** "Indian" reads better than "India" on a traveller line, which is what the
   *  reference prints. Only the handful the portal actually sells to. */
  function bkfNationalityAdj(n) {
    const map = {
      'India': 'Indian', 'United Arab Emirates': 'Emirati', 'Saudi Arabia': 'Saudi',
      'Singapore': 'Singaporean', 'Thailand': 'Thai', 'United Kingdom': 'British',
      'United States': 'American', 'Australia': 'Australian', 'Canada': 'Canadian',
      'Germany': 'German', 'France': 'French', 'Malaysia': 'Malaysian',
      'Sri Lanka': 'Sri Lankan', 'Nepal': 'Nepali', 'Qatar': 'Qatari', 'Oman': 'Omani',
      'Bahrain': 'Bahraini', 'Kuwait': 'Kuwaiti', 'Maldives': 'Maldivian',
      'Indonesia': 'Indonesian',
    };
    return map[n] || n;
  }

  function bkfPhone(p, ctx) {
    const c = (ctx.contact && ctx.contact.phone) || '';
    if (c) return c;
    if (!p.mobile) return '';
    const dial = String(p.countryCode || '+91 India').split(' ')[0];
    return `${dial} ${p.mobile}`;
  }

  function bkfRvSeatsHtml(ctx, segs, edit, fold) {
    const rows = (ctx.passengers || []).map((p, i) => {
      const seat = (ctx.seats || [])[i];
      const seg = segs[Math.min(i, segs.length - 1)] || segs[0];
      if (!seat || !seg) return '';
      return `
        <div class="bkf-row">
          <div class="bkf-row-lead">${bkfLogo(seg)}
            <div><b>${esc(seg.origin.code)} <span aria-hidden="true">&#8594;</span> ${esc(seg.destination.code)}</b>
              <span>${esc(bkfDate(seg.date))} &middot; ${esc([seg.airline, seg.flightNumber].filter(Boolean).join(' '))}</span></div>
          </div>
          <div class="bkf-row-facts">
            <div><span>Seat</span><b class="is-seat">${esc(seat.id)}</b></div>
            <div><span>Type</span><b>${esc(rvSeatType(seat) || '—')}</b></div>
          </div>
          ${edit('seats', 'seats')}
        </div>`;
    }).filter(Boolean).join('');
    if (!rows) return '';
    return `
      <section class="bkf-card bkf-rvcard" data-fold="seats">
        <div class="bkf-card-head">
          <h3 class="bkf-rvtitle">${bkfIc('seat')}<span>Seats</span></h3>
          <div class="bkf-rvright">${fold('seats')}</div>
        </div>
        <div class="bkf-card-body bkf-rows">${rows}</div>
      </section>`;
  }

  function bkfRvAddonsHtml(ctx, segs, edit, fold) {
    const all = ctx.addons || [];
    if (!all.length) return '';
    const scope = i => {
      const who = i == null ? null : Number(i);
      if (who == null) return segs.length === 1 && segs[0]
        ? `${segs[0].origin.code} → ${segs[0].destination.code}` : 'All Flights';
      const p = (ctx.passengers || [])[who] || {};
      return [p.first, p.last].filter(Boolean).join(' ') || `Traveller ${who + 1}`;
    };
    const groups = [
      ['baggage', 'Baggage', 'bag'],
      ['meal', 'Meals', 'meal'],
      ['other', 'Other Add-ons', 'shield'],
    ];
    const rows = groups.map(([key, label, ic]) => {
      const mine = all.filter(a => (key === 'other')
        ? (a.group !== 'baggage' && a.group !== 'meal')
        : a.group === key);
      if (!mine.length) return '';
      const sum = mine.reduce((t, a) => t + Number(a.price || 0), 0);
      return `
        <div class="bkf-row">
          <div class="bkf-row-lead">${bkfIc(ic)}
            <div><b>${esc(label)}</b>
              <span>${mine.map(a => `${esc(a.name)} (${esc(scope(a.passengerIndex))})`).join(', ')}</span></div>
          </div>
          <div class="bkf-row-amt">${sum ? esc(money(sum)) : 'Included'}</div>
          ${edit('addons', 'add-ons')}
        </div>`;
    }).filter(Boolean).join('');
    if (!rows) return '';
    return `
      <section class="bkf-card bkf-rvcard" data-fold="addons">
        <div class="bkf-card-head">
          <h3 class="bkf-rvtitle">${bkfIc('bag')}<span>Add-ons</span></h3>
          <div class="bkf-rvright">${fold('addons')}</div>
        </div>
        <div class="bkf-card-body bkf-rows">${rows}</div>
      </section>`;
  }

  function bkfRvContactHtml(ctx, edit) {
    const p = (ctx.passengers || [])[0] || {};
    const c = ctx.contact || {};
    const email = c.email || p.email || '';
    const phone = bkfPhone(p, ctx);
    if (!email && !phone) return '';
    return `
      <section class="bkf-card bkf-rvcard">
        <div class="bkf-card-head">
          <h3 class="bkf-rvtitle">${bkfIc('phone')}<span>Contact Details</span></h3>
          <div class="bkf-rvright">${edit('travellers', 'contact details')}</div>
        </div>
        <div class="bkf-card-body">
          <div class="bkf-contact">
            ${email ? `<div><span>Email</span><b>${esc(email)}</b></div>` : ''}
            ${phone ? `<div><span>Mobile</span><b>${esc(phone)}</b></div>` : ''}
          </div>
          <p class="bkf-okline">&#10003; We will send booking updates on this contact</p>
        </div>
      </section>`;
  }

  /* The app's own rules, not invented ones: the six-month passport rule and
     the 24-hour cancellation window are both enforced elsewhere in this
     codebase, and the fare-rules line restates what the add-ons step says. */
  function bkfRvInfoHtml(ctx) {
    const intl = ctx.item && typeof BookingApi !== 'undefined' && BookingApi.isInternational
      ? BookingApi.isInternational(ctx.item) : false;
    const items = [
      'Names must match government-issued ID proof.',
      'Check-in baggage allowance and fare rules vary by airline.',
    ];
    if (intl) items.push('Passports must be valid for at least six months from the date of travel.');
    items.push('You can cancel within 24 hours of booking for eligible fares.');
    items.push('By continuing, you agree to our <a href="#" data-bkf-terms="terms">Terms &amp; Conditions</a> and <a href="#" data-bkf-terms="privacy">Privacy Policy</a>.');
    return `
      <section class="bkf-card bkf-rvcard">
        <div class="bkf-card-head">
          <h3 class="bkf-rvtitle">${bkfIc('info')}<span>Important Information</span></h3>
        </div>
        <div class="bkf-card-body">
          <ul class="bkf-info-list">${items.map((t, i) =>
            `<li>${i === items.length - 1 ? t : esc(t)}</li>`).join('')}</ul>
        </div>
      </section>`;
  }

  /* ---- shared mount: collapsible cards, on Review and on the fare rail --- */
  function bkfWireFolds(scope, ctx) {
    if (!scope) return;
    if (!ctx.bkfShut) ctx.bkfShut = {};
    scope.querySelectorAll('[data-bkf-fold]').forEach(btn => {
      const key = btn.dataset.bkfFold;
      const card = btn.closest('.bkf-rvcard') || btn.closest('.bk-price');
      if (!card) return;
      const body = card.querySelector('.bkf-card-body, .bkf-fare-body');
      if (ctx.bkfShut[key]) {
        card.classList.add('is-shut');
        if (body && card.classList.contains('bk-price')) body.style.display = 'none';
      }
      btn.addEventListener('click', () => {
        const shut = !ctx.bkfShut[key];
        ctx.bkfShut[key] = shut;
        card.classList.toggle('is-shut', shut);
        if (body && card.classList.contains('bk-price')) body.style.display = shut ? 'none' : '';
        btn.setAttribute('aria-label', shut ? 'Expand section' : 'Collapse section');
      });
    });
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
              /* The API carries no middle name (customer_booking.py has
                 first_name/last_name only), and an airline's given-name field
                 is where a middle name goes on a ticket. With none typed this
                 is byte-identical to what it always sent. */
              first_name: [p.first, p.middle].filter(Boolean).join(' '),
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
              /* Which room this guest is staying in. The Guest Details screen
                 groups the party by room and that grouping has to survive the
                 write, or the property receives names and rooms with nothing
                 tying the two together (migration 0059). Null when the guest
                 came from a flow that never asked. */
              room_index: (p.roomIndex === undefined || p.roomIndex === null) ? null : p.roomIndex,
              title: p.title || null,
              /* The API carries no middle name (customer_booking.py has
                 first_name/last_name only), and an airline's given-name field
                 is where a middle name goes on a ticket. With none typed this
                 is byte-identical to what it always sent. */
              first_name: [p.first, p.middle].filter(Boolean).join(' '),
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
              /* The API carries no middle name (customer_booking.py has
                 first_name/last_name only), and an airline's given-name field
                 is where a middle name goes on a ticket. With none typed this
                 is byte-identical to what it always sent. */
              first_name: [p.first, p.middle].filter(Boolean).join(' '),
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
      label: 'Confirmation',
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

        /* THE HEADLINE MUST MATCH THE STATUS.
           No payment gateway is integrated, so a server booking is created
           `pending` and stays there — nothing has been paid and no property
           has confirmed anything. Saying "Booking confirmed" over a pending
           booking is the one claim this screen must never make.

           Scoped to hotels deliberately. Flight bookings are created `pending`
           for exactly the same reason and carry exactly the same wrong
           headline, but the Flights journey is signed off and is not being
           changed here — see the Phase 6 report. */
        /* THE HEADLINE FOLLOWS THE STATUS, FOR EVERY PRODUCT.
           No payment gateway is integrated, so a server booking — flight,
           hotel or package alike — is created `pending` and stays there:
           nothing has been paid and no supplier has confirmed anything.
           "Booking confirmed" over that is the one claim this screen must
           never make. It was scoped to hotels when the hotel journey was
           built; flights and packages carried the same wrong headline for the
           same reason, and now they do not.

           Cruise and visa have no backend at all: booking-store stamps those
           local rows `Confirmed` itself, and they are labelled "Demo booking"
           in the footer below, so reading their own status leaves them
           exactly as they were. */
        const confirmed = /confirm|complete|paid/i.test(String(b.status || ''));
        const heading = confirmed ? 'Booking confirmed' : 'Booking received';
        const subline = confirmed
          ? `Your booking has been successfully confirmed.
             ${esc(ctx.summaryTitle || '')} — recorded against your account.`
          : `${esc(ctx.summaryTitle || '')} — held against your account. Your booking
             is <b>pending</b> until payment is arranged; nothing has been charged.`;

        return `<div class="bk-step bk-done">
            <div class="bk-done-mark">${typeof JPIcon !== 'undefined' ? JPIcon.html('insurance', { size: 'xl' }) : ''}</div>
            <h2>${heading}</h2>
            <p class="bk-step-sub">${subline}</p>

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
    /* An extra bought for ONE named traveller is charged once — the same rule
       customer_pricing_service.price_addons applies, so the local estimate and
       the server's quote cannot disagree about it. */
    return ctx.addons.reduce((sum, a) => {
      const qty = (a.per === 'passenger' && a.passengerIndex == null) ? pax : 1;
      return sum + (a.price || 0) * qty;
    }, 0);
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
    /* The flight reference screens, used by booking-flow.js (the itinerary
       card and the CTA arrow) and booking-flows.js (the rail and action bar). */
    svg, itineraryHtml, fareHtml: bkfFareHtml, footHtml: bkfFootHtml, bkfDate,
    seatTypeLabel: rvSeatType, wireFolds: bkfWireFolds,
    flightPrice, hotelPrice, cruisePrice, packagePrice, visaPrice,
    PAY_METHODS,
  };
})();
