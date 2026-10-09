// The Travel Assistant's browser half — what it fetches and what it draws.
//
// Run:  node --test tests/js/
//
// Every API response here is MOCKED, in the exact shape the real endpoints
// return (checked against GET /api/customer/packages, /destinations and
// /destinations/{id}/{locations,attractions}; tests/verify_travel_assistant_routing.py
// section 3d asserts those shapes against a live server). Nothing touches a
// network, a browser or a database.
//
// TWO LAYERS
//   1. assistant-results.js — pure logic: the packages query, the relaxation and
//      style rules, places, the context store, the cache.
//   2. travel-assistant.js — loaded in a vm under a minimal fake DOM, to drive
//      presentInline() (what is drawn for each kind of answer, and for a failed
//      API call) and the action routing.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const JS = join(here, '..', '..', 'frontend', 'assets', 'js');
const R = createRequire(import.meta.url)(join(JS, 'assistant-results.js'));

/* ------------------------------------------------------------------ mocks */
const pkg = (o) => Object.assign({
  id: '1', name: 'Goa', destination: 'Goa', days: 4, nights: 3, priceFrom: '21900.00',
  price_next: null, next_departure: null, trip_type: 'domestic', category: 'holiday',
  blurb: 'North and South Goa beaches.', highlights: [], inclusions: ['3-night hotel stay'],
  departure_months: [],
}, o);

const GOA = [
  pkg({ id: '7', name: 'Goa', price_next: '30900.00', next_departure: '2026-10-10', departure_months: ['2026-10'] }),
  pkg({ id: '10', name: 'North Goa Heritage Tour', priceFrom: '22000.00', blurb: 'Forts and churches.' }),
  pkg({ id: '8', name: 'Goa Beach Escape', days: 5, priceFrom: '25000.00', blurb: 'Beach days.' }),
];
const ALL = GOA.concat([pkg({ id: '2', name: 'Bali', destination: 'Bali', days: 6, priceFrom: '61500.00' })]);
const DESTS = [{ id: 'goa', name: 'Goa', slug: 'goa', country: 'India', image: 'goa' },
               { id: 'bali', name: 'Bali', slug: 'bali', country: 'Indonesia', image: 'bali' }];
const ATTR = [{ id: 'goa__fort-aguada', destination_id: 'goa', name: 'Fort Aguada', slug: 'fort-aguada',
                description: '17th-century fort.', image: null, area_name: 'Candolim', hotel_count: 2 }];
const AREAS = [{ id: 'goa__panaji', destination_id: 'goa', name: 'Panaji', slug: 'panaji',
                 description: 'Riverside capital.', image: null, hotel_count: 0 }];

/** A fetch that answers from a routing table and counts every call. */
function mockApi(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const path = url.replace('/api/customer', '');
    for (const [match, body] of Object.entries(routes)) {
      if (path === match || (match.endsWith('*') && path.startsWith(match.slice(0, -1)))) {
        if (body instanceof Error) throw body;
        if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(path) : body) };
      }
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  return { fetch, calls };
}
const deps = (api) => ({ fetch: api.fetch, cache: new Map(), now: () => 1_000_000 });

/* ------------------------------------------------------- the packages query */
test('the packages query carries only parameters the API has', () => {
  assert.equal(R.packageQuery({}), '/packages');
  assert.equal(R.packageQuery({ dest: 'Goa' }), '/packages?destination=Goa');
  assert.equal(
    R.packageQuery({ dest: 'Goa', days: 5, month: '2026-12', pkgType: 'domestic' }),
    '/packages?destination=Goa&trip_type=domestic&min_days=5&max_days=5&month=2026-12');
  // Not API filters, so never sent: the style and the party size.
  assert.equal(R.packageQuery({ dest: 'Goa', preference: 'family', travellers: 4 }),
    '/packages?destination=Goa');
});

test('a length can be widened by a day either side, and never below one day', () => {
  assert.equal(R.packageQuery({ days: 3 }, 1), '/packages?min_days=2&max_days=4');
  assert.equal(R.packageQuery({ days: 1 }, 1), '/packages?min_days=1&max_days=2');
});

test('a destination with an ampersand or a space is encoded, not injected', () => {
  assert.equal(R.packageQuery({ dest: 'Goa & More' }), '/packages?destination=Goa+%26+More');
});

/* ------------------------------------------------------- searching packages */
test('real packages come back with the count, the summary and the page link', async () => {
  const api = mockApi({ '/packages?destination=Goa': GOA });
  const res = await R.searchPackages({ dest: 'Goa' }, deps(api));
  assert.equal(res.total, 3);
  assert.equal(res.empty, false);
  assert.equal(res.summary, 'Goa tour packages');
  assert.equal(res.href, 'packages.html?type=Goa');
  assert.deepEqual(res.notes, []);
  assert.equal(res.shown.length, 3);
});

test('no destination shows the whole shelf, capped, with the total honest', async () => {
  const many = Array.from({ length: 11 }, (_, i) => pkg({ id: String(i), name: 'P' + i }));
  const res = await R.searchPackages({}, deps(mockApi({ '/packages': many })));
  assert.equal(res.total, 11);
  assert.equal(res.shown.length, R.SHOWN);
});

