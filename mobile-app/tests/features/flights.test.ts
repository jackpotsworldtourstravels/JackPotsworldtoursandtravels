import { AIRPORTS, airportLabel, airportSubLabel, matchAirports } from '@/features/flights/airports';
import {
  CABINS,
  clampParty,
  defaultFlightSearch,
  FARES,
  flightProblem,
  isValidParty,
  maxChildren,
  maxInfants,
  parseFlightSearch,
  partySummary,
  type FlightSearch,
} from '@/features/flights/flightForm';
import { buildFlightQuoteRequest, describeTrip, FLIGHT_QUOTE_SUBJECT } from '@/features/flights/flightQuote';

const TODAY = '2026-10-22';
const base = (over: Partial<FlightSearch> = {}): FlightSearch => ({ ...defaultFlightSearch(TODAY), ...over });

describe('passengers (the website’s four rules)', () => {
  it('at most 9 seated, at least one adult, children never outnumber adults, infants never outnumber adults', () => {
    expect(isValidParty({ adults: 1, children: 0, infants: 0 })).toBe(true);
    expect(isValidParty({ adults: 0, children: 0, infants: 0 })).toBe(false);
    expect(isValidParty({ adults: 9, children: 0, infants: 6 })).toBe(true);
    expect(isValidParty({ adults: 5, children: 5, infants: 0 })).toBe(false); // 10 seats
    expect(isValidParty({ adults: 1, children: 2, infants: 0 })).toBe(false); // more children than adults
    expect(isValidParty({ adults: 2, children: 0, infants: 3 })).toBe(false); // more infants than adults
  });

  it('the caps are the intersection of rules 1 and 3, not either alone', () => {
    expect(maxChildren(5)).toBe(4); // rule 3 allows 5, but that is 10 seats
    expect(maxChildren(1)).toBe(1);
    expect(maxChildren(9)).toBe(0);
    expect(maxChildren(3)).toBe(3);
    expect(maxInfants(2)).toBe(2);
    expect(maxInfants(9)).toBe(6);
  });

  it('lowering adults pulls children and infants down to a legal party instead of leaving an impossible one', () => {
    expect(clampParty({ adults: 2, children: 4, infants: 6 })).toEqual({ adults: 2, children: 2, infants: 2 });
    expect(clampParty({ adults: 99, children: 99, infants: 99 })).toEqual({ adults: 9, children: 0, infants: 6 });
    expect(clampParty(null)).toEqual({ adults: 1, children: 0, infants: 0 });
  });

  it('is summarised the way the website prints it, leaving out zeroes', () => {
    expect(partySummary({ adults: 1, children: 0, infants: 0 })).toBe('1 Adult');
    expect(partySummary({ adults: 2, children: 1, infants: 0 })).toBe('2 Adults, 1 Child');
    expect(partySummary({ adults: 3, children: 2, infants: 1 })).toBe('3 Adults, 2 Children, 1 Infant');
  });
});

describe('the search, validated in the website’s words', () => {
  it('opens on Hyderabad to Delhi, one adult, Economy, regular fare, and is valid', () => {
    const s = defaultFlightSearch(TODAY);
    expect(s).toMatchObject({ trip: 'oneway', from: 'HYD', to: 'DEL', depart: TODAY, cabin: 'Economy', fare: 'regular' });
    expect(flightProblem(s)).toBeNull();
  });

  it('one way: needs both airports, different, and a date', () => {
    expect(flightProblem(base({ from: null }))).toBe('Choose where you are flying from.');
    expect(flightProblem(base({ to: null }))).toBe('Choose where you are flying to.');
    expect(flightProblem(base({ to: 'HYD' }))).toBe('Origin and destination cannot be the same.');
    expect(flightProblem(base({ depart: null }))).toBe('Choose a departure date.');
  });

  it('round trip: needs a return date that is not before departure', () => {
    expect(flightProblem(base({ trip: 'round', ret: null }))).toBe('Choose a return date, or switch to One Way.');
    expect(flightProblem(base({ trip: 'round', ret: '2026-10-21' }))).toBe('The return date cannot be before departure.');
    expect(flightProblem(base({ trip: 'round', ret: TODAY }))).toBeNull();
  });

  it('multi city: each flight is checked in turn, by number', () => {
    const legs = (l: FlightSearch['legs']) => base({ trip: 'multi', legs: l });
    expect(flightProblem(legs([{ from: null, to: 'DEL', date: TODAY }, { from: 'DEL', to: 'BLR', date: TODAY }]))).toBe('Choose where flight 1 departs from.');
    expect(flightProblem(legs([{ from: 'HYD', to: 'DEL', date: TODAY }, { from: 'DEL', to: null, date: TODAY }]))).toBe('Choose where flight 2 arrives.');
    expect(flightProblem(legs([{ from: 'HYD', to: 'HYD', date: TODAY }, { from: 'DEL', to: 'BLR', date: TODAY }]))).toBe('Flight 1 cannot start and end in the same city.');
    expect(flightProblem(legs([{ from: 'HYD', to: 'DEL', date: null }, { from: 'DEL', to: 'BLR', date: TODAY }]))).toBe('Choose a departure date for flight 1.');
    expect(flightProblem(legs([{ from: 'HYD', to: 'DEL', date: '2026-10-25' }, { from: 'DEL', to: 'BLR', date: '2026-10-24' }]))).toBe('Flight 2 cannot depart before flight 1.');
    expect(flightProblem(legs([{ from: 'HYD', to: 'DEL', date: '2026-10-25' }, { from: 'DEL', to: 'BLR', date: '2026-10-25' }]))).toBeNull();
  });

  it('refuses an impossible party before anything else', () => {
    expect(flightProblem(base({ party: { adults: 1, children: 3, infants: 0 }, from: null }))).toBe('That combination of passengers is not allowed.');
  });
});

