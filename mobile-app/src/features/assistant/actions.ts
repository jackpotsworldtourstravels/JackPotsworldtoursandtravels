import type { Href } from 'expo-router';

import type { AssistantAction } from '@/api/endpoints/assistant';

export interface ActionLink {
  label: string;
  icon: 'bed-outline' | 'map-outline' | 'airplane-outline' | 'compass-outline' | 'headset-outline' | 'ticket-outline';
  href: Href;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** "Banjara Hills" -> "banjara-hills": the catalogue's destination ids are slugs of their names. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The app screen an assistant action opens, as a card under the reply. Only what the traveller said is carried; the
 * screen it opens runs its own search, so nothing here can show a price the server did not give. `none` and any type
 * this app version doesn't know open nothing.
 */
export function actionLink(action: AssistantAction | null | undefined): ActionLink | null {
  if (!action) return null;
  const dest = text(action.params.dest) ?? text(action.params.destination);
  switch (action.type) {
    case 'search_hotels':
    case 'hotels_near':
      return dest
        ? { label: `Hotels in ${dest}`, icon: 'bed-outline', href: { pathname: '/hotels', params: { destination: slug(dest) } } }
        : { label: 'Search hotels', icon: 'bed-outline', href: '/search/hotels' };
    case 'search_packages':
    case 'show_packages':
      return dest
        ? { label: `Holiday packages in ${dest}`, icon: 'map-outline', href: { pathname: '/packages', params: { destination: dest } } }
        : { label: 'Holiday packages', icon: 'map-outline', href: '/packages' };
    case 'search_flights':
      return { label: 'Search flights', icon: 'airplane-outline', href: '/flights' };
    case 'open_destination':
    case 'show_destination':
      return dest
        ? { label: `Explore ${dest}`, icon: 'compass-outline', href: { pathname: '/destination/[id]', params: { id: slug(dest) } } }
        : { label: 'Explore destinations', icon: 'compass-outline', href: '/explore' };
    case 'show_destinations':
    case 'show_places':
      return { label: 'Explore destinations', icon: 'compass-outline', href: '/explore' };
    case 'open_support':
      return { label: 'Talk to our team', icon: 'headset-outline', href: '/support' };
    case 'open_bookings':
      return { label: 'My trips', icon: 'ticket-outline', href: '/bookings' };
    default:
      return null;
  }
}
