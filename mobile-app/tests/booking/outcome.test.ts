import {
  canCancel,
  canPay,
  checkoutKey,
  interpretReconcile,
  isFinal,
  KNOWN_STATUSES,
  payBy,
  paymentState,
  paymentStatusLabel,
  PAYMENT_WINDOW_MINUTES,
} from '@/features/booking/outcome';
import { bookingBadge } from '@/features/booking/components/status';
import type { BookingStatus, PaymentStatus } from '@/types/booking';

import { payment, reconcile } from '../fixtures/booking';

const booking = (status: BookingStatus, ...payments: PaymentStatus[]) => ({
  booking_ref: 'JPH000123',
  status,
  payments: payments.map((p) => payment(p)),
});

describe('paymentState: "paid" is only ever the server saying so', () => {
  it('is paid only when a payment is captured AND the booking is confirmed', () => {
    expect(paymentState(booking('confirmed', 'captured'))).toBe('paid');
    expect(paymentState(booking('completed', 'captured'))).toBe('paid');
  });

  it('is NOT paid when money arrived but the booking is not confirmed: that needs the desk', () => {
    expect(paymentState(booking('pending', 'captured'))).toBe('received_unconfirmed');
  });

  it('is not paid when the booking is confirmed but no payment is captured (never trust status alone)', () => {
    expect(paymentState(booking('confirmed', 'failed'))).toBe('failed');
    expect(paymentState(booking('confirmed'))).toBe('not_started');
  });

  it('reads the other states', () => {
    expect(paymentState(booking('pending'))).toBe('not_started');
    expect(paymentState(booking('pending', 'pending'))).toBe('in_progress');
    expect(paymentState(booking('pending', 'processing'))).toBe('in_progress');
    expect(paymentState(booking('pending', 'authorized'))).toBe('in_progress');
    expect(paymentState(booking('pending', 'failed'))).toBe('failed');
    expect(paymentState(booking('pending', 'expired', 'cancelled'))).toBe('failed');
    expect(paymentState(booking('cancelled'))).toBe('cancelled');
    expect(paymentState(booking('confirmed', 'captured', 'refunded'))).toBe('refunded');
  });

  it('prefers an open attempt over an old failure', () => {
    expect(paymentState(booking('pending', 'failed', 'pending'))).toBe('in_progress');
  });
});

describe('canPay and canCancel', () => {
  it('offers Pay for an unpaid pending booking, an open payment, or a failed one', () => {
    expect(canPay(booking('pending'))).toBe(true);
    expect(canPay(booking('pending', 'pending'))).toBe(true);
    expect(canPay(booking('pending', 'failed'))).toBe(true);
  });

  it('never offers Pay once paid, refunded, cancelled or under review', () => {
    expect(canPay(booking('confirmed', 'captured'))).toBe(false);
    expect(canPay(booking('pending', 'captured'))).toBe(false);
    expect(canPay(booking('cancelled'))).toBe(false);
    expect(canPay(booking('confirmed', 'refunded'))).toBe(false);
    expect(canPay(booking('completed'))).toBe(false);
  });

  it('lets an unpaid booking be cancelled, and a failed one', () => {
    expect(canCancel(booking('pending'))).toBe(true);
    expect(canCancel(booking('pending', 'failed'))).toBe(true);
  });

  it('will NOT cancel while a provider order is open, once money has arrived, or when not pending', () => {
    expect(canCancel(booking('pending', 'pending'))).toBe(false);
    expect(canCancel(booking('pending', 'processing'))).toBe(false);
    expect(canCancel(booking('pending', 'captured'))).toBe(false);
    expect(canCancel(booking('confirmed', 'captured'))).toBe(false);
    expect(canCancel(booking('cancelled'))).toBe(false);
  });
});

describe('checkoutKey', () => {
  it('is stable for a booking, so Pay Now pressed twice (or after a restart) resumes one order', () => {
    expect(checkoutKey(booking('pending'))).toBe('pay-JPH000123-1');
    expect(checkoutKey(booking('pending'))).toBe(checkoutKey(booking('pending')));
    expect(checkoutKey(booking('pending', 'pending'))).toBe('pay-JPH000123-1');
  });

  it('moves on only after an attempt has actually ended without money', () => {
    expect(checkoutKey(booking('pending', 'failed'))).toBe('pay-JPH000123-2');
    expect(checkoutKey(booking('pending', 'failed', 'expired'))).toBe('pay-JPH000123-3');
    expect(checkoutKey(booking('pending', 'failed', 'pending'))).toBe('pay-JPH000123-2');
  });

  it('is unique per booking and within the backend’s 8-64 character bound', () => {
    expect(checkoutKey({ booking_ref: 'JPP000045', payments: [] })).not.toBe(checkoutKey(booking('pending')));
    expect(checkoutKey(booking('pending')).length).toBeGreaterThanOrEqual(8);
    expect(checkoutKey(booking('pending')).length).toBeLessThanOrEqual(64);
  });
});

