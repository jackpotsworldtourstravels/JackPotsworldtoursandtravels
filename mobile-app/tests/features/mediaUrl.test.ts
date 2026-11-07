import { env } from '@/config/env';
import {
  attractionPhotoUrl,
  curatedPhotoUrl,
  destinationPhotoUrl,
  heroPhotoUrl,
  isSafeKey,
  packagePhotoUrl,
  siteAssetUrl,
} from '@/features/media/mediaUrl';

const base = env.apiBaseUrl;

describe('isSafeKey', () => {
  it.each(['goa', 'taj-palace', 'hyderabad__charminar', 'bali__sacred-monkey-forest-sanctuary', 'novotel_2'])('accepts %s', (key) => {
    expect(isSafeKey(key)).toBe(true);
  });

  it.each([
    '../../etc/passwd',
    'goa/../x',
    'goa.webp',
    'Goa',
    'a b',
    '',
    '__goa',
    'goa__',
    'a__b__c',
    'goa?x=1',
    'goa#frag',
    'x'.repeat(121),
  ])('refuses %p, so a hostile key can never become part of a URL', (key) => {
    expect(isSafeKey(key)).toBe(false);
  });

  it('refuses non-strings', () => {
    expect(isSafeKey(null)).toBe(false);
    expect(isSafeKey(undefined)).toBe(false);
  });
});

describe('photo URLs', () => {
  it('serves a destination photo from the site, at card and hero sizes', () => {
    expect(destinationPhotoUrl('goa')).toBe(`${base}/assets/destinations/goa-480.webp`);
    expect(destinationPhotoUrl('goa', 'hero')).toBe(`${base}/assets/destinations/goa.webp`);
  });

  it('serves a place photo by attraction id', () => {
    expect(attractionPhotoUrl('hyderabad__charminar')).toBe(`${base}/assets/locations/hyderabad__charminar-480.webp`);
  });

  it('keeps destination keys and attraction ids in their own folders', () => {
    expect(destinationPhotoUrl('hyderabad__charminar')).toBeNull();
    expect(attractionPhotoUrl('goa')).toBeNull();
  });

  it('routes a package photo by the shape of its key', () => {
    expect(packagePhotoUrl('kashmir')).toBe(`${base}/assets/destinations/kashmir-480.webp`);
    expect(packagePhotoUrl('goa__fort-aguada')).toBe(`${base}/assets/locations/goa__fort-aguada-480.webp`);
  });

  it('returns null, not a broken URL, for a missing or unsafe key', () => {
    expect(packagePhotoUrl(null)).toBeNull();
    expect(packagePhotoUrl('../x')).toBeNull();
    expect(destinationPhotoUrl(undefined)).toBeNull();
  });

  it('builds curated hotel and city file URLs', () => {
    expect(curatedPhotoUrl('hotels', 'novotel-bengaluru', 'card')).toBe(`${base}/assets/hotels/novotel-bengaluru-480.webp`);
    expect(curatedPhotoUrl('locations', 'singapore__merlion-park', 'hero')).toBe(`${base}/assets/locations/singapore__merlion-park.webp`);
  });

  it('joins a site path without doubling slashes', () => {
    expect(siteAssetUrl('/assets/x.webp')).toBe(`${base}/assets/x.webp`);
    expect(heroPhotoUrl()).toBe(`${base}/assets/images/hero-dubai-960.webp`);
  });
});
