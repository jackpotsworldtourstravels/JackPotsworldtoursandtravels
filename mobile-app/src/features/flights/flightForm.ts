import { z } from 'zod';

import { addDays, isISODate, type ISODate } from '@/utils/dates';

import { airportByCode } from './airports';

/**
 * THE WEBSITE'S FLIGHT SEARCH, AS RULES.
 *
 * Every option and every message here is from the website's booking card
 * (`frontend/assets/js/booking-card.js`: trip types, cabins, special fares, `VALIDATORS.flights`,
 * `MAX_LEGS`) and its passenger selector (`pax-selector.js`: the four rules). The app searches
 * nothing: there is no live flight supplier behind it (see `FlightsUnavailable`), but the form
 * asks what the site asks and refuses what the site refuses.
 * `tests/features/flights.parity.test.ts` reads those files and fails on drift.
 */
export type TripType = 'oneway' | 'round' | 'multi';

export const TRIP_TYPES: readonly { id: TripType; label: string }[] = [
  { id: 'oneway', label: 'One Way' },
  { id: 'round', label: 'Round Trip' },
  { id: 'multi', label: 'Multi City' },
];

export const CABINS = ['Economy', 'Premium Economy', 'Business', 'First'] as const;
export type Cabin = (typeof CABINS)[number];

/** "Select a special fare". The notes are the site's own. */
export const FARES = [
  { id: 'regular', label: 'Regular', note: 'Regular fares' },
  { id: 'student', label: 'Student', note: 'Extra discounts/baggage' },
  { id: 'armed', label: 'Armed Forces', note: 'Up to ₹ 600 off' },
  { id: 'senior', label: 'Senior Citizen', note: 'Up to ₹ 600 off' },
  { id: 'marine', label: 'Marine Fare', note: 'Up to ₹ 600 off' },
] as const;
export type FareId = (typeof FARES)[number]['id'];

/** A multi-city itinerary has at least two flights and at most five (`MAX_LEGS`). */
export const MIN_LEGS = 2;
export const MAX_LEGS = 5;

/** `pax-selector.js`: at most 9 seated passengers, one adult at least, children and infants never outnumber adults. */
export const PAX = { MAX_SEATED: 9, MAX_ADULTS: 9, MAX_CHILDREN: 6, MAX_INFANTS: 6 } as const;

export interface FlightParty {
  adults: number;
  children: number;
  infants: number;
}

export const DEFAULT_FLIGHT_PARTY: FlightParty = { adults: 1, children: 0, infants: 0 };

export function maxChildren(adults: number): number {
  return Math.max(0, Math.min(PAX.MAX_CHILDREN, adults, PAX.MAX_SEATED - adults));
}

/** Infants ride on a lap: one per adult, never more than six. */
export function maxInfants(adults: number): number {
  return Math.max(0, Math.min(PAX.MAX_INFANTS, adults));
}

const toInt = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback);

/** Any party forced into a legal one. Adults settle first; children and infants are clamped against them. */
export function clampParty(value: Partial<FlightParty> | null | undefined): FlightParty {
  const adults = Math.min(PAX.MAX_ADULTS, Math.max(1, toInt(value?.adults, 1)));
  return {
    adults,
    children: Math.min(maxChildren(adults), Math.max(0, toInt(value?.children, 0))),
    infants: Math.min(maxInfants(adults), Math.max(0, toInt(value?.infants, 0))),
  };
}

export function isValidParty(value: Partial<FlightParty> | null | undefined): boolean {
  const c = clampParty(value);
  return c.adults === value?.adults && c.children === value?.children && c.infants === value?.infants;
}

/** "2 Adults, 1 Child": zeroes are left out, as the site prints it. */
export function partySummary(value: FlightParty): string {
  const v = clampParty(value);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [plural(v.adults, 'Adult', 'Adults')];
  if (v.children) parts.push(plural(v.children, 'Child', 'Children'));
  if (v.infants) parts.push(plural(v.infants, 'Infant', 'Infants'));
  return parts.join(', ');
}

export interface Leg {
  from: string | null;
  to: string | null;
  date: ISODate | null;
}

export interface FlightSearch {
  trip: TripType;
  /** One way and round trip. */
  from: string | null;
  to: string | null;
  depart: ISODate | null;
  ret: ISODate | null;
  /** Multi city: two to five flights. */
  legs: Leg[];
  party: FlightParty;
  cabin: Cabin;
  fare: FareId;
}

/** The site opens on Hyderabad to Delhi, one adult, Economy, regular fare. */
export function defaultFlightSearch(today: ISODate): FlightSearch {
  return {
    trip: 'oneway',
    from: 'HYD',
    to: 'DEL',
    depart: today,
    ret: null,
    legs: [
      { from: 'HYD', to: 'DEL', date: today },
      { from: 'DEL', to: null, date: addDays(today, 3) },
    ],
    party: DEFAULT_FLIGHT_PARTY,
    cabin: 'Economy',
    fare: 'regular',
  };
}

/**
 * The first thing wrong with a search, in the site's own words, or null. Same order as
 * `VALIDATORS.flights`: passengers, then (multi city) each flight in turn, otherwise the route and dates.
 */
export function flightProblem(search: FlightSearch): string | null {
  if (!isValidParty(search.party)) return 'That combination of passengers is not allowed.';

  if (search.trip === 'multi') {
    for (let i = 0; i < search.legs.length; i += 1) {
      const leg = search.legs[i];
      const n = i + 1;
      if (!leg.from) return `Choose where flight ${n} departs from.`;
      if (!leg.to) return `Choose where flight ${n} arrives.`;
      if (leg.from === leg.to) return `Flight ${n} cannot start and end in the same city.`;
      if (!leg.date) return `Choose a departure date for flight ${n}.`;
      if (i > 0) {
        const previous = search.legs[i - 1].date;
        if (previous && leg.date < previous) return `Flight ${n} cannot depart before flight ${i}.`;
      }
    }
    return null;
  }

  if (!search.from) return 'Choose where you are flying from.';
  if (!search.to) return 'Choose where you are flying to.';
  if (search.from === search.to) return 'Origin and destination cannot be the same.';
  if (!search.depart) return 'Choose a departure date.';
  if (search.trip === 'round') {
    if (!search.ret) return 'Choose a return date, or switch to One Way.';
    if (search.ret < search.depart) return 'The return date cannot be before departure.';
  }
  return null;
}

/** A search carried in a route parameter. Anything that is not a well-formed search is refused (null), never repaired. */
const isoOrNull = z.union([z.null(), z.string().refine(isISODate)]);
const airportOrNull = z.union([z.null(), z.string().refine((c) => airportByCode(c) !== null)]);
const searchSchema = z.object({
  trip: z.enum(['oneway', 'round', 'multi']),
  from: airportOrNull,
  to: airportOrNull,
  depart: isoOrNull,
  ret: isoOrNull,
  legs: z.array(z.object({ from: airportOrNull, to: airportOrNull, date: isoOrNull })).min(MIN_LEGS).max(MAX_LEGS),
  party: z.object({ adults: z.number(), children: z.number(), infants: z.number() }),
  cabin: z.enum(CABINS),
  fare: z.enum(['regular', 'student', 'armed', 'senior', 'marine']),
});

export function parseFlightSearch(raw: string | null | undefined): FlightSearch | null {
  if (!raw) return null;
  try {
    const parsed = searchSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ...parsed.data, party: clampParty(parsed.data.party) } : null;
  } catch {
    return null;
  }
}
