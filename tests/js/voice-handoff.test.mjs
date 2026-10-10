// The Voice Assistant's decisions, as pure logic — no browser, no microphone.
//
// Run:  node --test tests/js/
//
// WHAT THIS PINS (assistant-results.js):
//   voicePlan      what the popup does with a reply: ask / seed / inline / reveal / handoff
//   the log        what survives the popup closing, for how long, and for whom
//   ownership      one customer's conversation is never handed to another
//
// The browser half of the same behaviour (tabs, fields, scrolling, closing,
// the recogniser) is tests/js/browser/voice-handoff.ui.test.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const R = createRequire(import.meta.url)('../../frontend/assets/js/assistant-results.js');

/** A sessionStorage stand-in. */
function store() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}
const flight = (params, ctx) => ({ action: { type: 'search_flights', params }, context: ctx });

test('a flight with a route still being asked for is SEEDED: the popup stays', () => {
  const p = R.voicePlan(flight({ to: 'Goa', toCode: 'GOI' }, { service: 'flight', awaiting: 'origin' }));
  assert.equal(p.mode, 'seed');
  assert.equal(R.voicePlan(flight({ from: 'Delhi' }, { service: 'flight', awaiting: 'destination' })).mode, 'seed');
});

test('a complete route is handed off — even though the date is still to be chosen on the card', () => {
  for (const awaiting of ['date', undefined]) {
    const p = R.voicePlan(flight({ from: 'Delhi', to: 'Goa' }, { service: 'flight', awaiting }));
    assert.equal(p.mode, 'handoff');
  }
});

test('a question with no action stays open', () => {
  assert.equal(R.voicePlan({ action: { type: 'none', params: {} } }).mode, 'ask');
  assert.equal(R.voicePlan({}).mode, 'ask');
});

test('hotels, gaming, a named place and destination pages are handoffs', () => {
  for (const type of ['search_hotels', 'open_gaming', 'hotels_near', 'open_destination', 'search_packages']) {
    assert.equal(R.voicePlan({ action: { type, params: {} } }).mode, 'handoff', type);
  }
});

test('a plain package search goes to the Packages page with only what that page can take', () => {
  const p = R.voicePlan({ action: { type: 'show_packages', params: { dest: 'Bali' } } });
  assert.equal(p.mode, 'handoff');
  assert.equal(p.action.type, 'search_packages');
  assert.deepEqual(p.action.params, { dest: 'Bali', month: undefined });
  assert.equal(R.voicePlan({ action: { type: 'show_packages', params: { dest: 'Bali', month: '2026-12' } } }).action.params.month, '2026-12');
});

test('a package search with a style, a length or a trip type stays in the conversation', () => {
  for (const extra of [{ preference: 'family' }, { minDays: 3 }, { tripType: 'domestic' }]) {
    const p = R.voicePlan({ action: { type: 'show_packages', params: Object.assign({ dest: 'Bali' }, extra) } });
    assert.equal(p.mode, 'inline');
    assert.equal(p.action.type, 'show_packages');
  }
});

test('destinations are revealed on the page; places and one destination are drawn inline', () => {
  assert.equal(R.voicePlan({ action: { type: 'show_destinations', params: {} } }).mode, 'reveal');
  for (const type of ['show_places', 'show_place', 'show_destination']) {
    assert.equal(R.voicePlan({ action: { type, params: {} } }).mode, 'inline', type);
  }
});

// -------------------------------------------------------------------------- the log
test('exchanges are kept in order, capped, and clipped', () => {
  let items = [];
  for (let i = 0; i < 10; i++) items = R.addExchange(items, 'q' + i, 'a' + i);
  assert.equal(items.length, R.LOG_MAX);
  assert.deepEqual(items[items.length - 1], { heard: 'q9', reply: 'a9' });
  assert.equal(R.addExchange([], 'x'.repeat(2000), '')[0].heard.length, 300);
  assert.deepEqual(R.addExchange([], '', ''), [], 'nothing said, nothing kept');
});

test('the log round-trips for its owner and is gone after the time-out', () => {
  const s = store();
  const items = R.addExchange([], 'flights to goa', 'Where from?');
  R.saveLog(s, items, 1000, 'guest');
  assert.deepEqual(R.loadLog(s, 1000 + 60_000, 'guest'), items);
  assert.deepEqual(R.loadLog(s, 1000 + R.CTX_TTL_MS + 1, 'guest'), [], 'a cold conversation is not resumed');
  assert.equal(s.getItem(R.LOG_KEY), null, 'and it is forgotten');
});

test('a guest\'s conversation is handed to the account that signs in; a customer\'s is nobody else\'s', () => {
  const s = store();
  const items = R.addExchange([], 'hotels in goa', 'ok');
  R.saveLog(s, items, 1, 'guest');
  assert.deepEqual(R.loadLog(s, 2, 'u:7'), items, 'sign-in claims the guest conversation');
  R.saveLog(s, items, 1, 'u:7');
  assert.deepEqual(R.loadLog(s, 2, 'u:8'), [], 'another customer never sees u:7\'s');
  assert.equal(s.getItem(R.LOG_KEY), null);
  R.saveLog(s, items, 1, 'u:7');
  assert.deepEqual(R.loadLog(s, 2, 'guest'), [], 'a signed-out visitor does not see a customer\'s either');
});

test('a corrupt or hostile log is ignored, never thrown', () => {
  const s = store();
  s.setItem(R.LOG_KEY, '{not json');
  assert.deepEqual(R.loadLog(s, 1, 'guest'), []);
  s.setItem(R.LOG_KEY, JSON.stringify({ owner: 'guest', at: 1, items: [null, 5, { heard: 'a'.repeat(999), reply: { x: 1 } }] }));
  const out = R.loadLog(s, 2, 'guest');
  assert.equal(out.length, 1, "entries that are not objects are dropped");
  assert.equal(out[0].heard.length, 300);
  assert.equal(typeof out[0].reply, "string");
  assert.deepEqual(R.loadLog(null, 1, 'guest'), [], 'no storage at all is fine');
});

test('the log holds words only: a token handed in with the text is not a field of it', () => {
  const s = store();
  R.saveLog(s, R.addExchange([], 'hi', 'hello'), 1, 'u:1');
  const raw = s.getItem(R.LOG_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['at', 'items', 'owner']);
  assert.deepEqual(Object.keys(JSON.parse(raw).items[0]).sort(), ['heard', 'reply']);
});

// -------------------------------------------------------------------------- ownership
test('ownerOf names a customer by id, never by token; everyone else is "guest"', () => {
  assert.equal(R.ownerOf({ userId: '42', access: 'secret-token' }), 'u:42');
  assert.ok(!R.ownerOf({ userId: '42', access: 'secret-token' }).includes('secret'));
  assert.equal(R.ownerOf(null), 'guest');
  assert.equal(R.ownerOf({ userId: null }), 'guest');
});

test('ownerChanged: a replaced customer resets; a guest signing in does not', () => {
  const s = store();
  assert.equal(R.ownerChanged(s, 'guest'), false, 'first sight');
  assert.equal(R.ownerChanged(s, 'u:1'), false, 'guest signs in: claimed, kept');
  assert.equal(R.ownerChanged(s, 'u:1'), false, 'same customer');
  assert.equal(R.ownerChanged(s, 'u:2'), true, 'a different customer');
  assert.equal(R.ownerChanged(s, 'guest'), true, 'signed out');
  assert.equal(R.ownerChanged(s, 'guest'), false);
  assert.equal(R.ownerChanged(null, 'guest'), false, 'no storage');
});
