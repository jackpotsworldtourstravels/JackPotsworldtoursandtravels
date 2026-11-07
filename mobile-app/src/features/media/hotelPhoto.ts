import type { ProviderImage } from '@/types/discovery';

import { curatedPhotoUrl, type PhotoSize } from './mediaUrl';

/**
 * Which photograph may represent a hotel. A port of
 * frontend/assets/js/hotel-image-map.js, whose rule is non-negotiable:
 *
 *   NEVER SHOW AN IMAGE OF A DIFFERENT HOTEL AS THOUGH IT REPRESENTED THIS ONE.
 *
 * There are exactly four answers, and the caller is always told which:
 *
 *   property     a photograph verified to be of THIS property: either the
 *                content provider's own photo (keyed on the supplier's id), or
 *                a curated file matched on name AND city AND area
 *   destination  no verified photo exists, so a photograph of the CITY, which
 *                the screen must label "not a photo of this hotel"
 *   placeholder  neither exists: an honest branded panel
 *
 * The API's own `image` key is deliberately ignored. The seed data pointed it at
 * a chain's file ("Taj anything" became the Taj Mahal Palace in Mumbai), so it is
 * not evidence of identity.
 *
 * KEEP THIS IN STEP WITH THE WEBSITE. tests/features/hotelPhoto.parity.test.ts
 * reads the website's file (when it is present in the repository) and fails if
 * the tables below differ.
 */

export type HotelPhotoKind = 'property' | 'destination' | 'placeholder';

export interface HotelPhoto {
  kind: HotelPhotoKind;
  uri: string | null;
  /** Short caption for the picture itself; empty for a verified property photo. */
  note: string;
  alt: string;
}

export interface HotelIdentityInput {
  name?: string | null;
  location?: string | null;
  city?: string | null;
  source?: string | null;
  hotelbeds_code?: number | string | null;
  provider_images?: ProviderImage[] | null;
}

const NOISE = new Set(['the', 'hotel', 'hotels', 'and', 'by', 'a', 'an', 'at', 'resort', 'resorts', 'spa']);

export function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Spellings a feed actually uses -> the one key the tables below are in. */
export const CITY_ALIASES: Record<string, string> = {
  bangalore: 'bengaluru', bengaluru: 'bengaluru',
  bombay: 'mumbai', mumbai: 'mumbai',
  'new delhi': 'delhi', delhi: 'delhi',
  hyderabad: 'hyderabad', secunderabad: 'hyderabad',
  srinagar: 'kashmir', kashmir: 'kashmir',
  calcutta: 'kolkata', kolkata: 'kolkata',
  panaji: 'goa', panjim: 'goa', goa: 'goa',
  bangkok: 'bangkok', phuket: 'phuket',
  male: 'maldives', maldives: 'maldives',
  singapore: 'singapore', dubai: 'dubai', jaipur: 'jaipur',
  bali: 'bali', tirupati: 'tirupati', tirumala: 'tirupati',
  vijayawada: 'vijayawada', venice: 'venice', london: 'london',
  cologne: 'cologne', washington: 'washington dc', 'washington dc': 'washington dc',
  gurgaon: 'gurugram', gurugram: 'gurugram',
};

export function cityKey(s: string | null | undefined): string {
  const n = norm(s);
  if (!n) return '';
  if (CITY_ALIASES[n]) return CITY_ALIASES[n];
  // "Hyderabad, Telangana" and "HITEC City Hyderabad" both carry the city as a
  // word; take the first known one.
  for (const k of Object.keys(CITY_ALIASES)) {
    if (` ${n} `.includes(` ${k} `)) return CITY_ALIASES[k];
  }
  return n;
}

interface Identity {
  name: string;
  location: string;
  city: string;
}

export function identity(h: HotelIdentityInput): Identity {
  const name = h.name ?? '';
  const location = h.location ?? '';
  const parts = String(location).split(',').map((s) => s.trim()).filter(Boolean);
  const city = cityKey(h.city || parts[parts.length - 1] || '') || cityKey(name);
  return { name, location, city };
}

