import type { PackageSummary, ProviderImage } from './discovery';

/**
 * Hotel and package booking shapes, from the backend's Pydantic schemas
 * (backend/app/schemas/customer_hotel_booking.py and customer_package_booking.py)
 * and checked against the production API's catalogue responses.
 *
 * REQUESTS CARRY NO MONEY. Not one request type below has a price, total, tax or
 * currency field, because the backend has none to read: the client names a
 * hotel, a room, dates and a party (or a package, a departure and travellers) and
 * the server prices it. Every amount in a RESPONSE is a decimal string; keep it a
 * string.
 */

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

/** Where one payment attempt stands. `captured` is the only state in which money arrived and was verified. */
export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refunded';

export interface FareLine {
  label: string;
  /** Decimal string; negative for a discount. */
  amount: string;
}

// ---------------------------------------------------------------------------
// Hotels
// ---------------------------------------------------------------------------

export interface RoomOption {
  id: number;
  code: string;
  name: string;
  description: string | null;
  bed_type: string | null;
  size_label: string | null;
  max_guests: number;
  /** Indicative nightly rate: the catalogue's figure, not a quote. */
  price: string;
  meal_plan: string;
  cancellation_policy: string | null;
  perks: string[];
  /** How many of this room type exist (a fixed count, not availability for dates). */
  left: number;
}

/** `GET /api/customer/hotels/{id}` */
export interface HotelDetail {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  stars: number;
  guest_rating: string | null;
  location: string;
  /** Kilometres from the airport. */
  distanceKm: string | null;
  amenities: string[];
  cancellation_policy: string | null;
  rooms: RoomOption[];
  source?: string;
  hotelbeds_code?: number | null;
  provider_images: ProviderImage[];
}

export interface StayInput {
  hotel_id: number;
  room_id: number;
  check_in: string;
  check_out: string;
  rooms_count: number;
  adults: number;
  children: number;
  child_ages?: number[];
}

export interface HotelGuestInput {
  guest_type: 'adult' | 'child';
  title?: string | null;
  first_name: string;
  last_name: string;
  is_contact: boolean;
  mobile?: string | null;
  email?: string | null;
}

/** `POST /hotel-bookings/quote` and the body of a quote request. */
export interface HotelQuoteRequest {
  stay: StayInput;
  addons: { code: string }[];
  coupon_code?: string | null;
}

export interface Quote {
  currency: string;
  total_amount: string;
  taxes: string;
  addon_total: string;
  discount: string;
  coupon_code: string | null;
  coupon_title: string | null;
  /** Set when the code did not apply; the fare is still priced without it. */
  coupon_error: string | null;
  lines: FareLine[];
}

export interface HotelQuote extends Quote {
  nights: number;
  room_subtotal: string;
}

export interface HotelBookingRequest {
  /** One per customer intention; see features/booking/attempts.ts. */
  idempotency_key: string;
  stay: StayInput;
  guests: HotelGuestInput[];
  addons: { code: string }[];
  special_requests: string[];
  notes?: string | null;
  coupon_code?: string | null;
}

export interface PaymentRecord {
  method: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  provider: string | null;
  provider_reference: string | null;
  created_at: string;
}

export interface HotelBooking {
  booking_ref: string;
  product_type: 'hotel';
  status: BookingStatus;
  hotel_id: number;
  hotel_name: string;
  hotel_location: string | null;
  room_id: number;
  room_name: string;
  meal_plan: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  rooms_count: number;
  adults: number;
  children: number;
  notes: string | null;
  room_subtotal: string;
  taxes: string;
  addon_total: string;
  discount: string;
  total_amount: string;
  currency: string;
  coupon_code: string | null;
  cancelled_at: string | null;
  created_at: string;
  guests: {
    guest_index: number;
    guest_type: string;
    title: string | null;
    first_name: string;
    last_name: string;
    is_contact: boolean;
    mobile: string | null;
    email: string | null;
  }[];
  payments: PaymentRecord[];
}

// ---------------------------------------------------------------------------
// Tour packages
// ---------------------------------------------------------------------------

