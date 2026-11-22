'use strict';
/* ===========================================================================
   Bug 7 — editing a package search restores the destination and departure
   month after a refresh, browser navigation or a direct/shared URL.

   The packages page persists its two criteria in the URL as ?type= (the
   destination/package name, read back into state.pkgType) and ?month=. The
   hero search card already kept state.pkgType in step with the chosen
   destination and called writeUrl; the PackageSearch PANEL's own Search handler
   used to set only state.pkgDest and never wrote the URL — so a panel search
   left the address bar stale, and a reload rebuilt the state from the PREVIOUS
   (or empty) criteria, losing the edited destination and month.

   travel-explore.js is DOM- and network-bound and cannot be imported, so this
   pins the fix structurally: the panel handler now syncs pkgType and writes the
   URL, writeUrl persists type+month for packages, and the seed/mount path reads
   them back and resolves pkgType -> pkgDest.

   run:  node frontend/tests/package-edit-search-restore.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/travel-explore.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* Isolate the PackageSearch.init(...) onSearch handler body. */
const initAt = SRC.indexOf('await PackageSearch.init(state, rows, req =>');
check(initAt !== -1, 'the PackageSearch.init handler is present');
const handler = initAt === -1 ? '' : SRC.slice(initAt, SRC.indexOf('});', initAt) + 3);

/* ---- The panel handler now keeps the URL-persisted key in sync and writes it */
check(/state\.pkgDest = req\.destination \|\| '';/.test(handler),
  'the panel handler still sets pkgDest from the chosen destination');
check(/state\.pkgType = req\.destination \|\| '';/.test(handler),
  'the panel handler now syncs pkgType (the ?type= key) with the destination');
check(/state\.pkgMonth = req\.departureMonth \|\| 'any';/.test(handler),
  'the panel handler sets pkgMonth from the chosen departure month');
check(/writeUrl\(true\);/.test(handler),
  'the panel handler now persists the criteria to the URL');

/* ---- writeUrl persists BOTH criteria for the packages page ------------ */
check(/type: state\.pkgType \|\| undefined,/.test(SRC),
  'writeUrl persists the destination as ?type=');
check(/month: state\.pkgMonth && state\.pkgMonth !== 'any' \? state\.pkgMonth : undefined,/.test(SRC),
  'writeUrl persists the departure month as ?month=');

/* ---- seedFromUrl reads them back on load ------------------------------ */
check(/const type = str\('type', \d+\);\s*if \(type\)\s*\{ state\.pkgType = type;/.test(SRC),
  'seedFromUrl restores pkgType from ?type=');
check(/const month = str\('month', \d+\); if \(month\) \{ state\.pkgMonth = month;/.test(SRC),
  'seedFromUrl restores pkgMonth from ?month=');

/* ---- mountPackageSearch resolves the persisted type back to a destination */
check(/if \(state\.pkgType && !state\.pkgDest\) \{\s*\n\s*const hit = rows\.find\(p => p\.name\.toLowerCase\(\) === String\(state\.pkgType\)\.toLowerCase\(\)\);/.test(SRC),
  'mountPackageSearch resolves pkgType back to pkgDest by exact package name');

if (failures.length) {
  console.error('FAIL — package-edit-search-restore.test.js');
  failures.forEach(f => console.error('  • ' + f));
  process.exit(1);
}
console.log('PASS — package-edit-search-restore.test.js (panel syncs type + writes URL; seed/mount restore)');