test('a length nobody sells is widened by a day and says so', async () => {
  const api = mockApi({
    '/packages?destination=Goa&min_days=3&max_days=3': [],
    '/packages?destination=Goa&min_days=2&max_days=4': [GOA[0]],
  });
  const res = await R.searchPackages({ dest: 'Goa', days: 3 }, deps(api));
  assert.equal(res.total, 1);
  assert.match(res.notes[0], /No 3-day packages.*2–4 day/);
});

test('an exact length is not widened when it matches', async () => {
  const api = mockApi({ '/packages?destination=Goa&min_days=5&max_days=5': [GOA[2]] });
  const res = await R.searchPackages({ dest: 'Goa', days: 5 }, deps(api));
  assert.deepEqual(res.notes, []);
  assert.equal(api.calls.length, 1);
});

test('a style is matched against the packages’ own text, literally', async () => {
  const api = mockApi({ '/packages?destination=Goa': GOA });
  const res = await R.searchPackages({ dest: 'Goa', preference: 'beach' }, deps(api));
  // "beach" is literally in the first package's blurb ("…beaches.") and in the
  // third's name — and in nothing else. The heritage tour is correctly left out.
  assert.deepEqual(res.rows.map(r => r.name), ['Goa', 'Goa Beach Escape']);
  assert.match(res.notes[0], /mention “beach”/);
});

test('a style no package mentions is NOT claimed: all matches are shown, and it says so', async () => {
  // "None are described as family trips" is the honest answer. Showing three
  // packages under a "family" heading would be the invented fact.
  const api = mockApi({ '/packages?destination=Goa': GOA });
  const res = await R.searchPackages({ dest: 'Goa', preference: 'family' }, deps(api));
  assert.equal(res.total, 3);
  assert.match(res.notes[0], /None of our packages are described as family trips/);
});

test('matchesPreference reads name, blurb, destination, highlights and inclusions only', () => {
  assert.equal(R.matchesPreference(pkg({ highlights: ['Family-friendly resort'] }), 'family'), true);
  assert.equal(R.matchesPreference(pkg({ inclusions: ['Family transfer'] }), 'family'), true);
  assert.equal(R.matchesPreference(pkg({}), 'family'), false);
  assert.equal(R.matchesPreference(pkg({ name: 'Honeymoon Bali' }), 'honeymoon'), true);
  assert.equal(R.matchesPreference(pkg({ name: 'x' }), 'not-a-style'), false);
});

test('an empty result is a clear empty state with destinations that DO have packages', async () => {
  const api = mockApi({ '/packages?destination=Paris': [], '/packages': ALL });
  const res = await R.searchPackages({ dest: 'Paris' }, deps(api));
  assert.equal(res.empty, true);
  assert.equal(res.total, 0);
  assert.deepEqual(res.alternatives, ['Goa', 'Bali']);
  assert.equal(res.summary, 'Paris tour packages');
});

test('a month with no departures is empty, not silently dropped', async () => {
  const api = mockApi({ '/packages?destination=Goa&month=2026-12': [], '/packages': ALL });
  const res = await R.searchPackages({ dest: 'Goa', month: '2026-12' }, deps(api));
  assert.equal(res.empty, true);
  assert.match(res.summary, /departing December 2026/);
  assert.equal(res.alternatives.includes('Goa'), false);        // not offered back to itself
});

test('an API failure is thrown to the caller, not swallowed into an empty list', async () => {
  const down = mockApi({ '/packages*': new Error('network down') });
  await assert.rejects(R.searchPackages({ dest: 'Goa' }, deps(down)), /network down/);
  const broken = mockApi({ '/packages*': 500 });
  await assert.rejects(R.searchPackages({}, deps(broken)), (e) => e.status === 500);
});

test('failing to list alternatives does not break an otherwise correct empty state', async () => {
  const api = mockApi({ '/packages?destination=Paris': [], '/packages': new Error('boom') });
  const res = await R.searchPackages({ dest: 'Paris' }, deps(api));
  assert.equal(res.empty, true);
  assert.deepEqual(res.alternatives, []);
});

/* ------------------------------------------------------------------- caching */
test('an unchanged request is not fetched twice', async () => {
  const api = mockApi({ '/packages?destination=Goa': GOA });
  const d = deps(api);
  await R.searchPackages({ dest: 'Goa' }, d);
  await R.searchPackages({ dest: 'Goa' }, d);
  // …and a follow-up that only changes the style reuses the same API response.
  await R.searchPackages({ dest: 'Goa', preference: 'family' }, d);
  assert.equal(api.calls.length, 1);
});

test('a different request is fetched', async () => {
  const api = mockApi({ '/packages*': GOA });
  const d = deps(api);
  await R.searchPackages({ dest: 'Goa' }, d);
  await R.searchPackages({ dest: 'Bali' }, d);
  assert.equal(api.calls.length, 2);
});

test('the cache expires, because availability changes', async () => {
  const api = mockApi({ '/packages': GOA });
  let t = 0;
  const d = { fetch: api.fetch, cache: new Map(), now: () => t };
  await R.searchPackages({}, d);
  t = R.DATA_TTL_MS - 1;
  await R.searchPackages({}, d);
  assert.equal(api.calls.length, 1);
  t = R.DATA_TTL_MS + 1;
  await R.searchPackages({}, d);
  assert.equal(api.calls.length, 2);
});

