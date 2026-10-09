// The Travel Assistant in a REAL browser: its panel, its conversation, its
// failures — and the proof that it is a separate interface from the Voice
// Assistant.
//
// Run (the backend must be serving the site):
//
//     JPW_BASE=http://127.0.0.1:8000 node --test "tests/js/browser/*.test.mjs"
//
// Chrome or Edge is found automatically (CHROME_PATH overrides). With no browser
// or no server the tests are SKIPPED and say why — they never fail for want of
// one.
//
// HOW THE NETWORK IS HANDLED. The assistant's endpoint is rate-limited (20 a
// minute per address), so every test but one answers POST /assistant/message
// itself, through request interception: that is also what makes loading, failure
// and retry states testable on demand. ONE test ("a real conversation") talks to
// the real server, uses about a dozen requests, and is where the real catalogue,
// the real packages API and the real matching are exercised end to end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const BASE = (process.env.JPW_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');

let chrome = null;
let skipReason = null;

before(async () => {
  if (!findChrome()) { skipReason = 'no Chrome or Edge found (set CHROME_PATH)'; return; }
  const up = await fetch(BASE + '/api/customer/destinations').then(r => r.ok).catch(() => false);
  if (!up) { skipReason = `no server answering at ${BASE} (set JPW_BASE)`; return; }
  chrome = await Chrome.launch();
});
after(async () => { if (chrome) await chrome.close(); });

/** test() that is skipped, with the reason, when there is no browser or server. */
function ui(name, fn) {
  test(name, { timeout: 90000 }, async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const page = await chrome.newPage();
    try { await fn(page, t); } finally { page.close(); }
  });
}

const MESSAGE = (url, method) => method === 'POST' && url.includes('/api/customer/assistant/message');
const reply = (text, extra = {}) => Object.assign({
  session_id: 's1', reply: text, intent: 'fallback', service_intent: 'x',
  action: { type: 'none', params: {} }, entities: {}, suggestions: [], choices: [],
  context: null, timestamp: new Date().toISOString(),
}, extra);
const bodies = (page) => page.requests(r => MESSAGE(r.url, r.method)).map(r => JSON.parse(r.body));

/** Answer every assistant message with `make(body)`; returns the recorded bodies. */
function mockMessages(page, make, opts = {}) {
  page.route(MESSAGE, async (req) => {
    const body = JSON.parse(req.body);
    return { json: make(body), delay: opts.delay || 0, status: opts.status || 200 };
  });
}

async function openApp(page, { width = 1280, height = 800, mobile = false } = {}) {
  await page.viewport({ width, height, mobile });
  await page.goto(BASE + '/');
  await page.eval('sessionStorage.clear()');
}
/** The traveller's route to the panel: the launcher, then Travel Assistant. */
async function openPanel(page) {
  await page.eval("document.getElementById('fabMainBtn').click()");
  await page.eval("document.getElementById('fabAiBtn').click()");
  await page.waitFor(() => document.getElementById('chatPanel').classList.contains('open'), { label: 'panel to open' });
  await page.waitFor(() => getComputedStyle(document.getElementById('chatPanel')).visibility === 'visible');
  // ...and for the opening animation to finish, so geometry is measured at rest.
  await page.waitFor(() => getComputedStyle(document.getElementById('chatPanel')).transform === 'none', { label: 'the panel to settle' });
}
async function say(page, text) {
  await page.eval("document.getElementById('taInput').focus()");
  await page.type(text);
  await page.key('Enter');
}
const idle = (page) => page.waitFor(() => !document.getElementById('taForm').classList.contains('is-busy')
  && !document.getElementById('taTyping'), { label: 'the answer to finish' });
const count = (page, sel) => page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const text = (page, sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
const clean = (s) => s.replace(/\s+/g, ' ').trim();

// ===========================================================================
// Travel Assistant UI
// ===========================================================================
ui('1. the panel opens from the launcher, closes with X and Escape, and hands focus back', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page);
  assert.equal(await page.eval("getComputedStyle(document.getElementById('chatPanel')).visibility"), 'hidden',
    'a closed panel is hidden, so it is out of the tab order');
  await openPanel(page);
  assert.equal(await page.eval("document.getElementById('chatPanel').getAttribute('aria-hidden')"), null);
  assert.equal(await page.eval("document.getElementById('fabAiBtn').getAttribute('aria-expanded')"), 'true');
  await page.waitFor(() => document.activeElement && document.activeElement.id === 'taInput', { label: 'input focus' });

  await page.eval("document.getElementById('taClose').click()");
  await page.waitFor(() => !document.getElementById('chatPanel').classList.contains('open'));
  assert.equal(await page.eval("document.getElementById('chatPanel').getAttribute('aria-hidden')"), 'true');
  assert.equal(await page.eval('document.activeElement.id'), 'fabMainBtn', 'focus returns to the launcher');
  await page.waitFor(() => getComputedStyle(document.getElementById('chatPanel')).visibility === 'hidden');

  await openPanel(page);
  await page.key('Escape');
  await page.waitFor(() => !document.getElementById('chatPanel').classList.contains('open'), { label: 'Escape to close' });
  assert.equal(await page.eval('document.activeElement.id'), 'fabMainBtn');
});

