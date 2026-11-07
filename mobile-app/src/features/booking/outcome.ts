import type { AnyBooking, PaymentRecord, PaymentStatus, ReconcileResponse } from '@/types/booking';

/**
 * What a booking and its payments mean for the customer, in one place.
 *
 * THE RULE: "paid" is a fact the BACKEND states, never something the app infers
 * from a browser closing, a redirect, or a button press. A booking counts as
 * paid only when the server reports a `captured` payment AND the booking itself
 * is `confirmed`/`completed`. A `captured` payment on a booking that is not
 * confirmed is a mismatch the desk must look at, and the app says so rather than
 * claiming success.
 */

/** Payment statuses that will never become "paid" on their own. */
export const FAILED_STATUSES: readonly PaymentStatus[] = ['failed', 'cancelled', 'expired'];
/** An attempt that is still open at the provider: the customer can resume it. */
export const OPEN_STATUSES: readonly PaymentStatus[] = ['pending', 'processing', 'authorized'];

/** How long a booking stays payable (the backend's PAYMENT_WINDOW_MINUTES). */
export const PAYMENT_WINDOW_MINUTES = 30;

export type PaymentState =
  /** Server says: captured and confirmed. The only "paid". */
  | 'paid'
  /** Server says money arrived but the booking is not confirmed. Needs the desk. */
  | 'received_unconfirmed'
  | 'refunded'
  /** The booking was cancelled (no money taken, or refund handled by the desk). */
  | 'cancelled'
  /** No payment has been started. */
  | 'not_started'
  /** An attempt is open at the provider. */
  | 'in_progress'
  /** Every attempt ended without money. The customer can try again. */
  | 'failed';

const has = (payments: readonly PaymentRecord[], ...statuses: PaymentStatus[]) =>
  payments.some((p) => statuses.includes(p.status));

/** Every status the backend can report today (`app/services/payments/base.py`). */
export const KNOWN_STATUSES: readonly PaymentStatus[] = [
  'pending',
  'processing',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'expired',
  'refunded',
];

/**
 * A status this app has never heard of (the backend grew one). It could mean
 * money is moving, so it is treated as "in progress": the customer is told to check
 * the payment, never that it failed and they may pay again.
 */
const hasUnknown = (payments: readonly PaymentRecord[]) => payments.some((p) => !KNOWN_STATUSES.includes(p.status));

export function paymentState(booking: Pick<AnyBooking, 'status' | 'payments'>): PaymentState {
  const { status, payments } = booking;
  const captured = has(payments, 'captured');

  if (has(payments, 'refunded')) return 'refunded';
  if (status === 'cancelled') return 'cancelled';
  if (captured) return status === 'confirmed' || status === 'completed' ? 'paid' : 'received_unconfirmed';
  if (has(payments, ...OPEN_STATUSES) || hasUnknown(payments)) return 'in_progress';
  if (payments.length === 0) return 'not_started';
  return 'failed';
}

/** May the customer be offered "Pay now"? The server still decides (window, amount, ownership). */
export function canPay(booking: Pick<AnyBooking, 'status' | 'payments'>): boolean {
  if (booking.status !== 'pending') return false;
  const state = paymentState(booking);
  return state === 'not_started' || state === 'in_progress' || state === 'failed';
}

/**
 * May the customer cancel without involving the desk? Only a booking nobody has
 * paid for and no provider order is still open on. Cancelling while an order is
 * open could let a payment land on a cancelled booking; cancelling after money
 * arrived would leave money held with no refund, which the desk must decide.
 */
export function canCancel(booking: Pick<AnyBooking, 'status' | 'payments'>): boolean {
  if (booking.status !== 'pending') return false;
  const state = paymentState(booking);
  return state === 'not_started' || state === 'failed';
}

/** One word for a payment attempt, for a list of payments. */
export function paymentStatusLabel(status: string): string {
  switch (status) {
    case 'captured':
      return 'Paid';
    case 'refunded':
      return 'Refunded';
    case 'failed':
      return 'Not completed';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'pending':
    case 'processing':
    case 'authorized':
      return 'In progress';
    default:
      return 'Being checked';
  }
}

/**
 * The idempotency key for the next Pay Now on a booking.
 *
 * Deterministic from the booking, so it survives the app being killed with no
 * storage: pressing Pay Now twice, or again after a restart, sends the same key
 * and the server resumes the order it already opened rather than opening a
 * second. After an attempt has FAILED (or expired or been cancelled) the count
 * goes up and the next press sends a new key, because that is a new intention.
 */
export function checkoutKey(booking: Pick<AnyBooking, 'booking_ref' | 'payments'>): string {
  const ended = booking.payments.filter((p) => FAILED_STATUSES.includes(p.status)).length;
  return `pay-${booking.booking_ref}-${ended + 1}`;
}

/** The deadline shown to the customer. Informational: the server enforces it, not the phone's clock. */
export function payBy(createdAt: string): Date {
  return new Date(new Date(createdAt).getTime() + PAYMENT_WINDOW_MINUTES * 60_000);
}

export type ReconcileOutcome =
  | 'paid'
  | 'received_unconfirmed'
  | 'waiting'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'not_started';

/** Read a reconcile answer. `captured` is ignored on purpose: it says what THIS call did, not where things stand. */
export function interpretReconcile(r: ReconcileResponse): ReconcileOutcome {
  const { payment_status: pay, booking_status: booking } = r;
  if (pay === null) return booking === 'cancelled' ? 'cancelled' : 'not_started';
  if (pay === 'refunded') return 'refunded';
  if (pay === 'captured') return booking === 'confirmed' || booking === 'completed' ? 'paid' : 'received_unconfirmed';
  if (pay === 'failed') return 'failed';
  if (pay === 'cancelled') return 'cancelled';
  if (pay === 'expired') return 'expired';
  return 'waiting';
}

/** Outcomes after which asking again cannot change the answer. */
export function isFinal(outcome: ReconcileOutcome): boolean {
  return outcome !== 'waiting';
}
