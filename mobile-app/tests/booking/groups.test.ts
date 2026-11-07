import { bookingGroup, canRequestCancellation, groupBookings, tripEnd } from '@/features/booking/groups';
import { addDays, todayISO } from '@/utils/dates';

import { hotelBooking, IN_30, IN_33, LAST_MONTH, packageBooking, payment } from '../fixtures/booking';

const today = todayISO();
const paidHotel = (over = {}) => hotelBooking({ status: 'confirmed', payments: [payment('captured')], ...over });

describe('where a trip ends', () => {
  it('is the check-out date for a hotel', () => {
    expect(tripEnd(hotelBooking())).toBe(IN_33);
  });

  it('is the last day of the package: departure plus its days, minus the departure day itself', () => {
    expect(tripEnd(packageBooking({ departure_date: IN_30, package_days: 4 }))).toBe(addDays(IN_30, 3));
    expect(tripEnd(packageBooking({ departure_date: IN_30, package_days: 1 }))).toBe(IN_30);
  });

  it('is unknown, not a guess, when the date is unusable', () => {
    expect(tripEnd(hotelBooking({ check_out_date: 'soon' }))).toBeNull();
  });
});

describe('which group a booking belongs in', () => {
  it('puts an unpaid, payable booking with its trip ahead under Awaiting payment', () => {
    expect(bookingGroup(hotelBooking(), today)).toBe('awaiting');
  });

  it('puts a paid, confirmed booking with its trip ahead under Upcoming', () => {
    expect(bookingGroup(paidHotel(), today)).toBe('upcoming');
  });

  it('keeps a booking whose payment was left open under Awaiting payment, where it can be resumed or checked', () => {
    expect(bookingGroup(hotelBooking({ payments: [payment('pending')] }), today)).toBe('awaiting');
  });

  it('puts a trip that has ended under Past, paid or not', () => {
    const over = { check_in_date: addDays(LAST_MONTH, -2), check_out_date: LAST_MONTH };
    expect(bookingGroup(paidHotel(over), today)).toBe('past');
    expect(bookingGroup(hotelBooking(over), today)).toBe('past');
  });

  it('puts a completed booking under Past even if its dates look current', () => {
    expect(bookingGroup(paidHotel({ status: 'completed' }), today)).toBe('past');
  });

  it('puts a cancelled booking under Cancelled, and a refunded one too', () => {
    expect(bookingGroup(hotelBooking({ status: 'cancelled' }), today)).toBe('cancelled');
    expect(bookingGroup(paidHotel({ payments: [payment('refunded')] }), today)).toBe('cancelled');
  });

  it('counts the last day of a stay as still current', () => {
    expect(bookingGroup(paidHotel({ check_out_date: today, check_in_date: addDays(today, -2) }), today)).toBe('upcoming');
  });
});

describe('grouping a list', () => {
  const rows = [
    { booking: hotelBooking({ booking_ref: 'JPH000001', status: 'cancelled' }) },
    { booking: paidHotel({ booking_ref: 'JPH000002' }) },
    { booking: hotelBooking({ booking_ref: 'JPH000003' }) },
    { booking: paidHotel({ booking_ref: 'JPH000004' }) },
  ];

  it('orders the groups Awaiting payment, Upcoming, Past, Cancelled and drops empty ones', () => {
    const sections = groupBookings(rows, today);
    expect(sections.map((s) => s.group)).toEqual(['awaiting', 'upcoming', 'cancelled']);
    expect(sections.map((s) => s.title)).toEqual(['Awaiting payment', 'Upcoming', 'Cancelled']);
  });

  it('keeps the order each group came in (newest first from the server)', () => {
    const upcoming = groupBookings(rows, today).find((s) => s.group === 'upcoming');
    expect(upcoming?.rows.map((r) => r.booking.booking_ref)).toEqual(['JPH000002', 'JPH000004']);
  });

  it('is an empty list for no bookings', () => {
    expect(groupBookings([], today)).toEqual([]);
  });
});

describe('asking the desk to review a cancellation', () => {
  it('is offered for a paid, confirmed booking whose trip is ahead', () => {
    expect(canRequestCancellation(paidHotel(), today)).toBe(true);
    expect(canRequestCancellation(packageBooking({ status: 'confirmed', payments: [payment('captured')] }), today)).toBe(true);
  });

  it('is offered when money has arrived but the booking is not confirmed, which is for the desk to look at', () => {
    expect(canRequestCancellation(hotelBooking({ status: 'pending', payments: [payment('captured')] }), today)).toBe(true);
  });

  it('is NOT offered for an unpaid booking (the customer simply cancels it), or while a payment is open', () => {
    expect(canRequestCancellation(hotelBooking(), today)).toBe(false);
    expect(canRequestCancellation(hotelBooking({ payments: [payment('pending')] }), today)).toBe(false);
  });

  it('is NOT offered once cancelled, completed, refunded, or when the trip has ended', () => {
    expect(canRequestCancellation(paidHotel({ status: 'cancelled' }), today)).toBe(false);
    expect(canRequestCancellation(paidHotel({ status: 'completed' }), today)).toBe(false);
    expect(canRequestCancellation(paidHotel({ payments: [payment('refunded')] }), today)).toBe(false);
    expect(canRequestCancellation(paidHotel({ check_in_date: addDays(LAST_MONTH, -2), check_out_date: LAST_MONTH }), today)).toBe(false);
  });
});