ui('1b. closing and reopening keeps the conversation', async (page) => {
  mockMessages(page, () => reply('Goa is lovely.'));
  await openApp(page);
  await openPanel(page);
  await say(page, 'tell me about Goa');
  await idle(page);
  await page.eval("document.getElementById('taClose').click()");
  await openPanel(page);
  const thread = clean(await text(page, '#chatBody'));
  assert.match(thread, /tell me about Goa/);
  assert.match(thread, /Goa is lovely/);
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 1);
  assert.equal(await count(page, '#chatBody .chat-msg.bot:not(.ta-typing)') >= 2, true);
});

ui('2. a short greeting and four starting suggestions, none of them decorative', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page);
  await openPanel(page);
  const greeting = await text(page, '#chatBody .chat-msg.bot');
  assert.ok(greeting.length < 130, 'the greeting is short: ' + greeting.length);
  const labels = await page.eval("[...document.querySelectorAll('#chatSuggestions button')].map(b => b.innerText)");
  assert.deepEqual(labels, ['Explore destinations', 'Tour packages', 'Find hotels', 'Search flights']);
});

for (const [label, message] of [['Explore destinations', 'Show me destinations'], ['Tour packages', 'Show tour packages'],
  ['Find hotels', 'Find hotels'], ['Search flights', 'Search flights']]) {
  ui(`2b. the "${label}" suggestion sends a real message and is not shown again`, async (page) => {
    mockMessages(page, () => reply('Here you go.'));
    await openApp(page);
    await openPanel(page);
    await page.eval(`[...document.querySelectorAll('#chatSuggestions button')].find(b => b.innerText === ${JSON.stringify(label)}).click()`);
    await idle(page);
    assert.deepEqual(bodies(page).map(b => b.message), [message]);
    assert.equal(await count(page, '#chatBody .chat-msg.user'), 1);
    // The starters are for the start of a conversation: after the first answer
    // (which offered nothing) the row is gone, not repeated.
    assert.equal(await page.eval("document.getElementById('chatSuggestions').children.length"), 0);
  });
}

ui('3. a message is sent with the button and with Enter, one request each, and the box clears', async (page) => {
  mockMessages(page, (b) => reply('Heard: ' + b.message));
  await openApp(page);
  await openPanel(page);
  await say(page, 'hotels in Goa');                       // Enter
  await idle(page);
  await page.eval("document.getElementById('taInput').focus()");
  await page.type('flights to Dubai');
  await page.eval("document.getElementById('taSend').click()");   // the button
  await idle(page);
  assert.deepEqual(bodies(page).map(b => b.message), ['hotels in Goa', 'flights to Dubai']);
  assert.equal(await page.eval("document.getElementById('taInput').value"), '');
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 2);
  assert.match(clean(await text(page, '#chatBody')), /Heard: flights to Dubai/);
});

ui('3b. an empty or blank message is not sent', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page);
  await openPanel(page);
  await page.eval("document.getElementById('taInput').focus()");
  await page.key('Enter');
  await page.type('    ');
  await page.key('Enter');
  assert.equal(bodies(page).length, 0);
});

ui('4. while an answer is on its way the button is disabled, it shows progress, and nothing is sent twice', async (page) => {
  mockMessages(page, () => reply('Done.'), { delay: 900 });
  await openApp(page);
  await openPanel(page);
  await say(page, 'show me destinations');
  await page.waitFor(() => document.getElementById('taSend').disabled, { label: 'send to be disabled' });
  assert.equal(await page.eval("document.getElementById('taForm').classList.contains('is-busy')"), true);
  assert.equal(await page.eval("document.getElementById('taForm').getAttribute('aria-busy')"), 'true');
  assert.equal(await count(page, '#taTyping'), 1, 'the typing indicator is shown');
  // Enter again, the button again, and a suggestion — all while busy.
  await page.type('and also this');
  await page.key('Enter');
  await page.eval("document.getElementById('taSend').click()");
  await idle(page);
  assert.equal(bodies(page).length, 1, 'only one request was made');
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 1, 'and only one question was shown');
  assert.equal(await page.eval("document.getElementById('taInput').value"), 'and also this',
    'what was typed meanwhile is kept, not lost');
  assert.equal(await page.eval("document.getElementById('taSend').disabled"), false);
});

