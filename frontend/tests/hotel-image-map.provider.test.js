'use strict';
/* Resolver provider-tier tests for assets/js/hotel-image-map.js.
 *
 * There is no JS test runner in this project, so this is a self-contained Node
 * harness: it shims the few browser globals the resolver touches, loads the
 * file in a VM context, and asserts HotelPhoto.resolve() across the scenarios
 * in the brief. No network, no credentials, no DOM rendering.
 *
 *   run:  node frontend/tests/hotel-image-map.provider.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Minimal browser shims. document.body is null so the file's boot() — which
   would wire MutationObservers — is skipped; only resolve() is under test. */
const sandbox = {
  location: { pathname: '/hotels.html', search: '' },
  document: {
    readyState: 'complete',
    body: null,
    addEventListener() {},
    querySelectorAll() { return []; },
    documentElement: {},
  },
  MutationObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame() {},
  console,
};
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'hotel-image-map.js'), 'utf8'),
  sandbox, { filename: 'hotel-image-map.js' },
);
const HotelPhoto = sandbox.window.HotelPhoto;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok  ' + msg); }
  else { failures++; console.error('  FAIL ' + msg); }
}

const HOST = 'https://photos.hotelbeds.com/giata/';
const PROV = [
  { url: HOST + 'bigger/p.jpg',   thumb: HOST + 'p.jpg',   large: HOST + 'xl/p.jpg',   is_primary: true,  room_code: null,  source: 'hotelbeds' },
  { url: HOST + 'bigger/dlx.jpg', thumb: HOST + 'dlx.jpg', large: HOST + 'xl/dlx.jpg', is_primary: false, room_code: 'DLX', source: 'hotelbeds' },
];
const HB = extra => Object.assign({ name: 'Any Hotel', location: 'Gachibowli, Hyderabad', provider_images: PROV }, extra);

let r;

// A — source==='hotelbeds' + images -> provider image used
r = HotelPhoto.resolve(HB({ source: 'hotelbeds' }));
assert(r.kind === 'property' && r.provider === 'hotelbeds' && r.src === HOST + 'xl/p.jpg',
  "A: source='hotelbeds' uses the provider primary photo");

// B — hotelbeds_code (no source) + images -> provider image used
r = HotelPhoto.resolve(HB({ hotelbeds_code: 112 }));
assert(r.kind === 'property' && r.provider === 'hotelbeds',
  'B: a hotelbeds_code alone is a trusted identity');

// C — seed hotel carrying an images array -> provider NOT trusted
r = HotelPhoto.resolve({ name: 'Taj Palace', location: 'Banjara Hills, Hyderabad', source: 'seed', provider_images: PROV }, { allowDestination: false });
assert(r.kind === 'placeholder' && !r.provider,
  'C: a seed row never trusts an images array');

// D — provider identity but no images -> honest placeholder
r = HotelPhoto.resolve({ name: 'Unknown Inn', location: 'Nowhere City', source: 'hotelbeds', provider_images: [] }, { allowDestination: false });
assert(r.kind === 'placeholder', 'D: provider row with no images -> placeholder');

// E — a destination image exists, but a hotel surface must never show it
r = HotelPhoto.resolve({ name: 'Taj Palace', location: 'Banjara Hills, Hyderabad' }, { allowDestination: false });
assert(r.kind === 'placeholder' && r.kind !== 'destination',
  'E: a destination/landmark photo is never used as a hotel image');
r = HotelPhoto.resolve(HB({ source: 'hotelbeds' }), { allowDestination: true });
assert(r.kind === 'property',
  'E2: a provider property photo outranks the destination tier');

// F — room with a matching provider roomCode -> that room photo
r = HotelPhoto.resolve(HB({ source: 'hotelbeds' }), { roomCode: 'DLX' });
assert(r.src === HOST + 'xl/dlx.jpg' && r.roomCode === 'DLX',
  'F: a matching roomCode selects the room photo');

// G — room without a provider image -> hotel primary (never another room/property)
r = HotelPhoto.resolve(HB({ source: 'hotelbeds' }), { roomCode: 'NOPE' });
assert(r.src === HOST + 'xl/p.jpg',
  'G1: an unmatched roomCode falls back to the hotel primary photo');
r = HotelPhoto.resolve({ name: 'Taj Palace', location: 'Banjara Hills, Hyderabad', source: 'seed', provider_images: PROV }, { roomCode: 'DLX', allowDestination: false });
assert(r.kind === 'placeholder' && !r.provider,
  'G2: a seed room gets the hotel placeholder, not a provider photo');

// Regression — the curated verified tier still resolves when no provider identity
r = HotelPhoto.resolve({ name: 'Novotel Bengaluru', location: 'Outer Ring Road, Bengaluru' }, { allowDestination: false });
assert(r.kind === 'property' && r.slug === 'novotel-bengaluru',
  'curated verified property still resolves with no provider data');

if (failures) { console.error('\n' + failures + ' resolver test(s) FAILED'); process.exit(1); }
console.log('\nAll ' + 'resolver provider-tier tests passed');
