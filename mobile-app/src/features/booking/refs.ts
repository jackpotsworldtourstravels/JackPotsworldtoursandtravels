/**
 * Booking references: `JPH000123` (hotel), `JPP000123` (package), `JPB000123`
 * (flight). They are guessable sequence numbers, so a reference is never proof
 * of anything on its own; the backend scopes every lookup to the signed-in
 * customer and answers 404 for anyone else's. The app only checks the SHAPE,
 * because a reference arrives from a route and is joined into a URL.
 */
export type BookingKind = 'hotel' | 'package' | 'flight';

const REF_RE = /^JP([HPB])(\d{4,12})$/;

export function parseBookingRef(ref: string | null | undefined): { ref: string; kind: BookingKind } | null {
  const m = typeof ref === 'string' ? REF_RE.exec(ref.trim().toUpperCase()) : null;
  if (!m) return null;
  const kind: BookingKind = m[1] === 'H' ? 'hotel' : m[1] === 'P' ? 'package' : 'flight';
  return { ref: `JP${m[1]}${m[2]}`, kind };
}

/** A route parameter that must be a positive integer id, or null. */
export function parseId(value: string | string[] | null | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}