export interface VerifiedProperty {
  slug: string;
  subject: string;
  names: string[];
  city: string;
  areas: string[];
  unique?: boolean;
}

/**
 * One row per photograph in assets/hotels/ that is of a known property. A hotel
 * matches only when its name (with the city, area and filler words taken out) is
 * one of `names`, its city is `city`, and one of `areas` appears in its name or
 * address. Anything less (a chain, a city, a guess) is not this property.
 */
export const VERIFIED_PROPERTIES: VerifiedProperty[] = [
  { slug: 'novotel-bengaluru', subject: 'Novotel Bengaluru Outer Ring Road',
    names: ['novotel'], city: 'bengaluru', areas: ['outer ring road', 'orr'] },
  { slug: 'novotel-hyderabad', subject: 'Novotel Hyderabad Airport',
    names: ['novotel'], city: 'hyderabad', areas: ['airport', 'shamshabad', 'rgia'] },
  { slug: 'taj-palace', subject: 'The Taj Mahal Palace, Mumbai',
    names: ['taj mahal palace', 'taj mahal'], city: 'mumbai', areas: ['colaba', 'apollo bunder'], unique: true },
  { slug: 'hyatt-regency', subject: 'Hyatt Regency London – The Churchill',
    names: ['hyatt regency', 'hyatt regency churchill', 'hyatt regency london churchill'], city: 'london', areas: ['portman square', 'churchill'] },
  { slug: 'radisson', subject: 'Radisson Blu Hotel, Cologne',
    names: ['radisson blu', 'radisson'], city: 'cologne', areas: ['messe', 'deutz', 'cologne'] },
  { slug: 'marriott', subject: 'Washington Marriott Marquis',
    names: ['marriott marquis', 'washington marriott marquis'], city: 'washington dc', areas: ['mount vernon'], unique: true },
  { slug: 'hilton', subject: 'Hilton Molino Stucky Venice',
    names: ['hilton molino stucky', 'hilton molino stucky venice'], city: 'venice', areas: ['giudecca'], unique: true },
  { slug: 'oberoi', subject: 'The Oberoi, Gurgaon',
    names: ['oberoi', 'oberoi gurgaon', 'oberoi gurugram'], city: 'gurugram', areas: ['nh 8', 'nh8'], unique: true },
  { slug: 'atlantis-the-palm', subject: 'Atlantis The Palm, Dubai',
    names: ['atlantis palm', 'atlantis'], city: 'dubai', areas: ['palm'], unique: true },
  { slug: 'marina-bay-sands', subject: 'Marina Bay Sands, Singapore',
    names: ['marina bay sands'], city: 'singapore', areas: ['bayfront'], unique: true },
];

export interface CityPhoto {
  dir: 'destinations' | 'locations';
  file: string;
  subject: string;
}

/** Verified photographs OF THE CITY: a landmark or a street, never a hotel. */
export const CITY_PHOTOS: Record<string, CityPhoto> = {
  hyderabad: { dir: 'destinations', file: 'hyderabad', subject: 'Charminar, Hyderabad' },
  bengaluru: { dir: 'destinations', file: 'bengaluru', subject: 'Vidhana Soudha, Bengaluru' },
  delhi: { dir: 'destinations', file: 'delhi', subject: 'Humayun’s Tomb, Delhi' },
  dubai: { dir: 'destinations', file: 'dubai', subject: 'Downtown Dubai' },
  goa: { dir: 'destinations', file: 'goa', subject: 'Palolem Beach, Goa' },
  jaipur: { dir: 'destinations', file: 'jaipur', subject: 'Hawa Mahal, Jaipur' },
  kashmir: { dir: 'destinations', file: 'kashmir', subject: 'Dal Lake, Srinagar' },
  kolkata: { dir: 'destinations', file: 'kolkata', subject: 'Victoria Memorial, Kolkata' },
  mumbai: { dir: 'destinations', file: 'mumbai', subject: 'Gateway of India, Mumbai' },
  bali: { dir: 'destinations', file: 'bali', subject: 'Tanah Lot, Bali' },
  bangkok: { dir: 'destinations', file: 'thailand', subject: 'Wat Arun, Bangkok' },
  tirupati: { dir: 'destinations', file: 'tirupati', subject: 'Tirumala, Tirupati' },
  vijayawada: { dir: 'destinations', file: 'vijayawada', subject: 'Prakasam Barrage, Vijayawada' },
  // The destination set's own files for these two are hotels.
  singapore: { dir: 'locations', file: 'singapore__merlion-park', subject: 'Merlion Park, Singapore' },
  maldives: { dir: 'locations', file: 'maldives__artificial-beach', subject: 'Artificial Beach, Malé' },
};

