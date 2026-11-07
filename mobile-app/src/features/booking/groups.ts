import type { AnyBooking } from '@/types/booking';
import { addDays, isISODate, todayISO, type ISODate } from '@/utils/dates';

import { canPay, paymentState } from './outcome';

/**
 * Sorting My bookings into the groups a customer thinks in. Every rule reads
 * what the backend said (status, payments, dates); none is the app's opinion.
 *
 *  - Awaiting payment: unpaid and still payable. These come first because they
 *    are the only ones with something to do (and they hold a room or seats).
 *  - Upcoming: confirmed (or otherwise live) with the trip still ahead or under way.
 *  - Past: completed, or the trip has ended.
 *  - Cancelled.
 */
export type BookingGroup = 'awaiting' | 'upcoming' | 'past' | 'cancelled';

export const GROUP_ORDER: readonly BookingGroup[] = ['awaiting', 'upcoming', 'past', 'cancelled'];

export const GROUP_TITLE: Record<BookingGroup, string> = {
  awaiting: 'Awaiting payment',
  upcoming: 'Upcoming',
  past: 'Past',
  cancelled: 'Cancelled',
};

/** The last day of the trip, or null if the booking carries no usable date. */
export function tripEnd(booking: AnyBooking): ISODate | null {
  if (booking.product_type === 'hotel') {
    return isISODate(booking.check_out_date) ? booking.check_out_date : null;
  }
  if (!isISODate(booking.departure_date)) return null;
  return addDays(booking.departure_date, Math.max(0, booking.package_days - 1));
}

export function bookingGroup(booking: AnyBooking, today: ISODate = todayISO()): BookingGroup {
  if (booking.status === 'cancelled') return 'cancelled';
  if (booking.status === 'completed') return 'past';
  // A refunded booking is over, whatever its status line says.
  if (paymentState(booking) === 'refunded') return 'cancelled';
  const end = tripEnd(booking);
  if (end !== null && end < today) return 'past';
  return canPay(booking) ? 'awaiting' : 'upcoming';
}

export interface BookingSection<T extends { booking: AnyBooking }> {
  group: BookingGroup;
  title: string;
  rows: T[];
}

/** Non-empty sections in display order. Rows keep the order they came in (newest first). */
export function groupBookings<T extends { booking: AnyBooking }>(rows: readonly T[], today: ISODate = todayISO()): BookingSection<T>[] {
  const buckets = new Map<BookingGroup, T[]>();
  for (const row of rows) {
    const group = bookingGroup(row.booking, today);
    buckets.set(group, [...(buckets.get(group) ?? []), row]);
  }
  return GROUP_ORDER.flatMap((group) => {
    const list = buckets.get(group);
    return list ? [{ group, title: GROUP_TITLE[group], rows: list }] : [];
  });
}

/**
 * May the customer ask the desk to review cancelling this booking? Only where
 * money is held or has arrived (an unpaid booking is simply cancelled by the
 * customer), the booking is still live, and the trip has not ended. This is a
 * REQUEST: it cancels nothing and moves no money; a person decides and the
 * server refuses a second open request.
 */
export function canRequestCancellation(booking: AnyBooking, today: ISODate = todayISO()): boolean {
  if (booking.status === 'cancelled' || booking.status === 'completed') return false;
  const state = paymentState(booking);
  if (state !== 'paid' && state !== 'received_unconfirmed') return false;
  const end = tripEnd(booking);
  return end === null || end >= today;
}
