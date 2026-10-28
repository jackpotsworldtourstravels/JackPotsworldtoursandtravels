'use strict';
/* ===========================================================================
   Flight "Choose a saved traveller" picker — booking-products.js.

   The picker lets a signed-in customer fill one passenger's fields from their
   own saved-traveller list (fetched via BookingApi.travellers()). This extracts
   the pure pieces (maskPassport, option label, fill plan, applyPickValue), the
   picker markup AND the cache lifecycle (owner key, reset, fetch, repaint), runs
   them in a VM against a controllable fake BookingApi, and makes structural
   assertions on the wiring and on the booking payload so the feature cannot
   silently regress into leaking a passport number, touching the booking contact,
   auto-submitting, showing one customer's travellers to another, or wiping what
   the traveller has typed.

   run:  node frontend/tests/saved-travellers-picker.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/booking-products.js');
const CSS = read('assets/css/booking-ref.css');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Pull a named `function foo(` out of the source by matching braces — the same
   approach saved-travellers.test.js uses for the Account Centre helpers. */
function extractFn(src, sig) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${sig} not found`); return ''; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${sig} braces unbalanced`);
  return '';
}

const MASK = extractFn(SRC, 'function bkfMaskPassport(');
const LABEL = extractFn(SRC, 'function bkfSavedOptionLabel(');
const PLAN = extractFn(SRC, 'function bkfSavedFillPlan(');
const APPLY = extractFn(SRC, 'function applyPickValue(');
const CLEARS = (/const BKF_PICK_CLEARS = [^;]*;/.exec(SRC) || [''])[0];
const APPLYPLAN = extractFn(SRC, 'function bkfApplySavedPlan(');
check(CLEARS !== '', 'the list of fields a pick must clear exists');
const PICKER = extractFn(SRC, 'function bkfSavedPickerHtml(');
const INNER = extractFn(SRC, 'function bkfSavedPickerInner(');
const FLOW = read('assets/js/booking-flow.js');
const NATADJ = (/const BKF_NATIONALITY_ADJ = \{[\s\S]*?\n  \};/.exec(SRC) || [''])[0];
const ALIASKEY = extractFn(SRC, 'function bkfAliasKey(');
const ALIASES = (/const BKF_NATIONALITY_ALIASES = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/.exec(SRC) || [''])[0];
const NATADJFN = extractFn(SRC, 'function bkfNationalityAdj(');
check(NATADJ !== '' && ALIASKEY !== '' && ALIASES !== '', 'the nationality table and its alias map exist');
/* The form's own country options, straight from the file that defines them. */
const NATIONALITIES = (() => {
  const m = /const NATIONALITIES = \[([\s\S]*?)\];/.exec(read('assets/js/booking-data.js'));
  return m ? m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
})();
check(NATIONALITIES.length >= 15 && NATIONALITIES.indexOf('India') !== -1, 'the form\'s nationality options were read from booking-data.js');

/* The cache and its lifecycle: the `let` declarations through the end of
   checkSavedTravellers (owner key, reset, sync, repaint-with-draft, fetch). */
const CHECK = extractFn(SRC, 'function checkSavedTravellers(');
const stateAt = SRC.indexOf('let _savedTravellers;');
check(stateAt !== -1, 'the saved-traveller cache declarations exist');
const STATE = stateAt === -1 || !CHECK ? '' : SRC.slice(stateAt, SRC.indexOf(CHECK) + CHECK.length);

/* The REAL escapeHtml (shared/formatters.js) and the page's own esc wrapper around it —
   not a stand-in — so the XSS checks below test what ships. */
const ESC = extractFn(read('shared/formatters.js'), 'function escapeHtml(') + '\n' +
  ((/\n  (const esc = [^\n]*)/.exec(SRC) || ['', ''])[1]);
check(/const esc = /.test(ESC) && /function escapeHtml/.test(ESC), 'the real escapeHtml and esc were extracted');

/* The real passenger card and its helpers, the real draft reader, and the real
   restore-what-was-typed block from mount() — the pieces a rebuild actually goes through. */
const CARDFNS = ['bkfField', 'bkfTelField', 'bkfKindNo', 'bkfScanHtml', 'bkfPaxCard', 'bkfTravellersHtml']
  .map(n => extractFn(SRC, 'function ' + n + '(')).join('\n');
const COUNTRYCODES = (/const COUNTRY_CODES = \[[\s\S]*?\];/.exec(SRC) || [''])[0];
const READINTO = extractFn(SRC, 'function readInto(');
const ISINTL = extractFn(read('assets/js/booking-api.js'), 'function isInternational(');
const HYDRATE = (() => {
  const at = SRC.indexOf('(ctx.passengers || []).forEach((pax, i) => {', SRC.indexOf('restore anything already typed'));
  if (at === -1) return '';
  const end = SRC.indexOf('\n        });', at);
  return end === -1 ? '' : SRC.slice(at, end + '\n        });'.length);
})();
check(CARDFNS !== '' && COUNTRYCODES !== '' && READINTO !== '' && ISINTL !== '' && HYDRATE !== '', 'the card, draft reader and hydration block were extracted');
const listOf = name => {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(read('assets/js/booking-data.js'));
  return m ? m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
};

/* One test harness = one booking page: a fake auth store, a fake API whose
   requests the test settles by hand, a fake bkMain, and a log of the order in
   which the draft was read and the step repainted. */
