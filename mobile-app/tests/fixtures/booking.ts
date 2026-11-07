import type {
  CheckoutResponse,
  HotelBooking,
  HotelDetail,
  HotelQuote,
  PackageBooking,
  PackageDetail,
  PackageQuote,
  PaymentRecord,
  ReconcileResponse,
} from '@/types/booking';
import { addDays, todayISO } from '@/utils/dates';

/**
 * Booking fixtures, shaped like the backend's real responses. Dates are computed
 * from today so a screen that validates "not in the past" never goes stale.
 */
export const IN_30 = addDays(todayISO(), 30);
export const IN_33 = addDays(todayISO(), 33);
export const IN_40 = addDays(todayISO(), 40);
export const LAST_MONTH = addDays(todayISO(), -30);

export const hotelDetail: HotelDetail = {
  id: '1',
  name: 'Taj Palace',
  description: 'A landmark five-star address in the heart of Banjara Hills.',
  image: 'taj-palace', // the misleading seed key the app must ignore
  stars: 5,
  guest_rating: '4.6',
  location: 'Banjara Hills, Hyderabad',
  distanceKm: '24.0',
  amenities: ['Free Wi-Fi', 'Pool', 'Spa'],
  cancellation_policy: 'Free cancellation up to 48 hours before check-in.',
  source: 'seed',
  hotelbeds_code: null,
  provider_images: [],
  rooms: [
    {
      id: 1, code: 'std', name: 'Superior Room', description: 'A comfortable room.', bed_type: '1 King or 2 Twin',
      size_label: '28 m²', max_guests: 2, price: '12500.00', meal_plan: 'Room only',
      cancellation_policy: 'Free cancellation up to 48 hours before check-in.', perks: ['Free Wi-Fi'], left: 6,
    },
    {
      id: 2, code: 'ste', name: 'Deluxe Suite', description: null, bed_type: 'King', size_label: '55 m²',
      max_guests: 4, price: '18500.00', meal_plan: 'Breakfast included', cancellation_policy: null, perks: [], left: 1,
    },
  ],
};

export const hotelQuote: HotelQuote = {
  currency: 'INR',
  nights: 3,
  room_subtotal: '37500.00',
  taxes: '4500.00',
  addon_total: '0.00',
  discount: '0.00',
  total_amount: '42000.00',
  coupon_code: null,
  coupon_title: null,
  coupon_error: null,
  lines: [
    { label: 'Superior Room × 3 nights', amount: '37500.00' },
    { label: 'Taxes & service', amount: '4500.00' },
  ],
};

export const hotelQuoteWithCoupon: HotelQuote = {
  ...hotelQuote,
  discount: '4200.00',
  total_amount: '37800.00',
  coupon_code: 'STAYMORE',
  coupon_title: 'Up to 40% off premium hotel stays',
  lines: [...hotelQuote.lines, { label: 'Discount (STAYMORE)', amount: '-4200.00' }],
};

export const badCouponQuote: HotelQuote = { ...hotelQuote, coupon_error: 'That coupon code is not valid.' };

const attempt = (status: PaymentRecord['status'], amount = '42000.00'): PaymentRecord => ({
  method: 'gateway',
  status,
  amount,
  currency: 'INR',
  provider: 'hdfc',
  provider_reference: 'ord_1',
  created_at: new Date().toISOString(),
});
export const payment = attempt;

export function hotelBooking(over: Partial<HotelBooking> = {}): HotelBooking {
  return {
    booking_ref: 'JPH000123',
    product_type: 'hotel',
    status: 'pending',
    hotel_id: 1,
    hotel_name: 'Taj Palace',
    hotel_location: 'Banjara Hills, Hyderabad',
    room_id: 1,
    room_name: 'Superior Room',
    meal_plan: 'Room only',
    check_in_date: IN_30,
    check_out_date: IN_33,
    nights: 3,
    rooms_count: 1,
    adults: 2,
    children: 0,
    notes: null,
    room_subtotal: '37500.00',
    taxes: '4500.00',
    addon_total: '0.00',
    discount: '0.00',
    total_amount: '42000.00',
    currency: 'INR',
    coupon_code: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    guests: [
      { guest_index: 0, guest_type: 'adult', title: null, first_name: 'Asha', last_name: 'Rao', is_contact: true, mobile: '+919876543210', email: 'asha@example.com' },
      { guest_index: 1, guest_type: 'adult', title: null, first_name: 'Ravi', last_name: 'Rao', is_contact: false, mobile: null, email: null },
    ],
    payments: [],
    ...over,
  };
}

