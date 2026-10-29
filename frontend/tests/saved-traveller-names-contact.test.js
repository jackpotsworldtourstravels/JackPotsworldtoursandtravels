'use strict';
/* ===========================================================================
   Saved travellers: first / middle / last stay apart, the traveller's own phone
   and email are theirs, and the account profile only ever fills an EMPTY booking
   contact. Pure pieces are lifted out of the shipped files and run in a VM; the
   rest is asserted structurally. Synthetic data only.

   run:  node frontend/tests/saved-traveller-names-contact.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const BP = read('assets/js/booking-products.js');
const HG = read('assets/js/hotel-guests.js');
const AC = read('assets/js/account-center.js');
const INDEX = read('index.html');
const API = read('assets/js/booking-api.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

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
const sandbox = code => { const sb = {}; vm.createContext(sb); vm.runInContext(code, sb); return sb; };

/* ---- 1. picker fill plan + label carry the middle name ------------------- */
const PLAN = extractFn(BP, 'function bkfSavedFillPlan(');
const LABEL = extractFn(BP, 'function bkfSavedOptionLabel(');
const MASK = extractFn(BP, 'function bkfMaskPassport(');
{
  const m = sandbox(`${MASK}\n${LABEL}\n${PLAN}\nglobalThis.plan=bkfSavedFillPlan;globalThis.label=bkfSavedOptionLabel;`);
  const t = { first_name: 'Asha', middle_name: 'Kumari', last_name: 'Rao', mobile: '+919000000001', email: 'own@example.com' };
  const plan = m.plan(t, false);
  check(plan.first === 'Asha' && plan.middle === 'Kumari' && plan.last === 'Rao', 'picker fills first, middle and last separately');
  check(!('mobile' in plan) && !('email' in plan) && !('ccode' in plan), 'picker never writes the booking contact, whatever the traveller carries');
  check(m.plan({ first_name: 'Ravi', last_name: 'Rao' }, false).middle === '', 'a traveller with no middle name clears a stale one');
  check(/Asha Kumari Rao/.test(m.label(t)), 'the option label shows the full name');
}

/* ---- 2. phone split: no guessing ----------------------------------------- */
const CODES = (/const COUNTRY_CODES = \[[\s\S]*?\];/.exec(BP) || [''])[0];
const SPLIT = extractFn(BP, 'function bkfSplitProfilePhone(');
check(CODES !== '' && SPLIT !== '', 'COUNTRY_CODES and bkfSplitProfilePhone exist');
{
  const m = sandbox(`${CODES}\n${SPLIT}\nglobalThis.split=bkfSplitProfilePhone;`);
  const a = m.split('+919876543210', '+91 India', false);
  check(a && a.code === '+91 India' && a.number === '9876543210', '"+91..." is split into the India code and the number');
  const b = m.split('+971501234567', '+91 India', false);
  check(b && b.code === '+971 UAE' && b.number === '501234567', 'a longer dial code beats a shorter prefix');
  check(m.split('+99912345678', '+91 India', false) === null, 'an unknown dial code is not guessed');
  const c = m.split('98765 43210', '+91 India', false);
  check(c && c.code === null && c.number === '9876543210', 'a bare number keeps the form\'s own code');
  check(m.split('9876543210', '+91 India', true) === null, 'a bare number is not used once the traveller chose a code');
  check(m.split('', '+91 India', false) === null && m.split(null, '+91 India', false) === null, 'blank gives nothing');
  check(m.split('+9198', '+91 India', false) === null, 'a too-short remainder is rejected');
}

