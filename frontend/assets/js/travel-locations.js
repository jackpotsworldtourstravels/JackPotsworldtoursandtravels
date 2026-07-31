'use strict';
/* Travel location reference data + ranked matching for the smart search fields.
   ---------------------------------------------------------------------------
   This is deliberately a STATIC FRONTEND dataset, not a new endpoint. The v2 API
   has no airport/city reference table — inventory carries only an IATA code in
   `travel_details.origin` and a display name in `origin_city`, which is enough to
   filter but not enough to offer "Hyderabad, India (HYD) — Rajiv Gandhi
   International" style suggestions, or to tell Hyderabad/India from
   Hyderabad/Pakistan. Adding a lookup table would mean a backend change, which
   this pass explicitly excludes, so the reference data lives here in the UI layer.

   Every code the seeded catalog actually sells is included, plus the major hubs a
   merchant is likely to type and the ambiguous-name cases (two Hyderabads, two
   Parises) that the disambiguation lines exist for. Extend the array freely —
   nothing below is generated or ordered by hand. */

const TRAVEL_LOCATIONS = [
  // ---- India (every domestic code in the seeded catalog, plus the majors) ----
  { city: 'New Delhi', region: 'Delhi', country: 'India', code: 'DEL', airport: 'Indira Gandhi International Airport', aliases: ['delhi', 'ncr'] },
  { city: 'Mumbai', region: 'Maharashtra', country: 'India', code: 'BOM', airport: 'Chhatrapati Shivaji Maharaj International Airport', aliases: ['bombay'] },
  { city: 'Bengaluru', region: 'Karnataka', country: 'India', code: 'BLR', airport: 'Kempegowda International Airport', aliases: ['bangalore'] },
  { city: 'Hyderabad', region: 'Telangana', country: 'India', code: 'HYD', airport: 'Rajiv Gandhi International Airport' },
  { city: 'Chennai', region: 'Tamil Nadu', country: 'India', code: 'MAA', airport: 'Chennai International Airport', aliases: ['madras'] },
  { city: 'Kolkata', region: 'West Bengal', country: 'India', code: 'CCU', airport: 'Netaji Subhas Chandra Bose International Airport', aliases: ['calcutta'] },
  { city: 'Kochi', region: 'Kerala', country: 'India', code: 'COK', airport: 'Cochin International Airport', aliases: ['cochin'] },
  { city: 'Goa', region: 'Goa', country: 'India', code: 'GOI', airport: 'Manohar International Airport', aliases: ['dabolim', 'panaji'] },
  { city: 'Ahmedabad', region: 'Gujarat', country: 'India', code: 'AMD', airport: 'Sardar Vallabhbhai Patel International Airport' },
  { city: 'Pune', region: 'Maharashtra', country: 'India', code: 'PNQ', airport: 'Pune Airport' },
  { city: 'Jaipur', region: 'Rajasthan', country: 'India', code: 'JAI', airport: 'Jaipur International Airport' },
  { city: 'Lucknow', region: 'Uttar Pradesh', country: 'India', code: 'LKO', airport: 'Chaudhary Charan Singh International Airport' },
  { city: 'Thiruvananthapuram', region: 'Kerala', country: 'India', code: 'TRV', airport: 'Trivandrum International Airport', aliases: ['trivandrum'] },
  { city: 'Srinagar', region: 'Jammu & Kashmir', country: 'India', code: 'SXR', airport: 'Sheikh ul-Alam International Airport' },
  { city: 'Varanasi', region: 'Uttar Pradesh', country: 'India', code: 'VNS', airport: 'Lal Bahadur Shastri International Airport', aliases: ['banaras', 'kashi'] },
  { city: 'Guwahati', region: 'Assam', country: 'India', code: 'GAU', airport: 'Lokpriya Gopinath Bordoloi International Airport' },
  { city: 'Port Blair', region: 'Andaman & Nicobar', country: 'India', code: 'IXZ', airport: 'Veer Savarkar International Airport', aliases: ['andaman'] },

  // ---- Ambiguous names: same city, different country/state ----
  { city: 'Hyderabad', region: 'Sindh', country: 'Pakistan', code: 'HDD', airport: 'Hyderabad Airport' },
  { city: 'Paris', region: 'Île-de-France', country: 'France', code: 'CDG', airport: 'Charles de Gaulle Airport' },
  { city: 'Paris', region: 'Texas', country: 'United States', code: 'PRX', airport: 'Cox Field' },
  { city: 'London', region: 'England', country: 'United Kingdom', code: 'LHR', airport: 'Heathrow Airport' },
  { city: 'London', region: 'Ontario', country: 'Canada', code: 'YXU', airport: 'London International Airport' },
  { city: 'Birmingham', region: 'England', country: 'United Kingdom', code: 'BHX', airport: 'Birmingham Airport' },
  { city: 'Birmingham', region: 'Alabama', country: 'United States', code: 'BHM', airport: 'Birmingham-Shuttlesworth International Airport' },

  // ---- Middle East ----
  { city: 'Dubai', region: 'Dubai', country: 'United Arab Emirates', code: 'DXB', airport: 'Dubai International Airport' },
  { city: 'Abu Dhabi', region: 'Abu Dhabi', country: 'United Arab Emirates', code: 'AUH', airport: 'Zayed International Airport' },
  { city: 'Doha', region: 'Doha', country: 'Qatar', code: 'DOH', airport: 'Hamad International Airport' },
  { city: 'Muscat', region: 'Muscat', country: 'Oman', code: 'MCT', airport: 'Muscat International Airport' },
  { city: 'Riyadh', region: 'Riyadh', country: 'Saudi Arabia', code: 'RUH', airport: 'King Khalid International Airport' },
  { city: 'Jeddah', region: 'Makkah', country: 'Saudi Arabia', code: 'JED', airport: 'King Abdulaziz International Airport' },
  { city: 'Kuwait City', region: 'Kuwait', country: 'Kuwait', code: 'KWI', airport: 'Kuwait International Airport' },
  { city: 'Manama', region: 'Capital', country: 'Bahrain', code: 'BAH', airport: 'Bahrain International Airport' },

  // ---- South & Southeast Asia ----
  { city: 'Singapore', region: 'Singapore', country: 'Singapore', code: 'SIN', airport: 'Changi Airport' },
  { city: 'Bangkok', region: 'Bangkok', country: 'Thailand', code: 'BKK', airport: 'Suvarnabhumi Airport' },
  { city: 'Phuket', region: 'Phuket', country: 'Thailand', code: 'HKT', airport: 'Phuket International Airport' },
  { city: 'Kuala Lumpur', region: 'Selangor', country: 'Malaysia', code: 'KUL', airport: 'Kuala Lumpur International Airport' },
  { city: 'Denpasar', region: 'Bali', country: 'Indonesia', code: 'DPS', airport: 'Ngurah Rai International Airport', aliases: ['bali'] },
  { city: 'Jakarta', region: 'Jakarta', country: 'Indonesia', code: 'CGK', airport: 'Soekarno-Hatta International Airport' },
  { city: 'Ho Chi Minh City', region: 'Ho Chi Minh', country: 'Vietnam', code: 'SGN', airport: 'Tan Son Nhat International Airport', aliases: ['saigon'] },
  { city: 'Hanoi', region: 'Hanoi', country: 'Vietnam', code: 'HAN', airport: 'Noi Bai International Airport' },
  { city: 'Male', region: 'Kaafu', country: 'Maldives', code: 'MLE', airport: 'Velana International Airport', aliases: ['maldives'] },
  { city: 'Colombo', region: 'Western', country: 'Sri Lanka', code: 'CMB', airport: 'Bandaranaike International Airport' },
  { city: 'Kathmandu', region: 'Bagmati', country: 'Nepal', code: 'KTM', airport: 'Tribhuvan International Airport' },
  { city: 'Dhaka', region: 'Dhaka', country: 'Bangladesh', code: 'DAC', airport: 'Hazrat Shahjalal International Airport' },
  { city: 'Karachi', region: 'Sindh', country: 'Pakistan', code: 'KHI', airport: 'Jinnah International Airport' },

  // ---- East Asia ----
  { city: 'Hong Kong', region: 'Hong Kong', country: 'China', code: 'HKG', airport: 'Hong Kong International Airport' },
  { city: 'Tokyo', region: 'Tokyo', country: 'Japan', code: 'HND', airport: 'Haneda Airport' },
  { city: 'Tokyo', region: 'Chiba', country: 'Japan', code: 'NRT', airport: 'Narita International Airport' },
  { city: 'Seoul', region: 'Incheon', country: 'South Korea', code: 'ICN', airport: 'Incheon International Airport' },
  { city: 'Shanghai', region: 'Shanghai', country: 'China', code: 'PVG', airport: 'Pudong International Airport' },
  { city: 'Beijing', region: 'Beijing', country: 'China', code: 'PEK', airport: 'Capital International Airport' },

  // ---- Europe ----
  { city: 'Frankfurt', region: 'Hesse', country: 'Germany', code: 'FRA', airport: 'Frankfurt Airport' },
  { city: 'Munich', region: 'Bavaria', country: 'Germany', code: 'MUC', airport: 'Munich Airport' },
  { city: 'Amsterdam', region: 'North Holland', country: 'Netherlands', code: 'AMS', airport: 'Schiphol Airport' },
  { city: 'Zurich', region: 'Zurich', country: 'Switzerland', code: 'ZRH', airport: 'Zurich Airport' },
  { city: 'Rome', region: 'Lazio', country: 'Italy', code: 'FCO', airport: 'Leonardo da Vinci-Fiumicino Airport' },
  { city: 'Milan', region: 'Lombardy', country: 'Italy', code: 'MXP', airport: 'Malpensa Airport' },
  { city: 'Madrid', region: 'Madrid', country: 'Spain', code: 'MAD', airport: 'Adolfo Suárez Madrid-Barajas Airport' },
  { city: 'Barcelona', region: 'Catalonia', country: 'Spain', code: 'BCN', airport: 'Josep Tarradellas Barcelona-El Prat Airport' },
  { city: 'Istanbul', region: 'Istanbul', country: 'Turkey', code: 'IST', airport: 'Istanbul Airport' },
  { city: 'Vienna', region: 'Vienna', country: 'Austria', code: 'VIE', airport: 'Vienna International Airport' },
  { city: 'Lisbon', region: 'Lisbon', country: 'Portugal', code: 'LIS', airport: 'Humberto Delgado Airport' },

  // ---- Americas ----
  { city: 'New York', region: 'New York', country: 'United States', code: 'JFK', airport: 'John F. Kennedy International Airport', aliases: ['nyc'] },
  { city: 'Newark', region: 'New Jersey', country: 'United States', code: 'EWR', airport: 'Newark Liberty International Airport' },
  { city: 'Los Angeles', region: 'California', country: 'United States', code: 'LAX', airport: 'Los Angeles International Airport' },
  { city: 'San Francisco', region: 'California', country: 'United States', code: 'SFO', airport: 'San Francisco International Airport' },
  { city: 'Chicago', region: 'Illinois', country: 'United States', code: 'ORD', airport: "O'Hare International Airport" },
  { city: 'Toronto', region: 'Ontario', country: 'Canada', code: 'YYZ', airport: 'Pearson International Airport' },
  { city: 'Vancouver', region: 'British Columbia', country: 'Canada', code: 'YVR', airport: 'Vancouver International Airport' },

  // ---- Africa & Oceania ----
  { city: 'Nairobi', region: 'Nairobi', country: 'Kenya', code: 'NBO', airport: 'Jomo Kenyatta International Airport' },
  { city: 'Cairo', region: 'Cairo', country: 'Egypt', code: 'CAI', airport: 'Cairo International Airport' },
  { city: 'Johannesburg', region: 'Gauteng', country: 'South Africa', code: 'JNB', airport: 'O. R. Tambo International Airport' },
  { city: 'Mauritius', region: 'Plaine Magnien', country: 'Mauritius', code: 'MRU', airport: 'Sir Seewoosagur Ramgoolam International Airport' },
  { city: 'Sydney', region: 'New South Wales', country: 'Australia', code: 'SYD', airport: 'Kingsford Smith Airport' },
  { city: 'Melbourne', region: 'Victoria', country: 'Australia', code: 'MEL', airport: 'Melbourne Airport' },
  { city: 'Auckland', region: 'Auckland', country: 'New Zealand', code: 'AKL', airport: 'Auckland Airport' },
];

