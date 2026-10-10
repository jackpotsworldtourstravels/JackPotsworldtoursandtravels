// Walks the site in a real browser and reports every image problem it can see.
//
//   JPW_BASE=http://127.0.0.1:8000 node tests/js/browser/image-audit.mjs [--widths=1366,375] [--max=80]
//
// PER PAGE, at each width: it scrolls the whole page (so lazy images load), waits, then reports
//   - failed:    an image request that came back >= 400, or never completed
//   - mime:      an image whose Content-Type is not image/*
//   - broken:    an <img> that finished loading with no pixels
//   - bgfail:    a CSS background-image url that does not load
//   - distorted: an <img> drawn at a different aspect ratio from its file, with an
//                object-fit that stretches (fill) — a squashed photograph
//   - overflow:  an <img> wider than the box that holds it
//   - tiny:      a photograph rendered smaller than 24px in both directions
//   - noalt:     an <img> with no alt attribute at all (decorative ones must say alt="")
//   - console:   console errors
// It is a REPORT: it exits 0 and prints JSON. The assertions live in image-audit.test.mjs.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome, findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The in-page probe. Runs after the page has been scrolled. */
const PROBE = `(() => {
  const out = { broken: [], distorted: [], overflow: [], tiny: [], noalt: [], bgfail: [], imgs: 0 };
  const name = (el) => (el.currentSrc || el.src || '').replace(location.origin, '').slice(0, 120);
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    const shown = r.width > 0 && r.height > 0 && getComputedStyle(img).visibility !== 'hidden';
    out.imgs++;
    if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) out.broken.push(name(img));
    if (!shown || !img.naturalWidth) continue;
    const cs = getComputedStyle(img);
    const nat = img.naturalWidth / img.naturalHeight, box = r.width / r.height;
    if (cs.objectFit === 'fill' && Math.abs(nat / box - 1) > 0.06 && r.width > 40 && !img.closest('svg'))
      out.distorted.push(name(img) + ' file ' + nat.toFixed(2) + ' drawn ' + box.toFixed(2));
    const p = img.parentElement && img.parentElement.getBoundingClientRect();
    if (p && p.width > 0 && r.width > p.width + 2 && getComputedStyle(img.parentElement).overflow === 'visible')
      out.overflow.push(name(img) + ' ' + Math.round(r.width) + ' > ' + Math.round(p.width));
    if (r.width < 24 && r.height < 24 && img.naturalWidth > 200) out.tiny.push(name(img));
    if (!img.hasAttribute('alt')) out.noalt.push(name(img));
  }
  return out;
})()`;

const BG = `(async () => {
  const urls = new Set();
  for (const el of document.querySelectorAll('*')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    for (const m of bg.matchAll(/url\\("([^"]*)"\\)|url\\(([^)"']*)\\)/g)) { const u = m[1] || m[2]; if (u && !u.startsWith('data:')) urls.add(u); }
  }
  const bad = [];
  await Promise.all([...urls].map(u => new Promise(res => { const i = new Image(); i.onload = res; i.onerror = () => { bad.push(u.replace(location.origin, '')); res(); }; i.src = u; })));
  return bad;
})()`;

