// The Voice Assistant's hand-off to the booking card, its closing, and its memory —
// in a REAL browser, with the assistant's endpoint and the microphone mocked.
//
// Run (the backend must be serving the site):
//
//     JPW_BASE=http://127.0.0.1:8000 node --test "tests/js/browser/voice-handoff.ui.test.mjs"
//
// WHAT IS MOCKED: POST /api/customer/assistant/message (so the reply is exactly what
// each test needs, and the 20-a-minute limiter is never touched) and the speech
// recogniser (a fake that records how many were created, started and aborted, and
// can be made to fire a transcript, or the same one twice). Everything else — the
// landing page, the booking card, its tabs and fields, the airport table, the
// scrolling, the storage — is the real thing.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after } from 'node:test';
import { Chrome, findChrome } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
void join(here);
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
function mockMessages(page, make, opts = {}) {
  page.route(MESSAGE, async (req) => ({ json: make(JSON.parse(req.body)), delay: opts.delay || 0, status: 200 }));
}

/** A fake recogniser that counts what is done to it. */
const FAKE_SPEECH = `
  window.__rec = { created: 0, started: 0, aborted: 0, stopped: 0, instances: [], last: null };
  class Fake {
    constructor() { window.__rec.created++; window.__rec.instances.push(this); this.active = false; }
    start() { window.__rec.started++; window.__rec.last = this; this.active = true; }
    stop() { window.__rec.stopped++; this.active = false; }
    abort() { window.__rec.aborted++; this.active = false; }
  }
  window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;
  window.__active = () => window.__rec.instances.filter(i => i.active).length;
  window.__say = (text, confidence, times) => {
    const r = [{ transcript: text, confidence: confidence == null ? 0.95 : confidence }]; r.isFinal = true;
    for (let i = 0; i < (times || 1); i++) window.__rec.last.onresult({ resultIndex: 0, results: [r] });
  };`;

async function start(page, make, opts) {
  await page.addInitScript(FAKE_SPEECH);
  mockMessages(page, make, opts);
  await page.viewport({ width: 1280, height: 800, mobile: false });
  await page.goto(BASE + '/');
  await page.eval('sessionStorage.clear(); localStorage.removeItem("jpc_access"); localStorage.removeItem("jpc_user_id")');
}
async function openVoice(page) {
  await page.eval("TravelAssistant.openVoice()");
  await page.waitFor(() => !document.getElementById('vaOverlay').hidden, { label: 'the voice popup' });
}
async function speak(page, text, confidence, times) {
  await page.eval("document.getElementById('vaMic').click()");
  await page.waitFor(() => document.getElementById('vaMic').classList.contains('is-listening'), { label: 'listening' });
  await page.eval(`window.__say(${JSON.stringify(text)}, ${confidence == null ? 'null' : confidence}, ${times || 1})`);
}
async function waitBodies(page, n) {
  for (let i = 0; i < 100 && bodies(page).length < n; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(bodies(page).length, n, 'the expected number of requests was made');
}
const popupHidden = (page) => page.eval("document.getElementById('vaOverlay').hidden");
const waitClosed = (page) => page.waitFor(() => document.getElementById('vaOverlay').hidden, { label: 'the popup to close' });
const card = (page) => page.eval(`(() => ({
  tab: document.querySelector('.search-tab.is-on').dataset.tab,
  from: document.getElementById('fFrom').dataset.key, fromText: document.getElementById('fFrom').value,
  to: document.getElementById('fTo').dataset.key, toText: document.getElementById('fTo').value }))()`);
const cardInView = (page) => page.eval(`(() => { const r = document.querySelector('.search-card').getBoundingClientRect();
  return r.top < innerHeight && r.bottom > 0; })()`);

const FLIGHT_ASK = (b) => b.message === 'Book a flight to Goa'
  ? reply('Sure — flights to Goa (GOI). Where will you be flying from?', {
    intent: 'flight', service_intent: 'flight_search',
    action: { type: 'search_flights', params: { trip: 'oneway', to: 'Goa', toCode: 'GOI' } },
    context: { service: 'flight', destination: 'Goa', destination_code: 'GOI', awaiting: 'origin', _sig: 'a', _at: 1 } })
  : reply('Got it — flying from Delhi (DEL). What day would you like to fly?', {
    intent: 'flight', service_intent: 'flight_search',
    action: { type: 'search_flights', params: { trip: 'oneway', from: 'Delhi', to: 'Goa', fromCode: 'DEL', toCode: 'GOI' } },
    context: { service: 'flight', origin: 'Delhi', destination: 'Goa', origin_code: 'DEL', destination_code: 'GOI', awaiting: 'date', _sig: 'b', _at: 2 } });

// ===========================================================================
ui('1-3. "Book a flight to Goa" activates Flights, fills Goa, does NOT guess an origin, and keeps asking', async (page) => {
  await start(page, FLIGHT_ASK);
  await page.eval("document.querySelector('.search-tab[data-tab=hotels]').click()");   // the card starts on another tab
  await openVoice(page);
  await speak(page, 'Book a flight to Goa');
  await page.waitFor(() => document.getElementById('vaReply').innerText.includes('flying from'), { label: 'the question' });
  await page.waitFor(() => document.getElementById('fTo').dataset.key === 'GOI', { label: 'the card to be filled' });
  const c = await card(page);
  assert.equal(c.tab, 'flights');
  assert.equal(c.to, 'GOI');
  assert.equal(c.from, '', 'the origin is left unset, not guessed');
  await new Promise(r => setTimeout(r, 1400));                 // longer than the hand-off delay
  assert.equal(await popupHidden(page), false, 'a question is open, so the assistant stays');
});

ui('2, 4, 8. the origin answers the question: route filled, assistant closes, card in view', async (page) => {
  await start(page, FLIGHT_ASK);
  await openVoice(page);
  await speak(page, 'Book a flight to Goa');
  await page.waitFor(() => document.getElementById('vaReply').innerText.includes('flying from'));
  await speak(page, 'Delhi');
  await waitClosed(page);
  const c = await card(page);
  assert.deepEqual([c.tab, c.from, c.to], ['flights', 'DEL', 'GOI']);
  await page.waitFor(() => { const r = document.querySelector('.search-card').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; },
    { label: 'the booking card to be scrolled into view' });
  assert.equal(await page.eval("document.body.style.overflow"), '', 'page scrolling is released');
  assert.equal(await page.eval('window.__active()'), 0, 'no microphone session is left running');
});

ui('5. the assistant does not close while the request is still being processed', async (page) => {
  await start(page, (b) => FLIGHT_ASK({ message: 'x' }), { delay: 1500 });
  await openVoice(page);
  await speak(page, 'Flights from Delhi to Goa');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await popupHidden(page), false, 'still thinking, still open');
  assert.equal(await page.eval("document.getElementById('vaOverlay').dataset.state"), 'thinking');
  await waitClosed(page);
  assert.equal((await card(page)).from, 'DEL');
});