test('a failed request is not cached, so a retry actually retries', async () => {
  let fail = true;
  const fetch = async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => GOA }; };
  const d = { fetch, cache: new Map(), now: () => 5 };
  await assert.rejects(R.searchPackages({}, d), /offline/);
  fail = false;
  assert.equal((await R.searchPackages({}, d)).total, 3);
});

/* ------------------------------------------------------------------- the card */
test('a package card mirrors the Tour Packages page: next-departure price, shelf price named', () => {
  const c = R.packageCard(GOA[0]);
  assert.equal(c.title, 'Goa');
  assert.equal(c.meta, '4 days · Goa');
  assert.equal(c.price, '₹30,900');
  assert.equal(c.otherDates, '₹21,900');
  assert.equal(c.departure, 'Next 10 Oct');
  assert.equal(c.href, 'package-details/7');
});

test('a package with no departure date says so rather than showing a blank', () => {
  const c = R.packageCard(GOA[1]);
  assert.equal(c.price, '₹22,000');
  assert.equal(c.otherDates, null);
  assert.equal(c.departure, 'Dates on request');
});

test('a package id is encoded in the link', () => {
  assert.equal(R.packageCard(pkg({ id: 'a/b' })).href, 'package-details/a%2Fb');
});

/* -------------------------------------------------------------------- places */
test('places come from the attractions list, and carry a page and a hotels-near link', async () => {
  const api = mockApi({ '/destinations/goa/attractions': ATTR, '/destinations/goa/locations': AREAS });
  const res = await R.searchPlaces('goa', 'attractions', deps(api));
  assert.equal(res.kind, 'attractions');
  assert.equal(res.fellBack, false);
  assert.equal(res.rows[0].name, 'Fort Aguada');
  assert.deepEqual(R.placeLinks('goa', res.rows[0], 'attractions'), {
    detail: 'destination/goa/fort-aguada', hotels: 'hotels/goa/fort-aguada' });
  assert.equal(api.calls.length, 1);                      // the second list is not fetched needlessly
});

test('"locations" asks for the areas, whose hotels go to the hotel search by area name', async () => {
  const api = mockApi({ '/destinations/goa/attractions': ATTR, '/destinations/goa/locations': AREAS });
  const res = await R.searchPlaces('goa', 'locations', deps(api));
  assert.equal(res.kind, 'locations');
  assert.deepEqual(R.placeLinks('goa', res.rows[0], 'locations'), { hotels: 'hotels.html?dest=Panaji' });
});

test('a destination with no areas falls back to its famous places, and says it did', async () => {
  const api = mockApi({ '/destinations/goa/locations': [], '/destinations/goa/attractions': ATTR });
  const res = await R.searchPlaces('goa', 'locations', deps(api));
  assert.equal(res.kind, 'attractions');
  assert.equal(res.fellBack, true);
});

test('a destination with NO locations at all is an empty state with alternatives, not an error', async () => {
  const api = mockApi({ '/destinations/goa/locations': [], '/destinations/goa/attractions': [],
                        '/destinations': DESTS });
  const res = await R.searchPlaces('goa', 'attractions', deps(api));
  assert.equal(res.empty, true);
  assert.equal(res.notFound, undefined);
  assert.deepEqual(res.alternatives, ['Goa', 'Bali']);
});

test('an unknown destination is a 404 and is reported as not found, which is a different answer', async () => {
  const api = mockApi({ '/destinations/atlantis/*': 404, '/destinations': DESTS });
  const res = await R.searchPlaces('atlantis', 'attractions', deps(api));
  assert.equal(res.notFound, true);
  assert.equal(res.empty, true);
  assert.ok(res.alternatives.length);
});

test('a server error is thrown, not mistaken for an empty destination', async () => {
  const api = mockApi({ '/destinations/goa/*': 503 });
  await assert.rejects(R.searchPlaces('goa', 'attractions', deps(api)), (e) => e.status === 503);
});

test('a slug is encoded in the request', async () => {
  const api = mockApi({ '/destinations/*': ATTR });
  await R.searchPlaces('a b/c', 'attractions', deps(api));
  assert.equal(api.calls[0], '/api/customer/destinations/a%20b%2Fc/attractions');
});

/* ---------------------------------------------------------------- wording */
test('the search in words', () => {
  assert.equal(R.describeSearch({}), 'tour packages');
  assert.equal(R.describeSearch({ dest: 'Goa', days: 5, preference: 'family', pkgType: 'domestic', month: '2026-10' }),
    'domestic 5-day family Goa tour packages departing October 2026');
});

test('the packages page link carries only what that page reads', () => {
  assert.equal(R.packagesPageHref({}), 'packages.html');
  assert.equal(R.packagesPageHref({ dest: 'Goa', month: '2026-10', days: 5, travellers: 4 }),
    'packages.html?type=Goa&month=2026-10');
});

