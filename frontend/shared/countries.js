'use strict';
/* countries.js — country names and their demonyms, for the two passenger
   fields that used to be free text.
   ===========================================================================
   WHY THIS IS A UI-LAYER TABLE AND NOT AN ENDPOINT.
   Exactly like travel-locations.js: there is no country reference in the v2
   API. `PassengerInput.nationality` and `PassengerInput.passport_issue_country`
   are plain `str | None` columns (schemas/ticket.py) and the server stores
   whatever arrives, so this list narrows what the *form offers* without
   narrowing what the API accepts. Historical rows carrying anything else still
   render — every reader prints the stored string rather than looking it up
   here.

   TWO FIELDS, TWO DIFFERENT ANSWERS, one table. Nationality is the demonym
   ("Indian"); the passport's issuing country is the country ("India"). They are
   the same row read two ways, which is what keeps "Indian"/"India" from
   drifting apart the way two hand-typed boxes did.

   Free entry survives: both combos offer what the merchant typed as an explicit
   option when nothing matches, so a passport from a country not on this list is
   still enterable. See clCountryOptions / clNationalityOptions in
   classic-booking.js. */

const WORLD_COUNTRIES = [
  { country: 'Afghanistan', nationality: 'Afghan', iso3: 'AFG' },
  { country: 'Albania', nationality: 'Albanian', iso3: 'ALB' },
  { country: 'Algeria', nationality: 'Algerian', iso3: 'DZA' },
  { country: 'Argentina', nationality: 'Argentine', iso3: 'ARG' },
  { country: 'Armenia', nationality: 'Armenian', iso3: 'ARM' },
  { country: 'Australia', nationality: 'Australian', iso3: 'AUS' },
  { country: 'Austria', nationality: 'Austrian', iso3: 'AUT' },
  { country: 'Azerbaijan', nationality: 'Azerbaijani', iso3: 'AZE' },
  { country: 'Bahrain', nationality: 'Bahraini', iso3: 'BHR' },
  { country: 'Bangladesh', nationality: 'Bangladeshi', iso3: 'BGD' },
  { country: 'Belarus', nationality: 'Belarusian', iso3: 'BLR' },
  { country: 'Belgium', nationality: 'Belgian', iso3: 'BEL' },
  { country: 'Bhutan', nationality: 'Bhutanese', iso3: 'BTN' },
  { country: 'Bolivia', nationality: 'Bolivian', iso3: 'BOL' },
  { country: 'Bosnia and Herzegovina', nationality: 'Bosnian', iso3: 'BIH' },
  { country: 'Botswana', nationality: 'Motswana', iso3: 'BWA' },
  { country: 'Brazil', nationality: 'Brazilian', iso3: 'BRA' },
  { country: 'Brunei', nationality: 'Bruneian', iso3: 'BRN' },
  { country: 'Bulgaria', nationality: 'Bulgarian', iso3: 'BGR' },
  { country: 'Cambodia', nationality: 'Cambodian', iso3: 'KHM' },
  { country: 'Cameroon', nationality: 'Cameroonian', iso3: 'CMR' },
  { country: 'Canada', nationality: 'Canadian', iso3: 'CAN' },
  { country: 'Chile', nationality: 'Chilean', iso3: 'CHL' },
  { country: 'China', nationality: 'Chinese', iso3: 'CHN' },
  { country: 'Colombia', nationality: 'Colombian', iso3: 'COL' },
  { country: 'Costa Rica', nationality: 'Costa Rican', iso3: 'CRI' },
  { country: 'Croatia', nationality: 'Croatian', iso3: 'HRV' },
  { country: 'Cuba', nationality: 'Cuban', iso3: 'CUB' },
  { country: 'Cyprus', nationality: 'Cypriot', iso3: 'CYP' },
  { country: 'Czechia', nationality: 'Czech', iso3: 'CZE' },
  { country: 'Denmark', nationality: 'Danish', iso3: 'DNK' },
  { country: 'Ecuador', nationality: 'Ecuadorian', iso3: 'ECU' },
  { country: 'Egypt', nationality: 'Egyptian', iso3: 'EGY' },
  { country: 'Estonia', nationality: 'Estonian', iso3: 'EST' },
  { country: 'Ethiopia', nationality: 'Ethiopian', iso3: 'ETH' },
  { country: 'Fiji', nationality: 'Fijian', iso3: 'FJI' },
  { country: 'Finland', nationality: 'Finnish', iso3: 'FIN' },
  { country: 'France', nationality: 'French', iso3: 'FRA' },
  { country: 'Georgia', nationality: 'Georgian', iso3: 'GEO' },
  { country: 'Germany', nationality: 'German', iso3: 'DEU' },
  { country: 'Ghana', nationality: 'Ghanaian', iso3: 'GHA' },
  { country: 'Greece', nationality: 'Greek', iso3: 'GRC' },
  { country: 'Hong Kong', nationality: 'Hong Konger', iso3: 'HKG' },
  { country: 'Hungary', nationality: 'Hungarian', iso3: 'HUN' },
  { country: 'Iceland', nationality: 'Icelandic', iso3: 'ISL' },
  { country: 'India', nationality: 'Indian', iso3: 'IND' },
  { country: 'Indonesia', nationality: 'Indonesian', iso3: 'IDN' },
  { country: 'Iran', nationality: 'Iranian', iso3: 'IRN' },
  { country: 'Iraq', nationality: 'Iraqi', iso3: 'IRQ' },
  { country: 'Ireland', nationality: 'Irish', iso3: 'IRL' },
  { country: 'Israel', nationality: 'Israeli', iso3: 'ISR' },
  { country: 'Italy', nationality: 'Italian', iso3: 'ITA' },
  { country: 'Jamaica', nationality: 'Jamaican', iso3: 'JAM' },
  { country: 'Japan', nationality: 'Japanese', iso3: 'JPN' },
  { country: 'Jordan', nationality: 'Jordanian', iso3: 'JOR' },
  { country: 'Kazakhstan', nationality: 'Kazakhstani', iso3: 'KAZ' },
  { country: 'Kenya', nationality: 'Kenyan', iso3: 'KEN' },
  { country: 'Kuwait', nationality: 'Kuwaiti', iso3: 'KWT' },
  { country: 'Kyrgyzstan', nationality: 'Kyrgyzstani', iso3: 'KGZ' },
  { country: 'Laos', nationality: 'Lao', iso3: 'LAO' },
  { country: 'Latvia', nationality: 'Latvian', iso3: 'LVA' },
  { country: 'Lebanon', nationality: 'Lebanese', iso3: 'LBN' },
  { country: 'Libya', nationality: 'Libyan', iso3: 'LBY' },
  { country: 'Lithuania', nationality: 'Lithuanian', iso3: 'LTU' },
  { country: 'Luxembourg', nationality: 'Luxembourgish', iso3: 'LUX' },
  { country: 'Macau', nationality: 'Macanese', iso3: 'MAC' },
  { country: 'Madagascar', nationality: 'Malagasy', iso3: 'MDG' },
  { country: 'Malawi', nationality: 'Malawian', iso3: 'MWI' },
  { country: 'Malaysia', nationality: 'Malaysian', iso3: 'MYS' },
  { country: 'Maldives', nationality: 'Maldivian', iso3: 'MDV' },
  { country: 'Malta', nationality: 'Maltese', iso3: 'MLT' },
  { country: 'Mauritius', nationality: 'Mauritian', iso3: 'MUS' },
  { country: 'Mexico', nationality: 'Mexican', iso3: 'MEX' },
  { country: 'Mongolia', nationality: 'Mongolian', iso3: 'MNG' },
  { country: 'Morocco', nationality: 'Moroccan', iso3: 'MAR' },
  { country: 'Mozambique', nationality: 'Mozambican', iso3: 'MOZ' },
  { country: 'Myanmar', nationality: 'Burmese', iso3: 'MMR' },
  { country: 'Namibia', nationality: 'Namibian', iso3: 'NAM' },
  { country: 'Nepal', nationality: 'Nepali', iso3: 'NPL' },
  { country: 'Netherlands', nationality: 'Dutch', iso3: 'NLD' },
  { country: 'New Zealand', nationality: 'New Zealander', iso3: 'NZL' },
  { country: 'Nigeria', nationality: 'Nigerian', iso3: 'NGA' },
  { country: 'North Macedonia', nationality: 'Macedonian', iso3: 'MKD' },
  { country: 'Norway', nationality: 'Norwegian', iso3: 'NOR' },
  { country: 'Oman', nationality: 'Omani', iso3: 'OMN' },
  { country: 'Pakistan', nationality: 'Pakistani', iso3: 'PAK' },
  { country: 'Palestine', nationality: 'Palestinian', iso3: 'PSE' },
  { country: 'Panama', nationality: 'Panamanian', iso3: 'PAN' },
  { country: 'Papua New Guinea', nationality: 'Papua New Guinean', iso3: 'PNG' },
  { country: 'Paraguay', nationality: 'Paraguayan', iso3: 'PRY' },
  { country: 'Peru', nationality: 'Peruvian', iso3: 'PER' },
  { country: 'Philippines', nationality: 'Filipino', iso3: 'PHL' },
  { country: 'Poland', nationality: 'Polish', iso3: 'POL' },
  { country: 'Portugal', nationality: 'Portuguese', iso3: 'PRT' },
  { country: 'Qatar', nationality: 'Qatari', iso3: 'QAT' },
  { country: 'Romania', nationality: 'Romanian', iso3: 'ROU' },
  { country: 'Russia', nationality: 'Russian', iso3: 'RUS' },
  { country: 'Rwanda', nationality: 'Rwandan', iso3: 'RWA' },
  { country: 'Saudi Arabia', nationality: 'Saudi', iso3: 'SAU' },
  { country: 'Senegal', nationality: 'Senegalese', iso3: 'SEN' },
  { country: 'Serbia', nationality: 'Serbian', iso3: 'SRB' },
  { country: 'Seychelles', nationality: 'Seychellois', iso3: 'SYC' },
  { country: 'Singapore', nationality: 'Singaporean', iso3: 'SGP' },
  { country: 'Slovakia', nationality: 'Slovak', iso3: 'SVK' },
  { country: 'Slovenia', nationality: 'Slovenian', iso3: 'SVN' },
  { country: 'South Africa', nationality: 'South African', iso3: 'ZAF' },
  { country: 'South Korea', nationality: 'South Korean', iso3: 'KOR' },
  { country: 'Spain', nationality: 'Spanish', iso3: 'ESP' },
  { country: 'Sri Lanka', nationality: 'Sri Lankan', iso3: 'LKA' },
  { country: 'Sudan', nationality: 'Sudanese', iso3: 'SDN' },
  { country: 'Sweden', nationality: 'Swedish', iso3: 'SWE' },
  { country: 'Switzerland', nationality: 'Swiss', iso3: 'CHE' },
  { country: 'Syria', nationality: 'Syrian', iso3: 'SYR' },
  { country: 'Taiwan', nationality: 'Taiwanese', iso3: 'TWN' },
  { country: 'Tajikistan', nationality: 'Tajikistani', iso3: 'TJK' },
  { country: 'Tanzania', nationality: 'Tanzanian', iso3: 'TZA' },
  { country: 'Thailand', nationality: 'Thai', iso3: 'THA' },
  { country: 'Tunisia', nationality: 'Tunisian', iso3: 'TUN' },
  { country: 'Turkey', nationality: 'Turkish', iso3: 'TUR' },
  { country: 'Turkmenistan', nationality: 'Turkmen', iso3: 'TKM' },
  { country: 'Uganda', nationality: 'Ugandan', iso3: 'UGA' },
  { country: 'Ukraine', nationality: 'Ukrainian', iso3: 'UKR' },
  { country: 'United Arab Emirates', nationality: 'Emirati', iso3: 'ARE' },
  { country: 'United Kingdom', nationality: 'British', iso3: 'GBR' },
  { country: 'United States', nationality: 'American', iso3: 'USA' },
  { country: 'Uruguay', nationality: 'Uruguayan', iso3: 'URY' },
  { country: 'Uzbekistan', nationality: 'Uzbekistani', iso3: 'UZB' },
  { country: 'Venezuela', nationality: 'Venezuelan', iso3: 'VEN' },
  { country: 'Vietnam', nationality: 'Vietnamese', iso3: 'VNM' },
  { country: 'Yemen', nationality: 'Yemeni', iso3: 'YEM' },
  { country: 'Zambia', nationality: 'Zambian', iso3: 'ZMB' },
  { country: 'Zimbabwe', nationality: 'Zimbabwean', iso3: 'ZWE' },
];