ui('6. a hotel request goes to the existing Hotels flow and the assistant closes first', async (page) => {
  await start(page, () => reply('Looking up hotels in Goa.', { intent: 'hotel', service_intent: 'hotel_search',
    action: { type: 'search_hotels', params: { dest: 'Goa' } } }));
  await openVoice(page);
  await speak(page, 'Show hotels in Goa');
  await page.waitFor(() => location.pathname.endsWith('/hotels.html') && /dest=Goa/.test(location.search), { label: 'the hotels page' });
});

ui('7. a plain tour-package request goes to the existing Tour Packages page', async (page) => {
  await start(page, () => reply('Looking up Bali tour packages.', { intent: 'package', service_intent: 'tour_package_search',
    action: { type: 'show_packages', params: { dest: 'Bali' } } }));
  await openVoice(page);
  await speak(page, 'Show tour packages for Bali');
  await page.waitFor(() => location.pathname.endsWith('/packages.html') && /type=Bali/.test(location.search), { label: 'the packages page' });
});

ui('7b. a package search with a style the page cannot express stays in the conversation', async (page) => {
  await start(page, () => reply('Looking up Bali tour packages (family style).', { intent: 'package', service_intent: 'tour_package_search',
    action: { type: 'show_packages', params: { dest: 'Bali', preference: 'family' } } }));
  await openVoice(page);
  await speak(page, 'Make it a family trip');
  await page.waitFor(() => document.getElementById('vaReply').innerText.includes('family style'));
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(await popupHidden(page), false);
  assert.ok(await page.eval('location.pathname').then(p => !p.endsWith('packages.html')));
});

