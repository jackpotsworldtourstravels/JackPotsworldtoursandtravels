import { useSyncExternalStore } from 'react';

import type { FlightSearch } from '../flightForm';

import type { SampleFlight } from './sample';

/**
 * The trip being put together in the flight booking flow: what was searched, the flight picked for each leg, who is
 * travelling, their seats and extras. One shared store, so every screen of the flow reads and edits the same trip and
 * Back never loses anything. It lives for the app session only; nothing here is a booking.
 */

export interface PassengerDraft {
  type: 'adult' | 'child' | 'infant';
  title: string;
  firstName: string;
  middleName: string;
  lastName: string;
  dateOfBirth: string;
  nationality: string;
  passportNumber: string;
  passportExpiry: string;
  frequentFlyer: string;
}

export type Wheelchair = 'distance' | 'steps' | 'full' | null;

export interface AssistanceDraft {
  wheelchair: Wheelchair;
  ownMobilityAid: boolean;
  visionOrHearing: boolean;
  medical: boolean;
  infant: boolean;
  notes: string;
}

export interface TripDraft {
  search: FlightSearch | null;
  picks: (SampleFlight | null)[];
  passengers: PassengerDraft[];
  contactEmail: string;
  contactMobile: string;
  /** seats[leg][passenger] = "12C" */
  seats: Record<number, Record<number, string>>;
  /** meals[passenger] = meal id, applied to every flight */
  meals: Record<number, string>;
  /** extra check-in kg per passenger, every flight */
  baggage: Record<number, number>;
  assistance: Record<number, AssistanceDraft>;
  priority: boolean;
  insurance: boolean;
}

export const emptyPassenger = (type: PassengerDraft['type']): PassengerDraft => ({
  type,
  title: '',
  firstName: '',
  middleName: '',
  lastName: '',
  dateOfBirth: '',
  nationality: 'Indian',
  passportNumber: '',
  passportExpiry: '',
  frequentFlyer: '',
});

export const emptyAssistance = (): AssistanceDraft => ({ wheelchair: null, ownMobilityAid: false, visionOrHearing: false, medical: false, infant: false, notes: '' });

const fresh = (): TripDraft => ({
  search: null,
  picks: [],
  passengers: [],
  contactEmail: '',
  contactMobile: '',
  seats: {},
  meals: {},
  baggage: {},
  assistance: {},
  priority: false,
  insurance: false,
});

let state: TripDraft = fresh();
const listeners = new Set<() => void>();

export const tripDraft = {
  get: () => state,
  set(change: Partial<TripDraft> | ((s: TripDraft) => Partial<TripDraft>)) {
    state = { ...state, ...(typeof change === 'function' ? change(state) : change) };
    listeners.forEach((l) => l());
  },
  /** A new search starts a new trip: nothing picked for the old one carries over. */
  start(search: FlightSearch, legs: number) {
    const party = search.party;
    state = {
      ...fresh(),
      search,
      picks: Array.from({ length: legs }, () => null),
      passengers: [
        ...Array.from({ length: party.adults }, () => emptyPassenger('adult')),
        ...Array.from({ length: party.children }, () => emptyPassenger('child')),
        ...Array.from({ length: party.infants }, () => emptyPassenger('infant')),
      ],
    };
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useTripDraft(): TripDraft {
  return useSyncExternalStore(tripDraft.subscribe, tripDraft.get, tripDraft.get);
}

/** "Asha Rao", or "Adult 1" until a name is typed. */
export function passengerName(p: PassengerDraft, index: number, all: readonly PassengerDraft[]): string {
  const name = `${p.firstName} ${p.lastName}`.trim();
  if (name) return name;
  const n = all.slice(0, index + 1).filter((x) => x.type === p.type).length;
  return `${p.type[0].toUpperCase()}${p.type.slice(1)} ${n}`;
}

/** Infants sit on a lap: no seat, no meal, no extra bag of their own. */
export const seated = (p: PassengerDraft) => p.type !== 'infant';