/* ---- 3. profile prefill: only empty, only untouched, only the right flow --- */
{
  const APPLYFN = extractFn(BP, 'function bkfApplyProfileToLead(');
  check(APPLYFN !== '', 'bkfApplyProfileToLead exists');
  function run({ email = '', mobile = '', ccode = '+91 India', touched = {}, profile, sameFlow = true }) {
    const els = { '#p0_email': { value: email }, '#p0_mobile': { value: mobile }, '#p0_ccode': { value: ccode } };
    const ctx = { leadTouched: touched };
    let draftReads = 0;
    const sb = {
      _profile: profile,
      BookingFlow: { context: sameFlow ? ctx : {} },
      document: { getElementById: () => ({ querySelector: sel => els[sel] || null }) },
      COUNTRY_CODES: null, bkfSplitProfilePhone: null, readInto: () => { draftReads++; },
    };
    vm.createContext(sb);
    vm.runInContext(`${CODES.replace('const ', 'var ')}\n${SPLIT}\n${APPLYFN}\nglobalThis.go=bkfApplyProfileToLead;`, sb);
    sb.go(ctx);
    return { els, draftReads };
  }
  const profile = { email: 'acct@example.com', mobile: '+919000000009' };

  let r = run({ profile });
  check(r.els['#p0_email'].value === 'acct@example.com' && r.els['#p0_mobile'].value === '9000000009', 'empty contact fields are filled from the profile');

  r = run({ profile, email: 'typed@example.com', mobile: '8111111111' });
  check(r.els['#p0_email'].value === 'typed@example.com' && r.els['#p0_mobile'].value === '8111111111', 'typed values are never replaced');

  r = run({ profile, touched: { email: true, mobile: true } });
  check(r.els['#p0_email'].value === '' && r.els['#p0_mobile'].value === '', 'a field the traveller touched (even if cleared) is left alone');

  r = run({ profile, email: 'typed@example.com' });
  check(r.els['#p0_email'].value === 'typed@example.com' && r.els['#p0_mobile'].value === '9000000009', 'each field is decided on its own');

  r = run({ profile, sameFlow: false });
  check(r.els['#p0_email'].value === '' && r.els['#p0_mobile'].value === '', 'a response for a flow that is no longer open changes nothing');

  r = run({ profile, email: 'typed@example.com', mobile: '8111111111' });
  check(r.draftReads === 0, 'nothing written means the draft is not re-read');
  r = run({ profile });
  check(r.draftReads === 1, 'a fill re-reads the draft once');

  r = run({ profile: undefined });
  check(r.els['#p0_email'].value === '', 'no profile loaded, nothing happens');

  r = run({ profile: { email: 'acct@example.com', mobile: '+99912345678' } });
  check(r.els['#p0_mobile'].value === '' && r.els['#p0_email'].value === 'acct@example.com', 'an unparseable phone leaves the mobile empty but still fills the email');
}