ui('5. a long conversation scrolls inside the panel, keeps the newest line and the input in view, and never moves the page', async (page) => {
  mockMessages(page, (b) => reply('Reply to ' + b.message + '. ' + 'More detail follows here. '.repeat(4)));
  await openApp(page);
  await openPanel(page);
  await page.eval('window.scrollTo(0, 240)');
  const pageY = await page.eval('Math.round(window.scrollY)');
  for (let i = 1; i <= 22; i++) {
    await page.eval(`TravelAssistant.send('question number ${i}')`);
    await idle(page);
  }
  const m = await page.eval(`(() => {
    const t = document.getElementById('chatBody'), p = document.getElementById('chatPanel').getBoundingClientRect();
    const c = document.getElementById('taForm').getBoundingClientRect(), i = document.getElementById('taInput').getBoundingClientRect();
    return { atEnd: t.scrollTop + t.clientHeight >= t.scrollHeight - 4, scrollable: t.scrollHeight > t.clientHeight * 3,
             pageY: Math.round(window.scrollY), composeBottomInPanel: Math.abs(c.bottom - p.bottom) < 2,
             inputVisible: i.top >= p.top && i.bottom <= p.bottom && i.bottom <= innerHeight, panelH: Math.round(p.height) };
  })()`);
  assert.equal(m.scrollable, true);
  await new Promise(r => setTimeout(r, 700));                // the scroll to the newest line is smooth
  m.atEnd = await page.eval("(() => { const t = document.getElementById('chatBody'); return t.scrollTop + t.clientHeight >= t.scrollHeight - 4; })()");
  assert.equal(m.atEnd, true, 'the newest message is in view');
  assert.equal(m.pageY, pageY, 'the page behind did not move');
  assert.equal(m.composeBottomInPanel, true, 'the input is anchored to the bottom of the panel');
  assert.equal(m.inputVisible, true);
  assert.ok(m.panelH <= 560, 'the panel does not grow with the conversation: ' + m.panelH);
});

ui('5b. a long answer is shown from its top, not its end', async (page) => {
  const long = Array.from({ length: 14 }, (_, i) => ({ id: String(i), name: 'Package ' + i, destination: 'Goa', days: 4, priceFrom: '1000.00' }));
  mockMessages(page, () => reply('Here are the packages.', { action: { type: 'show_packages', params: {} } }));
  page.route((u) => u.includes('/api/customer/packages'), () => ({ json: long }));
  await openApp(page);
  await openPanel(page);
  await say(page, 'show tour packages');
  await page.waitFor(() => document.querySelector('#chatBody .ta-card'), { label: 'cards' });
  await idle(page);
  await new Promise(r => setTimeout(r, 700));        // the scroll is smooth
  const r = await page.eval(`(() => {
    const t = document.getElementById('chatBody'), replyEl = [...t.querySelectorAll('.chat-msg.bot')].find(e => /Here are the packages/.test(e.innerText));
    const tr = t.getBoundingClientRect(), er = replyEl.getBoundingClientRect();
    return { replyVisible: er.top >= tr.top - 2 && er.top < tr.bottom, firstCardVisible: (() => { const c = t.querySelector('.ta-card').getBoundingClientRect(); return c.top < tr.bottom && c.bottom > tr.top; })() };
  })()`);
  assert.equal(r.replyVisible, true, 'the answer starts in view');
  assert.equal(r.firstCardVisible, true, 'and so does its first card');
});

ui('6. phone: a full-screen sheet that follows the keyboard, with no overflow and the launcher out of the way', async (page) => {
  mockMessages(page, (b) => reply('Reply to ' + b.message));
  await openApp(page, { width: 390, height: 780, mobile: true });
  assert.equal(await page.eval("getComputedStyle(document.getElementById('fabMenu')).display !== 'none'"), true);
  await openPanel(page);
  const m = await page.eval(`(() => {
    const p = document.getElementById('chatPanel').getBoundingClientRect(), s = (id) => document.getElementById(id).getBoundingClientRect();
    return { panel: [Math.round(p.left), Math.round(p.top), Math.round(p.width), Math.round(p.height)],
      fab: getComputedStyle(document.getElementById('fabMenu')).display, lock: document.documentElement.classList.contains('ta-lock'),
      overflowX: document.documentElement.scrollWidth - innerWidth, modal: document.getElementById('chatPanel').getAttribute('aria-modal'),
      close: s('taClose').top >= 0 && s('taClose').right <= innerWidth, input: s('taInput').bottom <= innerHeight && s('taInput').left >= 0,
      send: s('taSend').bottom <= innerHeight && s('taSend').right <= innerWidth, focusOnInput: document.activeElement.id === 'taInput',
      inputFont: parseFloat(getComputedStyle(document.getElementById('taInput')).fontSize),
      // The input row is the BOTTOM of the sheet — not floating mid-screen above a blank gap.
      composeGap: Math.round(p.bottom - document.getElementById('taForm').getBoundingClientRect().bottom) };
  })()`);
  assert.ok(m.composeGap <= 1, 'the input is anchored to the bottom of the sheet: gap ' + m.composeGap + 'px');
  assert.deepEqual(m.panel, [0, 0, 390, 780], 'fills the screen');
  assert.equal(m.fab, 'none', 'the launcher steps aside');
  assert.equal(m.lock, true, 'the page behind does not scroll');
  assert.ok(m.overflowX <= 0, 'no horizontal scroll: ' + m.overflowX);
  assert.equal(m.modal, 'true');
  assert.equal(m.close && m.input && m.send, true, 'close, input and send are all on screen');
  assert.equal(m.focusOnInput, false, 'the keyboard is not raised before the traveller asks');
  assert.ok(m.inputFont >= 16, 'a 16px input stops iOS zooming the page: ' + m.inputFont);

  // The on-screen keyboard takes the bottom of the screen: simulate it by
  // shrinking the (visual) viewport, as a phone does.
  for (let i = 1; i <= 8; i++) { await page.eval(`TravelAssistant.send('question ${i}')`); await idle(page); }
  await page.viewport({ width: 390, height: 430, mobile: true });
  await page.waitFor(() => Math.round(document.getElementById('chatPanel').getBoundingClientRect().height) <= 432, { label: 'sheet to shrink' });
  const k = await page.eval(`(() => {
    const p = document.getElementById('chatPanel').getBoundingClientRect(), i = document.getElementById('taInput').getBoundingClientRect(), t = document.getElementById('chatBody');
    return { h: Math.round(p.height), inputInView: i.bottom <= innerHeight && i.top >= 0, atEnd: t.scrollTop + t.clientHeight >= t.scrollHeight - 6 };
  })()`);
  assert.ok(k.h <= 432, 'the sheet fits the space above the keyboard: ' + k.h);
  assert.equal(k.inputInView, true, 'the input is not behind the keyboard');
  assert.equal(k.atEnd, true, 'the newest message is still in view');

  await page.viewport({ width: 390, height: 780, mobile: true });
  await page.eval("document.getElementById('taClose').click()");
  await page.waitFor(() => !document.getElementById('chatPanel').classList.contains('open'));
  assert.equal(await page.eval("document.documentElement.classList.contains('ta-lock')"), false, 'the page scrolls again');
  assert.equal(await page.eval("getComputedStyle(document.getElementById('fabMenu')).display !== 'none'"), true, 'the launcher is back');
});

