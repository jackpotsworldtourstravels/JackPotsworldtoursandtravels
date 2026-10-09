// A minimal Chrome DevTools Protocol client — no dependency.
//
// WHY THIS EXISTS. The Travel Assistant's behaviour that matters most (a panel
// that opens and closes, an input that stays above a phone's keyboard, a button
// that cannot be pressed twice, a list that scrolls without moving the page) is
// only real in a real browser. The project has no Playwright or Puppeteer and
// adding a download-a-browser dependency to a site with no package.json is the
// wrong trade, so this drives the Chrome that is already on the machine over its
// own debugging protocol, using the WebSocket Node 22 ships with.
//
//   const chrome = await Chrome.launch();
//   const page = await chrome.newPage();
//   await page.goto('http://127.0.0.1:8000/');
//   await page.eval('document.title');
//   await chrome.close();
//
// It does only what the tests need: navigate, evaluate, real key and mouse
// events, viewport emulation, and request interception (to count, delay, fail
// or answer a request — which is how loading, error and retry states are tested
// without waiting for a real outage).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find(p => existsSync(p)) || null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Page {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.routes = [];
    this.log = [];                       // every request the page made, for counting
    ws.addEventListener('message', (ev) => this._onMessage(JSON.parse(ev.data)));
  }

  _onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      (this.listeners.get(msg.method) || []).forEach(fn => fn(msg.params));
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  async init() {
    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable')]);
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
    this.on('Fetch.requestPaused', (p) => this._route(p));
  }

  /** Requests matching `test(url, method)` are answered by `handler(req)`, which
   *  returns {status, json|body, delay} to fulfil, {fail:true} to fail the
   *  network, or nothing to let the request through. Newest route first. */
  route(test, handler) {
    const r = { test, handler };
    this.routes.unshift(r);
    return () => { this.routes = this.routes.filter(x => x !== r); };
  }

  async _route(p) {
    const { requestId, request } = p;
    const entry = { url: request.url, method: request.method, body: request.postData || null, at: Date.now() };
    this.log.push(entry);
    const hit = this.routes.find(r => r.test(request.url, request.method));
    let out;
    try { out = hit ? await hit.handler(entry) : undefined; } catch (e) { out = { fail: true }; }
    if (!out) { await this.send('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
    if (out.delay) await sleep(out.delay);
    if (out.fail) { await this.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {}); return; }
    const body = out.json !== undefined ? JSON.stringify(out.json) : (out.body || '');
    await this.send('Fetch.fulfillRequest', {
      requestId, responseCode: out.status || 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(body).toString('base64'),
    }).catch(() => {});
  }

  requests(match) { return this.log.filter(r => (typeof match === 'string' ? r.url.includes(match) : match(r))); }

  async goto(url) {
    this.log.length = 0;
    const loaded = new Promise(res => { const off = this.once('Page.loadEventFired', () => res()); });
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(250);
  }

  once(method, fn) {
    const wrapper = (p) => { this.listeners.set(method, (this.listeners.get(method) || []).filter(f => f !== wrapper)); fn(p); };
    this.on(method, wrapper);
  }

  /** Evaluate in the page; promises are awaited; the result is returned by value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'evaluation failed');
    }
    return r.result.value;
  }

  /** Run `fn` (a function in the page) with JSON arguments. */
  call(fn, ...args) {
    return this.eval(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }

  async waitFor(predicate, { timeout = 8000, interval = 50, label = 'condition' } = {}) {
    const started = Date.now();
    for (;;) {
      const v = await this.eval(`Promise.resolve((${predicate.toString()})()).catch(()=>false)`).catch(() => false);
      if (v) return v;
      if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label);
      await sleep(interval);
    }
  }

  async key(key, extra = {}) {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0, ...extra };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === 'Enter' ? '\r' : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  type(text) { return this.send('Input.insertText', { text }); }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** @param mobile true for a 390x844 touch phone; false for 1280x800 desktop. */
  viewport({ width, height, mobile = false }) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  /** Scripts run in every new document, before the page's own — how a fake
   *  speech recogniser is installed for the Voice Assistant tests. */
  addInitScript(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

export class Chrome {
  static async launch() {
    const exe = findChrome();
    if (!exe) throw new Error('No Chrome or Edge found (set CHROME_PATH)');
    const dir = mkdtempSync(join(tmpdir(), 'jpw-chrome-'));
    const port = 9300 + Math.floor(Math.random() * 500);
    const proc = spawn(exe, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--mute-audio', 'about:blank',
    ], { stdio: 'ignore' });
    const c = new Chrome(proc, dir, port);
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return c; } catch { /* starting */ }
      await sleep(150);
    }
    await c.close();
    throw new Error('Chrome did not start');
  }

  constructor(proc, dir, port) { this.proc = proc; this.dir = dir; this.port = port; this.pages = []; }

  async newPage() {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
    const target = await r.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const page = new Page(ws);
    await page.init();
    this.pages.push(page);
    return page;
  }

  async close() {
    this.pages.forEach(p => p.close());
    try { this.proc.kill(); } catch { /* gone */ }
    await sleep(300);
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
  }
}
