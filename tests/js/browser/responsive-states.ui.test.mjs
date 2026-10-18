// The states a page is in when it is NOT the ideal, fully populated one - at phone, tablet and desktop widths and on a phone turned
// on its side: not-found, empty, error, loading, very long text, and a rotating screen. Each must keep its layout (no sideways
// scroll, nothing sticking out, no hidden-but-drawn element, no script error) and say something readable.
//
//   375x667  393x852  667x375 (a phone on its side)  768x1024  1280x800  1440x900
//
// The API is answered by the test (page.route), so this needs no particular data. JPW_AUDIT=1 prints findings without failing.
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';
import { MEASURE, openPage as open, report, sleep } from './responsive-helpers.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
let chrome = null; let skipReason = null;
before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

const SIZES = [[375, 667], [393, 852], [667, 375], [768, 1024], [1280, 800], [1440, 900]];
const text = (page) => page.eval(`(document.querySelector('main') || document.body).innerText.replace(/\\s+/g, ' ').trim()`);

/** The layout rules every state must keep. */
function layout(m, at, problems) {
  if (m.hScroll) problems.push(`sideways scroll (page ${m.sw}px)` + at);
  m.out.forEach(o => problems.push('sticks out: ' + o + at));
  m.hiddenShown.forEach(x => problems.push('an element marked hidden is being drawn: ' + x + at));
  m.clipped.forEach(c => problems.push('clipped text: ' + c + at));
}

test('not-found: a template opened with no slug or id says so, in words, and fits', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const path of ['/destination.html', '/destination-hotels.html', '/location.html', '/package.html', '/ticket-verify.html', '/no-such-page-404']) {
    for (const [w, h] of SIZES) {
      const { page, errors } = await open(chrome, path, w, h);
      try {
        await sleep(900);
        const at = ` ${path} @${w}x${h}`;
        const body = await text(page);
        if (!/(not found|could not|couldn.?t|invalid|expired|failed|can.?t find|cannot be found|went wrong)/i.test(body)) problems.push('no readable not-found message: "' + body.slice(0, 70) + '"' + at);
        layout(await page.eval(MEASURE), at, problems);
        errors.forEach(e => problems.push('script error: ' + e + at));
      } finally { page.close(); }
    }
  }
  report(problems, 'not-found states');
});

// Hotels and tour packages answer from the API. Stub it to be empty, to fail, to be slow, and to return very long names.
const LISTS = [
  { name: 'hotels', path: '/hotels.html', real: '/api/customer/hotels', api: /\/api\/customer\/hotels(\?|$)/, ready: () => document.querySelectorAll('#hrCards .hr-card').length > 0 },
  { name: 'packages', path: '/packages.html', real: '/api/customer/packages?category=holiday', api: /\/api\/customer\/packages(\?|$)/, ready: () => document.body.innerText.length > 400 },
];
const LONG_WORD = 'Extraordinarily' + '-unbrokenname'.repeat(7);
const LONG_TEXT = 'A very long name that keeps on going and going and going without ever reaching a sensible end, '.repeat(3);
const mutate = (v, long) => Array.isArray(v) ? v.map(x => mutate(x, long))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (typeof x === 'string' && /^(name|title|destination|location|city|area|tagline|summary|description|hotel_name|package_name)$/.test(k)) ? long : mutate(x, long)])) : v;

