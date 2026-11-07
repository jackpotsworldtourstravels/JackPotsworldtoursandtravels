import { paymentRows } from '@/features/booking/paymentHistory';

import { hotelBooking, packageBooking, payment } from '../fixtures/booking';

const at = (iso: string, status: Parameters<typeof payment>[0]) => ({ ...payment(status), created_at: iso });

describe('payments built from the customer’s own bookings', () => {
  const rows = [
    { kind: 'hotel' as const, booking: hotelBooking({ booking_ref: 'JPH000001', payments: [at('2026-10-20T09:00:00Z', 'failed'), at('2026-10-20T09:10:00Z', 'captured')] }) },
    { kind: 'package' as const, booking: packageBooking({ booking_ref: 'JPP000002', payments: [at('2026-10-21T08:00:00Z', 'refunded')] }) },
    { kind: 'hotel' as const, booking: hotelBooking({ booking_ref: 'JPH000003', payments: [] }) },
  ];

  it('flattens every attempt from every booking, newest first, each carrying its booking reference', () => {
    expect(paymentRows(rows).map((r) => [r.booking_ref, r.status])).toEqual([
      ['JPP000002', 'refunded'],
      ['JPH000001', 'captured'],
      ['JPH000001', 'failed'],
    ]);
  });

  it('keeps what the backend recorded, including the currency, and invents nothing', () => {
    const [first] = paymentRows(rows);
    expect(first).toMatchObject({ currency: 'INR', amount: expect.any(String), booking_ref: 'JPP000002' });
  });

  it('is empty when nothing has been paid or attempted', () => {
    expect(paymentRows([])).toEqual([]);
    expect(paymentRows([rows[2]])).toEqual([]);
  });
});