ui('6b. tablet: still a compact floating panel above the launcher', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page, { width: 820, height: 1100 });
  await openPanel(page);
  const m = await page.eval(`(() => { const p = document.getElementById('chatPanel').getBoundingClientRect(), f = document.getElementById('fabMainBtn').getBoundingClientRect();
    return { w: Math.round(p.width), h: Math.round(p.height), right: Math.round(innerWidth - p.right), above: p.bottom <= f.top + 2, overflowX: document.documentElement.scrollWidth - innerWidth }; })()`);
  assert.ok(m.w <= 380 && m.h <= 560, `compact: ${m.w}x${m.h}`);
  assert.equal(m.above, true, 'clear of the launcher');
  assert.ok(m.overflowX <= 0);
});

ui('6c. a small laptop: the panel never taller than the screen allows', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page, { width: 1100, height: 560 });
  await openPanel(page);
  const m = await page.eval(`(() => { const p = document.getElementById('chatPanel').getBoundingClientRect(), t = document.getElementById('chatBody').getBoundingClientRect();
    return { top: Math.round(p.top), bottom: Math.round(p.bottom), vh: innerHeight, convo: Math.round(t.height) }; })()`);
  assert.ok(m.top >= 0 && m.bottom <= m.vh, `fits the window: ${m.top}..${m.bottom} of ${m.vh}`);
  assert.ok(m.convo >= 150, `and the conversation is still usable: ${m.convo}px`);
});

ui('6d. a very short window: the conversation is not squeezed to a sliver', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page, { width: 900, height: 380 });
  await openPanel(page);
  const m = await page.eval(`(() => { const p = document.getElementById('chatPanel').getBoundingClientRect(), t = document.getElementById('chatBody').getBoundingClientRect(),
    c = document.getElementById('taForm').getBoundingClientRect(); return { top: Math.round(p.top), bottom: Math.round(p.bottom), vh: innerHeight, convo: Math.round(t.height), composeIn: c.bottom <= innerHeight }; })()`);
  assert.ok(m.top >= 0 && m.bottom <= m.vh && m.composeIn, `fits: ${m.top}..${m.bottom} of ${m.vh}`);
  assert.ok(m.convo >= 100, `the conversation keeps room: ${m.convo}px`);
});

