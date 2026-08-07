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