test('prices and days are formatted the way the site formats them', () => {
  assert.equal(R.formatPrice(1234567), '₹12,34,567');
  assert.equal(R.formatDay('2026-10-10'), '10 Oct');
  assert.equal(R.monthLabel('2026-02'), 'February 2026');
  assert.equal(R.monthLabel('nonsense'), '');
});

/* ------------------------------------------------------------ context store */
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('a search is remembered, and forgotten after it has been idle too long', () => {
  const s = memoryStorage();
  R.saveContext(s, { service: 'package', destination: 'Goa' }, 1000);
  assert.deepEqual(R.loadContext(s, 1000 + R.CTX_TTL_MS - 1), { service: 'package', destination: 'Goa' });
  assert.equal(R.loadContext(s, 1000 + R.CTX_TTL_MS + 1), null);
  assert.equal(s.m.size, 0);                              // and the stale record is removed
});

test('saving null clears the context', () => {
  const s = memoryStorage();
  R.saveContext(s, { service: 'package' }, 1);
  R.saveContext(s, null, 2);
  assert.equal(R.loadContext(s, 3), null);
});

test('storage that throws (private mode) or holds garbage never breaks the assistant', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(R.loadContext(throwing, 1), null);
  assert.doesNotThrow(() => R.saveContext(throwing, { service: 'package' }, 1));
  const junk = memoryStorage();
  junk.setItem(R.CTX_KEY, '{not json');
  assert.equal(R.loadContext(junk, 1), null);
  junk.setItem(R.CTX_KEY, JSON.stringify({ ctx: null, at: 1 }));
  assert.equal(R.loadContext(junk, 1), null);
  assert.equal(R.loadContext(null, 1), null);
});

test('"start over" and its synonyms are understood, and ordinary sentences are not', () => {
  for (const s of ['start over', 'Start again.', 'new search', 'reset', 'clear it', 'forget that'])
    assert.equal(R.isStartOver(s), true, s);
  for (const s of ['start over in Goa', 'show me Goa packages', 'clear skies in Goa', ''])
    assert.equal(R.isStartOver(s), false, s);
});

test('inline actions are exactly the four drawn in the conversation', () => {
  for (const t of ['show_packages', 'show_places', 'show_destination', 'show_destinations'])
    assert.equal(R.isInlineAction(t), true, t);
  for (const t of ['search_flights', 'search_hotels', 'hotels_near', 'open_destination', 'none', undefined])
    assert.equal(R.isInlineAction(t), false, String(t));
});

/* ============================================================================
   travel-assistant.js, under a fake DOM
   ========================================================================= */
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.attrs = {};
    this.listeners = {}; this._text = ''; this.dataset = {}; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { (this.listeners.click || []).forEach(f => f()); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(' '); }
  set innerHTML(_v) { this._text = ''; this.children = []; }
  set href(v) { this.attrs.href = v; }
  get href() { return this.attrs.href; }
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
  querySelectorAll() { return []; }
  remove() {}
}

function loadAssistant(routes, globals) {
  const api = mockApi(routes);
  const store = memoryStorage();
  const win = {
    fetch: (u, o) => api.fetch(u, o), sessionStorage: store, addEventListener() {},
    matchMedia: () => ({ matches: false }), location: { href: 'http://x/', },
  };
  const doc = {
    readyState: 'complete', createElement: (t) => new El(t), getElementById: () => null,
    addEventListener() {}, body: new El('body'),
  };
  const ctx = vm.createContext({
    window: win, document: doc, navigator: { onLine: true }, sessionStorage: store,
    fetch: (u, o) => win.fetch(u, o), setTimeout, clearTimeout, console, URLSearchParams, Intl, Date, Map, Promise,
    AssistantResults: R, AbortController, ...(globals || {}),
  });
  const code = readFileSync(join(JS, 'travel-assistant.js'), 'utf8');
  const TravelAssistant = vm.runInContext(code + '\n;TravelAssistant', ctx);
  return { TravelAssistant, api, win, doc, store };
}

const say = (type, params) => ({ reply: 'ok', action: { type, params } });
/** Objects built inside the vm are from another realm; compare them by value. */
const plain = (o) => JSON.parse(JSON.stringify(o));
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const buttons = (el) => el.find(e => e.tagName === 'button').map(text);
const links = (el) => el.find(e => e.tagName === 'a').map(e => e.href);

test('travel-assistant.js: packages are drawn with real prices, per person, and a link to each', async () => {
  const { TravelAssistant } = loadAssistant({ '/packages?destination=Goa': GOA });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_packages', { dest: 'Goa' }), host);
  const out = text(host);
  assert.match(out, /3 packages — Goa tour packages/);
  assert.match(out, /₹30,900 per person/);
  assert.match(out, /from ₹21,900 on other dates/);
  assert.match(out, /Dates on request/);
  assert.deepEqual(links(host).slice(0, 2), ['package-details/7', 'package-details/10']);
  assert.ok(links(host).includes('packages.html?type=Goa'));
  assert.equal(host.getAttribute('aria-busy'), 'false');
});

test('travel-assistant.js: the party size is noted, not applied or priced', async () => {
  const { TravelAssistant } = loadAssistant({ '/packages?destination=Goa': GOA });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_packages', { dest: 'Goa', travellers: 4 }), host);
  assert.match(text(host), /Noted 4 travellers\. Prices are per person/);
  assert.doesNotMatch(text(host), /₹\s?(?:1,2|8[0-9],)/);               // no invented total
});

