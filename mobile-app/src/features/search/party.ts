/**
 * The travelling party for a hotel stay.
 *
 * Limits are the backend's own for a stay (`StayInput` in
 * backend/app/schemas/customer_hotel_booking.py): 1-4 rooms, 1-32 adults,
 * 0-16 children. They are applied here so the form can't build a party the
 * booking call would refuse; the server still checks.
 */
export interface Party {
  rooms: number;
  adults: number;
  children: number;
}

export const PARTY_LIMITS = {
  rooms: { min: 1, max: 4 },
  adults: { min: 1, max: 32 },
  children: { min: 0, max: 16 },
} as const;

export const DEFAULT_PARTY: Party = { rooms: 1, adults: 2, children: 0 };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(n) || min));

/** Clamp each count, and never fewer adults than rooms (an empty room is not a booking). */
export function normaliseParty(party: Party): Party {
  const rooms = clamp(party.rooms, PARTY_LIMITS.rooms.min, PARTY_LIMITS.rooms.max);
  const adults = clamp(Math.max(party.adults, rooms), PARTY_LIMITS.adults.min, PARTY_LIMITS.adults.max);
  const children = clamp(party.children, PARTY_LIMITS.children.min, PARTY_LIMITS.children.max);
  return { rooms, adults, children };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 room · 2 adults" or "2 rooms · 4 adults · 1 child" */
export function partySummary(party: Party): string {
  const parts = [plural(party.rooms, 'room'), plural(party.adults, 'adult')];
  if (party.children > 0) parts.push(plural(party.children, 'child', 'children'));
  return parts.join(' · ');
}
