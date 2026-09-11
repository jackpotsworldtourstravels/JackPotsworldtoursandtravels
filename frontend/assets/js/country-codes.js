'use strict';
/* ===========================================================================
   country-codes.js - one dialling-code table for the whole front end.
   ===========================================================================
   WHY THIS FILE EXISTS. Three places asked a traveller for a country code and
   each carried its own answer: booking-products.js had nineteen entries "for
   the countries the portal actually sells to", hotel-guests.js had six, and
   the sign-up form had none at all - a bare `tel` box whose placeholder read
   "9876543210", which is an Indian number and nothing else. Somebody dialling
   in from anywhere else had no way to say so, and the server has always
   accepted a leading + (see _MOBILE_RE in backend/app/schemas/customer.py).

   So the table lives here, complete, and the callers pick from it. A short
   list is still a legitimate product decision - filter this one - but it is
   no longer something each form invents for itself.

   THE SHAPE IS [iso2, name, dial]. iso2 is what flag() turns into an emoji (no
   image files, no sprite sheet) and what a caller stores if it ever needs to
   know the COUNTRY rather than the code: several countries share a dial code
   (+1 is nineteen of them, +44 is four, +39 is two), so the dial code alone
   cannot answer that question. Nothing stores it today; the field is here so
   that the day something does, this table does not have to be rebuilt.

   ORDERING is alphabetical by name, with a short POPULAR list lifted to the
   top by list() - the markets this business actually sells to should not be a
   scroll away, and strict alphabetical order puts India ninety rows down.
   =========================================================================== */