/* ---- 4. profile prefill wiring: owner-scoped, never touches other passengers */
{
  const CHECKP = extractFn(BP, 'function checkProfile(');
  check(/_profile = undefined;[\s\S]*?_profileError = false;/.test(extractFn(BP, 'function resetSavedTravellers(')),
    'the profile is dropped on every credential change with the saved list');
  check(/seq !== _savedSeq \|\| savedOwnerKey\(\) !== owner/.test(CHECKP), 'a response for another customer / reset is discarded');
  check(!/#p[1-9]/.test(extractFn(BP, 'function bkfApplyProfileToLead(')), 'only passenger 0 (the booking contact) is ever written');
  check(/checkProfile\(ctx\);/.test(BP), 'the passenger step asks for the profile');
  check(/profile = \(\) => get\('\/api\/customer\/auth\/me'\)/.test(API) && /travellers, profile,/.test(API), 'BookingApi.profile uses the authenticated /me endpoint');
  check(!/console\.(log|info|debug)\([^)]*(_profile|profile)/.test(BP), 'the profile is never logged');
}

/* ---- 5. payloads: first and middle travel separately, contact stays the booking's */
{
  check(!/\[p\.first, p\.middle\]\.filter\(Boolean\)\.join/.test(BP), 'no payload folds the middle name into first_name any more');
  const n = (BP.match(/first_name: p\.first,\s*\n\s*middle_name: p\.middle \|\| null,/g) || []).length;
  check(n === 3, `flight, hotel and package payloads each send first_name and middle_name separately (found ${n})`);
  const lead = (BP.match(/is_contact: i === 0,/g) || []).length;
  check(lead >= 3, 'the booking contact still rides only on the first passenger');
  check(/mobile: i === 0 && p\.mobile/.test(BP) && /email: i === 0 \? \(p\.email \|\| null\) : null/.test(BP),
    'booking-contact phone/email are unchanged');
  check(/middle_name: \(v\.middle \|\| ''\)\.trim\(\) \|\| null/.test(HG), 'the hotel guest form sends middle_name');
  check(/id: `g\$\{i\}-middle`/.test(HG) && /first\|middle\|last/.test(HG), 'the hotel guest form has a middle-name field it can read back');
  check(/lead\.middle = lead\.middle \|\| t\.middle_name/.test(HG), 'hotel prefill from a saved traveller carries the middle name');
}

/* ---- 6. hotel contact prefill ---------------------------------------------- */
{
  const DIAL = (/const DIAL_CODES = \[[^\]]*\];/.exec(HG) || [''])[0];
  const MOB = (/const MOBILE_RE = [^;]*;/.exec(HG) || [''])[0];
  const SPLITH = extractFn(HG, 'function splitProfilePhone(');
  const PREF = extractFn(HG, 'async function prefillLeadContact(');
  const KEY = extractFn(HG, 'function authKey(');
  check(DIAL && MOB && SPLITH && PREF && KEY, 'hotel contact prefill pieces exist');

  async function run(lead, me, tokens) {
    let call = 0;
    const sb = {
      lead, BookingApi: { profile: async () => me }, getCustomerAuth: () => ({ access: tokens[Math.min(call++, tokens.length - 1)] }),
    };
    vm.createContext(sb);
    vm.runInContext(`${DIAL}\n${MOB}\n${SPLITH}\n${KEY}\n${PREF}\nglobalThis.go = () => prefillLeadContact(lead);`, sb);
    await sb.go();
    return lead;
  }
  (async () => {
    const me = { email: 'acct@example.com', mobile: '+919000000009' };
    let l = await run({ dial: '+91' }, me, ['t1']);
    check(l.email === 'acct@example.com' && l.mobile === '9000000009' && l.dial === '+91', 'hotel lead contact is filled when empty');
    l = await run({ dial: '+91', email: 'typed@example.com', mobile: '8111111111' }, me, ['t1']);
    check(l.email === 'typed@example.com' && l.mobile === '8111111111', 'hotel typed contact is not overwritten');
    l = await run({ dial: '+91', _touched_email: true, _touched_mobile: true }, me, ['t1']);
    check(!l.email && !l.mobile, 'hotel touched-and-cleared contact is left alone');
    l = await run({ dial: '+91' }, me, ['t1', 't2']);
    check(!l.email && !l.mobile, 'hotel: a different customer signing in mid-request gets nothing');
    l = await run({ dial: '+91' }, { email: 'a@example.com', mobile: '+99912345678' }, ['t1']);
    check(l.email === 'a@example.com' && !l.mobile, 'hotel: an unknown dial code is not guessed');

    finish();
  })();
}