/* THE FIRST ROWS OFFERED BEFORE ANYTHING IS TYPED. The desk's traffic is
   overwhelmingly Indian passports on Gulf and South-East Asian sectors, so an
   unprompted list that opens on Afghanistan makes the merchant type for the
   commonest answer of all. Alphabetical order is preserved for everything else
   — this only decides what surfaces first on an empty query. */
const COUNTRY_PRIORITY = [
  'India', 'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Oman', 'Kuwait',
  'Singapore', 'Thailand', 'Malaysia', 'Sri Lanka', 'United Kingdom', 'United States',
];

/* Rank a match: a prefix hit beats a hit in the middle of the word, and a
   priority country beats neither-of-those. Shared by both searches so the two
   fields order their suggestions the same way. */
function _countryRank(text, q, priority) {
  const t = text.toLowerCase();
  if (!q) return priority ? 0 : 1;
  if (t.startsWith(q)) return priority ? 0 : 1;
  return t.includes(q) ? 2 : -1;
}

function _searchCountryField(field, query, limit) {
  const q = String(query || '').trim().toLowerCase();
  const rows = WORLD_COUNTRIES
    .map(row => ({ row, rank: _countryRank(row[field], q, COUNTRY_PRIORITY.includes(row.country)) }))
    .filter(x => x.rank >= 0);
  rows.sort((a, b) => a.rank - b.rank
    || a.row[field].localeCompare(b.row[field]));
  return rows.slice(0, limit).map(x => x.row);
}

