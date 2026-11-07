import { env } from '@/config/env';

/**
 * Photographs are not duplicated into the app. They are the website's own files,
 * served by the same origin as the API (frontend/assets/..., mounted by the
 * backend in production and in local development). One copy to maintain, one set
 * of licences and credits.
 *
 * The API sends image KEYS, not URLs, so the path is derived here from keys that
 * come off the network. A key is accepted only if it is a plain slug: anything
 * with a slash or dots ("../../x") is refused rather than joined into a URL.
 */
const SAFE_KEY = /^[a-z0-9]+(?:[_-][a-z0-9]+)*(?:__[a-z0-9]+(?:[_-][a-z0-9]+)*)?$/;

export function isSafeKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.length <= 120 && SAFE_KEY.test(key);
}

/** A file under the site's `assets/` tree. */
export function siteAssetUrl(path: string): string {
  return `${env.apiBaseUrl}/${path.replace(/^\/+/, '')}`;
}

export type PhotoSize = 'card' | 'hero';

const DESTINATIONS_DIR = 'assets/destinations/';
const LOCATIONS_DIR = 'assets/locations/';
const HOTELS_DIR = 'assets/hotels/';

/** `card` is the 480px file, `hero` the 960px one. Files are WebP. */
function withSize(base: string, size: PhotoSize): string {
  return size === 'card' ? `${base}-480.webp` : `${base}.webp`;
}

/** A destination's photograph, by the destination's slug ("goa"). */
export function destinationPhotoUrl(key: string | null | undefined, size: PhotoSize = 'card'): string | null {
  return isSafeKey(key) && !key.includes('__') ? siteAssetUrl(withSize(`${DESTINATIONS_DIR}${key}`, size)) : null;
}

/** A place's photograph, by its attraction id ("hyderabad__charminar"). May not exist; see RemoteImage. */
export function attractionPhotoUrl(id: string | null | undefined, size: PhotoSize = 'card'): string | null {
  return isSafeKey(id) && id.includes('__') ? siteAssetUrl(withSize(`${LOCATIONS_DIR}${id}`, size)) : null;
}

/**
 * A package's photograph. Its `image` is a destination slug ("goa") for a
 * destination package and an attraction id ("goa__fort-aguada") for a themed one.
 */
export function packagePhotoUrl(key: string | null | undefined, size: PhotoSize = 'card'): string | null {
  if (!isSafeKey(key)) return null;
  return key.includes('__') ? attractionPhotoUrl(key, size) : destinationPhotoUrl(key, size);
}

/** Hotel and city files named by the resolver in hotelPhoto.ts. */
export function curatedPhotoUrl(dir: 'destinations' | 'locations' | 'hotels', file: string, size: PhotoSize): string {
  const base = dir === 'destinations' ? DESTINATIONS_DIR : dir === 'locations' ? LOCATIONS_DIR : HOTELS_DIR;
  return siteAssetUrl(withSize(`${base}${file}`, size));
}

/** The website's hero photograph (CC0), used behind the Home headline. */
export function heroPhotoUrl(): string {
  return siteAssetUrl('assets/images/hero-dubai-960.webp');
}