ui('7. keyboard and screen reader: names, roles, tab order, contrast', async (page) => {
  mockMessages(page, () => reply('ok'));
  await openApp(page);
  await openPanel(page);
  const a = await page.eval(`(() => {
    const p = document.getElementById('chatPanel'), name = (el) => (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || (el.id && document.querySelector('label[for="' + el.id + '"]') ? document.querySelector('label[for="' + el.id + '"]').innerText : '') || '').trim();
    const interactive = [...p.querySelectorAll('button, a[href], input, [tabindex="0"]')];
    const lum = (rgb) => { const [r, g, b] = rgb.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const user = document.createElement('div'); user.className = 'chat-msg user'; user.textContent = 'x'; document.getElementById('chatBody').appendChild(user);
    const us = getComputedStyle(user), bs = getComputedStyle(document.querySelector('#chatBody .chat-msg.bot')), chip = getComputedStyle(document.querySelector('#chatSuggestions .chat-chip'));
    const head = getComputedStyle(document.querySelector('.chatbot-head'));
    const out = { role: p.getAttribute('role'), labelledby: p.getAttribute('aria-labelledby'), title: (document.getElementById(p.getAttribute('aria-labelledby')) || {}).innerText,
      log: document.getElementById('chatBody').getAttribute('role'), live: document.getElementById('chatBody').getAttribute('aria-live'),
      unnamed: interactive.filter(el => !name(el)).map(el => el.outerHTML.slice(0, 80)),
      user: ratio(us.color, us.backgroundColor), bot: ratio(bs.color, bs.backgroundColor), chip: ratio(chip.color, chip.backgroundColor), head: ratio(getComputedStyle(document.querySelector('.chatbot-head h4')).color, head.backgroundColor),
      count: interactive.length };
    user.remove(); return out;
  })()`);
  assert.equal(a.role, 'dialog');
  assert.equal(a.title, 'JackPots World Travel Assistant');
  assert.equal(a.log, 'log');
  assert.equal(a.live, 'polite');
  assert.deepEqual(a.unnamed, [], 'every control has an accessible name');
  for (const k of ['user', 'bot', 'chip', 'head']) assert.ok(a[k] >= 4.5, `${k} text contrast ${a[k].toFixed(2)} >= 4.5`);

  // Tab order: close, the conversation (so it can be scrolled by keyboard),
  // the suggestions, the input, send — in that order, and nothing hidden.
  await page.eval("document.getElementById('taClose').focus()");
  const order = [];
  for (let i = 0; i < 9; i++) {
    order.push(await page.eval(`(() => { const e = document.activeElement; return e.id || (e.className.split(' ')[0] + ':' + (e.innerText || '').trim()); })()`));
    await page.key('Tab');
  }
  assert.deepEqual(order.slice(0, 3), ['taClose', 'chatBody', 'chat-chip:Explore destinations']);
  assert.ok(order.includes('taInput') && order.includes('taSend'), 'input and send are reachable: ' + order);
  assert.ok(order.indexOf('taInput') < order.indexOf('taSend'));
});

ui('7b. reduced motion is respected', async (page) => {
  mockMessages(page, () => reply('ok'));
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await openApp(page);
  await openPanel(page);
  // The site's own reduced-motion rule makes transitions effectively instant
  // (a hair above zero, which is how the page expresses "none").
  const d = await page.eval("parseFloat(getComputedStyle(document.getElementById('chatPanel')).transitionDuration)");
  assert.ok(d < 0.01, 'transitions are effectively off: ' + d);
});

