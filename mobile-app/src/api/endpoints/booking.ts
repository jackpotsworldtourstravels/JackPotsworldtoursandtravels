import type {
  CheckoutResponse,
  HotelBooking,
  HotelBookingRequest,
  HotelDetail,
  HotelQuote,
  HotelQuoteRequest,
  PackageBooking,
  PackageBookingRequest,
  PackageDetail,
  PackageQuote,
  PackageQuoteRequest,
  PaymentsConfig,
  ReconcileResponse,
  TourPackageEnquiryRequest,
  TourPackageEnquiryResponse,
} from '@/types/booking';

import { http } from '../client';

const BASE = '/api/customer';

/**
 * Reading a hotel or package page, and asking what a stay or trip would cost,
 * are public: no session, no token, no refresh. Creating, paying for and
 * reading back a BOOKING are the customer's own and go through the
 * authenticated client.
 */
const PUBLIC = { skipAuth: true } as const;

const seg = encodeURIComponent;

export const hotelApi = {
  async detail(hotelId: number): Promise<HotelDetail> {
    const { data } = await http.get<HotelDetail>(`${BASE}/hotels/${seg(String(hotelId))}`, PUBLIC);
    return data;
  },

  /** A server-priced quote. The request has no price in it. */
  async quote(request: HotelQuoteRequest): Promise<HotelQuote> {
    const { data } = await http.post<HotelQuote>(`${BASE}/hotel-bookings/quote`, request, PUBLIC);
    return data;
  },

  /** Same key, same booking: the server returns the one it already made. */
  async create(request: HotelBookingRequest): Promise<HotelBooking> {
    const { data } = await http.post<HotelBooking>(`${BASE}/hotel-bookings`, request);
    return data;
  },

  async get(ref: string): Promise<HotelBooking> {
    const { data } = await http.get<HotelBooking>(`${BASE}/hotel-bookings/${seg(ref)}`);
    return data;
  },

  async list(): Promise<HotelBooking[]> {
    const { data } = await http.get<HotelBooking[]>(`${BASE}/hotel-bookings`);
    return data;
  },

  async cancel(ref: string): Promise<HotelBooking> {
    const { data } = await http.post<HotelBooking>(`${BASE}/hotel-bookings/${seg(ref)}/cancel`);
    return data;
  },

  /** Opens a payment order. Takes no money and has no amount field. */
  async checkout(ref: string, idempotencyKey: string): Promise<CheckoutResponse> {
    const { data } = await http.post<CheckoutResponse>(`${BASE}/hotel-bookings/${seg(ref)}/checkout`, {
      idempotency_key: idempotencyKey,
    });
    return data;
  },

  /** Asks the backend to ask the provider. Nothing in the body decides anything. */
  async reconcile(ref: string): Promise<ReconcileResponse> {
    const { data } = await http.post<ReconcileResponse>(`${BASE}/hotel-bookings/${seg(ref)}/reconcile`, {});
    return data;
  },
};

export const packageApi = {
  async detail(packageId: number): Promise<PackageDetail> {
    const { data } = await http.get<PackageDetail>(`${BASE}/packages/${seg(String(packageId))}`, PUBLIC);
    return data;
  },

  async quote(request: PackageQuoteRequest): Promise<PackageQuote> {
    const { data } = await http.post<PackageQuote>(`${BASE}/package-bookings/quote`, request, PUBLIC);
    return data;
  },

  async create(request: PackageBookingRequest): Promise<PackageBooking> {
    const { data } = await http.post<PackageBooking>(`${BASE}/package-bookings`, request);
    return data;
  },

  async get(ref: string): Promise<PackageBooking> {
    const { data } = await http.get<PackageBooking>(`${BASE}/package-bookings/${seg(ref)}`);
    return data;
  },

  async list(): Promise<PackageBooking[]> {
    const { data } = await http.get<PackageBooking[]>(`${BASE}/package-bookings`);
    return data;
  },

  async cancel(ref: string): Promise<PackageBooking> {
    const { data } = await http.post<PackageBooking>(`${BASE}/package-bookings/${seg(ref)}/cancel`);
    return data;
  },

  async checkout(ref: string, idempotencyKey: string): Promise<CheckoutResponse> {
    const { data } = await http.post<CheckoutResponse>(`${BASE}/package-bookings/${seg(ref)}/checkout`, {
      idempotency_key: idempotencyKey,
    });
    return data;
  },

  async reconcile(ref: string): Promise<ReconcileResponse> {
    const { data } = await http.post<ReconcileResponse>(`${BASE}/package-bookings/${seg(ref)}/reconcile`, {});
    return data;
  },

  /** The "Enquire about dates" form: public, creates an enquiry (not a booking) and returns a reference. */
  async enquire(request: TourPackageEnquiryRequest): Promise<TourPackageEnquiryResponse> {
    const { data } = await http.post<TourPackageEnquiryResponse>(`${BASE}/tour-package-enquiries`, request, PUBLIC);
    return data;
  },
};

export const paymentsApi = {
  /**
   * Is online payment available for THIS booking, and through whom. Asked per
   * booking because a booking can be routed to a specific provider.
   */
  async config(bookingRef?: string): Promise<PaymentsConfig> {
    const { data } = await http.get<PaymentsConfig>(`${BASE}/payments/config`, {
      ...PUBLIC,
      params: bookingRef ? { booking_ref: bookingRef } : undefined,
    });
    return data;
  },
};