async function audit(chrome, url, width) {
  const page = await chrome.newPage();
  const net = new Map(); const consoleErrors = [];
  await page.send('Network.enable');
  page.on('Network.responseReceived', (p) => net.set(p.requestId, { url: p.response.url, status: p.response.status, type: p.response.mimeType, res: p.type }));
  page.on('Network.loadingFailed', (p) => { const e = net.get(p.requestId) || {}; net.set(p.requestId, Object.assign(e, { failed: p.errorText })); });
  page.on('Network.requestWillBeSent', (p) => { if (!net.has(p.requestId)) net.set(p.requestId, { url: p.request.url, pending: true, res: p.type }); });
  page.on('Runtime.exceptionThrown', (p) => consoleErrors.push((p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text).slice(0, 160)));
  page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map(a => a.value || a.description).join(' ').slice(0, 160)); });
  await page.addInitScript(`window.__perf = { cls: 0, lcp: 0, longTasks: 0, longMs: 0 };
    try { new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__perf.cls += e.value; })).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
    try { new PerformanceObserver(l => l.getEntries().forEach(e => { window.__perf.lcp = e.startTime; })).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
    try { new PerformanceObserver(l => l.getEntries().forEach(e => { window.__perf.longTasks++; window.__perf.longMs += e.duration; })).observe({ type: 'longtask', buffered: true }); } catch (e) {}`);
  await page.viewport({ width, height: 800, mobile: width < 600 });
  try { await page.goto(url); } catch (e) { return { url, width, error: String(e) }; }
  await sleep(1200);
  const h = await page.eval('document.documentElement.scrollHeight');
  for (let y = 0; y < h + 800; y += 600) { await page.eval(`window.scrollTo(0, ${y})`); await sleep(120); }
  await sleep(1500);
  const found = await page.eval(PROBE);
  found.bgfail = await page.eval(BG);
  const imgNet = [...net.values()].filter(r => r.res === 'Image' || /\.(png|jpe?g|webp|gif|svg|ico|avif)(\?|$)/i.test(r.url || ''));
  found.failed = imgNet.filter(r => r.failed || (r.status && r.status >= 400) || r.pending).map(r => `${r.status || r.failed || 'pending'} ${(r.url || '').replace(BASE, '')}`);
  found.mime = imgNet.filter(r => r.status && r.status < 400 && r.type && !/^image\//.test(r.type)).map(r => `${r.type} ${(r.url || '').replace(BASE, '')}`);
  found.external = [...new Set(imgNet.filter(r => r.url && !r.url.startsWith(BASE) && !r.url.startsWith('data:')).map(r => r.url.slice(0, 100)))];
  found.console = [...new Set(consoleErrors)].slice(0, 8);
  found.hScroll = await page.eval('document.documentElement.scrollWidth > innerWidth + 1');
  if (found.hScroll) found.wide = await page.eval(`[...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 2 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 6).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ' right=' + Math.round(e.getBoundingClientRect().right))`);
  found.perf = await page.eval(`(() => { const n = performance.getEntriesByType('navigation')[0] || {}; const p = window.__perf || {};
    const res = performance.getEntriesByType('resource');
    return { cls: +(p.cls || 0).toFixed(3), lcp: Math.round(p.lcp || 0), longTasks: p.longTasks || 0, longMs: Math.round(p.longMs || 0),
      dcl: Math.round(n.domContentLoadedEventEnd || 0), load: Math.round(n.loadEventEnd || 0), requests: res.length,
      kb: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024), dom: document.getElementsByTagName('*').length }; })()`);
  page.close();
  return Object.assign({ url: url.replace(BASE, ''), width }, found);
}

function seeds() {
  const files = readdirSync(join(ROOT, 'frontend')).filter(f => f.endsWith('.html')
    && !['design-system.html'].includes(f));
  const dyn = ['/destination/goa', '/destination/hyderabad', '/destination/bali', '/hotels/goa', '/package.html?id=7',
    '/location.html?id=hyderabad__charminar', '/destinations.html', '/flights.html'];
  return [...new Set(files.map(f => '/' + f).concat(dyn))];
}

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const widths = (args.widths || '1366').split(',').map(Number);
const max = Number(args.max || 80);
if (!findChrome()) { console.error('no Chrome'); process.exit(0); }
const chrome = await Chrome.launch();
const report = [];
try {
  const only = args.only ? args.only.split(',') : null;
  for (const url of (only || seeds()).slice(0, max)) {
    for (const w of widths) report.push(await audit(chrome, BASE + url, w));
  }
} finally { await chrome.close(); }
if (args.perf) { console.log(JSON.stringify(report.map(r => ({ url: r.url, width: r.width, hScroll: r.hScroll, wide: r.wide, console: r.console, perf: r.perf })), null, 0)); process.exit(0); }
const bad = report.filter(r => r.error || ['failed', 'mime', 'broken', 'bgfail', 'distorted', 'overflow', 'tiny', 'console'].some(k => (r[k] || []).length) || r.hScroll);
console.log(JSON.stringify({ pages: report.length, withProblems: bad.length, problems: bad }, null, 1));