ui('9. Gaming Tour Packages activates the card\'s Gaming tab', async (page) => {
  await start(page, () => reply('Opening Gaming Tour Packages.', { intent: 'gaming', service_intent: 'gaming_tour_package_search',
    action: { type: 'open_gaming', params: {} } }));
  await openVoice(page);
  await speak(page, 'Show gaming tour packages');
  await waitClosed(page);
  assert.equal((await card(page)).tab, 'gaming');
  await page.waitFor(() => { const r = document.querySelector('.search-card').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
});

ui('10. a destination request uses the existing Destinations shelf, then the popup closes', async (page) => {
  await start(page, () => reply('Here are our destinations.', { intent: 'destinations', service_intent: 'destination_discovery',
    action: { type: 'show_destinations', params: {} } }));
  await openVoice(page);
  await speak(page, 'Show me destinations');
  await waitClosed(page);
  await page.waitFor(() => { const r = document.getElementById('destinations').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; },
    { label: 'the Destinations section to be in view' });
});

ui('11-12. reopening restores the conversation; the retained context goes back with the follow-up', async (page) => {
  await start(page, (b) => b.message === 'What about hotels there?'
    ? reply('Looking up hotels in Goa.', { context: { service: 'hotel', destination: 'Goa', _sig: 'c', _at: 3 } })
    : FLIGHT_ASK(b));
  await openVoice(page);
  await speak(page, 'Book a flight to Goa');
  await page.waitFor(() => document.getElementById('vaReply').innerText.includes('flying from'));
  await speak(page, 'Delhi');
  await waitClosed(page);

  await openVoice(page);
  assert.match(await page.eval("document.getElementById('vaHeard').innerText"), /Delhi/, 'what was said last is shown');
  assert.match(await page.eval("document.getElementById('vaReply').innerText"), /flying from Delhi/);
  assert.match(await page.eval("document.getElementById('vaLog').innerText"), /Book a flight to Goa/, 'and what came before');
  assert.equal(await page.eval("document.getElementById('vaMic').classList.contains('is-listening')"), false, 'the microphone is NOT switched on by opening');
  assert.equal(await page.eval('window.__rec.started'), 2, 'only the two explicit presses');
  const before = bodies(page).length;
  await speak(page, 'What about hotels there?');
  await waitBodies(page, before + 1);
  const b = bodies(page).pop();
  assert.equal(b.session_id, 's1', 'the same conversation, not a new session');
  assert.equal(b.context.destination, 'Goa', 'the held search goes back with the follow-up');
  assert.equal(b.context.awaiting, 'date');
});

ui('12b. "start over" forgets the search and the log, so a new search inherits nothing', async (page) => {
  await start(page, (b) => FLIGHT_ASK(b));
  await openVoice(page);
  await speak(page, 'Book a flight to Goa');
  await page.waitFor(() => document.getElementById('vaReply').innerText.includes('flying from'));
  const n = bodies(page).length;
  await speak(page, 'start over');
  await page.waitFor(() => /starting fresh/i.test(document.getElementById('vaReply').innerText));
  assert.equal(bodies(page).length, n, 'no request for words about the conversation');
  await speak(page, 'Hotels in Bali');
  await waitBodies(page, n + 1);
  assert.equal('context' in bodies(page).pop(), false);
  await page.eval("TravelAssistant.closeVoice()");
  await openVoice(page);
  assert.doesNotMatch(await page.eval("document.getElementById('vaLog').innerText"), /Goa/);
});

ui('13-14. one customer\'s conversation is never shown to, or sent for, another', async (page) => {
  await start(page, (b) => reply('Heard: ' + b.message, { session_id: 'sess-of-' + (b.session_id || 'new'),
    context: { service: 'hotel', destination: 'Goa', _sig: 'x', _at: 1 } }));
  await page.eval('localStorage.setItem("jpc_access", "tok-a"); localStorage.setItem("jpc_user_id", "11")');
  await openVoice(page);
  await speak(page, 'hotels in goa');
  await page.waitFor(() => /Heard: hotels in goa/.test(document.getElementById('vaReply').innerText));
  assert.equal(await page.eval("sessionStorage.getItem('jpc_assistant_voicelog')").then(v => /tok-a/.test(v)), false, 'no token is ever stored in the log');
  await page.eval("TravelAssistant.closeVoice()");

  // another account signs in on the same tab
  await page.eval('localStorage.setItem("jpc_access", "tok-b"); localStorage.setItem("jpc_user_id", "22")');
  await openVoice(page);
  assert.equal(await page.eval("document.getElementById('vaHeard').innerText"), '', 'B does not see A\'s conversation');
  assert.equal(await page.eval("document.getElementById('vaLog').children.length"), 0);
  const n = bodies(page).length;
  await speak(page, 'hotels in bali');
  await waitBodies(page, n + 1);
  const b = bodies(page).pop();
  assert.equal('context' in b, false, "A's held search is not sent for B");
  assert.ok(!b.session_id, "A's conversation id is not reused for B");
});

ui('13b. a guest who signs in keeps the conversation (it is claimed, not reset)', async (page) => {
  await start(page, (b) => reply('Heard: ' + b.message, { context: { service: 'hotel', destination: 'Goa', _sig: 'x', _at: 1 } }));
  await openVoice(page);
  await speak(page, 'hotels in goa');
  await page.waitFor(() => /Heard/.test(document.getElementById('vaReply').innerText));
  await page.eval("TravelAssistant.closeVoice()");
  await page.eval('localStorage.setItem("jpc_access", "tok"); localStorage.setItem("jpc_user_id", "5")');
  await openVoice(page);
  assert.match(await page.eval("document.getElementById('vaHeard').innerText"), /hotels in goa/);
});

ui('15. a repeated final transcript is one request and one hand-off', async (page) => {
  await start(page, FLIGHT_ASK);
  await openVoice(page);
  await speak(page, 'Book a flight to Goa', null, 3);          // the recogniser reports it three times
  await page.waitFor(() => document.getElementById('vaReply').innerText.includes('flying from'));
  assert.equal(bodies(page).length, 1);
  await speak(page, 'Delhi', null, 2);
  await waitClosed(page);
  assert.equal(bodies(page).length, 2);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(await popupHidden(page), true, 'nothing reopened it');
});

ui('16. closing and reopening does not stack listeners or microphone sessions', async (page) => {
  await start(page, () => reply('ok'));
  for (let i = 0; i < 4; i++) {
    await openVoice(page);
    await page.eval("document.getElementById('vaMic').click()");
    await page.waitFor(() => window.__active() === 1, { label: 'one live session' });
    await page.eval("TravelAssistant.closeVoice()");
    assert.equal(await page.eval('window.__active()'), 0, 'closing ends the session (visit ' + (i + 1) + ')');
  }
  assert.equal(await page.eval('document.querySelectorAll("#vaOverlay").length'), 1, 'one popup, built once');
  const stale = await page.eval(`window.__rec.instances.slice(0, -1).every(i => i.onresult === null && i.onend === null && i.onerror === null)`);
  assert.equal(stale, true, 'old recognisers can no longer call back into the page');
  // a callback that arrives after the popup closed does nothing
  const n = bodies(page).length;
  await page.eval(`(() => { const r = [{ transcript: 'late words', confidence: 0.9 }]; r.isFinal = true;
    const old = window.__rec.instances[0]; if (old.onresult) old.onresult({ resultIndex: 0, results: [r] }); })()`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(bodies(page).length, n);
  assert.equal(await popupHidden(page), true);
});

ui('16b. an answer that arrives after the popup was closed opens nothing', async (page) => {
  await start(page, () => reply('Looking up hotels in Goa.', { intent: 'hotel', service_intent: 'hotel_search',
    action: { type: 'search_hotels', params: { dest: 'Goa' } } }), { delay: 1200 });
  await openVoice(page);
  await speak(page, 'Show hotels in Goa');
  await page.eval("TravelAssistant.closeVoice()");           // closed while the answer is on its way
  await new Promise(r => setTimeout(r, 2800));
  assert.equal(await page.eval('location.pathname.endsWith("hotels.html")'), false, 'no navigation from a closed popup');
  assert.equal(await popupHidden(page), true, 'and it did not reopen');
  await openVoice(page);
  assert.match(await page.eval("document.getElementById('vaHeard').innerText"), /hotels in Goa/i, 'the exchange was still kept');
});

ui('17. refresh and back/forward keep the conversation and do not duplicate anything', async (page) => {
  await start(page, (b) => b.message === 'Show hotels in Goa'
    ? reply('Looking up hotels in Goa.', { intent: 'hotel', service_intent: 'hotel_search',
      action: { type: 'search_hotels', params: { dest: 'Goa' } }, context: { service: 'hotel', destination: 'Goa', _sig: 'x', _at: 1 } })
    : reply('ok'));
  await openVoice(page);
  await speak(page, 'Show hotels in Goa');
  await page.waitFor(() => location.pathname.endsWith('/hotels.html'), { label: 'the hotels page' });

  await page.goto(BASE + '/');                                   // back to the landing page
  await openVoice(page);
  assert.match(await page.eval("document.getElementById('vaHeard').innerText"), /Show hotels in Goa/);
  assert.equal(await page.eval('document.querySelectorAll("#vaOverlay").length'), 1);
  await page.eval("TravelAssistant.closeVoice()");

  await page.goto(BASE + '/');                                   // a refresh
  await openVoice(page);
  assert.match(await page.eval("document.getElementById('vaReply').innerText"), /hotels in Goa/i);
  assert.equal(await page.eval('window.__active()'), 0, 'refreshing does not start the microphone');
  await page.eval("history.back()");                             // and the browser's own back
  await new Promise(r => setTimeout(r, 600));
});

ui('18. if the screen cannot be opened the popup stays, says so, and offers a retry', async (page) => {
  await start(page, FLIGHT_ASK);
  await openVoice(page);
  await page.eval("window.__realActivate = window.activateTab; window.activateTab = () => { throw new Error('boom'); }");
  await speak(page, 'Flights from Delhi to Goa');
  await page.waitFor(() => /could not open/i.test(document.getElementById('vaReply').innerText), { label: 'the error' });
  assert.equal(await popupHidden(page), false);
  await page.eval("window.activateTab = window.__realActivate");
  await page.eval("document.querySelector('#vaResults .ta-rich-chip').click()");
  await waitClosed(page);
  assert.equal((await card(page)).from, 'DEL');
});