/* Cities whose name appears more than once in the dataset. Those get their
   region shown ("Paris, Texas") so two identically-named rows are never
   ambiguous; unique cities stay short ("Bengaluru, India"). Computed once. */
const TRAVEL_LOCATION_DUPES = (() => {
  const seen = new Map();
  TRAVEL_LOCATIONS.forEach(l => {
    const k = l.city.toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
  });
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
})();

/* "Hyderabad, India" vs "Paris, Texas, United States" — region only where needed. */
function travelLocationLabel(loc) {
  return TRAVEL_LOCATION_DUPES.has(loc.city.toLowerCase()) && loc.region
    ? `${loc.city}, ${loc.region}, ${loc.country}`
    : `${loc.city}, ${loc.country}`;
}

/* What goes into the input once a row is chosen, and what the search actually
   filters on. The IATA code is the precise, unambiguous token and the catalog
   stores it in `travel_details.origin`, so selecting a row searches by code —
   that is why picking "Hyderabad, Pakistan" cannot silently return Indian
   inventory the way a bare "Hyderabad" string would. */
function travelLocationSearchToken(loc) { return loc.code; }
function travelLocationInputValue(loc) { return `${loc.city} (${loc.code})`; }

/* Ranked match, tightest first, exactly as specified:
   0 exact city / exact code, 1 city prefix, 2 code or alias prefix,
   3 city partial, 4 airport-name or country match.
   Ties inside a tier keep dataset order, which puts the seeded catalog's own
   cities above places we merely know about. */