test('travel-assistant.js: no matching package is a clear empty state with a next step', async () => {
  const { TravelAssistant } = loadAssistant({ '/packages?destination=Paris': [], '/packages': ALL });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_packages', { dest: 'Paris' }), host);
  assert.match(text(host), /No matching packages/);
  assert.match(text(host), /We don’t have Paris tour packages on sale right now/);
  assert.deepEqual(buttons(host), ['Goa tour packages', 'Bali tour packages']);
  assert.ok(links(host).includes('packages.html'));
});

test('travel-assistant.js: an API failure is a message with a retry, never a thrown error', async () => {
  const { TravelAssistant } = loadAssistant({ '/packages*': new Error('offline') });
  const host = new El('div');
  await assert.doesNotReject(TravelAssistant.presentInline(say('show_packages', {}), host));
  assert.match(text(host), /could not load that just now/);
  assert.deepEqual(buttons(host), ['Try again']);
  assert.equal(host.getAttribute('aria-busy'), 'false');
});

test('travel-assistant.js: Try again actually retries and draws the result', async () => {
  let fail = true;
  // A flaky network: the same fetch fails, then recovers.
  const flaky = loadAssistant({});
  flaky.win.fetch = async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => GOA }; };
  const host = new El('div');
  await flaky.TravelAssistant.presentInline(say('show_packages', {}), host);
  assert.deepEqual(buttons(host), ['Try again']);
  fail = false;
  host.find(e => e.tagName === 'button')[0].click();
  await new Promise(r => setTimeout(r, 20));
  assert.match(text(host), /3 packages/);
});

test('travel-assistant.js: places are listed with a page link and a hotels-near link each', async () => {
  const { TravelAssistant } = loadAssistant({ '/destinations/goa/attractions': ATTR });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_places', { destination: 'goa', name: 'Goa', list: 'attractions' }), host);
  assert.match(text(host), /Famous places in Goa/);
  assert.match(text(host), /Fort Aguada/);
  assert.match(text(host), /Candolim · 2 hotels nearby/);
  assert.deepEqual(links(host), ['destination/goa/fort-aguada', 'hotels/goa/fort-aguada']);
  assert.deepEqual(buttons(host), []);
});

test('travel-assistant.js: areas link to the hotel search and say they fell back when they did', async () => {
  const { TravelAssistant } = loadAssistant({ '/destinations/goa/locations': [], '/destinations/goa/attractions': ATTR });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_places', { destination: 'goa', name: 'Goa', list: 'locations' }), host);
  assert.match(text(host), /Goa has no areas listed, so these are its famous places/);
  const areas = loadAssistant({ '/destinations/goa/locations': AREAS });
  const h2 = new El('div');
  await areas.TravelAssistant.presentInline(say('show_places', { destination: 'goa', name: 'Goa', list: 'locations' }), h2);
  assert.match(text(h2), /Areas in Goa/);
  assert.deepEqual(links(h2), ['hotels.html?dest=Panaji']);
});

test('travel-assistant.js: a destination with nothing listed offers hotels and packages instead', async () => {
  const { TravelAssistant } = loadAssistant({ '/destinations/goa/*': [], '/destinations': DESTS });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_places', { destination: 'goa', name: 'Goa', list: 'attractions' }), host);
  assert.match(text(host), /No places listed for Goa yet/);
  assert.deepEqual(buttons(host).slice(-2), ['Hotels in Goa', 'Goa tour packages']);
});

test('travel-assistant.js: an unknown destination is said, with places we do have', async () => {
  const { TravelAssistant } = loadAssistant({ '/destinations/atlantis/*': 404, '/destinations': DESTS });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_places', { destination: 'atlantis', name: 'Atlantis', list: 'attractions' }), host);
  assert.match(text(host), /We don’t have Atlantis listed/);
  assert.deepEqual(buttons(host), ['Places to visit in Goa', 'Places to visit in Bali']);
});

test('travel-assistant.js: a destination card links to its page and never parses a name as HTML', async () => {
  const { TravelAssistant } = loadAssistant({});
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_destination', { destination: 'goa', name: '<img src=x onerror=alert(1)>' }), host);
  assert.deepEqual(links(host), ['destination/goa']);
  // textContent only: the markup is text, and no element was created from it.
  assert.equal(host.find(e => e.tagName === 'img').length, 0);
  assert.match(text(host), /<img src=x onerror=alert\(1\)>/);
});

test('travel-assistant.js: package data is rendered as text, whatever it contains', async () => {
  const evil = pkg({ id: '9', name: '<script>alert(1)</script>', blurb: '<b>x</b>' });
  const { TravelAssistant } = loadAssistant({ '/packages': [evil] });
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_packages', {}), host);
  assert.equal(host.find(e => e.tagName === 'script').length, 0);
  assert.equal(host.find(e => e.tagName === 'strong').every(e => !e.children.length), true);
  assert.match(text(host), /<script>alert\(1\)<\/script>/);
});

