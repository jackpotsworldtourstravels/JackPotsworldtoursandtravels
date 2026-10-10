// Which elements move, and when? Reports every layout shift on a page with the nodes involved.
//
//   JPW_BASE=http://127.0.0.1:8000 node tests/js/browser/cls-sources.mjs /flights.html 820 [/hotels.html 820 ...]
//
// A shift is reported with its score, the time it happened and, for each source, the element
// (tag#id.class) plus the box before and after. Use it to find WHAT to fix after image-audit.mjs
// (--perf=1) says a page's cumulative layout shift is high.
import { Chrome, findChrome } from './cdp.mjs';

const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pairs = [];
for (let i = 2; i < process.argv.length; i += 2) pairs.push([process.argv[i], Number(process.argv[i + 1] || 1440)]);
if (!findChrome() || !pairs.length) { console.error('usage: cls-sources.mjs <path> <width> ...'); process.exit(0); }

const chrome = await Chrome.launch();
try {
  for (const [path, width] of pairs) {
    const page = await chrome.newPage();
    await page.addInitScript(`window.__shifts = [];
      new PerformanceObserver(l => l.getEntries().forEach(e => { if (e.hadRecentInput) return;
        const name = (n) => !n ? '?' : (n.nodeType === 1 ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/)[0] : '') : '#text');
        window.__shifts.push({ t: Math.round(e.startTime), v: +e.value.toFixed(3), s: e.sources.slice(0, 3).map(x => name(x.node) + ' ' + Math.round(x.previousRect.y) + '->' + Math.round(x.currentRect.y) + ' h' + Math.round(x.previousRect.height) + '->' + Math.round(x.currentRect.height)) });
      })).observe({ type: 'layout-shift', buffered: true });`);
    await page.viewport({ width, height: 800, mobile: width < 600 });
    await page.goto(BASE + path);
    await sleep(3000);
    const shifts = await page.eval('window.__shifts');
    const total = shifts.reduce((a, s) => a + s.v, 0).toFixed(3);
    console.log(`\n${path} @${width}  total ${total}`);
    shifts.filter(s => s.v >= 0.005).forEach(s => console.log(`  ${String(s.t).padStart(5)}ms  ${s.v}  ${s.s.join(' | ')}`));
    page.close();
  }
} finally { await chrome.close(); }