/* "India", "United Arab Emirates" — for the passport's issuing country. */
function searchCountries(query, limit = 8) {
  return _searchCountryField('country', query, limit);
}

/* "Indian", "Emirati" — for nationality. Matched on the demonym AND on the
   country name, because a merchant typing "UAE passport holder" reaches for
   "United Arab" long before "Emirati". */
function searchNationalities(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  const direct = _searchCountryField('nationality', query, limit);
  if (!q || direct.length >= limit) return direct;
  const seen = new Set(direct.map(r => r.country));
  const byCountry = _searchCountryField('country', query, limit)
    .filter(r => !seen.has(r.country));
  return [...direct, ...byCountry].slice(0, limit);
}


/* "IND" -> the India row. The passport half of the SAME table, read a third
   way — a row already answers "India" and "Indian", and `iso3` is what lets a
   machine-readable zone reach it. A separate code->name map is exactly the
   second country system this file exists to prevent, so the code lives on the
   row beside the two names it must agree with.

   MRZ_STATE_ALIASES is NOT that second map. ICAO 9303 issuing-state codes are
   ISO 3166-1 alpha-3 with a short list of documented deviations, and a German
   passport really does print `D` rather than `DEU`. These are spelling
   variants of a code, not countries of their own: each one resolves to a row
   above rather than carrying a name itself.

   UNKNOWN CODES RETURN null, DELIBERATELY. A passport from a country not on
   this list must leave the field alone for someone to type, never receive a
   guess — the same rule the scan itself follows. */
