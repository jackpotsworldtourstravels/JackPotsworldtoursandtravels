'use strict';
/* ===========================================================================
   GST business-invoice block on the flight Traveller step — booking-products.js.

   Extracts the two GST helpers the booking engine added (bkfGstHtml, which
   bkfTravellersHtml renders, and readGstInto, which readInto calls) and runs
   them in a VM, so the optional GST capture cannot silently regress: the card
   renders closed by default, pre-fills from ctx.gst, forces the GSTIN uppercase,
   and captures into ctx.gst only when the toggle is on AND a GSTIN was typed.

   run:  node frontend/tests/gst-booking.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/booking-products.js');
const CSS = read('assets/css/booking-ref.css');

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

const GSTHTML = extractFn(SRC, 'function bkfGstHtml(');
const READGST = extractFn(SRC, 'function readGstInto(');
check(GSTHTML !== '' && READGST !== '', 'both GST helpers were extracted from booking-products.js');

/* A faithful HTML escaper so the real bkfGstHtml runs unchanged. */
const ESC = `function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}`;
const sb = {};
vm.createContext(sb);
vm.runInContext(`${ESC}\n${GSTHTML}\n${READGST}\nglobalThis.gstHtml=bkfGstHtml;globalThis.readGst=readGstInto;`, sb);

const VALID = '29ABCDE1234F1Z5';

/* ---------- bkfGstHtml: markup ---------- */
{
  const closed = sb.gstHtml({});
  check(/id="bkGstToggle"/.test(closed), 'renders the GST toggle');
  ['bkGstNumber', 'bkGstCompany', 'bkGstAddress', 'bkGstEmail', 'bkGstContact']
    .forEach(id => check(new RegExp(`id="${id}"`).test(closed), `renders the ${id} field`));
  check(/GST details/.test(closed), 'has the "GST details" heading');
  check(/id="bkGstFields"[^>]*\shidden/.test(closed), 'the fields are hidden by default (no GST on the draft)');
  check(!/id="bkGstToggle"[^>]*\schecked/.test(closed), 'the toggle is off by default');

  const open = sb.gstHtml({ gst: { gst_number: VALID, company_name: 'Acme Travels Pvt Ltd', company_address: '1 MG Road' } });
  check(/id="bkGstToggle"[^>]*\schecked/.test(open), 'the toggle is checked when the draft already carries GST');
  check(!/id="bkGstFields"[^>]*\shidden/.test(open), 'the fields are revealed when the draft carries GST');
  check(open.includes(`value="${VALID}"`), 'pre-fills the GSTIN from the draft');
  check(/value="Acme Travels Pvt Ltd"/.test(open), 'pre-fills the company name from the draft');
}

/* ---------- readGstInto: capture ---------- */
function rootWith(fields) {
  const els = {};
  for (const [sel, val] of Object.entries(fields)) {
    if (sel === '#bkGstToggle') els[sel] = { checked: val };
    else els[sel] = { value: val };
  }
  return { querySelector: sel => els[sel] || null };
}

{
  // Toggle on + a GSTIN typed in lowercase → captured, uppercased.
  const ctx = {};
  sb.readGst(ctx, rootWith({
    '#bkGstToggle': true, '#bkGstNumber': ' 29abcde1234f1z5 ',
    '#bkGstCompany': 'Acme Travels Pvt Ltd', '#bkGstAddress': '1 MG Road',
    '#bkGstEmail': 'accounts@acmetravels.com', '#bkGstContact': '+919000000002',
  }));
  check(ctx.gst && ctx.gst.gst_number === VALID, 'captures the GSTIN, trimmed and uppercased');
  check(ctx.gst.company_name === 'Acme Travels Pvt Ltd', 'captures the company name');
  check(ctx.gst.company_address === '1 MG Road', 'captures the address');
  check(ctx.gst.company_email === 'accounts@acmetravels.com' && ctx.gst.company_contact === '+919000000002',
    'captures the optional email and contact');
}

{
  // Toggle OFF → no GST on the draft, even if a GSTIN is present in the field.
  const ctx = {};
  sb.readGst(ctx, rootWith({ '#bkGstToggle': false, '#bkGstNumber': VALID, '#bkGstCompany': 'Acme' }));
  check(ctx.gst === null, 'toggle off yields no GST block (null)');
}

{
  // Toggle on but no GSTIN → null (never an empty GST object).
  const ctx = {};
  sb.readGst(ctx, rootWith({ '#bkGstToggle': true, '#bkGstNumber': '   ', '#bkGstCompany': 'Acme' }));
  check(ctx.gst === null, 'toggle on with an empty GSTIN yields null, not an empty object');
}

{
  // A step without the GST block (non-flight product) → readGstInto no-ops.
  const ctx = { gst: 'untouched' };
  sb.readGst(ctx, { querySelector: () => null });
  check(ctx.gst === 'untouched', 'no GST block present ⇒ readGstInto leaves the draft alone');
}

/* ---------- the GSTIN-uppercase affordance is styled ---------- */
check(/#bkGstNumber\s*\{[^}]*text-transform:\s*uppercase/.test(CSS), 'the GSTIN field is styled uppercase in booking-ref.css');

if (failures.length) {
  console.error('FAIL - gst-booking.test.js');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS - gst-booking.test.js');