describe('a search carried in a route parameter', () => {
  it('round-trips a valid search', () => {
    const s = base({ trip: 'round', ret: '2026-10-30', cabin: 'Business', fare: 'senior', party: { adults: 2, children: 1, infants: 0 } });
    expect(parseFlightSearch(JSON.stringify(s))).toEqual(s);
  });

  it('refuses anything that is not a well-formed search, rather than repairing it', () => {
    expect(parseFlightSearch(undefined)).toBeNull();
    expect(parseFlightSearch('not json')).toBeNull();
    expect(parseFlightSearch(JSON.stringify({ ...base(), from: 'XXX' }))).toBeNull(); // not an airport the site serves
    expect(parseFlightSearch(JSON.stringify({ ...base(), depart: 'tomorrow' }))).toBeNull();
    expect(parseFlightSearch(JSON.stringify({ ...base(), cabin: 'Space' }))).toBeNull();
    expect(parseFlightSearch(JSON.stringify({ ...base(), legs: [base().legs[0]] }))).toBeNull(); // multi city needs two
    expect(parseFlightSearch(JSON.stringify({ ...base(), fare: '<script>' }))).toBeNull();
  });

  it('pulls an illegal party back to a legal one', () => {
    expect(parseFlightSearch(JSON.stringify({ ...base(), party: { adults: 1, children: 5, infants: 5 } }))?.party).toEqual({ adults: 1, children: 1, infants: 1 });
  });
});

describe('the airport list', () => {
  it('prints cities as the site does, and says nothing it does not know', () => {
    expect(airportLabel('hyd')).toBe('Hyderabad (HYD)');
    expect(airportSubLabel('HYD')).toBe('HYD, Rajiv Gandhi International Airport');
    expect(airportSubLabel('CJB')).toBe('CJB, India'); // the site has no airport name for it: just the code and country
    expect(airportLabel('ZZZ')).toBe('ZZZ');
  });

  it('offers the popular airports before anything is typed, and finds by code, city or country', () => {
    expect(matchAirports('').map((a) => a.code)).toEqual(['HYD', 'DEL', 'BLR', 'CCU', 'BKK', 'JED']);
    expect(matchAirports('blr')[0].code).toBe('BLR');
    expect(matchAirports('thai')[0].code).toBe('BKK');
    expect(matchAirports('saudi').map((a) => a.code).sort()).toEqual(['JED', 'MED']);
    expect(matchAirports('qqqq')).toEqual([]);
    expect(AIRPORTS).toHaveLength(18);
  });
});

describe('a quote request', () => {
  it('says plainly what was asked, to whom, and that no fare was shown or booked', () => {
    const s = base({ trip: 'round', ret: '2026-10-30', cabin: 'Premium Economy', fare: 'student', party: { adults: 2, children: 1, infants: 0 } });
    const r = buildFlightQuoteRequest({ search: s, name: ' Asha Rao ', email: ' asha@example.com ', mobile: ' +919876543210 ' });
    expect(r.subject).toBe(FLIGHT_QUOTE_SUBJECT);
    expect(r.name).toBe('Asha Rao');
    expect(r.email).toBe('asha@example.com');
    expect(r.message).toContain('Trip: Round trip');
    expect(r.message).toContain('Hyderabad (HYD) to Delhi (DEL)');
    expect(r.message).toContain('Returning ');
    expect(r.message).toContain('Passengers: 2 Adults, 1 Child');
    expect(r.message).toContain('Cabin: Premium Economy');
    expect(r.message).toContain('Fare type asked for: Student');
    expect(r.message).toContain('Mobile: +919876543210');
    expect(r.message).toContain('The app showed no fares and took no booking or payment for this trip.');
    expect(r.message.length).toBeLessThanOrEqual(5000);
  });

  it('lists every flight of a multi-city trip, and leaves out a mobile that was not given', () => {
    const s = base({ trip: 'multi', legs: [{ from: 'HYD', to: 'DEL', date: '2026-10-25' }, { from: 'DEL', to: 'BKK', date: '2026-10-27' }] });
    expect(describeTrip(s)).toEqual([
      expect.stringContaining('Flight 1: Hyderabad (HYD) to Delhi (DEL), departing'),
      expect.stringContaining('Flight 2: Delhi (DEL) to Bangkok (BKK), departing'),
    ]);
    const r = buildFlightQuoteRequest({ search: s, name: 'A', email: 'a@example.com' });
    expect(r.message).toContain('Flight 2: Delhi (DEL) to Bangkok (BKK)');
    expect(r.message).not.toContain('Mobile:');
  });

  it('knows every cabin and fare the website offers', () => {
    expect(CABINS).toEqual(['Economy', 'Premium Economy', 'Business', 'First']);
    expect(FARES.map((f) => f.label)).toEqual(['Regular', 'Student', 'Armed Forces', 'Senior Citizen', 'Marine Fare']);
  });
});