/* ---- 6b. Packages: the split traveller card gets Middle name + the saved picker ------ */
{
  const FLOWS = read('assets/js/booking-flows.js');
  const CSS = read('assets/css/booking.css');

  /* Opt-in, and only for packages: hotel guests, cruise and visa cards are untouched. */
  const optIns = FLOWS.match(/P\.travellersStep\(\{[^}]*savedTravellers: true[^}]*\}\)/g) || [];
  check(optIns.length === 1 && /noun: 'Traveller'/.test(optIns[0]) && /passport: true/.test(optIns[0]),
    'exactly one step opts in: the package Traveller step');
  check(!/noun: '(Guest|Passenger|Applicant)'[^)]*savedTravellers/.test(FLOWS), 'hotel / cruise / visa steps do not opt in');

  /* The field list: Middle sits between First and Last, only when opted in. */
  const SPECS = extractFn(BP, 'function primarySpecs(');
  check(SPECS !== '', 'primarySpecs exists');
  {
    const sb = sandbox(`${CODES}\nconst BookingData = { NATIONALITIES: [], TITLES: [] };\n${SPECS}\nglobalThis.specs = primarySpecs;`);
    const ids = o => sb.specs(0, o).map(f => f.id);
    const on = ids({ savedTravellers: true });
    check(on.indexOf('p0_first') + 1 === on.indexOf('p0_middle') && on.indexOf('p0_middle') + 1 === on.indexOf('p0_last'),
      'Middle name sits between First and Last when opted in');
    check(ids({}).indexOf('p0_middle') === -1, 'the other products keep their field list unchanged');
    check(sb.specs(0, { savedTravellers: true }).find(f => f.id === 'p0_middle').required === false, 'Middle name is optional');
    check(sb.specs(2, { savedTravellers: true }).every(f => f.id.startsWith('p2_')), 'ids follow the passenger index');
  }
  check(/\$\{o\.savedTravellers \? bkfSavedPickerHtml\(i\) : ''\}/.test(BP), 'each opted-in card carries the picker slot');
  check(/if \(o\.savedTravellers\) checkSavedTravellers\(\);/.test(BP), 'the saved list is fetched only for opted-in steps');
  check(/\.bk-pax-body \.bkf-saved select/.test(CSS), 'the picker has styling on pages that do not load booking-ref.css');
  check(!/tick "Save to my profile"[^\n]*\n[^\n]*\n[^\n]*package/.test(BP) &&
        /add them under Saved Travellers in your account/.test(BP), 'the package empty state does not promise a checkbox it lacks');

  /* Picking fills ONLY the chosen passenger, names separately, on the legacy card's own ids. */
  const NAT = (/const BKF_NATIONALITY_ADJ = \{[\s\S]*?\n  \};/.exec(BP) || [''])[0];
  const ALI = (/const BKF_NATIONALITY_ALIASES = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/.exec(BP) || [''])[0];
  const CLEARS = (/const BKF_PICK_CLEARS = [^;]*;/.exec(BP) || [''])[0];
  const code = [NAT, extractFn(BP, 'function bkfAliasKey('), ALI, CLEARS, extractFn(BP, 'function applyPickValue('),
    extractFn(BP, 'function bkfApplySavedPlan('), extractFn(BP, 'function bkfSavedFillPlan('),
    'globalThis.apply = bkfApplySavedPlan; globalThis.plan = bkfSavedFillPlan;'].join('\n');
  const m = sandbox(code);
  const mkRoot = () => {
    const el = (tag, opts) => ({ tagName: tag, value: '', options: (opts || []).map(v => ({ value: v })) });
    const els = {};
    for (const i of [0, 1]) {
      for (const s of ['first', 'middle', 'last', 'dob', 'ppno', 'ppexp', 'ff', 'email', 'mobile']) els[`p${i}_${s}`] = el('INPUT');
      els[`p${i}_gender`] = el('SELECT', ['', 'Male', 'Female']);
      els[`p${i}_nat`] = el('SELECT', ['', 'India', 'United Arab Emirates']);
      els[`p${i}_title`] = el('SELECT', ['', 'Mr', 'Ms']);
      els[`p${i}_ppiss`] = el('SELECT', ['', 'India']);
    }
    els.p1_first.value = 'Second'; els.p1_middle.value = 'Traveller'; els.p0_email.value = 'booker@example.com'; els.p0_mobile.value = '9000000001';
    return { els, querySelector: sel => els[sel.slice(1)] || null };
  };
  const saved = { first_name: 'Asha', middle_name: 'Kumari', last_name: 'Rao', gender: 'female', nationality: 'Indian',
                  date_of_birth: '1990-04-12', passport_number: 'TW000111', passport_expiry: '2032-05-01',
                  mobile: '+919000000011', email: 'asha.own@example.com' };
  const root = mkRoot();
  m.apply(root, 0, m.plan(saved, true));
  check(root.els.p0_first.value === 'Asha' && root.els.p0_middle.value === 'Kumari' && root.els.p0_last.value === 'Rao',
    'package pick: first, middle and last land in their own boxes');
  check(root.els.p0_gender.value === 'Female' && root.els.p0_nat.value === 'India' && root.els.p0_dob.value === '1990-04-12',
    'package pick: gender and nationality are normalised to the form\'s options');
  check(root.els.p0_ppno.value === 'TW000111', 'package pick: the passport goes into the passport field (the field is masked only in the list)');
  check(root.els.p1_first.value === 'Second' && root.els.p1_middle.value === 'Traveller' && root.els.p1_ppno.value === '',
    'package pick: another passenger\'s card is untouched');
  check(root.els.p0_email.value === 'booker@example.com' && root.els.p0_mobile.value === '9000000001',
    'package pick: booking contact is not overwritten by the traveller\'s own phone / email');
  const dom = mkRoot();
  m.apply(dom, 1, m.plan({ first_name: 'Ravi', last_name: 'Rao' }, false));
  check(dom.els.p1_middle.value === '' && dom.els.p1_first.value === 'Ravi', 'package pick: a traveller with no middle name clears the previous one');
  check(dom.els.p1_ppno.value === '', 'domestic package pick writes no passport fields');

  /* Draft round-trip: readInto reads the Middle box, and restore writes it back. */
  const READ = extractFn(BP, 'function readInto(');
  {
    const els = {};
    for (const i of [0, 1]) for (const s of ['title', 'first', 'middle', 'last', 'gender', 'dob', 'nat', 'ppno', 'ppexp', 'ppiss', 'ffair', 'ff', 'ccode', 'mobile', 'email'])
      els[`p${i}_${s}`] = { value: '' };
    els.p0_first.value = ' Asha '; els.p0_middle.value = ' Kumari '; els.p0_last.value = 'Rao';
    els.p1_first.value = 'Ravi'; els.p1_middle.value = ''; els.p1_last.value = 'Rao';
    const root = { querySelector: sel => (sel === '#bkSaveTravellers' ? null : els[sel.slice(1)] || null) };
    const ctx = { paxKinds: ['Adult', 'Adult'] };
    const sbx = sandbox(`${READ}\nglobalThis.read = readInto;`); sbx.read(ctx, root);
    check(ctx.passengers[0].first === 'Asha' && ctx.passengers[0].middle === 'Kumari' && ctx.passengers[0].last === 'Rao',
      'the draft holds first, middle and last separately');
    check(ctx.passengers[1].middle === '' && ctx.passengers[1].first === 'Ravi', 'each passenger keeps their own middle name');
    check(ctx.passengers[1].email === null && ctx.passengers[1].mobile === null, 'only passenger 0 carries booking-contact fields');
  }

  /* Submission: the shipped package payload expression, run on a draft. */
  {
    const at = BP.indexOf('travellers: (ctx.passengers || []).map(');
    check(at !== -1, 'the package payload builder exists');
    let depth = 0, end = at;
    for (let i = BP.indexOf('(', at + 'travellers: (ctx.passengers'.length - 1); i < BP.length; i++) {
      if (BP[i] === '(') depth++;
      else if (BP[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const expr = BP.slice(BP.indexOf('(ctx.passengers', at), end + 1);
    const ctx = { passengers: [
      { kind: 'Adult', title: 'Ms', first: 'Asha', middle: 'Kumari', last: 'Rao', gender: 'Female', dob: '1990-04-12', nationality: 'India',
        passportNumber: 'TW000111', countryCode: '+91 India', mobile: '9000000001', email: 'booker@example.com' },
      { kind: 'Adult', first: 'Ravi', middle: '', last: 'Rao', gender: 'Male', countryCode: null, mobile: null, email: null },
    ] };
    const out = new Function('ctx', 'return ' + expr)(ctx);
    check(out[0].first_name === 'Asha' && out[0].middle_name === 'Kumari' && out[0].last_name === 'Rao',
      'package payload: first and middle are sent separately (the server composes the given name)');
    check(out[1].first_name === 'Ravi' && out[1].middle_name === null, 'package payload: an empty middle is null, not an empty string');
    check(out[0].is_contact === true && out[0].mobile === '+919000000001' && out[0].email === 'booker@example.com',
      'package payload: the booking contact is the lead\'s typed contact');
    check(out[1].is_contact === false && out[1].mobile === null && out[1].email === null, 'package payload: other travellers carry no contact');
    check(out.length === 2 && out[0].traveller_type === 'adult', 'package payload: passenger count and types are unchanged');
  }
}

/* ---- 6c. International detection: a package says is_international, a flight says isInternational ---- */
{
  const INTL = extractFn(API, 'function isInternational(');
  check(INTL !== '', 'BookingApi.isInternational exists');
  const intl = sandbox(`${INTL}\nglobalThis.f = isInternational;`).f;

  /* The object package.js hands the booking flow (bookingItem), for a real catalogue row. */
  const intlPackage = { id: '5', name: 'Thailand Escape', days: 6, priceFrom: 48900, blurb: 'Bangkok and Phuket', is_international: true, category: 'holiday' };
  const domPackage = { id: '7', name: 'Goa Beach Break', days: 4, priceFrom: 21900, blurb: 'North and South Goa', is_international: false, category: 'holiday' };
  check(intl(intlPackage) === true, 'an international package (is_international: true) is international');
  check(intl(domPackage) === false, 'a domestic package (is_international: false) is domestic');
  check(intl({ id: '9', name: 'Sample row' }) === false, 'a package with no flag at all is still treated as unknown -> domestic (unchanged)');
  check(intl({ is_international: 'true' }) === false, 'only a real boolean counts: a stray string is not read as international');
  check(intl({ isInternational: true, is_international: false }) === true && intl({ isInternational: false, is_international: true }) === false,
    'the camelCase flag still wins when both are present');
  /* The listing's own normalisation (travel-data.js) feeds the camelCase key. */
  check(intl({ isInternational: true }) === true && intl({ isInternational: undefined }) === false, 'listing items (camelCase) behave as before');
  /* Flights and everything else: unchanged. */
  check(intl({ origin: { country: 'India' }, destination: { country: 'UAE' } }) === true, 'a flight leaving India is international (unchanged)');
  check(intl({ origin: { country: 'India' }, destination: { country: 'India' } }) === false, 'a domestic flight is domestic (unchanged)');
  check(intl({ origin: { country: 'India' } }) === false && intl({}) === false && intl(null) === false, 'sample / empty items stay domestic (unchanged)');

  /* Every consumer goes through the one function, so passport visibility, the label, validation,
     the review line and the picker all agree. Prove the three that decide behaviour. */
  const NEED = /const needsPassport = ctx =>\s*o\.passport && !!\(typeof BookingApi !== 'undefined' && BookingApi\.isInternational\(ctx\.item\)\);/.test(BP);
  check(NEED, 'needsPassport (card labels, validate, status pill, picker) is defined only in terms of BookingApi.isInternational');
  check((BP.match(/BookingApi\.isInternational\(/g) || []).length >= 4 && !/\.isInternational\s*===|item\.isInternational/.test(BP),
    'no consumer reads the raw camelCase property itself');
  check(/bkfSavedFillPlan\(t, needsPassport\(ctx\)\)/.test(BP), 'the picker asks needsPassport before writing passport fields');
  check(/is_international: !!p\.is_international/.test(read('assets/js/package.js')), 'the package page passes is_international to the flow');

  /* End to end on the shipped pieces: international package -> passport keys in the plan; domestic -> none. */
  const PLAN2 = extractFn(BP, 'function bkfSavedFillPlan(');
  const sbp = sandbox(`${INTL}\n${PLAN2}\nglobalThis.go = (item, saved) => bkfSavedFillPlan(saved, isInternational(item));`);
  const saved = { first_name: 'Asha', middle_name: 'Kumari', last_name: 'Rao', passport_number: 'TW000111', passport_expiry: '2032-05-01', issuing_country: 'India' };
  const planIntl = sbp.go(intlPackage, saved);
  check(planIntl.ppno === 'TW000111' && planIntl.ppexp === '2032-05-01' && planIntl.ppiss === 'India' && planIntl.middle === 'Kumari',
    'international package: the plan carries the passport fields and the middle name');
  const planDom = sbp.go(domPackage, saved);
  check(!('ppno' in planDom) && !('ppexp' in planDom) && !('ppiss' in planDom) && planDom.middle === 'Kumari',
    'domestic package: no passport field is written, names still fill');
}

/* ---- 7. Account Center: first / middle / last / phone / email --------------- */
{
  const READ = extractFn(AC, 'function readTravellerForm(');
  const OPEN = extractFn(AC, 'function openTravellerForm(');
  const ROW = extractFn(AC, 'function travellerRowHtml(');
  const fields = {};
  const doc = {
    getElementById: id => ({
      get value() { return fields[id] === undefined ? '' : fields[id]; },
      set value(v) { fields[id] = v; },
      focus() {}, set hidden(_) {}, set textContent(_) {},
    }),
  };
  const sb = { document: doc, escapeHtml: s => String(s), maskPassport: s => s, JPIcon: undefined };
  vm.createContext(sb);
  vm.runInContext(`${READ}\n${OPEN}\n${ROW}\nglobalThis.read=readTravellerForm;globalThis.open=openTravellerForm;globalThis.row=travellerRowHtml;`, sb);

  sb.open({ customer_traveller_id: 7, first_name: 'Asha', middle_name: 'Kumari', last_name: 'Rao',
            mobile: '+919000000001', email: 'own@example.com' });
  check(fields.acctTravellerFirst === 'Asha' && fields.acctTravellerMiddle === 'Kumari' && fields.acctTravellerLast === 'Rao',
    'editing populates first, middle and last into their own boxes');
  check(fields.acctTravellerMobile === '+919000000001' && fields.acctTravellerEmail === 'own@example.com', 'editing populates the traveller phone and email');
  const payload = sb.read();
  check(payload.first_name === 'Asha' && payload.middle_name === 'Kumari' && payload.last_name === 'Rao', 'the form posts the three names apart');
  check(payload.mobile === '+919000000001' && payload.email === 'own@example.com', 'the form posts the traveller phone and email');
  fields.acctTravellerMiddle = ''; fields.acctTravellerMobile = ''; fields.acctTravellerEmail = '';
  const cleared = sb.read();
  check(cleared.middle_name === null && cleared.mobile === null && cleared.email === null, 'an emptied box is sent as an explicit null (clear)');
  check(/Asha Kumari Rao/.test(sb.row({ customer_traveller_id: 1, first_name: 'Asha', middle_name: 'Kumari', last_name: 'Rao' })), 'the row shows the full name');

  for (const id of ['acctTravellerMiddle', 'acctTravellerMobile', 'acctTravellerEmail']) {
    check(AC.includes(`id="${id}"`), `${id} is in the Account Center script markup`);
    check(INDEX.includes(`id="${id}"`), `${id} is in the static index.html copy`);
  }
}

function finish() {
  if (failures.length) {
    console.error('FAIL - saved-traveller-names-contact.test.js');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('PASS - saved-traveller-names-contact.test.js (names stay apart, profile prefill is empty-only, payload + Account Center + hotel wiring)');
}