describe('payBy', () => {
  it('is thirty minutes after creation, the backend’s own window', () => {
    expect(PAYMENT_WINDOW_MINUTES).toBe(30);
    expect(payBy('2026-11-05T10:00:00.000Z').toISOString()).toBe('2026-11-05T10:30:00.000Z');
  });
});

describe('interpretReconcile', () => {
  it('says paid only for captured payment AND confirmed booking', () => {
    expect(interpretReconcile(reconcile({ payment_status: 'captured', booking_status: 'confirmed', code: 'captured', retryable: false }))).toBe('paid');
  });

  it('does not trust the `captured` flag: it only says what THIS call did', () => {
    expect(interpretReconcile(reconcile({ captured: true, payment_status: 'pending', booking_status: 'pending' }))).toBe('waiting');
    expect(interpretReconcile(reconcile({ captured: true, payment_status: 'captured', booking_status: 'pending' }))).toBe('received_unconfirmed');
    expect(interpretReconcile(reconcile({ captured: false, payment_status: 'captured', booking_status: 'confirmed' }))).toBe('paid');
  });

  it('maps every other answer', () => {
    expect(interpretReconcile(reconcile({ payment_status: 'processing' }))).toBe('waiting');
    expect(interpretReconcile(reconcile({ payment_status: 'authorized' }))).toBe('waiting');
    expect(interpretReconcile(reconcile({ payment_status: 'failed' }))).toBe('failed');
    expect(interpretReconcile(reconcile({ payment_status: 'cancelled' }))).toBe('cancelled');
    expect(interpretReconcile(reconcile({ payment_status: 'expired' }))).toBe('expired');
    expect(interpretReconcile(reconcile({ payment_status: 'refunded' }))).toBe('refunded');
    expect(interpretReconcile(reconcile({ payment_status: null, booking_status: 'pending', code: 'no_payment' }))).toBe('not_started');
    expect(interpretReconcile(reconcile({ payment_status: null, booking_status: 'cancelled' }))).toBe('cancelled');
  });

  it('treats everything but "waiting" as final', () => {
    expect(isFinal('waiting')).toBe(false);
    for (const o of ['paid', 'failed', 'cancelled', 'expired', 'refunded', 'not_started', 'received_unconfirmed'] as const) expect(isFinal(o)).toBe(true);
  });
});

describe('the badge a customer sees', () => {
  it('reads Confirmed only for a server-confirmed, captured booking', () => {
    expect(bookingBadge(booking('confirmed', 'captured')).label).toBe('Confirmed');
    expect(bookingBadge(booking('confirmed')).label).not.toBe('Confirmed');
    expect(bookingBadge(booking('pending', 'captured')).label).toBe('Payment under review');
  });

  it('reads the unpaid and finished states plainly', () => {
    expect(bookingBadge(booking('pending')).label).toBe('Awaiting payment');
    expect(bookingBadge(booking('pending', 'pending')).label).toBe('Payment in progress');
    expect(bookingBadge(booking('pending', 'failed')).label).toBe('Payment not completed');
    expect(bookingBadge(booking('cancelled')).label).toBe('Cancelled');
    expect(bookingBadge(booking('completed', 'captured')).label).toBe('Completed');
  });
});

describe('a payment status this app has never heard of', () => {
  const odd = (...extra: PaymentStatus[]) => booking('pending', ...extra, 'partially_captured' as PaymentStatus);

  it('is treated as in progress, never as "failed, pay again", because money may be moving', () => {
    expect(paymentState(odd())).toBe('in_progress');
    expect(paymentState(odd('failed'))).toBe('in_progress'); // an older failure does not make it safe to pay again
  });

  it('lets the customer check or resume, but not cancel while it is unresolved', () => {
    expect(canPay(odd())).toBe(true);
    expect(canCancel(odd())).toBe(false);
  });

  it('still defers to what the backend settled: captured is paid, refunded is refunded', () => {
    expect(paymentState(booking('confirmed', 'captured', 'partially_captured' as PaymentStatus))).toBe('paid');
    expect(paymentState(booking('confirmed', 'refunded', 'partially_captured' as PaymentStatus))).toBe('refunded');
  });

  it('does not count it as an ended attempt when choosing the next checkout key', () => {
    expect(checkoutKey(odd())).toBe('pay-JPH000123-1');
  });

  it('is read as "waiting" when a reconcile answer carries it', () => {
    expect(interpretReconcile(reconcile({ payment_status: 'partially_captured' as PaymentStatus }))).toBe('waiting');
  });

  it('is labelled "Being checked" in a list, and the eight known statuses each have their own word', () => {
    expect(paymentStatusLabel('partially_captured')).toBe('Being checked');
    expect(KNOWN_STATUSES.map(paymentStatusLabel)).toEqual([
      'In progress', 'In progress', 'In progress', 'Paid', 'Not completed', 'Cancelled', 'Expired', 'Refunded',
    ]);
  });
});
