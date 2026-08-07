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
  { country: 'Afghanistan', nationality: 'Afghan' },
  { country: 'Albania', nationality: 'Albanian' },
  { country: 'Algeria', nationality: 'Algerian' },
  { country: 'Argentina', nationality: 'Argentine' },
  { country: 'Armenia', nationality: 'Armenian' },
  { country: 'Australia', nationality: 'Australian' },
  { country: 'Austria', nationality: 'Austrian' },
  { country: 'Azerbaijan', nationality: 'Azerbaijani' },
  { country: 'Bahrain', nationality: 'Bahraini' },
  { country: 'Bangladesh', nationality: 'Bangladeshi' },
  { country: 'Belarus', nationality: 'Belarusian' },
  { country: 'Belgium', nationality: 'Belgian' },
  { country: 'Bhutan', nationality: 'Bhutanese' },
  { country: 'Bolivia', nationality: 'Bolivian' },
  { country: 'Bosnia and Herzegovina', nationality: 'Bosnian' },
  { country: 'Botswana', nationality: 'Motswana' },
  { country: 'Brazil', nationality: 'Brazilian' },
  { country: 'Brunei', nationality: 'Bruneian' },
  { country: 'Bulgaria', nationality: 'Bulgarian' },
  { country: 'Cambodia', nationality: 'Cambodian' },
  { country: 'Cameroon', nationality: 'Cameroonian' },
  { country: 'Canada', nationality: 'Canadian' },
  { country: 'Chile', nationality: 'Chilean' },
  { country: 'China', nationality: 'Chinese' },
  { country: 'Colombia', nationality: 'Colombian' },
  { country: 'Costa Rica', nationality: 'Costa Rican' },
  { country: 'Croatia', nationality: 'Croatian' },
  { country: 'Cuba', nationality: 'Cuban' },
  { country: 'Cyprus', nationality: 'Cypriot' },
  { country: 'Czechia', nationality: 'Czech' },
  { country: 'Denmark', nationality: 'Danish' },
  { country: 'Ecuador', nationality: 'Ecuadorian' },
  { country: 'Egypt', nationality: 'Egyptian' },
  { country: 'Estonia', nationality: 'Estonian' },
  { country: 'Ethiopia', nationality: 'Ethiopian' },
  { country: 'Fiji', nationality: 'Fijian' },
  { country: 'Finland', nationality: 'Finnish' },
  { country: 'France', nationality: 'French' },
  { country: 'Georgia', nationality: 'Georgian' },
  { country: 'Germany', nationality: 'German' },
  { country: 'Ghana', nationality: 'Ghanaian' },
  { country: 'Greece', nationality: 'Greek' },
  { country: 'Hong Kong', nationality: 'Hong Konger' },
  { country: 'Hungary', nationality: 'Hungarian' },
  { country: 'Iceland', nationality: 'Icelandic' },
  { country: 'India', nationality: 'Indian' },
  { country: 'Indonesia', nationality: 'Indonesian' },
  { country: 'Iran', nationality: 'Iranian' },
  { country: 'Iraq', nationality: 'Iraqi' },
  { country: 'Ireland', nationality: 'Irish' },
  { country: 'Israel', nationality: 'Israeli' },
  { country: 'Italy', nationality: 'Italian' },
  { country: 'Jamaica', nationality: 'Jamaican' },
  { country: 'Japan', nationality: 'Japanese' },
  { country: 'Jordan', nationality: 'Jordanian' },
  { country: 'Kazakhstan', nationality: 'Kazakhstani' },
  { country: 'Kenya', nationality: 'Kenyan' },
  { country: 'Kuwait', nationality: 'Kuwaiti' },
  { country: 'Kyrgyzstan', nationality: 'Kyrgyzstani' },
  { country: 'Laos', nationality: 'Lao' },
  { country: 'Latvia', nationality: 'Latvian' },
  { country: 'Lebanon', nationality: 'Lebanese' },
  { country: 'Libya', nationality: 'Libyan' },
  { country: 'Lithuania', nationality: 'Lithuanian' },
  { country: 'Luxembourg', nationality: 'Luxembourgish' },
  { country: 'Macau', nationality: 'Macanese' },
  { country: 'Madagascar', nationality: 'Malagasy' },
  { country: 'Malawi', nationality: 'Malawian' },
  { country: 'Malaysia', nationality: 'Malaysian' },
  { country: 'Maldives', nationality: 'Maldivian' },
  { country: 'Malta', nationality: 'Maltese' },
  { country: 'Mauritius', nationality: 'Mauritian' },
  { country: 'Mexico', nationality: 'Mexican' },
  { country: 'Mongolia', nationality: 'Mongolian' },
  { country: 'Morocco', nationality: 'Moroccan' },
  { country: 'Mozambique', nationality: 'Mozambican' },
  { country: 'Myanmar', nationality: 'Burmese' },
  { country: 'Namibia', nationality: 'Namibian' },
  { country: 'Nepal', nationality: 'Nepali' },
  { country: 'Netherlands', nationality: 'Dutch' },
  { country: 'New Zealand', nationality: 'New Zealander' },
  { country: 'Nigeria', nationality: 'Nigerian' },
  { country: 'North Macedonia', nationality: 'Macedonian' },
  { country: 'Norway', nationality: 'Norwegian' },
  { country: 'Oman', nationality: 'Omani' },
  { country: 'Pakistan', nationality: 'Pakistani' },
  { country: 'Palestine', nationality: 'Palestinian' },
  { country: 'Panama', nationality: 'Panamanian' },
  { country: 'Papua New Guinea', nationality: 'Papua New Guinean' },
  { country: 'Paraguay', nationality: 'Paraguayan' },
  { country: 'Peru', nationality: 'Peruvian' },
  { country: 'Philippines', nationality: 'Filipino' },
  { country: 'Poland', nationality: 'Polish' },
  { country: 'Portugal', nationality: 'Portuguese' },
  { country: 'Qatar', nationality: 'Qatari' },
  { country: 'Romania', nationality: 'Romanian' },
  { country: 'Russia', nationality: 'Russian' },
  { country: 'Rwanda', nationality: 'Rwandan' },
  { country: 'Saudi Arabia', nationality: 'Saudi' },
  { country: 'Senegal', nationality: 'Senegalese' },
  { country: 'Serbia', nationality: 'Serbian' },
  { country: 'Seychelles', nationality: 'Seychellois' },
  { country: 'Singapore', nationality: 'Singaporean' },
  { country: 'Slovakia', nationality: 'Slovak' },
  { country: 'Slovenia', nationality: 'Slovenian' },
  { country: 'South Africa', nationality: 'South African' },
  { country: 'South Korea', nationality: 'South Korean' },
  { country: 'Spain', nationality: 'Spanish' },
  { country: 'Sri Lanka', nationality: 'Sri Lankan' },
  { country: 'Sudan', nationality: 'Sudanese' },
  { country: 'Sweden', nationality: 'Swedish' },
  { country: 'Switzerland', nationality: 'Swiss' },
  { country: 'Syria', nationality: 'Syrian' },
  { country: 'Taiwan', nationality: 'Taiwanese' },
  { country: 'Tajikistan', nationality: 'Tajikistani' },
  { country: 'Tanzania', nationality: 'Tanzanian' },
  { country: 'Thailand', nationality: 'Thai' },
  { country: 'Tunisia', nationality: 'Tunisian' },
  { country: 'Turkey', nationality: 'Turkish' },
  { country: 'Turkmenistan', nationality: 'Turkmen' },
  { country: 'Uganda', nationality: 'Ugandan' },
  { country: 'Ukraine', nationality: 'Ukrainian' },
  { country: 'United Arab Emirates', nationality: 'Emirati' },
  { country: 'United Kingdom', nationality: 'British' },
  { country: 'United States', nationality: 'American' },
  { country: 'Uruguay', nationality: 'Uruguayan' },
  { country: 'Uzbekistan', nationality: 'Uzbekistani' },
  { country: 'Venezuela', nationality: 'Venezuelan' },
  { country: 'Vietnam', nationality: 'Vietnamese' },
  { country: 'Yemen', nationality: 'Yemeni' },
  { country: 'Zambia', nationality: 'Zambian' },
  { country: 'Zimbabwe', nationality: 'Zimbabwean' },
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
