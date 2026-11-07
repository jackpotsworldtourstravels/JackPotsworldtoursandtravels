import { readFileSync } from 'fs';
import { resolve } from 'path';

import { AIRPORTS, POPULAR_CODES } from '@/features/flights/airports';
import { CABINS, FARES, MAX_LEGS, PAX, TRIP_TYPES } from '@/features/flights/flightForm';

/**
 * The flight search is the website's. These tests read the website's own files and fail if the app's airports,
 * options, limits or messages drift from them.
 */
const JS = resolve(__dirname, '../../../frontend/assets/js');
const airportsJs = readFileSync(resolve(JS, 'airports.js'), 'utf8');
const bookingCard = readFileSync(resolve(JS, 'booking-card.js'), 'utf8');
const paxSelector = readFileSync(resolve(JS, 'pax-selector.js'), 'utf8');
const travelLocations = readFileSync(resolve(JS, 'travel-locations.js'), 'utf8');

describe('airports match frontend/assets/js/airports.js', () => {
  const table = [...airportsJs.matchAll(/^\s*([A-Z]{3}):\s*\{\s*city:\s*'([^']+)',\s*country:\s*'([^']+)'/gm)].map((m) => ({ code: m[1], city: m[2], country: m[3] }));

  it('the same airports, with the same city and country, in the same order', () => {
    expect(table.length).toBe(18);
    expect(AIRPORTS.map(({ code, city, country }) => ({ code, city, country }))).toEqual(table);
  });

  it('the airport names are the site’s own where it has one, and empty where it has none', () => {
    for (const a of AIRPORTS) {
      const m = travelLocations.match(new RegExp(`code: '${a.code}', airport: '([^']+)'`));
      expect(a.airportName).toBe(m ? m[1] : '');
    }
  });

  it('the popular list is the site’s', () => {
    const popular = airportsJs.match(/const POPULAR = \[([^\]]+)\]/)![1].match(/[A-Z]{3}/g);
    expect([...POPULAR_CODES]).toEqual(popular);
  });
});

describe('the options and limits match frontend/assets/js/booking-card.js and pax-selector.js', () => {
  it('trip types', () => {
    for (const t of TRIP_TYPES) expect(bookingCard).toMatch(new RegExp(`id: '${t.id}',\\s+label: '${t.label}'`));
    expect(TRIP_TYPES).toHaveLength(3);
  });

  it('cabins', () => {
    expect(bookingCard).toContain(`const CABINS = [${CABINS.map((c) => `'${c}'`).join(', ')}]`);
  });

  it('special fares, with the site’s notes', () => {
    for (const f of FARES) {
      expect(bookingCard).toContain(`label: '${f.label}'`);
      expect(bookingCard).toContain(`note: '${f.note}'`);
    }
  });

  it('at most five flights in a multi-city trip', () => {
    expect(bookingCard).toContain(`const MAX_LEGS = ${MAX_LEGS};`);
  });

  it('passenger limits', () => {
    expect(paxSelector).toContain(`const MAX_SEATED   = ${PAX.MAX_SEATED};`);
    expect(paxSelector).toContain(`const MAX_ADULTS   = ${PAX.MAX_ADULTS};`);
    expect(paxSelector).toContain(`const MAX_CHILDREN = ${PAX.MAX_CHILDREN};`);
    expect(paxSelector).toContain(`const MAX_INFANTS  = ${PAX.MAX_INFANTS};`);
  });

  it('every validation message the app shows is one the website shows', () => {
    const messages = [
      'That combination of passengers is not allowed.',
      'Choose where you are flying from.',
      'Choose where you are flying to.',
      'Origin and destination cannot be the same.',
      'Choose a departure date.',
      'Choose a return date, or switch to One Way.',
      'The return date cannot be before departure.',
    ];
    for (const m of messages) expect(bookingCard).toContain(m);
    for (const piece of ['Choose where flight \' + n + \' departs from.', 'Choose where flight \' + n + \' arrives.', 'cannot start and end in the same city.', 'Choose a departure date for flight \' + n + \'.', 'cannot depart before flight']) {
      expect(bookingCard).toContain(piece);
    }
  });

  it('the website itself labels its flight list as a sample, which is why the app shows none', () => {
    const flightsHtml = readFileSync(resolve(__dirname, '../../../frontend/flights.html'), 'utf8');
    expect(flightsHtml).toContain('Sample schedule');
  });
});
