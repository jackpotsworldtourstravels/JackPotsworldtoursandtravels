import { CITY_PHOTOS, VERIFIED_PROPERTIES, cityKey, norm, resolveHotelPhoto } from '@/features/media/hotelPhoto';

import { hotelList } from '../fixtures/discovery';

/**
 * The website's rule is "never show an image of a different hotel as though it
 * represented the requested hotel". These tests pin the cases that matter, using
 * the real hotels production lists today.
 */
describe('resolveHotelPhoto', () => {
  const byName = (name: string) => hotelList.find((h) => h.name === name)!;

  it('shows Novotel Bengaluru on Outer Ring Road its own verified photograph', () => {
    const photo = resolveHotelPhoto(byName('Novotel Bengaluru'));
    expect(photo.kind).toBe('property');
    expect(photo.uri).toMatch(/\/assets\/hotels\/novotel-bengaluru-480\.webp$/);
    expect(photo.note).toBe('');
  });

  it('does NOT give the Hyderabad "Taj Palace" the Taj Mahal Palace Mumbai photo, whatever the API image key says', () => {
    const taj = byName('Taj Palace');
    expect(taj.image).toBe('taj-palace'); // the seed key that used to cause the mix-up
    const photo = resolveHotelPhoto(taj);
    expect(photo.kind).toBe('destination');
    expect(photo.uri).toMatch(/\/assets\/destinations\/hyderabad-480\.webp$/);
    expect(photo.uri).not.toMatch(/taj-palace/);
    expect(photo.note).toMatch(/not this hotel/i);
    expect(photo.alt).toMatch(/not of Taj Palace/);
  });

  it('does not give Novotel Hyderabad (HITEC City) the airport Novotel photo', () => {
    const photo = resolveHotelPhoto(byName('Novotel Hyderabad'));
    expect(photo.kind).toBe('destination');
    expect(photo.uri).not.toMatch(/novotel/);
  });

  it('does give the Novotel at the airport its photo, because the area proves it', () => {
    const photo = resolveHotelPhoto({ name: 'Novotel Hyderabad Airport', location: 'Shamshabad, Hyderabad' });
    expect(photo.kind).toBe('property');
    expect(photo.uri).toMatch(/novotel-hyderabad/);
  });

  it('never lets a chain name stand in for a property', () => {
    for (const name of ['Hyatt Regency', 'Radisson', 'Marriott']) {
      const photo = resolveHotelPhoto(byName(name));
      expect(photo.kind).toBe('destination');
      expect(photo.uri).not.toMatch(/hyatt|radisson|marriott/);
    }
  });

  it('matches a one-of-a-kind building by name alone', () => {
    const photo = resolveHotelPhoto({ name: 'Marina Bay Sands', location: 'Singapore' });
    expect(photo.kind).toBe('property');
    expect(photo.uri).toMatch(/marina-bay-sands/);
  });

  it('is honest when it has nothing: a placeholder, never a guess', () => {
    const photo = resolveHotelPhoto({ name: 'Seaside Inn', location: 'Nowheresville, Atlantis' });
    expect(photo).toMatchObject({ kind: 'placeholder', uri: null });
    expect(photo.alt).toMatch(/No verified photograph of Seaside Inn/);
  });

  it('can be told not to fall back to a destination photo', () => {
    const photo = resolveHotelPhoto(byName('Taj Palace'), { allowDestination: false });
    expect(photo.kind).toBe('placeholder');
  });

  it('uses the larger file for hero size', () => {
    expect(resolveHotelPhoto(byName('Novotel Bengaluru'), { size: 'hero' }).uri).toMatch(/novotel-bengaluru\.webp$/);
  });

  describe('provider photographs', () => {
    const provider = { url: 'https://photos.example.com/a.jpg', thumb: 'https://photos.example.com/a-t.jpg', large: 'https://photos.example.com/a-l.jpg', is_primary: true };

    it('are trusted when the row carries a real supplier identity', () => {
      const photo = resolveHotelPhoto({ name: 'Any Hotel', location: 'Dubai', source: 'hotelbeds', hotelbeds_code: 4521, provider_images: [provider] });
      expect(photo).toMatchObject({ kind: 'property', uri: provider.large });
    });

    it('are ignored on a seed row, so a seed row can’t borrow supplier imagery', () => {
      const photo = resolveHotelPhoto({ name: 'Any Hotel', location: 'Dubai', source: 'seed', hotelbeds_code: null, provider_images: [provider] });
      expect(photo.kind).not.toBe('property');
    });

    it('are ignored unless served over https', () => {
      const insecure = { ...provider, url: 'http://x/a.jpg', large: 'http://x/l.jpg' };
      const photo = resolveHotelPhoto({ name: 'Any Hotel', location: 'Dubai', source: 'hotelbeds', provider_images: [insecure] });
      expect(photo.kind).not.toBe('property');
    });

    it('prefer the primary image', () => {
      const other = { ...provider, is_primary: false, large: 'https://photos.example.com/other.jpg' };
      const photo = resolveHotelPhoto({ name: 'H', location: 'Dubai', source: 'hotelbeds', provider_images: [other, provider] });
      expect(photo.uri).toBe(provider.large);
    });
  });
});

describe('matching helpers', () => {
  it('normalises accents, case and punctuation', () => {
    expect(norm('  Humāyun’s   Tomb! ')).toBe('humayuns tomb');
    expect(norm('Café & Bar')).toBe('cafe and bar');
  });

  it('finds the city inside a longer address', () => {
    expect(cityKey('HITEC City, Hyderabad, Telangana')).toBe('hyderabad');
    expect(cityKey('Bangalore')).toBe('bengaluru');
    expect(cityKey('')).toBe('');
  });

  it('every city photo file is a safe slug', () => {
    for (const [city, photo] of Object.entries(CITY_PHOTOS)) {
      expect(photo.file).toMatch(/^[a-z0-9_-]+$/);
      expect(['destinations', 'locations']).toContain(photo.dir);
      expect(city).toMatch(/^[a-z ]+$/);
    }
    for (const p of VERIFIED_PROPERTIES) expect(p.slug).toMatch(/^[a-z0-9-]+$/);
  });
});