// ===========================================================================
// Conversation — against the real server
// ===========================================================================
ui('8-17. a real conversation: destinations, places, packages, follow-ups, a misspelling, an unknown place', async (page) => {
  await openApp(page);
  await openPanel(page);
  const lastReply = () => page.eval("[...document.querySelectorAll('#chatBody .chat-msg.bot:not(.ta-rich):not(.ta-typing)')].pop().innerText");
  const rich = async () => clean(await page.eval("[...document.querySelectorAll('#chatBody .ta-rich')].pop().innerText"));
  const ask = async (q) => { await say(page, q); await idle(page); await new Promise(r => setTimeout(r, 250)); };
  const notThrottled = async () => assert.equal(page.requests(r => MESSAGE(r.url, r.method)).length, bodies(page).length);

  // 8. generic destination discovery — the real shelf, in the conversation.
  await ask('Show me destinations');
  const dests = await page.eval("[...document.querySelectorAll('#chatBody .ta-dest .ta-card-title')].map(e => e.innerText)");
  const api = await (await fetch(BASE + '/api/customer/destinations')).json();
  assert.deepEqual(dests, api.map(d => d.name), 'the cards ARE the backend destinations, in order');
  assert.ok(await count(page, '#chatBody .ta-dest img') > 0, 'with the shelf artwork');
  assert.equal(await page.eval("window.scrollY"), 0, 'and the page did not scroll');

  // choosing one asks about it exactly as typing its name would
  await page.eval("document.querySelector('#chatBody .ta-dest').click()");
  await idle(page);
  await new Promise(r => setTimeout(r, 250));
  assert.match(await lastReply(), /Here is Hyderabad/);
  assert.deepEqual(await page.eval("[...document.querySelectorAll('#chatSuggestions button')].map(b => b.innerText)"),
    ['Places to visit in Hyderabad', 'Hyderabad tour packages', 'Hotels in Hyderabad'], 'context-aware, not the starters again');

  // 9. destination-location discovery — the real attractions
  await page.eval("[...document.querySelectorAll('#chatSuggestions button')].find(b => /Places to visit/.test(b.innerText)).click()");
  await idle(page); await new Promise(r => setTimeout(r, 250));
  assert.match(await rich(), /Famous places in Hyderabad.*Charminar/);
  assert.match(await rich(), /View place.*Hotels near Charminar/);

  // 10. packages with a destination — real prices
  await ask('Show Goa tour packages');
  const cards = await page.eval("[...document.querySelectorAll('#chatBody .ta-rich:last-of-type .ta-card')].length");
  assert.ok(cards >= 1);
  const pk = await (await fetch(BASE + '/api/customer/packages?destination=Goa')).json();
  assert.match(await rich(), new RegExp(`${pk.length} packages? — Goa tour packages`));
  assert.ok(await count(page, '#chatBody .ta-rich:last-of-type .ta-card img') > 0, 'package cards carry the destination artwork');

  // 17. follow-ups — and nothing claimed that the backend cannot do
  await ask('Only family packages');
  assert.match(await rich(), /None of our packages are described as family trips/);
  await ask('For four people');
  assert.match(await rich(), /Noted 4 travellers/);
  await ask('Change the destination to Bali');
  assert.match(await rich(), /family Bali tour packages/);
  assert.match(await lastReply(), /Updated — destination Bali/);

  // 14. a misspelling is asked about, never acted on
  const before = await count(page, '#chatBody .ta-rich');
  await ask('Show Charminnar');
  assert.equal(await lastReply(), 'Did you mean Charminar (Hyderabad)?');
  assert.equal(await count(page, '#chatBody .ta-rich'), before, 'nothing was shown for the guess');
  assert.deepEqual(await page.eval("[...document.querySelectorAll('#chatSuggestions button')].map(b => b.innerText)"), ['Charminar · Hyderabad']);
  await page.eval("document.querySelector('#chatSuggestions button').click()");
  await idle(page); await new Promise(r => setTimeout(r, 250));
  assert.match(await rich(), /Charminar.*in Hyderabad.*View Charminar.*Hotels near Charminar/);

  // 16. an unknown place
  await ask('Show Chandni Chowk');
  assert.match(await lastReply(), /^We couldn't find that location: Chandni Chowk\./);
  assert.ok(await page.eval("document.querySelectorAll('#chatSuggestions button').length") >= 2, 'with real destinations to try');

  // 15. several plausible matches
  await ask('Show Calangute bech');
  assert.equal(await lastReply(), 'Which of these did you mean?');
  assert.deepEqual(await page.eval("[...document.querySelectorAll('#chatSuggestions button')].map(b => b.innerText)"),
    ['Calangute Beach · Goa', 'Calangute · Goa']);
  assert.equal(page.requests(r => MESSAGE(r.url, r.method)).length, 11, 'one request per sentence, and no extras');
});

ui('18. result cards lead to pages that exist: package details, a place, hotels near it', async (page) => {
  await openApp(page);
  const pk = await (await fetch(BASE + '/api/customer/packages')).json();
  for (const url of [`/package-details/${pk[0].id}`, '/destination/hyderabad', '/destination/hyderabad/charminar',
    '/hotels/hyderabad/charminar', '/hotels.html?dest=Banjara%20Hills', '/packages.html?type=Goa']) {
    const r = await fetch(BASE + url);
    assert.equal(r.status, 200, url);
  }
});

ui('19a. a failed message keeps the conversation and Try again sends the same question once', async (page) => {
  let failing = true;
  page.route(MESSAGE, () => (failing ? { status: 503, json: { detail: 'down' } } : { json: reply('Back again.') }));
  await openApp(page);
  await openPanel(page);
  await say(page, 'tell me about Goa');
  await idle(page);
  assert.match(clean(await text(page, '#chatBody .ta-error')), /Something went wrong on our side.*Try again/);
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 1, 'the question is still shown');
  failing = false;
  await page.eval("document.querySelector('#chatBody .ta-retry').click()");
  await idle(page);
  assert.equal(bodies(page).length, 2);
  assert.deepEqual(bodies(page).map(b => b.message), ['tell me about Goa', 'tell me about Goa']);
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 1, 'asked twice, shown once');
  assert.equal(await count(page, '#chatBody .ta-error'), 0);
  assert.match(clean(await text(page, '#chatBody')), /Back again/);
});

ui('19b. no connection: said plainly, and the next message still works', async (page) => {
  let down = true;
  page.route(MESSAGE, () => (down ? { fail: true } : { json: reply('Connected.') }));
  await openApp(page);
  await openPanel(page);
  await say(page, 'hello');
  await idle(page);
  assert.match(clean(await text(page, '#chatBody .ta-error')), /could not reach the assistant/);
  down = false;
  await say(page, 'hello again');
  await idle(page);
  assert.match(clean(await text(page, '#chatBody')), /Connected\./);
  assert.equal(await page.eval("document.getElementById('taSend').disabled"), false);
});

ui('19c. a packages request that fails shows a retry that works', async (page) => {
  mockMessages(page, () => reply('Looking up Goa tour packages.', { action: { type: 'show_packages', params: { dest: 'Goa' } } }));
  let failing = true;
  page.route((u) => u.includes('/api/customer/packages'), () => (failing ? { fail: true } : undefined));
  await openApp(page);
  await openPanel(page);
  await say(page, 'Goa tour packages');
  await page.waitFor(() => /could not load that/.test(document.getElementById('chatBody').innerText), { label: 'the failure message' });
  assert.equal(await count(page, '#chatBody .ta-rich button'), 1);
  failing = false;
  await page.eval("document.querySelector('#chatBody .ta-rich button').click()");
  await page.waitFor(() => document.querySelector('#chatBody .ta-card'), { label: 'results after retry' });
  assert.match(clean(await text(page, '#chatBody .ta-rich')), /packages? — Goa tour packages/);
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 1, 'the question was not asked again');
});