const CountryCodes = (function () {

  /** [iso2, name, dial] - E.164 assignments. */
  const ALL = [
    ['AF', 'Afghanistan', '93'],
    ['AX', 'Aland Islands', '358'],
    ['AL', 'Albania', '355'],
    ['DZ', 'Algeria', '213'],
    ['AS', 'American Samoa', '1684'],
    ['AD', 'Andorra', '376'],
    ['AO', 'Angola', '244'],
    ['AI', 'Anguilla', '1264'],
    ['AG', 'Antigua & Barbuda', '1268'],
    ['AR', 'Argentina', '54'],
    ['AM', 'Armenia', '374'],
    ['AW', 'Aruba', '297'],
    ['AU', 'Australia', '61'],
    ['AT', 'Austria', '43'],
    ['AZ', 'Azerbaijan', '994'],
    ['BS', 'Bahamas', '1242'],
    ['BH', 'Bahrain', '973'],
    ['BD', 'Bangladesh', '880'],
    ['BB', 'Barbados', '1246'],
    ['BY', 'Belarus', '375'],
    ['BE', 'Belgium', '32'],
    ['BZ', 'Belize', '501'],
    ['BJ', 'Benin', '229'],
    ['BM', 'Bermuda', '1441'],
    ['BT', 'Bhutan', '975'],
    ['BO', 'Bolivia', '591'],
    ['BA', 'Bosnia & Herzegovina', '387'],
    ['BW', 'Botswana', '267'],
    ['BR', 'Brazil', '55'],
    ['IO', 'British Indian Ocean Territory', '246'],
    ['VG', 'British Virgin Islands', '1284'],
    ['BN', 'Brunei', '673'],
    ['BG', 'Bulgaria', '359'],
    ['BF', 'Burkina Faso', '226'],
    ['BI', 'Burundi', '257'],
    ['KH', 'Cambodia', '855'],
    ['CM', 'Cameroon', '237'],
    ['CA', 'Canada', '1'],
    ['CV', 'Cape Verde', '238'],
    ['BQ', 'Caribbean Netherlands', '599'],
    ['KY', 'Cayman Islands', '1345'],
    ['CF', 'Central African Republic', '236'],
    ['TD', 'Chad', '235'],
    ['CL', 'Chile', '56'],
    ['CN', 'China', '86'],
    ['CO', 'Colombia', '57'],
    ['KM', 'Comoros', '269'],
    ['CG', 'Congo - Brazzaville', '242'],
    ['CD', 'Congo - Kinshasa', '243'],
    ['CK', 'Cook Islands', '682'],
    ['CR', 'Costa Rica', '506'],
    ['CI', 'Cote d\'Ivoire', '225'],
    ['HR', 'Croatia', '385'],
    ['CU', 'Cuba', '53'],
    ['CW', 'Curacao', '599'],
    ['CY', 'Cyprus', '357'],
    ['CZ', 'Czechia', '420'],
    ['DK', 'Denmark', '45'],
    ['DJ', 'Djibouti', '253'],
    ['DM', 'Dominica', '1767'],
    ['DO', 'Dominican Republic', '1809'],
    ['EC', 'Ecuador', '593'],
    ['EG', 'Egypt', '20'],
    ['SV', 'El Salvador', '503'],
    ['GQ', 'Equatorial Guinea', '240'],
    ['ER', 'Eritrea', '291'],
    ['EE', 'Estonia', '372'],
    ['SZ', 'Eswatini', '268'],
    ['ET', 'Ethiopia', '251'],
    ['FK', 'Falkland Islands', '500'],
    ['FO', 'Faroe Islands', '298'],
    ['FJ', 'Fiji', '679'],
    ['FI', 'Finland', '358'],
    ['FR', 'France', '33'],
    ['GF', 'French Guiana', '594'],
    ['PF', 'French Polynesia', '689'],
    ['GA', 'Gabon', '241'],
    ['GM', 'Gambia', '220'],
    ['GE', 'Georgia', '995'],
    ['DE', 'Germany', '49'],
    ['GH', 'Ghana', '233'],
    ['GI', 'Gibraltar', '350'],
    ['GR', 'Greece', '30'],
    ['GL', 'Greenland', '299'],
    ['GD', 'Grenada', '1473'],
    ['GP', 'Guadeloupe', '590'],
    ['GU', 'Guam', '1671'],
    ['GT', 'Guatemala', '502'],
    ['GG', 'Guernsey', '44'],
    ['GN', 'Guinea', '224'],
    ['GW', 'Guinea-Bissau', '245'],
    ['GY', 'Guyana', '592'],
    ['HT', 'Haiti', '509'],
    ['HN', 'Honduras', '504'],
    ['HK', 'Hong Kong SAR', '852'],
    ['HU', 'Hungary', '36'],
    ['IS', 'Iceland', '354'],
    ['IN', 'India', '91'],
    ['ID', 'Indonesia', '62'],
    ['IR', 'Iran', '98'],
    ['IQ', 'Iraq', '964'],
    ['IE', 'Ireland', '353'],
    ['IM', 'Isle of Man', '44'],
    ['IL', 'Israel', '972'],
    ['IT', 'Italy', '39'],
    ['JM', 'Jamaica', '1876'],
    ['JP', 'Japan', '81'],
    ['JE', 'Jersey', '44'],
    ['JO', 'Jordan', '962'],
    ['KZ', 'Kazakhstan', '7'],
    ['KE', 'Kenya', '254'],
    ['KI', 'Kiribati', '686'],
    ['XK', 'Kosovo', '383'],
    ['KW', 'Kuwait', '965'],
    ['KG', 'Kyrgyzstan', '996'],
    ['LA', 'Laos', '856'],
    ['LV', 'Latvia', '371'],
    ['LB', 'Lebanon', '961'],
    ['LS', 'Lesotho', '266'],
    ['LR', 'Liberia', '231'],
    ['LY', 'Libya', '218'],
    ['LI', 'Liechtenstein', '423'],
    ['LT', 'Lithuania', '370'],
    ['LU', 'Luxembourg', '352'],
    ['MO', 'Macao SAR', '853'],
    ['MG', 'Madagascar', '261'],
    ['MW', 'Malawi', '265'],
    ['MY', 'Malaysia', '60'],
    ['MV', 'Maldives', '960'],
    ['ML', 'Mali', '223'],
    ['MT', 'Malta', '356'],
    ['MH', 'Marshall Islands', '692'],
    ['MQ', 'Martinique', '596'],
    ['MR', 'Mauritania', '222'],
    ['MU', 'Mauritius', '230'],
    ['YT', 'Mayotte', '262'],
    ['MX', 'Mexico', '52'],
    ['FM', 'Micronesia', '691'],
    ['MD', 'Moldova', '373'],
    ['MC', 'Monaco', '377'],
    ['MN', 'Mongolia', '976'],
    ['ME', 'Montenegro', '382'],
    ['MS', 'Montserrat', '1664'],
    ['MA', 'Morocco', '212'],
    ['MZ', 'Mozambique', '258'],
    ['MM', 'Myanmar', '95'],
    ['NA', 'Namibia', '264'],
    ['NR', 'Nauru', '674'],
    ['NP', 'Nepal', '977'],
    ['NL', 'Netherlands', '31'],
    ['NC', 'New Caledonia', '687'],
    ['NZ', 'New Zealand', '64'],
    ['NI', 'Nicaragua', '505'],
    ['NE', 'Niger', '227'],
    ['NG', 'Nigeria', '234'],
    ['NU', 'Niue', '683'],
    ['NF', 'Norfolk Island', '672'],
    ['KP', 'North Korea', '850'],
    ['MK', 'North Macedonia', '389'],
    ['MP', 'Northern Mariana Islands', '1670'],
    ['NO', 'Norway', '47'],
    ['OM', 'Oman', '968'],
    ['PK', 'Pakistan', '92'],
    ['PW', 'Palau', '680'],
    ['PS', 'Palestine', '970'],
    ['PA', 'Panama', '507'],
    ['PG', 'Papua New Guinea', '675'],
    ['PY', 'Paraguay', '595'],
    ['PE', 'Peru', '51'],
    ['PH', 'Philippines', '63'],
    ['PL', 'Poland', '48'],
    ['PT', 'Portugal', '351'],
    ['PR', 'Puerto Rico', '1787'],
    ['QA', 'Qatar', '974'],
    ['RE', 'Reunion', '262'],
    ['RO', 'Romania', '40'],
    ['RU', 'Russia', '7'],
    ['RW', 'Rwanda', '250'],
    ['WS', 'Samoa', '685'],
    ['SM', 'San Marino', '378'],
    ['ST', 'Sao Tome & Principe', '239'],
    ['SA', 'Saudi Arabia', '966'],
    ['SN', 'Senegal', '221'],
    ['RS', 'Serbia', '381'],
    ['SC', 'Seychelles', '248'],
    ['SL', 'Sierra Leone', '232'],
    ['SG', 'Singapore', '65'],
    ['SX', 'Sint Maarten', '1721'],
    ['SK', 'Slovakia', '421'],
    ['SI', 'Slovenia', '386'],
    ['SB', 'Solomon Islands', '677'],
    ['SO', 'Somalia', '252'],
    ['ZA', 'South Africa', '27'],
    ['KR', 'South Korea', '82'],
    ['SS', 'South Sudan', '211'],
    ['ES', 'Spain', '34'],
    ['LK', 'Sri Lanka', '94'],
    ['BL', 'St. Barthelemy', '590'],
    ['SH', 'St. Helena', '290'],
    ['KN', 'St. Kitts & Nevis', '1869'],
    ['LC', 'St. Lucia', '1758'],
    ['MF', 'St. Martin', '590'],
    ['PM', 'St. Pierre & Miquelon', '508'],
    ['VC', 'St. Vincent & Grenadines', '1784'],
    ['SD', 'Sudan', '249'],
    ['SR', 'Suriname', '597'],
    ['SE', 'Sweden', '46'],
    ['CH', 'Switzerland', '41'],
    ['SY', 'Syria', '963'],
    ['TW', 'Taiwan', '886'],
    ['TJ', 'Tajikistan', '992'],
    ['TZ', 'Tanzania', '255'],
    ['TH', 'Thailand', '66'],
    ['TL', 'Timor-Leste', '670'],
    ['TG', 'Togo', '228'],
    ['TK', 'Tokelau', '690'],
    ['TO', 'Tonga', '676'],
    ['TT', 'Trinidad & Tobago', '1868'],
    ['TN', 'Tunisia', '216'],
    ['TR', 'Turkiye', '90'],
    ['TM', 'Turkmenistan', '993'],
    ['TC', 'Turks & Caicos Islands', '1649'],
    ['TV', 'Tuvalu', '688'],
    ['UG', 'Uganda', '256'],
    ['UA', 'Ukraine', '380'],
    ['AE', 'United Arab Emirates', '971'],
    ['GB', 'United Kingdom', '44'],
    ['US', 'United States', '1'],
    ['UY', 'Uruguay', '598'],
    ['UZ', 'Uzbekistan', '998'],
    ['VU', 'Vanuatu', '678'],
    ['VA', 'Vatican City', '39'],
    ['VE', 'Venezuela', '58'],
    ['VN', 'Vietnam', '84'],
    ['WF', 'Wallis & Futuna', '681'],
    ['EH', 'Western Sahara', '212'],
    ['YE', 'Yemen', '967'],
    ['ZM', 'Zambia', '260'],
    ['ZW', 'Zimbabwe', '263']
  ];

  /* Lifted to the top of the list, in this order. It is this business's own:
     India first, then the Gulf, then the long-haul markets the packages sell
     into. */
  const POPULAR = ['IN', 'AE', 'SA', 'QA', 'OM', 'KW', 'BH', 'SG', 'MY', 'TH',
                   'GB', 'US', 'CA', 'AU', 'NZ', 'DE', 'FR', 'LK', 'NP', 'MV'];

  const DEFAULT_ISO = 'IN';

  /** The flag, from the iso2 code alone: two regional-indicator code points.
   *  No image, no font file, no sprite - the platform draws it. A platform
   *  that will not (older Windows) shows the two letters instead, which is
   *  still a readable answer rather than a broken image. */
  function flag(iso) {
    const c = String(iso || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '';
    return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65,
                                0x1F1E6 + c.charCodeAt(1) - 65);
  }

  const byIso = iso => ALL.find(r => r[0] === String(iso || '').toUpperCase()) || null;

  /** Every row, popular markets first: {iso, name, dial, flag, label}. */
  function list() {
    const rank = iso => {
      const i = POPULAR.indexOf(iso);
      return i === -1 ? POPULAR.length : i;
    };
    return ALL.slice()
      .sort((a, b) => (rank(a[0]) - rank(b[0])) || a[1].localeCompare(b[1]))
      .map(r => ({
        iso: r[0], name: r[1], dial: '+' + r[2], flag: flag(r[0]),
        /* THE DIAL CODE COMES BEFORE THE NAME, and that is about what survives
           truncation. A closed native <select> is only as wide as the control,
           and the control cannot be as wide as "United Arab Emirates (+971)"
           without taking most of the row from the number being typed. Read
           "name (+dial)" and the closed box shows "United Arab Emi..." — every
           character except the one thing the field is for. Read "+971 United
           Arab Emi..." and the code is never the part that is cut.

           The cost is the browser's own prefix typeahead, which matches the
           option TEXT: typing "u" no longer jumps to the U's. POPULAR above is
           the answer to that for the markets this business actually sells to,
           and the list is still ordered by name underneath. */
        label: flag(r[0]) + '  +' + r[2] + '  ' + r[1],
      }));
  }

  /** <option> markup for a <select>. `selected` is an iso2 code.
   *
   *  THE VALUE IS THE ISO CODE, NOT THE DIAL CODE, and that is deliberate: a
   *  <select> cannot tell two options with the same value apart, and nineteen
   *  countries share +1. Read the dial code back with dialOf(). */
  function options(selected) {
    const want = String(selected || DEFAULT_ISO).toUpperCase();
    return list().map(c =>
      '<option value="' + c.iso + '"' + (c.iso === want ? ' selected' : '') + '>'
      + c.label + '</option>').join('');
  }

  /** The '+NN' for an iso2 code, or the default country's if it is unknown. */
  function dialOf(iso) {
    const row = byIso(iso) || byIso(DEFAULT_ISO);
    return row ? '+' + row[2] : '';
  }

  return { ALL, POPULAR, DEFAULT_ISO, list, options, flag, dialOf, byIso };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CountryCodes;
