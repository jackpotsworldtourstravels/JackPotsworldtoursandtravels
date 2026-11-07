import { resolveHotelPhoto, type HotelPhoto } from '@/features/media/hotelPhoto';
import type { PhotoSize } from '@/features/media/mediaUrl';
import type { DestinationHotelItem, HotelListItem } from '@/types/discovery';
import { compareMoney, toDecimalString } from '@/utils/money';

/**
 * One hotel as the screens draw it, built from either of the backend's two hotel
 * shapes (the all-hotels list and a destination's page), which disagree on field
 * names and on whether price and rating are strings or numbers.
 */
export interface HotelCardModel {
  id: string;
  name: string;
  stars: number;
  /** For display only. */
  rating: number | null;
  /** "Banjara Hills, Hyderabad" */
  location: string;
  /** Indicative nightly price as a decimal STRING, never a float. */
  pricePerNight: string | null;
  currency: string;
  amenities: string[];
  freeCancellation: boolean;
  /** What the cheapest room's rate includes first, then the other plans the property offers ("Room only", "Breakfast included"). */
  mealPlans: string[];
  /** Kilometres to the airport, as the server sent it. */
  distanceKm: string | null;
  /** The property's own cancellation sentence. */
  cancellationPolicy: string | null;
}

export function fromListItem(h: HotelListItem): HotelCardModel {
  return {
    id: h.id,
    name: h.name,
    stars: h.stars,
    rating: parseRating(h.guest_rating),
    location: h.location,
    pricePerNight: toDecimalString(h.pricePerNight),
    currency: 'INR',
    amenities: h.amenities ?? [],
    freeCancellation: Boolean(h.free_cancellation),
    mealPlans: h.meal_plans ?? [],
    distanceKm: h.distanceKm ?? null,
    cancellationPolicy: h.cancellation_policy ?? null,
  };
}

/** Where a destination-page hotel is: its `location`, else area and city joined. */
function destinationHotelLocation(h: DestinationHotelItem): string {
  return h.location || [h.location_name, h.city].filter(Boolean).join(', ');
}

export function fromDestinationItem(h: DestinationHotelItem): HotelCardModel {
  return {
    id: h.id,
    name: h.name,
    stars: h.stars,
    rating: parseRating(h.guest_rating),
    location: destinationHotelLocation(h),
    pricePerNight: toDecimalString(h.price_per_night),
    currency: h.currency || 'INR',
    amenities: h.amenities ?? [],
    freeCancellation: h.free_cancellation,
    mealPlans: [],
    distanceKm: h.distance_km === null || h.distance_km === undefined ? null : String(h.distance_km),
    cancellationPolicy: null,
  };
}

/** A guest rating is a rating, not money, so reading it as a number is fine. */
function parseRating(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The photograph for a hotel, under the website's rule that a photo of another
 * hotel is never shown as this one. Takes the raw API row because the verified
 * match needs `source`, `hotelbeds_code` and `provider_images`, which the
 * destination page does not carry (those hotels never get provider photos).
 */
export function photoForListItem(h: HotelListItem, size: PhotoSize = 'card'): HotelPhoto {
  return resolveHotelPhoto(
    {
      name: h.name,
      location: h.location,
      source: h.source,
      hotelbeds_code: h.hotelbeds_code,
      provider_images: h.provider_images,
    },
    { size },
  );
}

export function photoForDestinationItem(h: DestinationHotelItem, size: PhotoSize = 'card'): HotelPhoto {
  return resolveHotelPhoto({ name: h.name, location: destinationHotelLocation(h) }, { size });
}

export type HotelSort = 'recommended' | 'price_asc' | 'price_desc' | 'rating';

export const HOTEL_SORTS: { value: HotelSort; label: string }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Guest rating' },
];

/** Higher rating first; a hotel with no rating yet sorts after every rated one. */
function byRatingDesc(a: HotelCardModel, b: HotelCardModel): number {
  if (a.rating === b.rating) return 0;
  if (a.rating === null) return 1;
  if (b.rating === null) return -1;
  return b.rating - a.rating;
}

/** Sorting never mutates its input. */
export function sortHotels<T extends HotelCardModel>(hotels: readonly T[], sort: HotelSort): T[] {
  const list = [...hotels];
  switch (sort) {
    case 'price_asc':
      return list.sort((a, b) => compareMoney(a.pricePerNight, b.pricePerNight));
    case 'price_desc':
      // A missing price still sorts last, not first.
      return list.sort((a, b) =>
        a.pricePerNight === null || b.pricePerNight === null ? compareMoney(a.pricePerNight, b.pricePerNight) : compareMoney(b.pricePerNight, a.pricePerNight),
      );
    case 'rating':
      return list.sort((a, b) => byRatingDesc(a, b) || compareMoney(a.pricePerNight, b.pricePerNight));
    case 'recommended':
    default:
      // Best-rated first, then more stars, then cheaper.
      return list.sort((a, b) => byRatingDesc(a, b) || b.stars - a.stars || compareMoney(a.pricePerNight, b.pricePerNight));
  }
}

export interface HotelFilters {
  minStars?: number;
  freeCancellationOnly?: boolean;
}

export function filterHotels<T extends HotelCardModel>(hotels: readonly T[], filters: HotelFilters): T[] {
  return hotels.filter((h) => {
    if (filters.minStars && h.stars < filters.minStars) return false;
    if (filters.freeCancellationOnly && !h.freeCancellation) return false;
    return true;
  });
}

/** The few hotels the Home screen leads with: the "recommended" order, trimmed. */
export function pickFeatured<T extends HotelCardModel>(hotels: readonly T[], count = 4): T[] {
  return sortHotels(hotels, 'recommended').slice(0, count);
}