ui('19d. no matching packages: a clear empty state with a way forward', async (page) => {
  mockMessages(page, () => reply('Looking up Paris tour packages.', { action: { type: 'show_packages', params: { dest: 'Paris' } } }));
  page.route((u) => /\/api\/customer\/packages(\?|$)/.test(u), (r) => ({ json: r.url.includes('destination=Paris') ? [] : [
    { id: '7', name: 'Goa', destination: 'Goa', days: 4, priceFrom: '21900.00' }] }));
  await openApp(page);
  await openPanel(page);
  await say(page, 'tour packages for Paris');
  await page.waitFor(() => /No matching packages/.test(document.getElementById('chatBody').innerText), { label: 'empty state' });
  const t = clean(await text(page, '#chatBody .ta-rich'));
  assert.match(t, /We don’t have Paris tour packages on sale right now/);
  assert.deepEqual(await page.eval("[...document.querySelectorAll('#chatBody .ta-rich button')].map(b => b.innerText)"), ['Goa tour packages']);
});

ui('19e. a hotel and a flight request still go to the existing search (regression)', async (page) => {
  mockMessages(page, (b) => /hotel/i.test(b.message)
    ? reply('Looking up hotels in Goa.', { action: { type: 'search_hotels', params: { dest: 'Goa' } } })
    : reply('Searching flights.', { action: { type: 'search_flights', params: { trip: 'oneway', from: 'Hyderabad', to: 'Delhi', fromCode: 'HYD', toCode: 'DEL' } } }));
  await openApp(page);
  await openPanel(page);
  await say(page, 'Hyderabad to Delhi');
  await idle(page);
  await page.waitFor(() => /airport|Delhi|DEL/.test(document.querySelector('.search-card') ? document.querySelector('.search-card').innerText : ''), { label: 'the flight card' });
  assert.match(await page.eval('location.pathname'), /^\/(index\.html)?$/, 'the flight search is the landing page card, not a page of its own');
  await page.goto(BASE + '/');
  await openPanel(page);
  await say(page, 'Hotels in Goa');
  await page.waitFor(() => location.pathname.endsWith('hotels.html'), { label: 'navigation to the hotel search', timeout: 6000 });
  assert.match(await page.eval('location.search'), /dest=Goa/);
});

// ===========================================================================
// Two assistants, kept apart
// ===========================================================================
ui('20. the Travel Assistant has no microphone and starts no speech recognition', async (page) => {
  await page.addInitScript(`window.__recog = 0; const Fake = class { constructor() { window.__recog++; } start() {} stop() {} };
    window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;`);
  mockMessages(page, () => reply('ok'));
  await openApp(page);
  await openPanel(page);
  await say(page, 'hello');
  await idle(page);
  const m = await page.eval(`(() => { const p = document.getElementById('chatPanel');
    return { mic: p.querySelectorAll('[class*="mic" i], [id*="mic" i], [aria-label*="microphone" i], [aria-label*="voice" i], [aria-label*="speak" i], [data-jp-icon="mic"]').length,
             text: /microphone|speech|dictat|voice/i.test(p.innerText), recognisers: window.__recog }; })()`);
  assert.equal(m.mic, 0, 'no microphone control in the panel');
  assert.equal(m.text, false);
  assert.equal(m.recognisers, 0, 'no speech recogniser was ever created by the typed panel');
  // And the source of the panel's markup says the same.
  const src = readFileSync(join(ROOT, 'frontend/assets/js/travel-assistant.js'), 'utf8');
  const markup = src.slice(src.indexOf('function buildPanel'), src.indexOf('Enter submits the form natively'));
  assert.doesNotMatch(markup, /mic|speech|record|listen|voice/i);
});

ui('21. the Voice Assistant still opens, listens, hears, answers and closes', async (page) => {
  await page.addInitScript(`window.__rec = { started: 0, stopped: 0 };
    class Fake { start() { window.__rec.started++; window.__rec.last = this; } stop() { window.__rec.stopped++; } }
    window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;
    window.__say = (text, confidence) => { const r = [{ transcript: text, confidence: confidence == null ? 0.95 : confidence }]; r.isFinal = true;
      window.__rec.last.onresult({ resultIndex: 0, results: [r] }); };`);
  mockMessages(page, (b) => reply('Voice heard: ' + b.message));
  await openApp(page);
  await page.eval("document.getElementById('fabMainBtn').click()");
  await page.eval("document.getElementById('fabVoiceBtn').click()");
  await page.waitFor(() => !document.getElementById('vaOverlay').hidden, { label: 'the voice popup' });
  assert.equal(await page.eval("document.getElementById('vaMic').disabled"), false);
  assert.equal(await count(page, '#vaOverlay .va-mic'), 1, 'it has its microphone');
  await page.eval("document.getElementById('vaMic').click()");
  await page.waitFor(() => document.getElementById('vaMic').classList.contains('is-listening'), { label: 'listening' });
  assert.equal(await page.eval('window.__rec.started'), 1);
  await page.eval("window.__say('hotels in goa')");
  await page.waitFor(() => /Voice heard: hotels in goa/.test(document.getElementById('vaReply').innerText), { label: 'the spoken answer' });
  assert.equal(await page.eval("document.getElementById('vaHeard').innerText"), 'hotels in goa');
  assert.equal(await page.eval("document.getElementById('vaMic').classList.contains('is-listening')"), false, 'stopped listening once it heard');
  assert.deepEqual(bodies(page).map(b => b.kind), ['voice']);
  await page.key('Escape');
  await page.waitFor(() => document.getElementById('vaOverlay').hidden, { label: 'the popup to close' });
  // ...and its close button
  await page.eval("document.getElementById('fabMainBtn').click()");
  await page.eval("document.getElementById('fabVoiceBtn').click()");
  await page.waitFor(() => !document.getElementById('vaOverlay').hidden);
  await page.eval("document.getElementById('vaClose').click()");
  assert.equal(await page.eval("document.getElementById('vaOverlay').hidden"), true);
});