for (const list of LISTS) {
  test(`${list.name}: empty, failing, slow and very long results keep their layout and say something`, { timeout: 900000 }, async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const problems = [];
    const real = await fetch(BASE + list.real).then(r => r.json()).catch(() => []);
    const variants = [
      ['empty', () => ({ status: 200, json: [] })],
      ['failing (500)', () => ({ status: 500, json: { detail: 'Server exploded' } })],
      ['failing (network)', () => ({ fail: true })],
      ['slow', () => ({ status: 200, json: real, delay: 2500 })],
      ['unbroken long names', () => ({ status: 200, json: mutate(real, LONG_WORD) })],
      ['long sentences', () => ({ status: 200, json: mutate(real, LONG_TEXT) })],
    ];
    for (const [label, answer] of variants) {
      for (const [w, h] of SIZES) {
        const p2 = await chrome.newPage();
        const errs = [];
        p2.on('Runtime.exceptionThrown', (e) => errs.push((e.exceptionDetails.exception && e.exceptionDetails.exception.description || e.exceptionDetails.text || '').split('\n')[0].slice(0, 110)));
        await p2.viewport({ width: w, height: h, mobile: Math.min(w, h) <= 480 });
        if (w <= 1280) await p2.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        p2.route((u, m) => list.api.test(u) && m === 'GET', answer);
        const at = ` ${list.path} [${label}] @${w}x${h}`;
        try {
          await p2.goto(BASE + list.path);
          await sleep(label === 'slow' ? 700 : 2200);
          if (label === 'slow') {
            // while it loads: the page is whole (no overflow) and does not already claim an error
            const mid = await p2.eval(MEASURE); layout(mid, at + ' (while loading)', problems);
            const body = await text(p2);
            if (/(could not|couldn.?t|went wrong|failed)/i.test(body)) problems.push('a slow answer already shows an error while loading' + at);
            await sleep(3200);
          }
          const m = await p2.eval(MEASURE);
          layout(m, at, problems);
          const body = await text(p2);
          if (label === 'empty' && !/(no |0 |nothing|not found|couldn.?t find|none|available)/i.test(body)) problems.push('empty list: nothing says it is empty: "' + body.slice(0, 80) + '"' + at);
          if (/failing/.test(label) && !/(could not|couldn.?t|went wrong|failed|try again|retry|unavailable|error|offline|network)/i.test(body)) problems.push('failing list: no readable error: "' + body.slice(0, 80) + '"' + at);
          // The stub must really have been shown, or these variants would pass without testing anything.
          if (label === 'unbroken long names' && !body.includes('Extraordinarily')) problems.push('the long-name stub did not reach the page, so this case proved nothing' + at);
          if (label === 'long sentences' && !body.includes('keeps on going')) problems.push('the long-sentence stub did not reach the page, so this case proved nothing' + at);
          if (label === 'slow' && list.name === 'hotels' && !(await p2.eval(`document.querySelectorAll('#hrCards .hr-card').length > 0`))) problems.push('a slow answer never produced results' + at);
          errs.forEach(e => problems.push('script error: ' + e + at));
        } finally { p2.close(); }
      }
    }
    report(problems, `${list.name} states`);
  });
}

test('orientation: turning a phone on its side and back keeps every main page whole', { timeout: 900000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  const TURNS = [[667, 375], [375, 667], [812, 375], [393, 852], [852, 393], [412, 968]];
  for (const path of ['/', '/flights.html', '/hotels.html', '/packages.html', '/about.html', '/my-bookings.html']) {
    const { page, errors } = await open(chrome, path, 375, 667);
    try {
      for (const [w, h] of TURNS) {
        await page.viewport({ width: w, height: h, mobile: true });
        await sleep(800);
        const m = await page.eval(MEASURE);
        const at = ` ${path} turned to ${w}x${h}`;
        layout(m, at, problems);
        if (!m.header) problems.push('no visible header' + at);
      }
      errors.forEach(e => problems.push('script error: ' + e + ` ${path}`));
    } finally { page.close(); }
  }
  report(problems, 'orientation');
});

test('disabled: the disabled Continue button on the hotel results is visible, whole, and inside the screen', { timeout: 600000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const problems = [];
  for (const [w, h] of SIZES) {
    const { page } = await open(chrome, '/hotels.html', w, h);
    try {
      await page.waitFor(() => document.querySelectorAll('#hrCards .hr-card').length > 0, { timeout: 12000, label: 'hotels' });
      const b = await page.eval(`(() => { const e = document.getElementById('hrContinue'); if (!e) return null; const r = e.getBoundingClientRect(); return { disabled: e.disabled, w: Math.round(r.width), h: Math.round(r.height), inX: r.left >= -1 && r.right <= innerWidth + 1, text: e.textContent.trim().slice(0, 40) }; })()`);
      const at = ` @${w}x${h}`;
      if (!b) { problems.push('no Continue button' + at); continue; }
      if (!b.disabled) problems.push('Continue is enabled before any hotel is chosen' + at);
      if (b.w > 0 && !b.inX) problems.push('the disabled Continue button is outside the screen' + at);
      if (b.w > 0 && b.w < 32) problems.push(`the Continue button is ${b.w}px wide` + at);
    } finally { page.close(); }
  }
  report(problems, 'disabled state');
});
