'use strict';
/* ===========================================================================
   Bug 11 — the Image Credits footer link is gone.

   The link was removed from both the footer definition (site-footer.js) and
   the static footer copy in index.html. The page itself (image-credits.html /
   image-credits.js) is deliberately kept — it stays reachable by direct URL —
   so this test checks the LINK is gone, not the page.

   No browser, no network: the footer link list is a plain data literal in
   site-footer.js, and index.html's footer is static markup.

   run:  node frontend/tests/footer-no-image-credits.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

const FOOTER_JS = read('assets/js/site-footer.js');
const INDEX = read('index.html');

/* ---- The link is gone from both renderers ----------------------------- */
check(!/\/image-credits/.test(FOOTER_JS), 'site-footer.js no longer references /image-credits');
check(!/Image Credits/.test(FOOTER_JS), 'site-footer.js no longer lists "Image Credits"');
check(!/href="\/image-credits"/.test(INDEX), 'index.html footer no longer links to /image-credits');
check(!/>Image Credits</.test(INDEX), 'index.html footer no longer shows "Image Credits"');

/* ---- The footer still renders its other legal links ------------------- */
for (const label of ['Privacy Policy', 'Cookie Policy', 'Disclaimer', 'Payment Security']) {
  check(FOOTER_JS.includes(`'${label}',`), `site-footer.js keeps the "${label}" legal link`);
}
/* The legal column structure itself is intact. */
check(/legal:\s*\[/.test(FOOTER_JS), 'the legal link group is still defined');

if (failures.length) {
  console.error('FAIL — footer-no-image-credits.test.js');
  failures.forEach(f => console.error('  • ' + f));
  process.exit(1);
}
console.log('PASS — footer-no-image-credits.test.js (link removed from js + index, other links intact)');