test('travel-assistant.js: "show destinations" scrolls to the shelf, or goes to it from another page', async () => {
  const onLanding = loadAssistant({});
  let scrolled = null;
  onLanding.doc.getElementById = (id) => (id === 'destinations' ? { scrollIntoView: (o) => { scrolled = o; } } : null);
  await onLanding.TravelAssistant.presentInline(say('show_destinations', {}), new El('div'));
  assert.deepEqual(plain(scrolled), { behavior: 'smooth', block: 'start' });

  const elsewhere = loadAssistant({});
  await elsewhere.TravelAssistant.presentInline(say('show_destinations', {}), new El('div'));
  assert.equal(elsewhere.win.location.href, 'index.html#destinations');
});

test('travel-assistant.js: the shelf scroll respects reduced motion', async () => {
  const a = loadAssistant({});
  a.win.matchMedia = () => ({ matches: true });
  let opts = null;
  a.doc.getElementById = () => ({ scrollIntoView: (o) => { opts = o; } });
  await a.TravelAssistant.presentInline(say('show_destinations', {}), new El('div'));
  assert.equal(opts.behavior, 'auto');
});

test('travel-assistant.js: inline actions never navigate the page', () => {
  const { TravelAssistant, win } = loadAssistant({});
  for (const type of ['show_packages', 'show_places', 'show_destination', 'show_destinations']) {
    const done = TravelAssistant.runAction({ type, params: { dest: 'Goa', destination: 'goa' } }, {});
    assert.deepEqual(plain(done), { opened: false, note: null }, type);
  }
  assert.equal(win.location.href, 'http://x/');
});

test('travel-assistant.js: the older actions still navigate exactly as they did', () => {
  const { TravelAssistant, win } = loadAssistant({});
  TravelAssistant.runAction({ type: 'search_hotels', params: { dest: 'Goa' } }, {});
  assert.equal(win.location.href, 'hotels.html?dest=Goa');
  TravelAssistant.runAction({ type: 'search_packages', params: { dest: 'Goa' } }, {});
  assert.equal(win.location.href, 'packages.html?type=Goa');
  TravelAssistant.runAction({ type: 'hotels_near', params: { destination: 'hyderabad', attraction: 'charminar' } }, {});
  assert.equal(win.location.href, 'hotels/hyderabad/charminar');
  TravelAssistant.runAction({ type: 'open_destination', params: { destination: 'goa' } }, {});
  assert.equal(win.location.href, 'destination/goa');
});

test('travel-assistant.js: an unknown action opens nothing', () => {
  const { TravelAssistant } = loadAssistant({});
  assert.deepEqual(plain(TravelAssistant.runAction({ type: 'delete_everything', params: {} }, {})), { opened: false, note: null });
  assert.deepEqual(plain(TravelAssistant.handleAssistantIntent({ action: { type: 'none' } })), { opened: false, note: null });
});

/* ============================================================================
   Misspelt and ambiguous places — choices, the single-place card, the context
   ========================================================================= */
test('travel-assistant.js: a place is shown as itself, with its page and hotels-near links', async () => {
  const { TravelAssistant } = loadAssistant({});
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_place', { destination: 'hyderabad', destinationName: 'Hyderabad',
    kind: 'attraction', slug: 'charminar', name: 'Charminar' }), host);
  assert.match(text(host), /Charminar/);
  assert.match(text(host), /in Hyderabad/);
  assert.deepEqual(links(host), ['destination/hyderabad/charminar', 'hotels/hyderabad/charminar', 'destination/hyderabad']);
  assert.match(text(host), /View Charminar.*Hotels near Charminar.*Open the Hyderabad page/);
});

test('travel-assistant.js: an area goes to the hotel search by its name, and has no page of its own', async () => {
  const { TravelAssistant } = loadAssistant({});
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_place', { destination: 'hyderabad', destinationName: 'Hyderabad',
    kind: 'area', slug: 'banjara-hills', name: 'Banjara Hills' }), host);
  assert.deepEqual(links(host), ['hotels.html?dest=Banjara%20Hills', 'destination/hyderabad']);
  assert.match(text(host), /Hotels in Banjara Hills/);
  assert.doesNotMatch(text(host), /View Banjara Hills/);
});

test('travel-assistant.js: a place name is text, never markup', async () => {
  const { TravelAssistant } = loadAssistant({});
  const host = new El('div');
  await TravelAssistant.presentInline(say('show_place', { destination: 'x', destinationName: '<b>X</b>',
    kind: 'attraction', slug: 's', name: '<img src=x onerror=alert(1)>' }), host);
  assert.equal(host.find(e => e.tagName === 'img').length, 0);
});

test('travel-assistant.js: choices keep their own label; a plain suggestion is its own message', () => {
  const { TravelAssistant } = loadAssistant({});
  const { asChoice, choicesOf } = TravelAssistant;
  assert.deepEqual(plain(asChoice({ label: 'Charminar · Hyderabad', message: 'Show Charminar' })),
    { label: 'Charminar · Hyderabad', message: 'Show Charminar' });
  assert.deepEqual(plain(asChoice('Hotels in Goa')), { label: 'Hotels in Goa', message: 'Hotels in Goa' });
  // The server's choices win when it made any (a misspelt or ambiguous place)...
  assert.deepEqual(plain(choicesOf({ choices: [{ label: 'A', message: 'a' }], suggestions: ['x'] })),
    [{ label: 'A', message: 'a' }]);
  // ...and plain suggestions are the fallback, including for an older reply.
  assert.deepEqual(plain(choicesOf({ choices: [], suggestions: ['x'] })), ['x']);
  assert.deepEqual(plain(choicesOf({})), []);
  assert.deepEqual(plain(choicesOf(null)), []);
});