function searchTravelLocations(query, limit = 5) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const scored = [];
  for (const loc of TRAVEL_LOCATIONS) {
    const city = loc.city.toLowerCase();
    const code = loc.code.toLowerCase();
    const airport = (loc.airport || '').toLowerCase();
    const country = loc.country.toLowerCase();
    const aliases = (loc.aliases || []).map(a => a.toLowerCase());

    let tier = -1;
    if (city === q || code === q) tier = 0;
    else if (city.startsWith(q)) tier = 1;
    else if (code.startsWith(q) || aliases.some(a => a.startsWith(q))) tier = 2;
    else if (city.includes(q) || aliases.some(a => a.includes(q))) tier = 3;
    else if (airport.includes(q) || country.includes(q)) tier = 4;

    if (tier >= 0) scored.push({ loc, tier });
  }

  /* Relevance cut: tier 4 is a loose substring hit anywhere in an airport or
     country name, which is useful only when nothing better exists. Without this,
     "DEL" listed Barcelona ("Tarradellas") and Lisbon ("Delgado") under the real
     DEL. If any city/code match landed, weak matches are dropped. */
  const best = scored.reduce((m, s) => Math.min(m, s.tier), 9);
  const kept = best <= 2 ? scored.filter(s => s.tier < 4) : scored;

  return kept
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => (a.tier - b.tier) || (a.i - b.i))
    .slice(0, limit)
    .map(s => s.loc);
}

/* ---------------------------------------------------------------------------
   Country lookup — used to decide whether a route is international.

   The v2 API stores only an IATA code and a display city on a request, with no
   country anywhere, so this dataset is the only place the answer exists. That
   is also why the callers treat "unknown" as *not* international rather than
   guessing: a code missing from this table must not turn into a passport
   requirement the merchant cannot satisfy.
   --------------------------------------------------------------------------- */
const TRAVEL_LOCATIONS_BY_CODE = TRAVEL_LOCATIONS.reduce((map, loc) => {
  map[loc.code.toUpperCase()] = loc;
  return map;
}, Object.create(null));

function travelLocationByCode(code) {
  return code ? TRAVEL_LOCATIONS_BY_CODE[String(code).trim().toUpperCase()] || null : null;
}

function travelCountryForCode(code) {
  return travelLocationByCode(code)?.country || null;
}

/* Returns true only when both countries are known AND differ. Unknown on
   either side yields false — see the note above. */
function isInternationalRoute(originCode, destinationCode) {
  const a = travelCountryForCode(originCode);
  const b = travelCountryForCode(destinationCode);
  return !!(a && b && a !== b);
}
