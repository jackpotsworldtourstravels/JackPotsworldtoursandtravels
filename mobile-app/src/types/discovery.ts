/**
 * Response shapes for the public discovery endpoints, taken from the backend's
 * Pydantic schemas (backend/app/schemas/customer_destination.py,
 * customer_hotel_booking.py, customer_package_booking.py, customer_booking.py)
 * and checked against the production API's responses.
 *
 * Money is a decimal string except where noted. IDs of hotels and packages are
 * strings on the wire even though the booking endpoints want integers.
 */

export interface Destination {
  /** Slug, e.g. "goa". Also the key of the destination's photograph. */
  id: string;
  name: string;
  slug: string;
  country: string | null;
  image: string | null;
}

export interface DestinationLocation {
  id: string;
  destination_id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  hotel_count: number;
}

export interface DestinationAttraction {
  /** "hyderabad__charminar": also the key of its photograph, when one exists. */
  id: string;
  destination_id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  area_id: string | null;
  area_name: string | null;
  hotel_count: number;
}

export interface ProviderImage {
  url: string;
  thumb: string;
  large: string;
  is_primary?: boolean;
  room_code?: string | null;
  source?: string;
}

/** `GET /api/customer/hotels`: every active property. */
export interface HotelListItem {
  id: string;
  name: string;
  image: string | null;
  stars: number;
  /** A decimal string ("4.6"), not a number. */
  guest_rating: string | null;
  location: string;
  distanceKm: string | null;
  pricePerNight: string;
  amenities: string[];
  cancellation_policy: string | null;
  meal_plans?: string[];
  free_cancellation?: boolean;
  source?: string;
  hotelbeds_code?: number | null;
  provider_images: ProviderImage[];
}

/** One hotel inside `GET /destinations/{id}/hotels`. A different shape from the list's. */
export interface DestinationHotelItem {
  id: string;
  name: string;
  image: string | null;
  stars: number;
  /** A JSON number here, unlike the list endpoint. */
  guest_rating: number | null;
  location: string | null;
  address: string | null;
  city: string | null;
  description: string | null;
  amenities: string[];
  /** A JSON number here (6400.0), unlike the list endpoint's string. */
  price_per_night: number;
  currency: string;
  free_cancellation: boolean;
  location_id: string | null;
  location_name: string | null;
  distance_km: number | null;
}

export interface DestinationHotelsPage {
  destination: Destination;
  locations: { id: string; name: string; slug: string }[];
  hotels: DestinationHotelItem[];
  page: number;
  page_size: number;
  total: number;
}

export interface PackageSummary {
  id: string;
  name: string;
  destination: string | null;
  country: string | null;
  nights: number | null;
  days: number;
  trip_type: string | null;
  hotel_category: number | null;
  rating: number | null;
  rating_count: number | null;
  rating_source: string | null;
  highlights: string[];
  inclusions: string[];
  /** A destination slug ("goa") or an attraction id ("goa__fort-aguada"). */
  image: string | null;
  departure_months: string[];
  /** ISO date of the soonest bookable departure, or null when none is scheduled. */
  next_departure: string | null;
  /** Price on that departure. Null whenever `next_departure` is null. */
  price_next: string | null;
  /** The lowest price across ALL of the package's departures, including past ones. */
  priceFrom: string;
  blurb: string;
  is_international: boolean;
  category: string;
}

export interface PackageQuery {
  destination?: string;
  trip_type?: 'domestic' | 'international' | 'pilgrimage';
  category?: string;
  min_days?: number;
  max_days?: number;
  min_price?: number;
  max_price?: number;
  /** "YYYY-MM" */
  month?: string;
}

export interface Coupon {
  code: string;
  title: string;
  description: string | null;
  discount_type: 'percent' | 'flat' | string;
  discount_value: string;
}

export type CouponProduct = 'hotel' | 'package' | 'flight' | 'cruise';