test('travel-assistant.js: the context a reply hands back is sent with the next message', async () => {
  const a = loadAssistant({});
  const bodies = [];
  const replies = [{ context: { service: 'package', destination: 'Goa' } }, { context: null }, {}];
  a.win.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => Object.assign(
      { session_id: 's1', reply: 'ok', intent: 'package', action: { type: 'none', params: {} }, suggestions: [] },
      replies.shift()) };
  };
  await a.TravelAssistant.send('Goa tour packages');
  await a.TravelAssistant.send('only family packages');
  await a.TravelAssistant.send('thanks');
  assert.equal('context' in bodies[0], false);                       // nothing to follow yet
  assert.deepEqual(plain(bodies[1].context), { service: 'package', destination: 'Goa' });
  assert.equal('context' in bodies[2], false);                       // the reply cleared it
  assert.equal(bodies[1].session_id, 's1');
});

test('travel-assistant.js: a failed request is survived, and the next one is sent (retry)', async () => {
  const a = loadAssistant({});
  let calls = 0;
  a.win.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ session_id: 's', reply: 'ok', intent: 'greeting',
      action: { type: 'none', params: {} }, suggestions: [] }) };
  };
  await assert.doesNotReject(a.TravelAssistant.send('Show Charminar'));
  await a.TravelAssistant.send('Show Charminar');                    // not blocked by the failure
  assert.equal(calls, 2);
});

test('travel-assistant.js: a server error does not leave the assistant stuck', async () => {
  const a = loadAssistant({});
  let n = 0;
  a.win.fetch = async () => { n += 1; return n === 1 ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ session_id: 's', reply: 'ok', intent: 'greeting', action: { type: 'none', params: {} } }) }; };
  await a.TravelAssistant.send('hello');
  await a.TravelAssistant.send('hello again');
  assert.equal(n, 2);
});

/* ============================================================================
   The typed Travel Assistant's own pieces: artwork, the shelf, two doors
   ========================================================================= */
const ART = {
  DESTINATION_IMAGE_FILES: { goa: 'bbc2f3b2', hyderabad: 'a90e4bc2' },
  DESTINATION_IMAGE_DIR: 'assets/destinations/',
};

test('artwork comes from the page manifests, with their ?v= stamps, and is null when none shipped', () => {
  const m = { destinations: { files: { goa: 'bbc2f3b2' }, dir: 'assets/destinations/' },
              locations: { files: { 'goa__fort-aguada': 'ab12' }, dir: 'assets/locations/' } };
  assert.deepEqual(R.resolveArt('goa', m), { src: 'assets/destinations/goa.webp?v=bbc2f3b2', small: 'assets/destinations/goa-480.webp?v=bbc2f3b2' });
  assert.equal(R.resolveArt('goa__fort-aguada', m).small, 'assets/locations/goa__fort-aguada-480.webp?v=ab12');
  assert.equal(R.resolveArt('atlantis', m), null, 'no artwork, no picture — and no stand-in');
  assert.equal(R.resolveArt(null, m), null);
  assert.equal(R.resolveArt('goa', null), null);
  assert.equal(R.resolveArt('goa', { destinations: { files: null } }), null);
});

test('each door keeps its own search, in its own storage slot', () => {
  const s = memoryStorage();
  R.saveContext(s, { service: 'package', destination: 'Goa' }, 1, 'assistant');
  R.saveContext(s, { service: 'package', destination: 'Bali' }, 1, 'voice');
  assert.equal(R.loadContext(s, 2, 'assistant').destination, 'Goa');
  assert.equal(R.loadContext(s, 2, 'voice').destination, 'Bali');
  assert.equal(R.loadContext(s, 2).destination, 'Goa', 'no door means the typed panel, as it always has');
  R.saveContext(s, null, 3, 'voice');
  assert.equal(R.loadContext(s, 4, 'voice'), null);
  assert.equal(R.loadContext(s, 4, 'assistant').destination, 'Goa', 'clearing one door leaves the other alone');
  assert.notEqual(R.ctxKey('voice'), R.ctxKey('assistant'));
});

test('the shelf is the destinations API, optionally one country, fetched once', async () => {
  const rows = [{ id: 'goa', name: 'Goa', country: 'India' }, { id: 'dubai', name: 'Dubai', country: 'United Arab Emirates' }];
  const api = mockApi({ '/destinations': rows });
  const d = deps(api);
  assert.deepEqual((await R.listDestinations(null, d)).map(r => r.name), ['Goa', 'Dubai']);
  assert.deepEqual((await R.listDestinations('India', d)).map(r => r.name), ['Goa']);
  assert.equal(api.calls.length, 1);
  await assert.rejects(R.listDestinations(null, deps(mockApi({ '/destinations': 500 }))), (e) => e.status === 500);
});

