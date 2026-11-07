import { norm } from '@/features/media/hotelPhoto';
import type { Destination } from '@/types/discovery';

/**
 * Filter destinations by what a person types: name or country, ignoring case,
 * accents and punctuation, in the order the backend listed them. An empty query
 * returns everything.
 */
export function filterDestinations(destinations: readonly Destination[], query: string): Destination[] {
  const q = norm(query);
  if (!q) return [...destinations];
  return destinations.filter((d) => norm(`${d.name} ${d.country ?? ''}`).includes(q));
}

/** The destination with this slug, or null. */
export function findDestination(destinations: readonly Destination[] | undefined, id: string | undefined): Destination | null {
  if (!destinations || !id) return null;
  return destinations.find((d) => d.id === id) ?? null;
}

export type RegionFilter = 'all' | 'india' | 'international';

/** India versus the rest, by the destination's country. */
export function filterByRegion(destinations: readonly Destination[], region: RegionFilter): Destination[] {
  if (region === 'all') return [...destinations];
  const isIndia = (d: Destination) => (d.country ?? '').trim().toLowerCase() === 'india';
  return destinations.filter((d) => (region === 'india' ? isIndia(d) : !isIndia(d)));
}
