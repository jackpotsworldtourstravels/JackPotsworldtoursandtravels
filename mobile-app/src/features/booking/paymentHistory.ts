import type { PaymentRecord } from '@/types/booking';

import type { BookingRow } from './hooks';

/**
 * The customer's payments, built from their own bookings.
 *
 * Not from `GET /payments/history`: that route reads only FLIGHT payments (the
 * `customer_booking_payments` table), so for hotel and package customers it is
 * always empty. Every hotel and package booking already carries its payment
 * attempts, exactly as the backend recorded them, so this is a flattening of
 * data the app already has, not a second source of truth.
 */
export interface PaymentRow extends PaymentRecord {
  booking_ref: string;
}

export function paymentRows(bookings: readonly BookingRow[]): PaymentRow[] {
  return bookings
    .flatMap(({ booking }) => booking.payments.map((p) => ({ ...p, booking_ref: booking.booking_ref })))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}