test('travel-assistant.js: the typed panel draws the shelf with artwork; tapping a card asks about it', async () => {
  const a = loadAssistant({ '/destinations': [{ id: 'goa', name: 'Goa', country: 'India', image: 'goa' },
                                              { id: 'atlantis', name: 'Atlantis', country: null, image: null }] }, ART);
  const host = new El('div');
  await a.TravelAssistant.presentInline(say('show_destinations', {}), host, { door: 'assistant' });
  assert.match(text(host), /Our destinations.*Goa.*India.*Atlantis/);
  const imgs = host.find(e => e.tagName === 'img');
  assert.equal(imgs.length, 1, 'a card with artwork has a picture; one without has none');
  assert.equal(imgs[0].attrs.src, 'assets/destinations/goa-480.webp?v=bbc2f3b2');
  const cards = host.find(e => e.tagName === 'button' && /ta-dest/.test(e.className));
  assert.equal(cards.length, 2);
  // tapping asks exactly as typing would: it goes to the assistant's endpoint
  const bodies = [];
  a.win.fetch = async (u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ session_id: 's', reply: 'ok', intent: 'fallback', action: { type: 'none' } }) }; };
  cards[0].click();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(bodies.map(b => b.message), ['Tell me about Goa']);
  assert.equal(bodies[0].kind, 'assistant');
});

test('travel-assistant.js: the voice popup does not get the typed panel\'s pictures or its shelf list', async () => {
  const v = loadAssistant({ '/destinations': [{ id: 'goa', name: 'Goa', image: 'goa' }], '/packages': [pkg({ image: 'goa' })] }, ART);
  let scrolled = false;
  v.doc.getElementById = () => ({ scrollIntoView: () => { scrolled = true; } });
  const shelf = new El('div');
  await v.TravelAssistant.presentInline(say('show_destinations', {}), shelf, { door: 'voice' });
  assert.equal(scrolled, true, 'the voice popup still scrolls to the page shelf');
  assert.equal(shelf.find(e => /ta-dest/.test(e.className || '')).length, 0);
  const packages = new El('div');
  await v.TravelAssistant.presentInline(say('show_packages', {}), packages, { door: 'voice' });
  assert.equal(packages.find(e => e.tagName === 'img').length, 0, 'no thumbnails in the voice popup');
  const typed = new El('div');
  await v.TravelAssistant.presentInline(say('show_packages', {}), typed, { door: 'assistant' });
  assert.equal(typed.find(e => e.tagName === 'img').length, 1, 'but the typed panel has them');
  assert.match(text(typed), /per person/);
});

test('travel-assistant.js: a package card with artwork is still a link to the package', async () => {
  const a = loadAssistant({ '/packages': [pkg({ id: '7', image: 'goa' })] }, ART);
  const host = new El('div');
  await a.TravelAssistant.presentInline(say('show_packages', {}), host, { door: 'assistant' });
  assert.deepEqual(links(host).slice(0, 1), ['package-details/7']);
  assert.match(host.find(e => e.tagName === 'a')[0].className, /ta-card has-art/);
});

test('travel-assistant.js: the two doors send their own context and never see each other\'s', async () => {
  const a = loadAssistant({});
  const bodies = [];
  const answers = [{ context: { service: 'package', destination: 'Goa' } }, { context: { service: 'package', destination: 'Bali' } }, {}];
  a.win.fetch = async (u, o) => { bodies.push(JSON.parse(o.body));
    return { ok: true, json: async () => Object.assign({ session_id: 's', reply: 'ok', intent: 'package', action: { type: 'none' } }, answers.shift()) }; };
  // The typed door's search is Goa; then the spoken door asks and gets Bali.
  await a.TravelAssistant.send('Goa tour packages', 'assistant');
  await a.TravelAssistant.send('Bali tour packages', 'voice');
  await a.TravelAssistant.send('only family packages', 'assistant');
  assert.equal('context' in bodies[0], false);
  assert.equal('context' in bodies[1], false, 'the spoken door did not start from the typed search');
  assert.equal(bodies[2].context.destination, 'Goa', 'the typed door continued its own search, not Bali');
  assert.deepEqual(bodies.map(b => b.kind), ['assistant', 'voice', 'assistant']);
});

test('travel-assistant.js: a request that never answers is given up on, said plainly, and does not wedge the panel', async () => {
  // Any timer over ten seconds (the 20s request timeout) fires almost at once.
  const quick = (fn, ms) => setTimeout(fn, ms > 10000 ? 5 : ms);
  const a = loadAssistant({}, { setTimeout: quick });
  // An abortable fetch that never resolves — a stalled connection.
  a.win.fetch = (u, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.doesNotReject(a.TravelAssistant.send('hello'));
  // The assistant is free again afterwards.
  let ok = 0;
  a.win.fetch = async () => { ok += 1; return { ok: true, json: async () => ({ session_id: 's', reply: 'ok', intent: 'greeting', action: { type: 'none' } }) }; };
  await a.TravelAssistant.send('hello again');
  assert.equal(ok, 1);
});
