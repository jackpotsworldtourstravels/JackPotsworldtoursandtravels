import type { ContactPayload } from '@/features/account/support';
import { formatShortDate } from '@/utils/dates';

import { airportLabel } from './airports';
import { FARES, partySummary, type FlightSearch } from './flightForm';

export const FLIGHT_QUOTE_SUBJECT = 'Flight quote request';

const date = (d: string | null) => (d ? formatShortDate(d) : 'no date');

/** The trip, in the words the desk will read. */
export function describeTrip(search: FlightSearch): string[] {
  if (search.trip === 'multi') {
    return search.legs.map((l, i) => `Flight ${i + 1}: ${airportLabel(l.from)} to ${airportLabel(l.to)}, departing ${date(l.date)}`);
  }
  const lines = [`${airportLabel(search.from)} to ${airportLabel(search.to)}, departing ${date(search.depart)}`];
  if (search.trip === 'round') lines.push(`Returning ${date(search.ret)}`);
  return lines;
}

const TRIP_LABEL = { oneway: 'One way', round: 'Round trip', multi: 'Multi city' } as const;

/**
 * A request for a quote on a flight, sent to the desk by email (the website's contact channel). The app does not show
 * live fares or sell flights, and the text says so, so nobody reading it believes the customer saw a price.
 */
export function buildFlightQuoteRequest(input: {
  search: FlightSearch;
  name: string;
  email: string;
  mobile?: string;
}): ContactPayload {
  const { search } = input;
  const fare = FARES.find((f) => f.id === search.fare)?.label ?? 'Regular';
  const mobile = input.mobile?.trim();
  const lines = [
    'Please quote me for this flight (sent from the mobile app).',
    '',
    `Trip: ${TRIP_LABEL[search.trip]}`,
    ...describeTrip(search),
    `Passengers: ${partySummary(search.party)}`,
    `Cabin: ${search.cabin}`,
    `Fare type asked for: ${fare}`,
    '',
    `Name: ${input.name.trim()}`,
    `Email: ${input.email.trim()}`,
    ...(mobile ? [`Mobile: ${mobile}`] : []),
    '',
    'The app showed no fares and took no booking or payment for this trip.',
  ];
  return { name: input.name.trim(), email: input.email.trim(), subject: FLIGHT_QUOTE_SUBJECT, message: lines.join('\n').slice(0, 5000) };
}