const MRZ_STATE_ALIASES = {
  D: 'DEU',      // Germany, printed as a bare D since the first machine-readable passports
  GBD: 'GBR',    // British overseas territories / nationals — all read as United Kingdom
  GBN: 'GBR',
  GBO: 'GBR',
  GBP: 'GBR',
  GBS: 'GBR',
};

function countryFromIso3(code) {
  const raw = String(code || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!raw) return null;
  const iso = MRZ_STATE_ALIASES[raw] || raw;
  return WORLD_COUNTRIES.find(r => r.iso3 === iso) || null;
}


/* ===========================================================================
   DIALLING CODES — the country-code half of a phone field.
   ===========================================================================
   A SEPARATE TABLE FROM WORLD_COUNTRIES, on purpose. That list exists to name
   a passport's issuing country and covers 130-odd of them; this one exists so
   a merchant can pick the prefix in front of a contact number, and the useful
   set is much smaller — the markets this desk actually sells to. Merging them
   would mean either scrolling a 130-row dropdown to reach "+91" or carrying a
   `dial` key that is null on most rows.

   The code is stored WITHOUT the plus, because that is the shape the API has
   always held: `BookingContact.phone` is a digits string, and every reader
   (invoices, the Booking Operations desk, the airline handover) already prints
   it that way. The plus is presentation and lives in the label only.

   `default: true` marks the one selected when there is nothing stored to
   restore — India, which is the overwhelming majority of this platform's
   traffic. Nothing here narrows what the API accepts: a number already stored
   under a code not on this list still renders (see clSplitDialCode, which
   falls back to showing the whole stored value in the number box).

   `len` IS THE NATIONAL NUMBER LENGTH, WITHOUT THE CODE AND WITHOUT THE TRUNK
   "0" — a number where the country has one, `[min, max]` where it genuinely
   varies. This started life as a single global constant of 10, which is right
   for India and wrong for most of the rest of this list: a UAE mobile is 9
   digits and a Qatari number is 8, so the form refused numbers the desk dials
   every day. Ranges are used only where a country really does vary (the UK's
   9-digit landlines beside 10-digit mobiles, Germany's 10-and-11), because a
   range wide enough to be safe everywhere would accept any typo. Where a code
   is not on this list at all, `dialLengths` answers with a deliberately loose
   fallback rather than guessing — see below. */