function harness(opts) {
  opts = opts || {};
  const auth = { access: 'access' in opts ? opts.access : 'tok-A' };
  const requests = [];                    // each travellers() call, settled by the test
  const order = [];                       // 'read' / 'repaint', in the order they happened
  const reads = [];
  const screen = { travellerCards: true, readThrows: false };
  const ctx0 = { passengers: [], paxKinds: ['Adult'] };
  const flowState = { ctx: ctx0 };         // what BookingFlow.context returns: the ACTIVE flow's draft

  /* The passenger form as the focus code sees it: elements by id, one focused
     element, carets that behave like a browser's (email/date/select have none, and
     setSelectionRange on them throws). `world.rebuild` makes a repaint REPLACE every
     element — new nodes, focus on <body>, values as the draft restores them — which
     is what a non-patched repaint does; leaving it off models a patched repaint. */
  const body = { tagName: 'BODY' };
  const doc = { activeElement: body, body };
  const els = {};
  const world = { rebuild: false, drop: [], disable: [], valueAfter: {}, activeAfter: null, realDraft: false, replaceOnly: [] };
  function mkEl(id, o) {
    o = o || {};
    const el = { id, tagName: o.tagName || 'INPUT', type: o.type || 'text', disabled: !!o.disabled,
      selectionStart: null, selectionEnd: null, selectionDirection: 'none',
      focusCalls: [], rangeCalls: [], valueWrites: 0, _v: '' };
    Object.defineProperty(el, 'value', { get() { return this._v; }, set(v) { this._v = v; this.valueWrites++; } });
    el.value = o.value || ''; el.valueWrites = 0;
    el.hasCaret = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|tel|url|password)$/.test(el.type));
    if (el.hasCaret) {
      el.selectionStart = o.start == null ? el.value.length : o.start;
      el.selectionEnd = o.end == null ? el.selectionStart : o.end;
      el.selectionDirection = o.dir || 'none';
    }
    el.focus = function (opts) { doc.activeElement = this; this.focusCalls.push(opts); };
    el.setSelectionRange = function (st, en, dir) {
      if (!this.hasCaret) throw new Error('InvalidStateError');
      this.rangeCalls.push([st, en, dir]); this.selectionStart = st; this.selectionEnd = en; this.selectionDirection = dir;
    };
    els[id] = el;
    return el;
  }
  const mainRoot = {
    querySelector: sel => {
      if (sel === '.bkf-pax') return screen.travellerCards ? {} : null;
      const byId = /^#(.+)$/.exec(sel);
      if (byId) return els[byId[1]] || null;
      const m = /^\[id="(.*)"\]$/.exec(sel);
      return m ? (els[m[1].replace(/\\"/g, '"')] || null) : null;
    },
    contains: e => Object.keys(els).some(k => els[k] === e),
  };
  function rebuildAll() {
    const old = Object.assign({}, els);
    Object.keys(old).forEach(id => {
      delete els[id];
      if (world.drop.indexOf(id) !== -1) return;
      const o = old[id];
      /* realDraft: new nodes start EMPTY, as the markup is, and get their text back only
         from the draft — exactly what mount() does. Legacy mode copies the old value. */
      mkEl(id, { tagName: o.tagName, type: o.type, disabled: world.disable.indexOf(id) !== -1,
        value: world.realDraft ? '' : (id in world.valueAfter ? world.valueAfter[id] : o.value) });
    });
    doc.activeElement = world.activeAfter ? els[world.activeAfter] : body;
    if (world.realDraft && flowState.ctx) sandbox.__m.hydrate(mainRoot, flowState.ctx);
  }
  /* A repaint that rewrites only the picker slot's contents: those elements are new, the
     rest of the form is the very same nodes. */
  function replaceSome(ids) {
    ids.forEach(id => {
      const o = els[id]; if (!o) return;
      const wasActive = doc.activeElement === o;
      delete els[id];
      mkEl(id, { tagName: o.tagName, type: o.type, value: o.value });
      if (wasActive) doc.activeElement = body;
    });
  }

  const sandbox = {
    console, String, Array, Boolean, Object, Promise,
    getCustomerAuth: () => ({ access: auth.access }),
    BookingApi: {
      isSignedIn: () => !!auth.access,
      travellers: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    },
    BookingFlow: { repaint: () => { order.push('repaint'); if (world.rebuild) rebuildAll(); else if (world.replaceOnly.length) replaceSome(world.replaceOnly); },
                   get context() { return flowState.ctx; } },
    BookingData: { TITLES: listOf('TITLES'), GENDERS: listOf('GENDERS'), NATIONALITIES },
    document: Object.assign(doc, { getElementById: id => (id === 'bkMain' ? mainRoot : null) }),
    readInto: (c, r) => { order.push('read'); reads.push([c, r]); if (screen.readThrows) throw new Error('boom');
      if (world.realDraft) return sandbox.__m.real(c, r); },
    bkfIc: () => '<ic>',
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${ESC}\n${COUNTRYCODES}\nlet _ocrAvailable = false;\nfunction svg(){return '<svg></svg>';}\n${CARDFNS}\n`+
    `const __real = (function(){ ${READINTO}\nreturn readInto; })();\nfunction __hydrate(root, ctx) { ${HYDRATE} }\n` +
    `${ISINTL}\nglobalThis.BookingApi.isInternational = isInternational;\n` +
    `${MASK}\n${LABEL}\n${PLAN}\n${APPLY}\n${NATADJ}\n${ALIASKEY}\n${ALIASES}\n${NATADJFN}\n${CLEARS}\n${APPLYPLAN}\n${STATE}\n${INNER}\n${PICKER}\n` +
    `globalThis.__m={renderCards:(c,o)=>bkfTravellersHtml(c,o),hydrate:__hydrate,real:__real,bkfMaskPassport,bkfSavedOptionLabel,bkfSavedFillPlan,applyPickValue,bkfApplySavedPlan,bkfAliasKey,bkfNationalityAdj,ALIASES:BKF_NATIONALITY_ALIASES,ADJ:BKF_NATIONALITY_ADJ,bkfSavedPickerHtml,` +
    `checkSavedTravellers,syncSavedTravellersOwner,bkfCaptureFocus,bkfRestoreFocus,` +
    `st:{get list(){return _savedTravellers},set list(v){_savedTravellers=v},` +
    `get pending(){return _savedTravellersPending},set pending(v){_savedTravellersPending=v},` +
    `get error(){return _savedTravellersError},set error(v){_savedTravellersError=v},` +
    `get owner(){return _savedOwner},set owner(v){_savedOwner=v},get seq(){return _savedSeq}}};`,
    sandbox);
  const m = sandbox.__m;

  /* Preload state as if a fetch had already settled under the current credential. */
  if (opts.list !== undefined) { m.st.list = opts.list; m.st.owner = auth.access; }
  if (opts.error) { m.st.error = true; m.st.owner = auth.access; }
  if (opts.pending) { m.st.pending = true; m.st.owner = auth.access; }

  return { m, auth, requests, order, reads, screen, doc, els, mkEl, world, body, flow: flowState, ctx: ctx0 };
}
const flush = () => new Promise(r => setImmediate(r));

const TRAVELLER = {
  customer_traveller_id: 7, title: 'Mr', first_name: 'Asha', last_name: 'Rao',
  gender: 'Female', date_of_birth: '1990-04-02', nationality: 'India',
  passport_number: 'M7654321', passport_expiry: '2030-01-01', issuing_country: 'India',
  frequent_flyer_number: 'AI123', mobile: '9876500000', email: 'asha@example.com',
};
/* Two customers' lists, with names that cannot be confused. */
const A_LIST = [{ customer_traveller_id: 1, first_name: 'Alpha', last_name: 'Aaronson', passport_number: 'A1111111' }];
const B_LIST = [{ customer_traveller_id: 2, first_name: 'Bravo', last_name: 'Bellamy', passport_number: 'B2222222' }];

/* A fake DOM field and root, enough for applyPickValue. */
const field = (tag, value, options) => ({ tagName: tag, value: value || '', options: options || null });
const select = (value, optionValues) => field('SELECT', value, optionValues.map(v => ({ value: v })));
const fakeRoot = fields => ({ querySelector: sel => fields[sel] || null });

(async function run() {
  const h0 = harness();
  const m = h0.m;

  /* ---- masking: never the raw number -------------------------------- */
  check(m.bkfMaskPassport('M7654321') === '•••• 4321', 'a long passport masks to the last 4');
  check(m.bkfMaskPassport('AB12') !== 'AB12', 'a short value is never shown whole (it used to be returned as-is)');
  check(m.bkfMaskPassport('') === '' && m.bkfMaskPassport(null) === '', 'empty/null masks to empty');

  /* ---- option label: masked, never the full number ------------------ */
  {
    const label = m.bkfSavedOptionLabel(TRAVELLER);
    check(label.startsWith('Asha Rao'), 'the label leads with the name');
    check(label.includes('•••• 4321'), 'the label shows the masked passport');
    check(!label.includes('M7654321'), 'the full passport number never reaches the label');
    check(m.bkfSavedOptionLabel({ first_name: 'A', last_name: 'B' }) === 'A B',
      'a traveller with no extra bits is just the name');
  }

  /* ---- fill plan: the right fields, and never the contact ones ------- */
  {
    const intl = m.bkfSavedFillPlan(TRAVELLER, true);
    check(intl.first === 'Asha' && intl.last === 'Rao' && intl.title === 'Mr', 'names and title map across');
    check(intl.dob === '1990-04-02' && intl.gender === 'Female' && intl.nat === 'India', 'dob/gender/nationality map across');
    check(intl.middle === '', 'middle name is cleared (the data model has none)');
    check(intl.ppno === 'M7654321' && intl.ppexp === '2030-01-01' && intl.ppiss === 'India',
      'passport fields are in the plan when the international block exists');
    check(!('email' in intl) && !('mobile' in intl),
      'email and mobile are NEVER in the plan — they are the booking contact, not the traveller');

    const dom = m.bkfSavedFillPlan(TRAVELLER, false);
    check(!('ppno' in dom) && !('ppexp' in dom) && !('ppiss' in dom),
      'passport fields are absent from the plan on a domestic card');
    check(m.bkfSavedFillPlan(null, true) && Object.keys(m.bkfSavedFillPlan(null, true)).length === 0,
      'no traveller -> empty plan');
  }

  /* ---- applyPickValue: graceful, scoped, option-validated ----------- */
  {
    /* Two passengers on screen. Filling passenger 1 must not touch passenger 0. */
    const fields = {
      '#p0_first': field('INPUT', 'Existing'),
      '#p1_first': field('INPUT', ''),
      '#p1_gender': select('', ['', 'Male', 'Female', 'Other']),
      '#p1_nat': select('India', ['', 'India', 'Nepal']),
    };
    const root = fakeRoot(fields);

    m.applyPickValue(root, 'p1_first', 'Asha');
    check(fields['#p1_first'].value === 'Asha', 'a text field takes the value');
    check(fields['#p0_first'].value === 'Existing', 'another passenger is left untouched');

    m.applyPickValue(root, 'p1_gender', 'Female');
    check(fields['#p1_gender'].value === 'Female', 'a select takes a value that is one of its options');

    m.applyPickValue(root, 'p1_nat', 'Bhutan');   // not an option
    check(fields['#p1_nat'].value === 'India', 'a select value with no matching option leaves the field unchanged');

    /* A passport field that is not on the card (domestic) is a silent no-op. */
    let threw = false;
    try { m.applyPickValue(root, 'p1_ppno', 'X123'); } catch { threw = true; }
    check(!threw && !fields['#p1_ppno'], 'writing to an absent field neither throws nor invents it');
  }

  /* ---- REGRESSION: Account Center stores gender lowercase ------------ */
  {
    /* The exact values account-center.js saves (its <select> option values), against
       the exact options the flight form offers (BookingData.GENDERS / TITLES). */
    const GENDERS = ['', 'Male', 'Female', 'Other'];
    const stored = [['male', 'Male'], ['female', 'Female'], ['other', 'Other']];
    stored.forEach(([saved, want]) => {
      const f = { '#p0_gender': select('', GENDERS) };
      m.applyPickValue(fakeRoot(f), 'p0_gender', saved);
      check(f['#p0_gender'].value === want,
        `saved gender "${saved}" sets the option's own value "${want}" (got "${f['#p0_gender'].value}")`);
    });

    /* End to end through the plan: a record exactly as the Account Center writes it. */
    const acctRecord = { first_name: 'Arjun', last_name: 'Mehta', gender: 'male', title: 'Mr',
      nationality: 'India', date_of_birth: '1988-03-14' };
    const f = { '#p0_gender': select('', GENDERS), '#p0_title': select('', ['', 'Mr', 'Ms', 'Mrs', 'Dr', 'Mstr']),
      '#p0_nat': select('India', ['', 'India', 'Nepal']) };
    const plan = m.bkfSavedFillPlan(acctRecord, false);
    Object.keys(plan).forEach(sfx => m.applyPickValue(fakeRoot(f), `p0_${sfx}`, plan[sfx]));
    check(f['#p0_gender'].value === 'Male', 'a record saved by Account Center fills Gender through the plan');

    /* Case and surrounding space are ignored; the option's spelling wins. */
    const g = { '#a': select('', GENDERS), '#b': select('', ['', 'Mr', 'Ms']), '#c': select('India', ['', 'India', 'Nepal']) };
    m.applyPickValue(fakeRoot(g), 'a', 'FEMALE');   check(g['#a'].value === 'Female', 'upper case matches');
    m.applyPickValue(fakeRoot(g), 'a', '  other '); check(g['#a'].value === 'Other', 'surrounding space is ignored');
    m.applyPickValue(fakeRoot(g), 'b', 'mr');       check(g['#b'].value === 'Mr', 'title matches case-insensitively');
    m.applyPickValue(fakeRoot(g), 'c', 'nepal');    check(g['#c'].value === 'Nepal', 'nationality matches case-insensitively');

    /* No valid option -> unchanged (never blanked, never an invented value). */
    const u = { '#g': select('Male', GENDERS) };
    m.applyPickValue(fakeRoot(u), 'g', 'nonbinary');
    check(u['#g'].value === 'Male', 'an unknown value leaves the field unchanged');
    m.applyPickValue(fakeRoot(u), 'g', null);       // empty -> the blank option, as before
    check(u['#g'].value === '', 'an empty stored value clears to the blank option');
    const nb = { '#g': select('Male', ['Male', 'Female']) };   // no blank option at all
    m.applyPickValue(fakeRoot(nb), 'g', '');
    check(nb['#g'].value === 'Male', 'an empty value with no blank option leaves the field unchanged');

    /* An exact match is preferred over a case-folded one. */
    const ex = { '#x': select('', ['', 'a', 'A']) };
    m.applyPickValue(fakeRoot(ex), 'x', 'A');
    check(ex['#x'].value === 'A', 'an exact match wins over a case-insensitive one');
  }

  /* ---- picker markup across the four states ------------------------- */
  {
    const signedOut = harness({ access: null }).m.bkfSavedPickerHtml(0);
    check(/sign in/i.test(signedOut) && signedOut.includes('bkf-saved'), 'signed out -> a sign-in hint, form still usable');

    const errored = harness({ error: true }).m.bkfSavedPickerHtml(0);
    check(/couldn(?:'|&#39;)t load/i.test(errored), 'a failed load -> a non-sensitive hint');
    check(!errored.includes('M7654321'), 'the error state never contains a passport number');

    const pending = harness({ pending: true }).m.bkfSavedPickerHtml(0);
    check(!/<select|bkf-saved"|bkf-saved is-hint/.test(pending) && pending.includes('bkf-saved-slot'),
      'while loading -> the empty slot only, nothing visible (no flicker)');

    const empty = harness({ list: [] }).m.bkfSavedPickerHtml(0);
    check(/no saved travellers/i.test(empty), 'loaded but empty -> an invite to save');

    const loaded = harness({ list: [TRAVELLER] }).m.bkfSavedPickerHtml(2);
    check(loaded.includes('data-saved-pick="2"'), 'the select is bound to this passenger index');
    check(loaded.includes('value="7"'), 'each option carries the traveller id');
    check(loaded.includes('•••• 4321') && !loaded.includes('M7654321'),
      'the dropdown shows a masked passport, never the full number');
    check(loaded.includes('>Select a saved traveller<'), 'a placeholder option lets no pick be the default');

    /* XSS: a hostile name is escaped, not injected. */
    const evil = harness({ list: [{ customer_traveller_id: 9, first_name: '<img src=x onerror=alert(1)>', last_name: '"><b>' }] })
      .m.bkfSavedPickerHtml(0);
    check(!/<img|<b>/.test(evil), 'a hostile traveller name is HTML-escaped in the dropdown');
  }

  /* ---- LIFECYCLE: signed out never fetches -------------------------- */
  {
    const h = harness({ access: null });
    h.m.checkSavedTravellers();
    check(h.requests.length === 0, 'signed out -> no request is made');
    check(h.m.st.list === undefined && !h.m.st.pending, 'signed out -> nothing is cached or marked pending');
  }

  /* ---- LIFECYCLE: a normal load, fetched once ------------------------ */
  {
    const h = harness();
    h.m.checkSavedTravellers();
    h.m.checkSavedTravellers();                    // a repaint asks again while in flight
    check(h.requests.length === 1, 'one request however many times the step asks while it is in flight');
    h.requests[0].resolve(A_LIST); await flush();
    check(Array.isArray(h.m.st.list) && h.m.st.list.length === 1, 'the list is cached once it arrives');
    h.m.checkSavedTravellers();
    check(h.requests.length === 1, 'a loaded list is not fetched again (no repaint loop)');
    check(h.m.bkfSavedPickerHtml(0).includes('Alpha Aaronson'), 'the loaded list is offered to the signed-in customer');
  }

  /* ---- LIFECYCLE: sign-out clears the cache -------------------------- */
  {
    const h = harness();
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    h.auth.access = null;                               // signs out: clearCustomerAuth removed the token
    const html = h.m.bkfSavedPickerHtml(0);
    check(!html.includes('Alpha') && !html.includes('Aaronson') && /sign in/i.test(html),
      'after sign-out the previous customer\'s travellers are not drawn — a sign-in hint is');
    check(h.m.st.list === undefined && h.m.st.owner === null, 'sign-out empties the cache and its owner');
    h.m.checkSavedTravellers();
    check(h.requests.length === 1, 'signed out again -> still no new request');
  }

  /* ---- LIFECYCLE: a different customer never sees the previous list -- */
  {
    const h = harness();
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    h.auth.access = 'tok-B';                            // B signs in on the same page, no reload
    const before = h.m.bkfSavedPickerHtml(0);           // the repaint that follows draws before any fetch
    check(!before.includes('Alpha') && !before.includes('Aaronson') && !before.includes('data-saved-pick'),
      'a new customer is never offered the previous customer\'s list, not even for one paint');
    check(h.m.st.list === undefined, 'the previous customer\'s list is dropped when the credential changes');
    h.m.checkSavedTravellers();
    check(h.requests.length === 2, 'the new customer\'s list is fetched through the authenticated API');
    h.requests[1].resolve(B_LIST); await flush();
    const after = h.m.bkfSavedPickerHtml(0);
    check(after.includes('Bravo Bellamy') && !after.includes('Alpha'), 'the new customer sees only their own travellers');
  }

  /* ---- LIFECYCLE: a failed request is shown once and never leaks over - */
  {
    const h = harness();
    h.m.checkSavedTravellers(); h.requests[0].reject(new Error('503')); await flush();
    check(h.m.st.error === true && /couldn(?:'|&#39;)t load/i.test(h.m.bkfSavedPickerHtml(0)), 'a failed load shows the manual-entry hint');
    h.m.checkSavedTravellers(); h.m.checkSavedTravellers();
    check(h.requests.length === 1, 'a failure is not retried in a loop');
    h.auth.access = 'tok-B';                            // the next customer must not inherit A's failure
    check(!/couldn(?:'|&#39;)t load/i.test(h.m.bkfSavedPickerHtml(0)) && h.m.st.error === false,
      'a cached error is not carried over to a different customer');
    h.m.checkSavedTravellers();
    check(h.requests.length === 2, 'the next customer gets a fresh attempt');
  }

  /* ---- LIFECYCLE: STALE responses cannot repopulate for someone else -- */
  {
    /* A's request is in flight; B signs in and B's request starts; A's response
       then lands late. */
    const h = harness();
    h.m.checkSavedTravellers();                    // request 0, under tok-A
    h.auth.access = 'tok-B';
    h.m.checkSavedTravellers();                    // request 1, under tok-B
    check(h.requests.length === 2, 'the new customer starts their own request');
    h.requests[0].resolve(A_LIST); await flush();       // the OLD one finishes last
    check(h.m.st.list === undefined, 'a late response for the previous customer does not populate the cache');
    check(!h.m.bkfSavedPickerHtml(0).includes('Alpha'), 'and is never drawn');
    h.requests[1].resolve(B_LIST); await flush();
    check(h.m.bkfSavedPickerHtml(0).includes('Bravo') && !h.m.bkfSavedPickerHtml(0).includes('Alpha'),
      'only the new customer\'s own list ends up cached');
  }
  {
    /* A late FAILURE for the previous customer must not mark the new one as failed. */
    const h = harness();
    h.m.checkSavedTravellers();
    h.auth.access = 'tok-B';
    h.m.checkSavedTravellers();
    h.requests[0].reject(new Error('timeout')); await flush();
    check(h.m.st.error === false, 'a late failure for the previous customer does not poison the new one');
    h.requests[1].resolve(B_LIST); await flush();
    check(Array.isArray(h.m.st.list) && h.m.st.list.length === 1, 'the new customer still loads normally');
  }
  {
    /* Sign-out with NO repaint in between: the response lands against a token
       that is no longer there. */
    const h = harness();
    h.m.checkSavedTravellers();
    h.auth.access = null;
    h.requests[0].resolve(A_LIST); await flush();
    check(h.m.st.list === undefined, 'a response that lands after sign-out is not cached');
    check(!h.m.bkfSavedPickerHtml(0).includes('Alpha'), 'and is not drawn');
  }
  {
    /* Another customer signs in with NO repaint in between, then the old response lands. */
    const h = harness();
    h.m.checkSavedTravellers();
    h.auth.access = 'tok-B';
    h.requests[0].resolve(A_LIST); await flush();
    check(h.m.st.list === undefined, 'a response for a customer who is gone is dropped, not stored under the new one');
    h.m.checkSavedTravellers();
    check(h.requests.length === 2, 'and the new customer is fetched fresh');
  }
  {
    /* The same customer's token is refreshed mid-flight: safe fallback is one refetch. */
    const h = harness();
    h.m.checkSavedTravellers();
    h.auth.access = 'tok-A2';
    h.requests[0].resolve(A_LIST); await flush();
    check(h.m.st.list === undefined, 'a response is only kept under the credential it was requested with');
    h.m.checkSavedTravellers();
    check(h.requests.length === 2, 'a refreshed token costs one extra fetch, not stale data');
  }

  /* ---- REPAINT: what the traveller typed survives the list arriving --- */
  {
    const h = harness();
    h.m.checkSavedTravellers();
    h.requests[0].resolve(A_LIST); await flush();
    check(h.order.join() === 'read,repaint', 'the cards are read into the draft BEFORE the repaint (got ' + h.order.join() + ')');
    check(h.reads.length === 1 && h.reads[0][0] === h.ctx, 'the flow\'s own draft is the one that is filled');
  }
  {
    const h = harness();
    h.m.checkSavedTravellers();
    h.requests[0].reject(new Error('500')); await flush();
    check(h.order.join() === 'read,repaint', 'a failed load also saves the draft before it repaints');
  }
  {
    const h = harness();
    h.screen.travellerCards = false;                    // the traveller has moved on to another step
    h.m.checkSavedTravellers();
    h.requests[0].resolve(A_LIST); await flush();
    check(h.order.join() === 'repaint', 'with no traveller cards on screen nothing is read (it would blank the draft)');
  }
  {
    const h = harness();
    h.screen.readThrows = true;
    h.m.checkSavedTravellers();
    h.requests[0].resolve(A_LIST); await flush();
    check(h.order.join() === 'read,repaint' && Array.isArray(h.m.st.list), 'a draft read that throws never blocks the repaint or the list');
  }

  /* ---- REGRESSION: an unsupported title must not leave the previous one -- */
  {
    const TITLES = ['', 'Mr', 'Ms', 'Mrs', 'Dr', 'Mstr'];       // BookingData.TITLES behind the blank option
    const titleSel = value => {
      const el = { tagName: 'SELECT', _v: value || '', sIdx: 0, options: TITLES.map(v => ({ value: v })) };
      Object.defineProperty(el, 'value', { get() { return this._v; }, set(v) { this._v = v; } });
      Object.defineProperty(el, 'selectedIndex', { get() { return this.sIdx; }, set(i) { this.sIdx = i; if (i === -1) this._v = ''; } });
      return el;
    };
    /* The change handler calls exactly this: the plan, written into passenger 0's card. */
    const pickRec = (root, rec) => m.bkfApplySavedPlan(root, 0, m.bkfSavedFillPlan(rec, false));
    const title = titleSel('');
    const root = fakeRoot({ '#p0_title': title, '#p0_first': field('INPUT', ''), '#p0_last': field('INPUT', '') });

    pickRec(root, { first_name: 'Arjun', last_name: 'Mehta', title: 'Mr' });
    check(title.value === 'Mr', 'a supported title maps as before');
    pickRec(root, { first_name: 'Priya', last_name: 'Sharma', title: 'ms' });
    check(title.value === 'Ms', 'a supported title still maps case-insensitively to the option\'s own spelling');
    pickRec(root, { first_name: 'Casey', last_name: 'Dutta', title: 'Mx' });     // the form has no "Mx"
    check(title.value === '', 'a title the form has no option for clears the field (got "' + title.value + '")');
    check(title.value !== 'Ms', 'the PREVIOUS traveller\'s title is never retained for the next');
    pickRec(root, { first_name: 'Arjun', last_name: 'Mehta', title: 'Dr' });
    pickRec(root, { first_name: 'No', last_name: 'Title', title: null });
    check(title.value === '', 'a traveller with no saved title does not inherit the last one\'s either');
    pickRec(root, { first_name: 'Arjun', last_name: 'Mehta', title: 'Mr' });
    check(title.value === 'Mr', 'after a cleared pick an ordinary supported title maps again');

    /* No blank option at all: still never leave the previous title standing. */
    const noBlank = { tagName: 'SELECT', _v: 'Mr', sIdx: 0, options: ['Mr', 'Ms'].map(v => ({ value: v })) };
    Object.defineProperty(noBlank, 'value', { get() { return this._v; }, set(v) { this._v = v; } });
    Object.defineProperty(noBlank, 'selectedIndex', { get() { return this.sIdx; }, set(i) { this.sIdx = i; if (i === -1) this._v = ''; } });
    m.applyPickValue(fakeRoot({ '#t': noBlank }), 't', 'Mx', { clearIfUnmatched: true });
    check(noBlank.value === '' && noBlank.sIdx === -1, 'with no blank option the select is emptied, not left on the previous value');

    /* applyPickValue itself only clears when told to; bkfApplySavedPlan is what tells it. */
    const g = { '#g': select('Male', ['', 'Male', 'Female', 'Other']) };
    m.applyPickValue(fakeRoot(g), 'g', 'nonbinary');
    check(g['#g'].value === 'Male', 'without the flag an unmatched value still leaves the field unchanged');

    check(/bkfApplySavedPlan\(root, i, plan\);/.test(SRC), 'the pick handler writes the plan through bkfApplySavedPlan');
  }

  /* ---- REGRESSION: nothing of the PREVIOUS pick survives in a select ---- */
  {
    const mk = (value, values) => {
      const el = { tagName: 'SELECT', _v: value || '', sIdx: 0, options: values.map(v => ({ value: v })) };
      Object.defineProperty(el, 'value', { get() { return this._v; }, set(v) { this._v = v; } });
      Object.defineProperty(el, 'selectedIndex', { get() { return this.sIdx; }, set(i) { this.sIdx = i; if (i === -1) this._v = ''; } });
      return el;
    };
    const TITLES = ['', 'Mr', 'Ms', 'Mrs', 'Dr', 'Mstr'];
    const GENDERS = ['', 'Male', 'Female', 'Other'];
    const NATS = ['', 'India', 'United Arab Emirates', 'United Kingdom', 'Nepal'];
    const card = () => {
      const f = {
        '#p0_title': mk('', TITLES), '#p0_gender': mk('', GENDERS), '#p0_nat': mk('India', NATS), '#p0_ppiss': mk('India', NATS),
        '#p0_first': field('INPUT', ''), '#p0_last': field('INPUT', ''), '#p0_dob': field('INPUT', ''), '#p0_ff': field('INPUT', ''),
        '#p0_ppno': field('INPUT', ''), '#p0_ppexp': field('INPUT', ''),
        /* the booking contact, and a second passenger: neither may ever be touched */
        '#p0_email': field('INPUT', 'contact.person@example.com'), '#p0_mobile': field('INPUT', '9876543210'), '#p0_ccode': field('INPUT', '+91 India'),
        '#p1_title': mk('Dr', TITLES), '#p1_gender': mk('Male', GENDERS), '#p1_nat': mk('Nepal', NATS), '#p1_first': field('INPUT', 'Second'),
      };
      return { f, root: fakeRoot(f) };
    };
    const V = (c, sfx) => c.f['#p0_' + sfx].value;
    const apply = (c, rec, intl) => m.bkfApplySavedPlan(c.root, 0, m.bkfSavedFillPlan(rec, intl !== false));

    /* The records, as the Account Center / API would hold them. */
    const PRIYA = { first_name: 'Priya', last_name: 'Sharma', title: 'Ms', gender: 'female', nationality: 'India', issuing_country: 'India',
      date_of_birth: '1992-07-22', passport_number: 'Z7654321', passport_expiry: '2029-11-15', frequent_flyer_number: 'AI1' };
    const DANA = { first_name: 'Dana', last_name: 'Unsupp', title: 'Mx', gender: 'nonbinary', nationality: 'Fiji', issuing_country: 'Fiji',
      date_of_birth: '1999-01-01', passport_number: 'Z0000001', passport_expiry: '2031-01-01' };
    const ELI = { first_name: 'Eli', last_name: 'Brit', title: 'dr', gender: 'OTHER', nationality: 'united kingdom', issuing_country: 'UNITED KINGDOM' };
    const NIA = { first_name: 'Nia', last_name: 'Bare' };               // no title, gender, nationality, passport

    const c = card();
    apply(c, PRIYA);
    check(V(c, 'title') === 'Ms' && V(c, 'gender') === 'Female' && V(c, 'nat') === 'India' && V(c, 'ppiss') === 'India',
      'a fully supported traveller fills title, gender, nationality and issuing country');

    apply(c, DANA);                                                      // supported -> UNSUPPORTED
    check(V(c, 'gender') === '', 'an unsupported gender clears — the previous traveller\'s "Female" is not retained (got "' + V(c, 'gender') + '")');
    check(V(c, 'nat') === '', 'an unsupported nationality clears — the previous "India" is not retained (got "' + V(c, 'nat') + '")');
    check(V(c, 'ppiss') === '', 'an unsupported issuing country clears too (got "' + V(c, 'ppiss') + '")');
    check(V(c, 'title') === '', 'an unsupported title clears — the previous "Ms" is not retained');
    check(V(c, 'first') === 'Dana' && V(c, 'last') === 'Unsupp' && V(c, 'dob') === '1999-01-01' && V(c, 'ppno') === 'Z0000001',
      'the ordinary fields are still the new traveller\'s');

    apply(c, ELI);                                                       // UNSUPPORTED -> case-variants of valid options
    check(V(c, 'title') === 'Dr' && V(c, 'gender') === 'Other' && V(c, 'nat') === 'United Kingdom' && V(c, 'ppiss') === 'United Kingdom',
      'case-insensitive matching still sets each option\'s own spelling (dr, OTHER, united kingdom, UNITED KINGDOM)');

    apply(c, PRIYA);                                                     // and an ordinary pick works again afterwards
    check(V(c, 'gender') === 'Female' && V(c, 'nat') === 'India' && V(c, 'title') === 'Ms', 'a supported pick after a cleared one maps normally');

    apply(c, NIA);                                                       // a record with none of them
    check(V(c, 'title') === '' && V(c, 'gender') === '' && V(c, 'nat') === '' && V(c, 'ppiss') === '',
      'a traveller with no saved title/gender/nationality inherits none from the one before');
    check(V(c, 'first') === 'Nia' && V(c, 'dob') === '' && V(c, 'ppno') === '' && V(c, 'ff') === '', 'and the text fields are blanked, not kept');

    /* Unsupported first, from a clean card: cleared, not guessed (no India default "kept" by accident for gender). */
    const c2 = card(); c2.f['#p0_gender'].value = 'Male';
    apply(c2, DANA);
    check(V(c2, 'gender') === '' && V(c2, 'nat') === '', 'an unsupported value clears whatever stood there, including a hand-picked one');

    /* Domestic card: no passport fields in the plan, so the issuing country is not touched at all. */
    const c3 = card(); c3.f['#p0_ppiss'].value = 'Nepal';
    apply(c3, DANA, false);
    check(V(c3, 'ppiss') === 'Nepal', 'on a domestic card the passport fields are left exactly as they were');

    /* NOTHING ELSE IS TOUCHED, across every one of those picks. */
    const k = card();
    [PRIYA, DANA, ELI, NIA, DANA].forEach(r => apply(k, r));
    check(k.f['#p0_email'].value === 'contact.person@example.com' && k.f['#p0_mobile'].value === '9876543210' && k.f['#p0_ccode'].value === '+91 India',
      'the booking contact\'s email, mobile and dial code are untouched by any pick');
    check(k.f['#p1_title'].value === 'Dr' && k.f['#p1_gender'].value === 'Male' && k.f['#p1_nat'].value === 'Nepal' && k.f['#p1_first'].value === 'Second',
      'another passenger\'s card is untouched, including its selects');

    /* The rule is exactly these four selects. */
    const list = /\[([^\]]*)\]/.exec(CLEARS);
    const names = list ? list[1].split(',').map(x => x.trim().replace(/'/g, '')).sort().join() : '';
    check(names === 'gender,nat,ppiss,title', 'the clearing rule covers exactly title, gender, nationality and issuing country (got ' + names + ')');
    check(!/email|mobile|ccode/.test(CLEARS), 'the contact fields can never be on the clearing list');
  }

  /* ---- PRIVACY: a short passport is never shown whole ----------------- */
  {
    check(m.bkfMaskPassport('') === '' && m.bkfMaskPassport(null) === '' && m.bkfMaskPassport('   ') === '', 'empty stays empty');
    check(m.bkfMaskPassport('A') === '••••' && m.bkfMaskPassport('AB') === '••••', '1-2 characters reveal nothing');
    check(m.bkfMaskPassport('AB1') === '•••• 1' && m.bkfMaskPassport('AB12') === '•••• 2', '3-4 characters reveal only the last one');
    check(m.bkfMaskPassport('AB123') === '•••• 23' && m.bkfMaskPassport('AB12345') === '•••• 45', '5-7 characters reveal the last two');
    check(m.bkfMaskPassport('M7654321') === '•••• 4321' && m.bkfMaskPassport('Z123456789') === '•••• 6789', '8+ characters reveal the last four, as before');
    for (let n = 1; n <= 14; n++) {
      const v = 'Q' + '7654321098765'.slice(0, n - 1);
      const out = m.bkfMaskPassport(v);
      const shown = out.replace(/[•\s]/g, '');
      check(out !== v && !out.includes(v), `a ${n}-character passport is not returned whole`);
      check(shown.length <= 4 && shown.length < n, `a ${n}-character passport reveals at most four characters and never all of them (shows ${shown.length})`);
      check(v.endsWith(shown), `what is shown is the tail of the ${n}-character value`);
    }
    const label = m.bkfSavedOptionLabel({ first_name: 'Sho', last_name: 'Rt', passport_number: 'AB12' });
    check(!label.includes('AB12') && label.includes('•••• 2'), 'a short passport in a dropdown label is masked, not printed');
    check(m.bkfSavedOptionLabel({ first_name: 'A', last_name: 'B', passport_number: 'X9' }) === 'A B · ••••', 'a 2-character passport leaves only the mask in the label');
  }

  /* ---- NATIONALITY: free text in Account Center, country names in the form -- */
  {
    const OPTS = [''].concat(NATIONALITIES);
    const mkSel = (value, values) => {
      const el = { tagName: 'SELECT', _v: value || '', sIdx: 0, options: values.map(v => ({ value: v })) };
      Object.defineProperty(el, 'value', { get() { return this._v; }, set(v) { this._v = v; } });
      Object.defineProperty(el, 'selectedIndex', { get() { return this.sIdx; }, set(i) { this.sIdx = i; if (i === -1) this._v = ''; } });
      return el;
    };
    const card = () => {
      const f = {
        '#p0_title': mkSel('', ['', 'Mr', 'Ms', 'Mrs', 'Dr', 'Mstr']), '#p0_gender': mkSel('', ['', 'Male', 'Female', 'Other']),
        '#p0_nat': mkSel('India', OPTS), '#p0_ppiss': mkSel('India', OPTS),
        '#p0_first': field('INPUT', ''), '#p0_last': field('INPUT', ''), '#p0_dob': field('INPUT', ''), '#p0_ff': field('INPUT', ''),
        '#p0_ppno': field('INPUT', ''), '#p0_ppexp': field('INPUT', ''),
        '#p0_email': field('INPUT', 'contact.person@example.com'), '#p0_mobile': field('INPUT', '9876543210'), '#p0_ccode': field('INPUT', '+91 India'),
        '#p1_nat': mkSel('Nepal', OPTS), '#p1_ppiss': mkSel('Nepal', OPTS), '#p1_first': field('INPUT', 'Second'),
      };
      return { f, root: fakeRoot(f) };
    };
    const pick = (c, rec, intl) => m.bkfApplySavedPlan(c.root, 0, m.bkfSavedFillPlan(rec, intl !== false));
    const NAT = c => c.f['#p0_nat'].value;

    /* -- the tables agree with the form --------------------------------------- */
    const adjKeys = Object.keys(m.ADJ);
    check(adjKeys.slice().sort().join('|') === NATIONALITIES.slice().sort().join('|'),
      'the demonym table covers exactly the countries the flight form offers');
    const demonyms = adjKeys.map(k => m.bkfAliasKey(m.ADJ[k]));
    check(new Set(demonyms).size === demonyms.length, 'no two countries share a demonym (nothing ambiguous)');
    check(adjKeys.every(k => m.ALIASES[m.bkfAliasKey(m.ADJ[k])] === k), 'every demonym resolves to its own country');
    check(Object.keys(m.ALIASES).every(k => NATIONALITIES.indexOf(m.ALIASES[k]) !== -1), 'every alias resolves to a real option of the form');
    check(NATIONALITIES.every(c => !(m.bkfAliasKey(c) in m.ALIASES) || m.ALIASES[m.bkfAliasKey(c)] === c),
      'no alias key is another country\'s name');
    check(m.bkfNationalityAdj('India') === 'Indian' && m.bkfNationalityAdj('United Kingdom') === 'British'
      && m.bkfNationalityAdj('Fiji') === 'Fiji' && m.bkfNationalityAdj('constructor') === 'constructor',
      'the display helper behaves exactly as before');

    /* -- exact matches and case variants keep working -------------------------- */
    [['India', 'India'], ['india', 'India'], ['INDIA', 'India'], ['  india ', 'India'], ['United Kingdom', 'United Kingdom'],
     ['united kingdom', 'United Kingdom'], ['SRI LANKA', 'Sri Lanka'], ['nepal', 'Nepal']].forEach(([saved, want]) => {
      const c = card(); c.f['#p0_nat'].value = (want === 'Nepal' ? 'India' : 'Nepal'); pick(c, { first_name: 'A', last_name: 'B', nationality: saved });
      check(NAT(c) === want, `"${saved}" selects "${want}" (got "${NAT(c)}")`);
    });

    /* -- known aliases -------------------------------------------------------- */
    [['Indian', 'India'], ['indian', 'India'], ['INDIAN', 'India'], [' Indian ', 'India'], ['Emirati', 'United Arab Emirates'],
     ['Saudi', 'Saudi Arabia'], ['Saudi Arabian', 'Saudi Arabia'], ['Singaporean', 'Singapore'], ['Thai', 'Thailand'],
     ['British', 'United Kingdom'], ['american', 'United States'], ['Australian', 'Australia'], ['Canadian', 'Canada'],
     ['German', 'Germany'], ['French', 'France'], ['Malaysian', 'Malaysia'], ['Sri Lankan', 'Sri Lanka'], ['Nepali', 'Nepal'],
     ['Nepalese', 'Nepal'], ['Qatari', 'Qatar'], ['Omani', 'Oman'], ['Bahraini', 'Bahrain'], ['Kuwaiti', 'Kuwait'],
     ['Maldivian', 'Maldives'], ['Indonesian', 'Indonesia'], ['UAE', 'United Arab Emirates'], ['U.A.E', 'United Arab Emirates'],
     ['USA', 'United States'], ['U.S.A.', 'United States'], ['US', 'United States'], ['United States of America', 'United States'],
     ['UK', 'United Kingdom'], ['U.K.', 'United Kingdom'], ['Great Britain', 'United Kingdom'], ['Britain', 'United Kingdom'],
     ['Emirian', 'United Arab Emirates']].forEach(([saved, want]) => {
      const c = card(); c.f['#p0_nat'].value = (want === 'Nepal' ? 'India' : 'Nepal');
      pick(c, { first_name: 'A', last_name: 'B', nationality: saved });
      check(NAT(c) === want, `the saved nationality "${saved}" selects "${want}" (got "${NAT(c)}")`);
    });

    /* -- unsupported or ambiguous: cleared, never guessed, never the previous value -- */
    ['Fijian', 'Fiji', 'Indian origin', 'Indian national', 'Kashmiri', 'Pakistani', 'Bhutanese', 'Commonwealth', 'Indi', 'Ind1a', 'IN',
     'IND', 'Ind', 'AUS', 'ARE', 'CAN', 'GBR', 'IDN', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '   ', ''].forEach(saved => {
      const c = card(); c.f['#p0_nat'].value = 'Nepal';                 // the PREVIOUS traveller's value
      let threw = false;
      try { pick(c, { first_name: 'A', last_name: 'B', nationality: saved }); } catch { threw = true; }
      check(!threw, `"${saved}" does not break the pick`);
      check(NAT(c) === '', `the unsupported nationality "${saved}" clears the field instead of keeping "Nepal" (got "${NAT(c)}")`);
    });
    { const c = card(); pick(c, { first_name: 'A', last_name: 'B' });
      check(NAT(c) === '', 'a traveller with no nationality clears it'); }

    /* -- an alias whose country this select does not offer is no match ------------- */
    {
      const sel = mkSel('Nepal', ['', 'Nepal', 'Qatar']);
      m.applyPickValue(fakeRoot({ '#n': sel }), 'n', 'Indian', { clearIfUnmatched: true, aliases: m.ALIASES });
      check(sel.value === '', 'an alias for a country the select lacks clears it, it does not invent an option');
      const sel2 = mkSel('Nepal', ['', 'Nepal', 'Qatar']);
      m.applyPickValue(fakeRoot({ '#n': sel2 }), 'n', 'Indian', { aliases: m.ALIASES });
      check(sel2.value === 'Nepal', 'and without the clearing flag it leaves the field alone, as before');
      const sel3 = mkSel('Nepal', OPTS);
      m.applyPickValue(fakeRoot({ '#n': sel3 }), 'n', 'Indian');
      check(sel3.value === 'Nepal', 'without an alias map "Indian" is not an option, so nothing changes (aliases are opt-in)');
    }

    /* -- only NATIONALITY gets aliases; the issuing country is untouched in behaviour -- */
    {
      const c = card();
      pick(c, { first_name: 'A', last_name: 'B', nationality: 'Indian', issuing_country: 'Indian', passport_number: 'Z7654321' });
      check(NAT(c) === 'India', 'nationality "Indian" selects India');
      check(c.f['#p0_ppiss'].value === '', 'the issuing country "Indian" is NOT aliased: it is not a country name, so it clears as before');
      pick(c, { first_name: 'A', last_name: 'B', nationality: 'British', issuing_country: 'India', passport_number: 'Z7654321' });
      check(NAT(c) === 'United Kingdom' && c.f['#p0_ppiss'].value === 'India', 'nationality and issuing country are mapped independently');
      const dom = card(); dom.f['#p0_ppiss'].value = 'Nepal';
      pick(dom, { first_name: 'A', last_name: 'B', nationality: 'Indian', issuing_country: 'India' }, false);
      check(NAT(dom) === 'India' && dom.f['#p0_ppiss'].value === 'Nepal', 'on a domestic card the issuing country is still left alone');
    }

    /* -- switching between travellers ----------------------------------------------- */
    {
      const c = card();
      const log = [];
      const seq = [
        [{ first_name: 'Priya', last_name: 'Sharma', title: 'Ms', gender: 'female', nationality: 'Indian', issuing_country: 'India' }, 'India'],
        [{ first_name: 'Dana', last_name: 'Unsupp', title: 'Mx', gender: 'nonbinary', nationality: 'Fijian', issuing_country: 'Fiji' }, ''],
        [{ first_name: 'Eli', last_name: 'Brit', title: 'dr', gender: 'OTHER', nationality: 'british', issuing_country: 'united kingdom' }, 'United Kingdom'],
        [{ first_name: 'Nia', last_name: 'Bare' }, ''],
        [{ first_name: 'Arjun', last_name: 'Mehta', title: 'Mr', gender: 'male', nationality: 'indian', issuing_country: 'India' }, 'India'],
        [{ first_name: 'Dana', last_name: 'Unsupp', nationality: 'Fijian' }, ''],
        [{ first_name: 'Omar', last_name: 'Said', nationality: 'Omani', issuing_country: 'Oman' }, 'Oman'],
      ];
      seq.forEach(([rec, want]) => { pick(c, rec); log.push(NAT(c)); check(NAT(c) === want, `after ${rec.first_name} (${rec.nationality || 'none'}) nationality is "${want}" (got "${NAT(c)}")`); });
      check(c.f['#p0_email'].value === 'contact.person@example.com' && c.f['#p0_mobile'].value === '9876543210' && c.f['#p0_ccode'].value === '+91 India',
        'the booking contact is untouched across every switch');
      check(c.f['#p1_nat'].value === 'Nepal' && c.f['#p1_ppiss'].value === 'Nepal' && c.f['#p1_first'].value === 'Second',
        'another passenger\'s nationality, issuing country and name are untouched');
      check(c.f['#p0_title'].value === '' && c.f['#p0_gender'].value === '', 'title and gender behave as before (the last record had neither)');
    }
  }

  /* ---- STALE FLOW CONTEXT: a response lands in the flow that is open NOW -- */
  {
    /* Flow A's render starts the request; the sheet is closed and another flight chosen
       (BookingFlow.start builds a new ctx); flow B renders — the request is already pending,
       so it starts none — and then the response lands. The OLD code read the form into the
       ctx captured by flow A's render. */
    const h = harness(); h.world.realDraft = true;
    const ctxA = h.ctx;
    const ctxB = { passengers: [], paxKinds: ['Adult'] };
    h.m.checkSavedTravellers(ctxA);                         // flow A's render (an argument the old code captured)
    h.flow.ctx = ctxB;                                      // flow B is now the active flow
    h.mkEl('p0_first', { value: 'Typed in flow B' });       // and it is flow B's form on screen
    h.m.checkSavedTravellers(ctxB);                         // flow B's render
    check(h.requests.length === 1, 'sanity: one request serves both flows (the cache is the customer\'s)');
    h.requests[0].resolve(A_LIST); await flush();
    check(h.reads.length === 1 && h.reads[0][0] === ctxB, 'the response reads the form into the ACTIVE flow\'s draft, not the one that started the request');
    check(ctxB.passengers[0] && ctxB.passengers[0].first === 'Typed in flow B', 'flow B\'s typed text is in flow B\'s draft');
    check(ctxA.passengers.length === 0, 'the closed flow\'s draft is left alone');
  }
  {
    /* No flow open when the response lands: nothing to read, no error, list still cached. */
    const h = harness(); h.world.realDraft = true;
    h.m.checkSavedTravellers(h.ctx);
    h.flow.ctx = null;
    h.requests[0].resolve(A_LIST); await flush();
    check(h.reads.length === 0 && h.order.join() === 'repaint', 'with no flow open nothing is read and the repaint is a harmless no-op');
    check(Array.isArray(h.m.st.list) && h.m.st.list.length === 1, 'the customer\'s list is still cached for the next flow');
  }
  {
    /* Both the flow AND the customer change while A's request is pending. */
    const h = harness(); h.world.realDraft = true;
    const ctxB = { passengers: [], paxKinds: ['Adult'] };
    h.m.checkSavedTravellers(h.ctx);                        // flow A, customer A
    h.flow.ctx = ctxB; h.auth.access = 'tok-B';             // another flow, another customer
    h.mkEl('p0_first', { value: 'Typed' });
    h.m.checkSavedTravellers(ctxB);                         // the new customer's own request
    check(h.requests.length === 2, 'the new customer starts their own request');
    h.requests[0].resolve(A_LIST); await flush();
    check(h.m.st.list === undefined && !h.m.bkfSavedPickerHtml(0).includes('Alpha'), 'the old customer\'s late response is dropped');
    h.requests[1].resolve(B_LIST); await flush();
    check(h.m.bkfSavedPickerHtml(0).includes('Bravo') && !h.m.bkfSavedPickerHtml(0).includes('Alpha'), 'only the new customer\'s list is offered');
    check(h.reads.length > 0 && h.reads.every(r => r[0] === ctxB), 'every draft read went to the active flow\'s ctx, never the old one');
  }

  /* ---- ONE "Save to my profile" control, however the card is built ------- */
  {
    const count = (str, re) => (str.match(re) || []).length;
    const cardCtx = (kinds, intl) => ({ paxKinds: kinds, passengers: [], saveTravellers: false,
      item: { origin: { country: 'India' }, destination: { country: intl ? 'Thailand' : 'India' } } });
    const partyOf = { one: ['Adult'], two: ['Adult', 'Adult'], family: ['Adult', 'Adult', 'Child', 'Infant'] };
    const pickers = { signedOut: { access: null }, error: { error: true }, pending: { pending: true }, empty: { list: [] }, loaded: { list: [TRAVELLER] } };
    Object.keys(partyOf).forEach(pk => [false, true].forEach(intl => Object.keys(pickers).forEach(ps => {
      const kinds = partyOf[pk];
      const h = harness(pickers[ps]);
      const html = h.m.renderCards(cardCtx(kinds, intl), { passport: true, frequentFlyer: true, reference: true });
      const tag = `${pk}/${intl ? 'international' : 'domestic'}/${ps}`;
      check(count(html, /id="bkSaveTravellers"/g) === 1, `[${tag}] exactly one Save-to-profile checkbox`);
      check(count(html, /<span>Save to my profile<\/span>/g) === 1, `[${tag}] the label "Save to my profile" appears once as a control`);
      check(count(html, /class="bkf-switch"/g) === 1 && count(html, /type="checkbox"/g) === 1, `[${tag}] one switch, one checkbox on the whole step (the picker adds none)`);
      check(count(html, /class="bkf-pax" /g) === kinds.length, `[${tag}] one card per passenger`);
      check(count(html, /data-saved-slot=/g) === kinds.length, `[${tag}] one picker slot per passenger card`);
      const cards = html.split('<div class="bkf-pax" ').slice(1);
      check(cards.length === kinds.length && cards.every(c => count(c, /data-saved-slot=/g) === 1 && count(c, /class="bkf-pax-body"/g) === 1),
        `[${tag}] each card holds exactly one slot, in its body`);
      check(cards.every(c => c.indexOf('data-saved-slot=') < c.indexOf('class="bkf-grid"')), `[${tag}] the picker sits above the fields`);
      check(count(cards[0], /id="bkSaveTravellers"/g) === 1 && cards.slice(1).every(c => count(c, /bkSaveTravellers/g) === 0),
        `[${tag}] the switch is on the lead card only`);
      check(count(html, /class="bkf-pax-remove"/g) === kinds.length - 1, `[${tag}] Remove on every card but the lead`);
      check(count(html, /class="bkf-passport"/g) === (intl ? kinds.length : 0), `[${tag}] passport block on every card if international, none if domestic`);
      check(count(html, /id="p0_email"/g) === 1 && count(html, /id="p\d+_email"/g) === 1, `[${tag}] the booking contact is on the lead card only`);
    })));
  }

  /* ---- FOCUS FALLBACK, end to end: real draft read, real mount hydration ---- */
  {
    /* The rebuild path: every node replaced, new ones EMPTY, text restored only from the draft the
       picker saved first, focus restored by the fallback. Unit-level: a fake DOM, not a browser. */
    const h = harness(); h.world.rebuild = true; h.world.realDraft = true;
    const first = h.mkEl('p0_first', { value: 'TypedWhilePending', start: 14, end: 14 });
    h.mkEl('p0_last', { value: 'Rao-Mehta' });
    h.mkEl('p0_email', { type: 'email', value: 'a@b.co' });
    h.doc.activeElement = first;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    const n = h.els.p0_first;
    check(n !== first && h.els.p0_last && h.els.p0_email, 'sanity: the rebuild replaced the nodes');
    check(n.value === 'TypedWhilePending' && h.els.p0_last.value === 'Rao-Mehta' && h.els.p0_email.value === 'a@b.co',
      'typed text in three fields survives the rebuild — via the real draft read and the real hydration');
    check(h.ctx.passengers[0] && h.ctx.passengers[0].first === 'TypedWhilePending' && h.ctx.passengers[0].email === 'a@b.co',
      'the draft holds what was on screen when the list arrived');
    check(h.doc.activeElement === n, 'keyboard focus is back on the field it was in');
    check(n.rangeCalls.length === 1 && n.rangeCalls[0][0] === 14 && n.rangeCalls[0][1] === 14, 'and the caret is back mid-word, at 14');
    check(h.order.join() === 'read,repaint', 'the draft was read BEFORE the repaint');
  }
  {
    /* the CORRECT control gets focus back, not simply the first one */
    const h = harness(); h.world.rebuild = true; h.world.realDraft = true;
    h.mkEl('p0_first', { value: 'One' });
    const last = h.mkEl('p0_last', { value: 'Mehta-Sharma', start: 2, end: 6, dir: 'forward' });
    h.mkEl('p1_first', { value: 'Two' });
    h.doc.activeElement = last;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    check(h.doc.activeElement === h.els.p0_last, 'focus returns to the control that had it (p0_last), not the first field');
    const r = h.els.p0_last.rangeCalls[0];
    check(r && r[0] === 2 && r[1] === 6 && r[2] === 'forward', 'its selected range comes back too');
    check(h.els.p0_first.focusCalls.length === 0 && h.els.p1_first.focusCalls.length === 0, 'no other control was focused');
  }
  {
    /* a field with no caret (email) and a select: focus alone, text/choice intact via the draft */
    const h = harness(); h.world.rebuild = true; h.world.realDraft = true;
    const email = h.mkEl('p0_email', { type: 'email', value: 'a@b.co' });
    h.mkEl('p0_gender', { tagName: 'SELECT', value: 'Female' });
    h.doc.activeElement = email;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    check(h.doc.activeElement === h.els.p0_email && h.els.p0_email.rangeCalls.length === 0 && h.els.p0_email.value === 'a@b.co',
      'an email field gets focus back, no selection attempted, text intact');
    check(h.els.p0_gender.value === 'Female', 'a select keeps its choice through the draft');
  }
  {
    /* What the draft read is FOR: without it, a rebuild loses the text but focus still returns. */
    const h = harness(); h.world.rebuild = true; h.world.realDraft = true; h.screen.readThrows = true;
    const first = h.mkEl('p0_first', { value: 'Typed', start: 5, end: 5 }); h.doc.activeElement = first;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    check(h.els.p0_first.value === '' && h.doc.activeElement === h.els.p0_first,
      'documented limit: if the draft read itself fails, a REBUILD loses the text (focus is still restored); a patched repaint never rebuilds');
  }
  {
    /* Only the picker slot's contents are replaced (a focused picker <select>): focus returns to the new select. */
    const h = harness(); h.world.replaceOnly = ['p0_saved'];
    const first = h.mkEl('p0_first', { value: 'Keep', start: 2, end: 2 });
    const sel = h.mkEl('p0_saved', { tagName: 'SELECT', value: '' });
    h.doc.activeElement = sel;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    check(h.els.p0_saved !== sel && h.doc.activeElement === h.els.p0_saved, 'a replaced picker <select> gets keyboard focus back');
    check(h.els.p0_saved.rangeCalls.length === 0, 'with no caret attempted on a select');
    check(h.els.p0_first === first && first.valueWrites === 0 && first.focusCalls.length === 0 && first.value === 'Keep',
      'the rest of the form is the same nodes, untouched');
  }

  /* ---- THE PICKER'S SLOT: the card is patched, not rebuilt ------------- */
  {
    const open = i => `<div class="bkf-saved-slot" data-bk-slot data-saved-slot="${i}">`;
    const states = {
      signedOut: harness({ access: null }),
      error: harness({ error: true }),
      pending: harness({ pending: true }),
      unasked: harness(),
      empty: harness({ list: [] }),
      loaded: harness({ list: [TRAVELLER] }),
    };
    Object.keys(states).forEach(k => {
      const html = states[k].m.bkfSavedPickerHtml(3);
      check(html.startsWith(open(3)) && html.endsWith('</div>'),
        `the ${k} state is wrapped in the same data-bk-slot box (so the card's shape never changes)`);
    });
    check(states.pending.m.bkfSavedPickerHtml(0) === open(0) + '</div>', 'a pending load is an empty slot, which takes no room');
    check(/<select[^>]*data-saved-pick="1"/.test(states.loaded.m.bkfSavedPickerHtml(1)), 'the select sits inside the slot');

    /* The mechanism the slot relies on, in booking-flow.js: two slots match whatever they hold,
       and a matching slot has its contents rewritten without touching its siblings. */
    check(/const isSlot = n => n\.nodeType === 1 && n\.hasAttribute\('data-bk-slot'\);/.test(FLOW), 'the flow identifies slots by data-bk-slot');
    check(/if \(isSlot\(a\) && isSlot\(b\)\) return true;/.test(FLOW), 'sameShape ignores what a slot contains');
    check(/if \(isSlot\(a\)\) \{\s*if \(a\.innerHTML !== b\.innerHTML\) a\.innerHTML = b\.innerHTML;\s*return;/.test(FLOW),
      'a patched slot has its contents rewritten in place');

    /* The listener lives on the slot, so it survives the contents being replaced. */
    const mountAt = SRC.indexOf("root.querySelectorAll('[data-saved-slot]')");
    check(mountAt !== -1, 'the pick listener is bound on each picker slot');
    check(!/querySelectorAll\('\[data-saved-pick\]'\)/.test(SRC), 'nothing is bound directly to the <select>, which is replaced');
    check(/ev\.target\.closest\('\[data-saved-pick\]'\)/.test(SRC), 'the slot handler finds the select from the event');
  }

  /* ---- REGRESSION: focus and caret survive the list arriving ----------- */
  {
    /* A patched repaint (the normal case now): nothing is touched, nothing needs fixing. */
    const h = harness();
    const f = h.mkEl('p0_first', { value: 'TypedWhilePending', start: 14, end: 14 });
    h.doc.activeElement = f;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    check(h.doc.activeElement === f && h.els.p0_first === f, 'a patched repaint leaves the very same element focused');
    check(f.focusCalls.length === 0 && f.rangeCalls.length === 0, 'and does not re-focus or move the caret (nothing was lost)');
    check(f.value === 'TypedWhilePending' && f.valueWrites === 0, 'typed text is untouched');
  }
  {
    /* A REBUILDING repaint: new nodes, focus on <body>. */
    const h = harness(); h.world.rebuild = true;
    const f = h.mkEl('p0_first', { value: 'TypedWhilePending', start: 14, end: 14 });
    h.doc.activeElement = f;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    const n = h.els.p0_first;
    check(n !== f, 'sanity: the rebuild really replaced the element');
    check(h.doc.activeElement === n, 'focus is back on the rebuilt field');
    check(n.focusCalls.length === 1 && n.focusCalls[0] && n.focusCalls[0].preventScroll === true, 'focus returns without scrolling the page');
    check(n.rangeCalls.length === 1 && n.rangeCalls[0][0] === 14 && n.rangeCalls[0][1] === 14, 'the caret is back at position 14, mid-word');
    check(n.value === 'TypedWhilePending' && n.valueWrites === 0, 'restoring focus writes no value — the traveller\'s text is never overwritten');
    check(h.order.join() === 'read,repaint', 'the draft is still read before the repaint');
  }
  {
    /* a real selection, and its direction */
    const h = harness(); h.world.rebuild = true;
    const f = h.mkEl('p0_last', { value: 'Mehta-Sharma', start: 3, end: 8, dir: 'backward' });
    h.doc.activeElement = f;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    const r = h.els.p0_last.rangeCalls[0];
    check(r && r[0] === 3 && r[1] === 8 && r[2] === 'backward', 'a selected range and its direction are restored, not just the caret');
  }
  {
    /* the rebuilt value is shorter than the old caret: clamp, never throw */
    const h = harness(); h.world.rebuild = true; h.world.valueAfter = { p0_first: 'Short' };
    const f = h.mkEl('p0_first', { value: 'TypedWhilePending', start: 14, end: 14 });
    h.doc.activeElement = f;
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    const r = h.els.p0_first.rangeCalls[0];
    check(r && r[0] === 5 && r[1] === 5, 'a caret past the end of a shorter restored value is clamped to the end');
  }
  {
    /* types with no caret (email, date, number) and selects: focus only, no selection calls */
    for (const type of ['email', 'date', 'number']) {
      const h = harness(); h.world.rebuild = true;
      const f = h.mkEl('p0_x', { type, value: 'a@b.co' });
      h.doc.activeElement = f;
      h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
      const n = h.els.p0_x;
      check(h.doc.activeElement === n && n.rangeCalls.length === 0, `a ${type} field gets focus back and no selection is attempted`);
    }
    const hs = harness(); hs.world.rebuild = true;
    const sel = hs.mkEl('p0_gender', { tagName: 'SELECT', value: 'Male' });
    hs.doc.activeElement = sel;
    hs.m.checkSavedTravellers(); hs.requests[0].resolve(A_LIST); await flush();
    check(hs.doc.activeElement === hs.els.p0_gender && hs.els.p0_gender.rangeCalls.length === 0 && hs.els.p0_gender.value === 'Male',
      'a focused <select> gets focus back, with no caret and its value intact');
    const ht = harness(); ht.world.rebuild = true;
    const ta = ht.mkEl('p0_note', { tagName: 'TEXTAREA', value: 'hello world', start: 5, end: 5 });
    ht.doc.activeElement = ta;
    ht.m.checkSavedTravellers(); ht.requests[0].resolve(A_LIST); await flush();
    check(ht.els.p0_note.rangeCalls.length === 1 && (ht.els.p0_note.rangeCalls[0] || [])[0] === 5, 'a <textarea> keeps its caret too');
  }
  {
    /* focus is never stolen */
    const h = harness(); h.world.rebuild = true;
    const f = h.mkEl('p0_first', { value: 'Abc' }); h.mkEl('p1_first', { value: '' });
    h.doc.activeElement = f; h.world.activeAfter = 'p1_first';      // the traveller had already moved on
    h.m.checkSavedTravellers(); h.requests[0].resolve(A_LIST); await flush();
    check(h.doc.activeElement === h.els.p1_first && h.els.p0_first.focusCalls.length === 0,
      'if the traveller has already focused another field, focus is not pulled back');

    const h2 = harness(); h2.world.rebuild = true;
    const header = { id: 'hdrBtn', tagName: 'BUTTON' };               // focus outside the form
    h2.mkEl('p0_first', { value: 'Abc' }); h2.doc.activeElement = header;
    h2.m.checkSavedTravellers(); h2.requests[0].resolve(A_LIST); await flush();
    check(h2.els.p0_first.focusCalls.length === 0, 'focus outside the passenger form is left alone');

    const h3 = harness(); h3.world.rebuild = true; h3.world.drop = ['p0_first'];
    const f3 = h3.mkEl('p0_first', { value: 'Abc' }); h3.doc.activeElement = f3;
    h3.m.checkSavedTravellers(); h3.requests[0].resolve(A_LIST); await flush();
    check(h3.doc.activeElement === h3.body && !h3.els.p0_first, 'a field that no longer exists is skipped without error');

    const h4 = harness(); h4.world.rebuild = true; h4.world.disable = ['p0_first'];
    const f4 = h4.mkEl('p0_first', { value: 'Abc' }); h4.doc.activeElement = f4;
    h4.m.checkSavedTravellers(); h4.requests[0].resolve(A_LIST); await flush();
    check(h4.els.p0_first.focusCalls.length === 0, 'a field that is now disabled is not focused');

    const h5 = harness(); h5.world.rebuild = true; h5.screen.travellerCards = false;
    const f5 = h5.mkEl('p0_first', { value: 'Abc' }); h5.doc.activeElement = f5;
    h5.m.checkSavedTravellers(); h5.requests[0].resolve(A_LIST); await flush();
    check(h5.els.p0_first.focusCalls.length === 0, 'with no traveller cards on screen no focus is touched');
  }
  {
    /* a failed load restores focus the same way, and a throwing capture/read never blocks the repaint */
    const h = harness(); h.world.rebuild = true;
    const f = h.mkEl('p0_first', { value: 'Typed', start: 2, end: 2 }); h.doc.activeElement = f;
    h.m.checkSavedTravellers(); h.requests[0].reject(new Error('500')); await flush();
    check(h.doc.activeElement === h.els.p0_first && (h.els.p0_first.rangeCalls[0] || [])[0] === 2, 'a failed load also restores focus and caret');
    const hb = harness(); hb.screen.readThrows = true; hb.world.rebuild = true;
    const fb = hb.mkEl('p0_first', { value: 'Typed', start: 2, end: 2 }); hb.doc.activeElement = fb;
    hb.m.checkSavedTravellers(); hb.requests[0].resolve(A_LIST); await flush();
    check(hb.order.join() === 'read,repaint' && hb.doc.activeElement === hb.els.p0_first, 'a draft read that throws still repaints and still restores focus');
  }

  /* ---- no sensitive data in logs ------------------------------------ */
  check(!/console\./.test(ALIASES) && !/console\./.test(NATADJ) && !/console\./.test(MASK) && !/console\./.test(STATE) && !/console\./.test(PICKER) && !/console\./.test(INNER) && !/console\./.test(PLAN) && !/console\./.test(APPLY),
    'the picker and its cache lifecycle never log');

  /* ---- STRUCTURAL: wiring, no-submit, payload untouched ------------- */
  check(/function checkSavedTravellers\(/.test(SRC), 'the fetch helper exists');
  check(/checkSavedTravellers\(\);/.test(SRC) && !/function checkSavedTravellers\(ctx/.test(SRC),
    'the fetch captures no flow ctx: the repaint asks the flow for its current draft');
  check(/BookingFlow\.context/.test(STATE), 'the repaint reads the ACTIVE flow\'s draft from BookingFlow.context');
  check(/get context\(\) \{ return ctx; \}/.test(FLOW), 'BookingFlow really exports the active ctx');
  check(/function start\(definition, seed\) \{\s*flow = definition;\s*ctx = Object\.assign\(/.test(FLOW), 'every flow start builds a NEW ctx (why a captured one goes stale)');
  check(/BookingApi\.travellers\(\)/.test(SRC), 'it fetches through the existing BookingApi.travellers() client');
  check(/_savedTravellers !== undefined \|\| _savedTravellersPending \|\| _savedTravellersError/.test(SRC),
    'the fetch is guarded so it runs once (no repeated calls / repaint loop)');
  check(/getCustomerAuth\(\)/.test(STATE) && /\.access/.test(STATE), 'the cache is keyed on the customer\'s access token');

  /* The selection handler reads the draft back in but must not submit/save. */
  const handlerAt = SRC.indexOf("root.querySelectorAll('[data-saved-slot]')");
  const block = SRC.slice(handlerAt, SRC.indexOf('validate(ctx) {', handlerAt));
  check(/readInto\(ctx, root\)/.test(block), 'a pick reads the draft in (so Back keeps it)');
  check(!/createBooking|submit\(|\.pay\(|quote\(/.test(block), 'a pick never books, pays, quotes or submits');
  check(/sel\.value = '';/.test(block), 'the dropdown resets so the same traveller can be re-picked');
  check(/syncSavedTravellersOwner\(\)/.test(block), 'a pick re-checks the owner before using the cached list');

  /* The booking payload still treats email/mobile as the lead contact only —
     the picker change must not have altered how the party is sent. */
  check(/is_contact: i === 0,/.test(SRC), 'the payload still marks only the first passenger as the contact');
  check(/email: i === 0 \? \(p\.email \|\| null\) : null,/.test(SRC),
    'email is still sent for the contact passenger only');
  check(/mobile: i === 0 && p\.mobile/.test(SRC), 'mobile is still sent for the contact passenger only');

  /* ---- CSS is present so the control is not unstyled ---------------- */
  check(/\.bkf-saved\b/.test(CSS), 'booking-ref.css styles the picker');
  check(/\.bkf-saved\.is-hint\b/.test(CSS), 'the hint variant is styled');

  if (failures.length) {
    console.error('FAIL - saved-travellers-picker.test.js');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('PASS - saved-travellers-picker.test.js (mask, label, fill plan, case-insensitive selects, picker states, cache lifecycle, stale responses, draft-before-repaint, picker slot, focus/caret restore, title/gender/nationality clearing, nationality aliases, passport masking, stale flow context, one save control, focus fallback, wiring, payload)');
})();
