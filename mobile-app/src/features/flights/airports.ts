/**
 * THE WEBSITE'S AIRPORT LIST.
 *
 * The table is `TABLE` in `frontend/assets/js/airports.js`: the airports the business
 * actually serves, with the city and country the site prints. Nothing is added, so the
 * picker never offers a route the site does not. `airportName` is the site's own
 * "proper name" for the airport where `travel-locations.js` has one, and empty where
 * the site has none (the site prints nothing there either).
 * `tests/features/flights.parity.test.ts` reads both files and fails if this drifts.
 */
export interface Airport {
  code: string;
  city: string;
  country: string;
  airportName: string;
}

export const AIRPORTS: readonly Airport[] = [
  { code: 'HYD', city: 'Hyderabad', country: 'India', airportName: 'Rajiv Gandhi International Airport' },
  { code: 'DEL', city: 'Delhi', country: 'India', airportName: 'Indira Gandhi International Airport' },
  { code: 'JAI', city: 'Jaipur', country: 'India', airportName: 'Jaipur International Airport' },
  { code: 'CJB', city: 'Coimbatore', country: 'India', airportName: '' },
  { code: 'AYJ', city: 'Ayodhya', country: 'India', airportName: '' },
  { code: 'CCU', city: 'Kolkata', country: 'India', airportName: 'Netaji Subhas Chandra Bose International Airport' },
  { code: 'NAG', city: 'Nagpur', country: 'India', airportName: '' },
  { code: 'TIR', city: 'Tirupati', country: 'India', airportName: '' },
  { code: 'TRV', city: 'Thiruvananthapuram', country: 'India', airportName: 'Trivandrum International Airport' },
  { code: 'IXU', city: 'Aurangabad', country: 'India', airportName: '' },
  { code: 'VGA', city: 'Vijayawada', country: 'India', airportName: '' },
  { code: 'STV', city: 'Surat', country: 'India', airportName: '' },
  { code: 'BLR', city: 'Bengaluru', country: 'India', airportName: 'Kempegowda International Airport' },
  { code: 'CMB', city: 'Colombo', country: 'Sri Lanka', airportName: 'Bandaranaike International Airport' },
  { code: 'JED', city: 'Jeddah', country: 'Saudi Arabia', airportName: 'King Abdulaziz International Airport' },
  { code: 'MED', city: 'Madinah', country: 'Saudi Arabia', airportName: '' },
  { code: 'BAH', city: 'Bahrain', country: 'Bahrain', airportName: 'Bahrain International Airport' },
  { code: 'BKK', city: 'Bangkok', country: 'Thailand', airportName: 'Suvarnabhumi Airport' },
];

/** Offered before anything is typed (`POPULAR` in airports.js). */
export const POPULAR_CODES = ['HYD', 'DEL', 'BLR', 'CCU', 'BKK', 'JED'] as const;

const BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]));

export function airportByCode(code: string | null | undefined): Airport | null {
  return code ? (BY_CODE.get(code.toUpperCase()) ?? null) : null;
}

/** "Hyderabad (HYD)", as the site's fields print it. */
export function airportLabel(code: string | null | undefined): string {
  const a = airportByCode(code);
  return a ? `${a.city} (${a.code})` : (code ?? '');
}

/** The line under the label: "HYD, Rajiv Gandhi International Airport", or just the country where the site has no name. */
export function airportSubLabel(code: string | null | undefined): string {
  const a = airportByCode(code);
  if (!a) return '';
  return a.airportName ? `${a.code}, ${a.airportName}` : `${a.code}, ${a.country}`;
}

/** Airports for a typed query: by code, city or country, best matches first. An empty query is the popular list. */
export function matchAirports(query: string, limit = 8): Airport[] {
  const q = query.trim().toLowerCase();
  if (!q) return POPULAR_CODES.map((c) => BY_CODE.get(c)!).slice(0, limit);
  const score = (a: Airport): number => {
    const code = a.code.toLowerCase();
    const city = a.city.toLowerCase();
    if (code === q) return 0;
    if (city.startsWith(q)) return 1;
    if (code.startsWith(q)) return 2;
    if (city.includes(q)) return 3;
    if (a.country.toLowerCase().includes(q) || a.airportName.toLowerCase().includes(q)) return 4;
    return 99;
  };
  return AIRPORTS.map((a) => ({ a, s: score(a) }))
    .filter((x) => x.s < 99)
    .sort((x, y) => x.s - y.s || x.a.city.localeCompare(y.a.city))
    .slice(0, limit)
    .map((x) => x.a);
}