const DIAL_CODES = [
  { code: '91', country: 'India', default: true, len: 10 },
  { code: '971', country: 'United Arab Emirates', len: [8, 9] },
  { code: '966', country: 'Saudi Arabia', len: 9 },
  { code: '974', country: 'Qatar', len: 8 },
  { code: '968', country: 'Oman', len: 8 },
  { code: '965', country: 'Kuwait', len: 8 },
  { code: '973', country: 'Bahrain', len: 8 },
  { code: '65', country: 'Singapore', len: 8 },
  { code: '60', country: 'Malaysia', len: [9, 10] },
  { code: '66', country: 'Thailand', len: [8, 9] },
  { code: '94', country: 'Sri Lanka', len: 9 },
  { code: '977', country: 'Nepal', len: 10 },
  { code: '880', country: 'Bangladesh', len: 10 },
  { code: '960', country: 'Maldives', len: 7 },
  { code: '44', country: 'United Kingdom', len: [9, 10] },
  { code: '1', country: 'United States / Canada', len: 10 },
  { code: '61', country: 'Australia', len: 9 },
  { code: '64', country: 'New Zealand', len: [8, 10] },
  { code: '49', country: 'Germany', len: [10, 11] },
  { code: '33', country: 'France', len: 9 },
  { code: '39', country: 'Italy', len: [9, 10] },
  { code: '34', country: 'Spain', len: 9 },
  { code: '31', country: 'Netherlands', len: 9 },
  { code: '41', country: 'Switzerland', len: 9 },
  { code: '46', country: 'Sweden', len: [7, 9] },
  { code: '47', country: 'Norway', len: 8 },
  { code: '353', country: 'Ireland', len: 9 },
  { code: '351', country: 'Portugal', len: 9 },
  { code: '90', country: 'Turkey', len: 10 },
  { code: '20', country: 'Egypt', len: 10 },
  { code: '27', country: 'South Africa', len: 9 },
  { code: '254', country: 'Kenya', len: 9 },
  { code: '234', country: 'Nigeria', len: 10 },
  { code: '81', country: 'Japan', len: 10 },
  { code: '82', country: 'South Korea', len: [9, 10] },
  { code: '86', country: 'China', len: 11 },
  { code: '852', country: 'Hong Kong', len: 8 },
  { code: '84', country: 'Vietnam', len: 9 },
  { code: '63', country: 'Philippines', len: 10 },
  { code: '62', country: 'Indonesia', len: [9, 12] },
  { code: '7', country: 'Russia / Kazakhstan', len: 10 },
  { code: '55', country: 'Brazil', len: [10, 11] },
  { code: '52', country: 'Mexico', len: 10 },
];