ui('21b. the Voice Assistant keeps asking when it is not sure what it heard', async (page) => {
  await page.addInitScript(`window.__rec = { started: 0 }; class Fake { start() { window.__rec.started++; window.__rec.last = this; } stop() {} }
    window.SpeechRecognition = Fake; window.__say = (t, c) => { const r = [{ transcript: t, confidence: c }]; r.isFinal = true; window.__rec.last.onresult({ resultIndex: 0, results: [r] }); };`);
  mockMessages(page, () => reply('ok'));
  await openApp(page);
  await page.eval("TravelAssistant.openVoice(); document.getElementById('vaMic').click()");
  await page.eval("window.__say('hotels in goa', 0.2)");
  await page.waitFor(() => /Did you say/.test(document.getElementById('vaReply').innerText), { label: 'the confirmation' });
  assert.equal(bodies(page).length, 0, 'nothing was sent on a low-confidence guess');
});

ui('22. the two assistants keep separate searches, and share only the server', async (page) => {
  await page.addInitScript(`window.__rec = { last: null }; class Fake { start() { window.__rec.last = this; } stop() {} }
    window.SpeechRecognition = Fake; window.__say = (t) => { const r = [{ transcript: t, confidence: 0.95 }]; r.isFinal = true; window.__rec.last.onresult({ resultIndex: 0, results: [r] }); };`);
  mockMessages(page, (b) => reply('ok', { context: { service: 'package', destination: b.kind === 'voice' ? 'Bali' : 'Goa' } }));
  await openApp(page);
  await openPanel(page);
  await say(page, 'Goa tour packages');                 // typed -> typed context = Goa
  await idle(page);
  await page.eval("document.getElementById('taClose').click()");
  await page.eval("TravelAssistant.openVoice(); document.getElementById('vaMic').click()");
  await page.eval("window.__say('Bali tour packages')");   // spoken -> voice context = Bali
  for (let i = 0; i < 60 && bodies(page).length < 2; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(bodies(page).length, 2, 'the spoken request was made');
  await page.waitFor(() => !document.getElementById('taForm').classList.contains('is-busy'));
  await page.eval("TravelAssistant.closeVoice()");
  await openPanel(page);
  await say(page, 'only family packages');               // typed again
  await idle(page);
  const b = bodies(page);
  assert.equal('context' in b[0], false);
  assert.equal('context' in b[1], false, "the spoken search did not start from the typed one's context");
  assert.equal(b[2].context.destination, 'Goa', "the typed search continues the typed one — not the spoken Bali");
  assert.deepEqual(b.map(x => x.kind), ['assistant', 'voice', 'assistant']);
  assert.equal(new Set(b.map(x => x.session_id).filter(Boolean)).size <= 1, true, 'one conversation record for both');
});

ui('23. no duplicate requests: a double tap sends once; the same destinations are fetched once', async (page) => {
  mockMessages(page, () => reply('Here are our destinations.', { action: { type: 'show_destinations', params: {} } }));
  await openApp(page);
  // The landing page's own Destinations shelf fetches this list when it loads;
  // what matters is how many MORE requests the assistant makes.
  const onLoad = page.requests(r => /\/api\/customer\/destinations$/.test(r.url)).length;
  await openPanel(page);
  // a double tap on a suggestion, in the same instant
  await page.eval(`(() => { const b = [...document.querySelectorAll('#chatSuggestions button')].find(x => x.innerText === 'Explore destinations'); b.click(); b.click(); })()`);
  await idle(page);
  await page.waitFor(() => document.querySelector('#chatBody .ta-dest'));
  assert.equal(bodies(page).length, 1, 'one message');
  assert.equal(await count(page, '#chatBody .chat-msg.user'), 1, 'shown once');
  // ask for the destinations again: the answer is drawn again, the API is not hit again
  await say(page, 'show destinations');
  await idle(page);
  await page.waitFor(() => document.querySelectorAll('#chatBody .ta-rich').length === 2);
  assert.equal(page.requests(r => /\/api\/customer\/destinations$/.test(r.url)).length - onLoad, 1,
    'the assistant fetched GET /destinations once, however often it was shown');
});