function verifiedProperty(id: Identity): VerifiedProperty | null {
  const hay = ` ${norm(`${id.name} ${id.location}`)} `;
  for (const p of VERIFIED_PROPERTIES) {
    if (p.city !== id.city) continue;
    // `unique`: a name only one building in the world carries needs no area.
    if (!p.unique && !p.areas.some((a) => hay.includes(` ${a} `))) continue;

    const cityWords = new Set([
      ...Object.keys(CITY_ALIASES)
        .filter((k) => CITY_ALIASES[k] === p.city)
        .join(' ')
        .split(' '),
      ...NOISE,
    ]);
    const areaWords = new Set(p.areas.join(' ').split(' '));
    const withArea = norm(id.name).split(' ').filter((t) => t && !cityWords.has(t));
    const core = withArea.filter((t) => !areaWords.has(t));
    if (p.names.includes(withArea.join(' ')) || p.names.includes(core.join(' '))) return p;
  }
  return null;
}

/**
 * A content provider's photograph is trusted only when the row carries a real
 * supplier identity (`source === 'hotelbeds'` or a `hotelbeds_code`); an images
 * array on a seed row is ignored, which is what stops a seed row borrowing
 * supplier imagery. Only https URLs are used.
 */
function providerPhoto(id: Identity, h: HotelIdentityInput): HotelPhoto | null {
  const hasIdentity =
    h.source === 'hotelbeds' || (h.hotelbeds_code !== null && h.hotelbeds_code !== undefined && h.hotelbeds_code !== '');
  if (!hasIdentity) return null;
  const images = (h.provider_images ?? []).filter((im) => im && typeof im.url === 'string' && im.url.startsWith('https://'));
  if (images.length === 0) return null;
  const pick = images.find((im) => im.is_primary) ?? images[0];
  return {
    kind: 'property',
    uri: pick.large || pick.url,
    note: '',
    alt: `${id.name || 'This hotel'}: photograph of the property`,
  };
}

export function resolveHotelPhoto(
  hotel: HotelIdentityInput,
  options: { size?: PhotoSize; allowDestination?: boolean } = {},
): HotelPhoto {
  const { size = 'card', allowDestination = true } = options;
  const id = identity(hotel);
  const name = id.name || 'This hotel';

  const provider = providerPhoto(id, hotel);
  if (provider) return provider;

  const property = verifiedProperty(id);
  if (property) {
    return {
      kind: 'property',
      uri: curatedPhotoUrl('hotels', property.slug, size),
      note: '',
      alt: `${name}: photograph of the property`,
    };
  }

  const city = allowDestination ? CITY_PHOTOS[id.city] : undefined;
  if (city) {
    return {
      kind: 'destination',
      uri: curatedPhotoUrl(city.dir, city.file, size),
      note: 'Destination photo, not this hotel',
      alt: `${city.subject}: a photograph of the destination, not of ${name}`,
    };
  }

  return {
    kind: 'placeholder',
    uri: null,
    note: 'Hotel photo unavailable',
    alt: `No verified photograph of ${name} is available`,
  };
}