/** What to accept for a code this table does not carry.
 *
 * Wide on purpose. It is reached only when something outside the picker asks —
 * a number stored years ago under a code since removed, say — and the right
 * answer there is "do not stand in the way", not a guess at a country. The
 * server's own bound is `min_length=5, max_length=30` on the joined string, so
 * nothing here can let through something it would refuse.
 */
const DIAL_LEN_FALLBACK = [6, 13];

/** The accepted national-number length for a dialling code, as `{min, max}`.
 *
 * Takes the code with or without its plus and with or without spaces, because
 * callers hold it variously as a `<select>` value, a stored digits string and a
 * literal.
 */
function dialLengths(code) {
  const digits = String(code ?? '').replace(/\D+/g, '');
  const entry = DIAL_CODES.find(d => d.code === digits);
  const len = entry ? entry.len : DIAL_LEN_FALLBACK;
  return Array.isArray(len) ? { min: len[0], max: len[1] } : { min: len, max: len };
}

/** The length as the merchant reads it: "10", or "8 to 9" when it is a range.
 *
 * Just the quantity, no noun — the callers put it inside "… digits", "N of …
 * digits" and "is N digits, not …", and a helper that returned the whole
 * sentence would have to know which of those it was writing.
 */
function dialLengthText(code) {
  const { min, max } = dialLengths(code);
  return min === max ? `${min}` : `${min} to ${max}`;
}

/** Is `digits` an acceptable national number for `code`? Blank is not judged. */
function dialLengthOk(code, digits) {
  const n = String(digits ?? '').replace(/\D+/g, '').length;
  if (!n) return true;
  const { min, max } = dialLengths(code);
  return n >= min && n <= max;
}

/** The code selected when nothing is stored — "91". */
function defaultDialCode() {
  return (DIAL_CODES.find(d => d.default) || DIAL_CODES[0]).code;
}

/** Split a stored digits-only number into its dialling code and the rest.
 *
 * LONGEST CODE FIRST, which is the whole reason this is not a one-liner: "91"
 * and "971" are both real codes and a naive scan would read every Emirati
 * number as an Indian one with a leading 1. Falls back to the default code and
 * the whole stored value in the number box when nothing matches — an existing
 * contact saved before this field had a picker is then shown intact rather than
 * silently truncated.
 *
 * LENGTH BREAKS THE REMAINING TIES, now that each code carries one. Longest
 * match alone is not always right: "8801712345678" starts with both "880"
 * (Bangladesh) and "88", and the longest match is only the correct one because
 * the remainder is then 10 digits, which is what a Bangladeshi number is. So
 * the codes are tried longest first and the first one whose remainder is a
 * VALID LENGTH for it wins; if none qualifies the longest match is still used,
 * which is exactly the old behaviour. That keeps a number the table cannot
 * explain visible and editable rather than reshaped into a wrong country.
 */
function splitDialCode(stored) {
  const digits = String(stored ?? '').replace(/\D+/g, '');
  if (!digits) return { code: defaultDialCode(), number: '' };
  const candidates = [...DIAL_CODES]
    .sort((a, b) => b.code.length - a.code.length)
    .filter(d => digits.startsWith(d.code) && digits.length > d.code.length);
  if (!candidates.length) return { code: defaultDialCode(), number: digits };
  const fits = candidates.find(d => dialLengthOk(d.code, digits.slice(d.code.length)));
  const match = fits || candidates[0];
  return { code: match.code, number: digits.slice(match.code.length) };
}
