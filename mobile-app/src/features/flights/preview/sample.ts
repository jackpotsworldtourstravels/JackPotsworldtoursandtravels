import { addDays, type ISODate } from '@/utils/dates';

import { airportByCode } from '../airports';
import type { Cabin, FlightSearch } from '../flightForm';

/**
 * SAMPLE FLIGHTS, FOR THE UI-ONLY BOOKING FLOW.
 *
 * There is no flight supplier behind the app yet, so these are invented, deterministically, from the route and the
 * date: the same search always shows the same flights, which makes the screens reviewable. The airlines are
 * fictional on purpose, and every screen that shows these says they are samples. When a supplier is connected its
 * results replace `sampleFlights`; nothing else in the flow needs to change.
 */

export interface SampleAirline {
  name: string;
  code: string;
  color: string;
}

export const SAMPLE_AIRLINES: readonly SampleAirline[] = [
  { name: 'Sapphire Air', code: 'SA', color: '#1D4E89' },
  { name: 'Monsoon Air', code: 'MA', color: '#0F766E' },
  { name: 'Coral Airways', code: 'CA', color: '#9A3412' },
];

export interface FlightLeg {
  from: string;
  to: string;
  date: ISODate;
}

export interface SampleFlight {
  id: string;
  airline: SampleAirline;
  number: string;
  aircraft: string;
  dep: string;
  arr: string;
  /** "+1" when it lands the next day. */
  arrDayShift: number;
  minutes: number;
  stops: 0 | 1;
  via: string | null;
  /** Per adult, in rupees, as a decimal string like the rest of the app's money. */
  price: string;
  fare: 'Saver' | 'Flexi';
  checkinKg: number;
  cabinKg: number;
  freeMeal: boolean;
}

/** The flights of a search, in order: one, two (round trip), or two to five (multi city). Incomplete legs are dropped. */
export function legsOf(search: FlightSearch): FlightLeg[] {
  const ok = (l: { from: string | null; to: string | null; date: ISODate | null }): l is FlightLeg => Boolean(l.from && l.to && l.date);
  if (search.trip === 'multi') return search.legs.filter(ok);
  const out = [{ from: search.from, to: search.to, date: search.depart }];
  if (search.trip === 'round') out.push({ from: search.to, to: search.from, date: search.ret });
  return out.filter(ok);
}

/** True when any airport on the trip is outside India: passports are then asked for. */
export function isInternational(legs: readonly FlightLeg[]): boolean {
  return legs.some((l) => [l.from, l.to].some((c) => (airportByCode(c)?.country ?? 'India') !== 'India'));
}

function seed(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const CABIN_FACTOR: Record<Cabin, number> = { Economy: 1, 'Premium Economy': 1.8, Business: 3.6, First: 5.5 };
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (mins: number) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
const HUBS = ['BOM', 'BLR', 'MAA', 'AMD'];

export function sampleFlights(leg: FlightLeg, cabin: Cabin): SampleFlight[] {
  const rnd = seed(`${leg.from}-${leg.to}-${leg.date}`);
  const international = isInternational([leg]);
  const base = international ? 14000 + rnd() * 9000 : 3800 + rnd() * 3200;
  const duration = Math.round((international ? 210 : 105) + rnd() * 70);
  const departures = [6 * 60 + 10, 7 * 60 + 40, 10 * 60 + 35, 13 * 60 + 5, 16 * 60 + 50, 19 * 60 + 30, 21 * 60 + 55];
  return departures.map((dep, i) => {
    const airline = SAMPLE_AIRLINES[Math.floor(rnd() * SAMPLE_AIRLINES.length)];
    const stops: 0 | 1 = i === 3 || i === 5 ? 1 : 0;
    const via = stops ? (HUBS.find((h) => h !== leg.from && h !== leg.to) ?? null) : null;
    const minutes = duration + (stops ? 95 + Math.round(rnd() * 60) : Math.round(rnd() * 15));
    const shift = (dep + minutes) >= 24 * 60 ? 1 : 0;
    const time = [0.92, 0.85, 1.05, 0.9, 1.12, 1, 0.88][i];
    const price = Math.round((base * time * (stops ? 0.86 : 1) * CABIN_FACTOR[cabin]) / 10) * 10;
    return {
      id: `${leg.from}${leg.to}${leg.date}-${i}`,
      airline,
      number: `${airline.code} ${200 + Math.floor(rnd() * 700)}`,
      aircraft: rnd() > 0.5 ? 'A320neo' : 'A321',
      dep: clock(dep),
      arr: clock(dep + minutes),
      arrDayShift: shift,
      minutes,
      stops,
      via,
      price: price.toFixed(2),
      fare: rnd() > 0.7 ? 'Flexi' : 'Saver',
      checkinKg: international ? 25 : 15,
      cabinKg: 7,
      freeMeal: rnd() > 0.6,
    };
  });
}

/** The cheapest sample fare on each of five days around a date, for the date strip. */
export function sampleDayPrices(leg: FlightLeg, cabin: Cabin): { date: ISODate; price: string }[] {
  return [-2, -1, 0, 1, 2].map((d) => {
    const date = addDays(leg.date, d);
    const cheapest = sampleFlights({ ...leg, date }, cabin).reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
    return { date, price: cheapest.price };
  });
}

export const durationLabel = (mins: number) => `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;

/** Taxes and airport fees on a sample fare: a flat 18% so the breakdown reads like a real one. */
export const sampleTaxes = (base: number) => Math.round(base * 0.18);