export const checkout: CheckoutResponse = {
  provider: 'hdfc',
  order_id: 'ord_1',
  amount: 4200000,
  currency: 'INR',
  key_id: 'SG6226',
  booking_ref: 'JPH000123',
  options: {},
  redirect_url: 'https://smartgateway.hdfc.example/pay/ord_1',
  payment_status: 'pending',
};

export function reconcile(over: Partial<ReconcileResponse> = {}): ReconcileResponse {
  return { booking_ref: 'JPH000123', booking_status: 'pending', payment_status: 'pending', captured: false, code: 'pending', retryable: true, ...over };
}

export function packageDetail(over: Partial<PackageDetail> = {}): PackageDetail {
  return {
    id: '7', name: 'Goa', destination: 'Goa', country: 'India', nights: 3, days: 4, trip_type: 'domestic',
    hotel_category: null, rating: null, rating_count: null, rating_source: null, highlights: [],
    inclusions: ['3-night hotel stay', 'Daily breakfast'], image: 'goa', departure_months: [], next_departure: IN_30,
    price_next: '30900.00', priceFrom: '21900.00', blurb: 'North and South Goa beaches.', is_international: false,
    category: 'holiday', description: 'Four days across North and South Goa.', exclusions: ['Flights'],
    cancellation_policy: 'Free cancellation up to 7 days before departure.',
    departures: [
      { id: 49, date: LAST_MONTH, price: '21900.00', seats_left: 7 }, // already left: must never be offered
      { id: 55, date: IN_30, price: '30900.00', seats_left: 4 },
      { id: 56, date: IN_40, price: '32400.00', seats_left: 0 }, // sold out
    ],
    itinerary: [
      { day_number: 2, title: 'South Goa', description: 'Beaches and churches.', location: 'Colva', image: null, meals: ['Breakfast'] },
      { day_number: 1, title: 'Arrival', description: null, location: 'Panaji', image: null, meals: [] },
    ],
    hotels: [{ hotel_name: 'Sea View Resort', city: 'Calangute', star_rating: 4, room_type: 'Deluxe', nights: 3, hotel_id: null, image: null }],
    ...over,
  };
}

export const internationalPackage = packageDetail({
  id: '12', name: 'Dubai', destination: 'Dubai', country: 'United Arab Emirates', is_international: true, trip_type: 'international',
  image: 'dubai', departures: [{ id: 80, date: IN_30, price: '52000.00', seats_left: 6 }],
});

export const packageQuote: PackageQuote = {
  currency: 'INR', base_total: '61800.00', taxes: '3090.00', addon_total: '0.00', discount: '0.00', total_amount: '64890.00',
  coupon_code: null, coupon_title: null, coupon_error: null,
  lines: [{ label: 'Package × 2', amount: '61800.00' }, { label: 'GST', amount: '3090.00' }],
};

export function packageBooking(over: Partial<PackageBooking> = {}): PackageBooking {
  return {
    booking_ref: 'JPP000045', product_type: 'package', status: 'pending', package_id: 7, package_name: 'Goa', package_days: 4,
    is_international: false, departure_id: 55, departure_date: IN_30, pax_count: 2, base_total: '61800.00', taxes: '3090.00',
    addon_total: '0.00', discount: '0.00', total_amount: '64890.00', currency: 'INR', coupon_code: null, cancelled_at: null,
    created_at: new Date().toISOString(),
    travellers: [
      { traveller_index: 0, traveller_type: 'adult', first_name: 'Asha', last_name: 'Rao', is_contact: true, mobile: '+919876543210', email: 'asha@example.com' },
      { traveller_index: 1, traveller_type: 'adult', first_name: 'Ravi', last_name: 'Rao', is_contact: false, mobile: null, email: null },
    ],
    payments: [],
    ...over,
  };
}
