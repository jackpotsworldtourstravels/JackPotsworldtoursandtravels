// Every customer-facing page, at every target viewport (CSS pixels, not device pixels).
//
//   phones, portrait        375x667   393x852   412x968 (a foldable folded)      320x568 (the narrowest)
//   phones, landscape       667x375   812x375                                     (short screens)
//   tablets, portrait       768x1024  960x1440
//   landscape / laptop      1004x764  1280x800
//   desktop with a mouse    1440x900  1920x1080
//
// THE PAGE LIST IS NOT HAND-KEPT. Static pages are read from the frontend directory; the templated pages (destination,
// attraction, hotels near an attraction, package) are sampled from the live catalogue; and a second test follows the site's
// own links from the home page and fails if it finds a page this audit would not cover.
//
// For every page, at every viewport, in a real browser, this checks
//   * no sideways page scroll, and no element sticking out past the right edge (unless it scrolls itself),
//   * no element marked [hidden] that is still drawn,
//   * no script error and no failed request on load,
//   * on touch screens (phones, tablets, landscape): interactive controls are at least 32px tall and wide (WCAG 2.2 target
//     size is 24px; 44px is Apple's guideline - 32px is the floor this site holds) and phone text inputs are >= 16px,
//   * text that is clipped by an ancestor that hides overflow without an ellipsis,
//   * the header and footer are present, visible and inside the viewport.
// The 1440 and 1920 runs use a mouse (no touch emulation), so the touch-target rules are not asked of a desktop.
//
// JPW_AUDIT=1 prints findings and does not fail, to survey a page before changing it.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';
import { ALL_VIEWPORTS, staticPages, familyPages, AUTH_CARD, MEASURE, AUDIT, openPage as open, report, sleep } from './responsive-helpers.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

// Unlinked developer reference: a public style guide with demo controls and no site footer. Still held to every other rule.
const STYLE_GUIDE = new Set(['/design-system.html']);
// Templates opened with no slug or id: their own API call answers not-found by design (a readable message is asserted in
// responsive-states.ui.test.mjs), so that 4xx is not a failed request.
const BARE_TEMPLATES = new Set(['/destination.html', '/destination-hotels.html', '/location.html', '/package.html', '/ticket-verify.html']);

test('every customer page fits every viewport: no overflow, no hidden-but-drawn elements, no errors, usable touch targets', { timeout: 4800000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  const pages = [...staticPages(), ...(await familyPages(BASE))];
  for (const path of pages) {
    for (const [w, h] of ALL_VIEWPORTS) {
      const { page, errors, failed } = await open(chrome, path, w, h);
      try {
        const m = await page.eval(MEASURE);
        const at = ` ${path} @${w}x${h}`;
        if (m.hScroll) problems.push(`sideways scroll (page ${m.sw}px)` + at);
        m.out.forEach(o => problems.push('sticks out: ' + o + at));
        m.hiddenShown.forEach(x => problems.push('an element marked hidden is being drawn: ' + x + at));
        // Sign-in and recovery pages are a single card with no site header or footer, by design.
        if (!AUTH_CARD.has(path) && !STYLE_GUIDE.has(path)) { if (!m.header) problems.push('no visible header' + at); if (!m.footer) problems.push('no footer' + at); if (!m.footerOk) problems.push('footer outside the viewport' + at); }
        if (m.nSmall && !STYLE_GUIDE.has(path)) problems.push(`${m.nSmall} touch target(s) under 32px: ${m.small.slice(0, 3).join(' | ')}` + at);
        m.zoom.forEach(z => problems.push('input under 16px (iOS zoom): ' + z + at));
        m.clipped.forEach(c => problems.push('clipped text: ' + c + at));
        errors.forEach(e => problems.push('script error: ' + e + at));
        [...new Set(failed)].filter(f => !(BARE_TEMPLATES.has(path) && /^(400|404|422) \/api\//.test(f))).slice(0, 3).forEach(f => problems.push('failed request: ' + f + at));
      } finally { page.close(); }
    }
  }
  report(problems, 'responsive page audit');
});

// Follow the site's own links from the home page. Every page it reaches must be one this audit covers (a static page read from
// the frontend directory, or a member of a templated family), and must exist.
const FAMILIES = [[/^\/destination\/[^/]+$/, 'destination'], [/^\/destination\/[^/]+\/[^/]+$/, 'attraction'], [/^\/hotels\/[^/]+\/[^/]+$/, 'hotels near an attraction'], [/^\/package(-details)?\/[^/]+$/, 'package']];
const NOT_CUSTOMER_SITE = /^\/(api|assets|components|shared|admin|manager|merchant|merchant-classic|operations|super-admin|uploads|docs|tests)(\/|$)/;

test('every page the site links to is covered by this audit', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const covered = new Set(staticPages());
  const problems = [];
  const seen = new Map(); const queue = ['/'];
  const familyVisited = new Set();
  const classify = (p) => { const f = FAMILIES.find(([re]) => re.test(p)); return f ? f[1] : null; };
  while (queue.length && seen.size < 120) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const fam = classify(path);
    if (fam) { if (familyVisited.has(fam)) { seen.set(path, 'family:' + fam); continue; } familyVisited.add(fam); }
    seen.set(path, fam ? 'family:' + fam : 'static');
    const { page } = await open(chrome, path, 1280, 800);
    try {
      const hrefs = await page.eval(`[...document.querySelectorAll('a[href]')].map(a => a.href)`);
      for (const h of new Set(hrefs)) {
        let u; try { u = new URL(h); } catch { continue; }
        if (u.origin !== BASE) continue;
        let p = u.pathname.replace(/\/index\.html$/, '/') || '/';
        if (/\.(png|jpe?g|webp|svg|ico|css|js|json|xml|txt|pdf|mp4|woff2?)$/i.test(p) || NOT_CUSTOMER_SITE.test(p)) continue;
        if (!seen.has(p)) queue.push(p);
      }
    } finally { page.close(); }
  }
  for (const [path, kind] of seen) {
    if (kind.startsWith('family:')) continue;
    if (!covered.has(path) && path !== '/customer/') problems.push(`linked page ${path} is not in the audit's page list`);
    const status = await fetch(BASE + path).then(r => r.status).catch(() => 0);
    if (status !== 200) problems.push(`linked page ${path} answers ${status}`);
  }
  if (seen.size < 15) problems.push(`the crawl reached only ${seen.size} pages`);
  report(problems, 'linked-page coverage');
});