export interface DepartureOption {
  id: number;
  /** ISO date. The detail endpoint can include dates that have already passed. */
  date: string;
  /** Per-person price on this departure; indicative until quoted. */
  price: string;
  seats_left: number;
}

export interface PackageItineraryDay {
  day_number: number;
  title: string;
  description: string | null;
  location: string | null;
  image: string | null;
  meals: string[];
}

export interface PackageHotelStay {
  hotel_name: string;
  city: string | null;
  star_rating: number | null;
  room_type: string | null;
  nights: number | null;
  hotel_id: number | null;
  image: string | null;
}

/** `GET /api/customer/packages/{id}` */
export interface PackageDetail extends PackageSummary {
  description: string | null;
  exclusions: string[];
  cancellation_policy: string | null;
  departures: DepartureOption[];
  itinerary: PackageItineraryDay[];
  hotels: PackageHotelStay[];
}

export interface TripInput {
  package_id: number;
  departure_id: number;
  pax_count: number;
}

export interface PackageTravellerInput {
  traveller_type: 'adult' | 'child' | 'infant';
  title?: string | null;
  first_name: string;
  last_name: string;
  gender?: string | null;
  date_of_birth?: string | null;
  nationality?: string | null;
  passport_number?: string | null;
  passport_expiry?: string | null;
  issuing_country?: string | null;
  is_contact: boolean;
  mobile?: string | null;
  email?: string | null;
}

export interface PackageQuoteRequest {
  trip: TripInput;
  addons: { code: string; traveller_index?: number | null }[];
  coupon_code?: string | null;
}

export interface PackageQuote extends Quote {
  base_total: string;
}

export interface PackageBookingRequest {
  idempotency_key: string;
  trip: TripInput;
  travellers: PackageTravellerInput[];
  addons: { code: string; traveller_index?: number | null }[];
  coupon_code?: string | null;
}

export interface PackageBooking {
  booking_ref: string;
  product_type: 'package';
  status: BookingStatus;
  package_id: number;
  package_name: string;
  package_days: number;
  is_international: boolean;
  departure_id: number;
  departure_date: string;
  pax_count: number;
  base_total: string;
  taxes: string;
  addon_total: string;
  discount: string;
  total_amount: string;
  currency: string;
  coupon_code: string | null;
  cancelled_at: string | null;
  created_at: string;
  travellers: {
    traveller_index: number;
    traveller_type: string;
    first_name: string;
    last_name: string;
    is_contact: boolean;
    mobile: string | null;
    email: string | null;
  }[];
  payments: PaymentRecord[];
}

export type AnyBooking = HotelBooking | PackageBooking;

export interface TourPackageEnquiryRequest {
  name: string;
  email: string;
  mobile: string;
  package_id?: number | null;
  package_name: string;
  preferred_travel_date?: string | null;
  number_of_travellers?: number | null;
  message: string;
}

export interface TourPackageEnquiryResponse {
  success: boolean;
  message: string;
  enquiry_reference: string;
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/** `POST .../checkout`. No amount field in the request; every rupee is the booking row's. */
export interface CheckoutResponse {
  provider: string;
  order_id: string;
  /** Minor units, as the provider reported them. For display checks only. */
  amount: number;
  currency: string;
  key_id: string;
  booking_ref: string;
  options: Record<string, unknown>;
  /** A hosted payment page (HDFC SmartGateway), or null for a drop-in checkout the app cannot open. */
  redirect_url: string | null;
  /** Always "pending": opening a checkout takes no money. */
  payment_status: string;
}

/** `POST .../reconcile`: the backend asked the provider and reports where things stand. */
export interface ReconcileResponse {
  booking_ref: string;
  booking_status: BookingStatus;
  payment_status: PaymentStatus | null;
  /** True only when THIS call moved the payment to captured. Never use it to decide "paid". */
  captured: boolean;
  /** A machine code for logs, never for display. */
  code: string;
  retryable: boolean;
}

export interface PaymentsConfig {
  configured: boolean;
  provider: string | null;
  key_id: string | null;
  currency: string;
  /** "demo" on a development server: no provider is opened and nothing can be paid. */
  mode: 'demo' | 'real' | string;
}
