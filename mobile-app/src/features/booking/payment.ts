import { hotelApi, packageApi, paymentsApi } from '@/api/endpoints/booking';
import { isApiError } from '@/api/errors';
import type { AnyBooking, CheckoutResponse, ReconcileResponse } from '@/types/booking';

import { checkoutKey, interpretReconcile, isFinal, type ReconcileOutcome } from './outcome';
import type { BookingKind } from './refs';

/**
 * Paying for a booking, end to end, with the BACKEND as the only judge.
 *
 *   1. Is online payment available for this booking?      GET  /payments/config
 *   2. Open an order (no amount sent; the key is stable)  POST .../checkout
 *   3. Show the provider's hosted page in a browser
 *   4. Ask the backend where the payment stands           POST .../reconcile
 *
 * Step 3 proves nothing. The hosted page redirects to the website, a browser
 * closing says nothing about the money, and anything the page's URL says is
 * ignored. Only step 4's answer (the server asked the provider and compared the
 * amount with the booking it priced) decides "paid".
 *
 * Written against a small set of injected dependencies so every branch is
 * testable without a browser or a network.
 */
export interface PaymentDeps {
  config: (ref: string) => Promise<{ configured: boolean; mode: string }>;
  checkout: (kind: BookingKind, ref: string, key: string) => Promise<CheckoutResponse>;
  reconcile: (kind: BookingKind, ref: string) => Promise<ReconcileResponse>;
  /** Resolves when the customer closes the hosted page. */
  openBrowser: (url: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export const liveDeps = (openBrowser: PaymentDeps['openBrowser']): PaymentDeps => ({
  config: (ref) => paymentsApi.config(ref),
  checkout: (kind, ref, key) => (kind === 'hotel' ? hotelApi.checkout(ref, key) : packageApi.checkout(ref, key)),
  reconcile: (kind, ref) => (kind === 'hotel' ? hotelApi.reconcile(ref) : packageApi.reconcile(ref)),
  openBrowser,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** After the page closes: ask straight away, then back off. About a minute in all. */
export const RECONCILE_DELAYS_MS: readonly number[] = [0, 2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000];

export type PaymentProgress =
  | { step: 'checking' }
  | { step: 'opening' }
  | { step: 'in_browser' }
  | { step: 'confirming'; attempt: number };

export type PaymentResult =
  | { kind: 'outcome'; outcome: ReconcileOutcome; reconcile: ReconcileResponse }
  /** Could not start: say why, in words fit for a customer. */
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

const UNAVAILABLE = 'Online payment isn’t available right now. Please try again later or contact support.';

/** Only an https URL is ever opened. The backend already pins the provider’s domain; this is belt and braces. */
export function isSafeRedirect(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function messageFor(error: unknown): string {
  return isApiError(error) ? error.message : 'Something went wrong. Please try again.';
}

/** Ask the backend where a payment stands, retrying quietly until it is final or the budget is spent. */
export async function confirmPayment(
  kind: BookingKind,
  ref: string,
  deps: Pick<PaymentDeps, 'reconcile' | 'sleep'>,
  onProgress?: (p: PaymentProgress) => void,
  delays: readonly number[] = RECONCILE_DELAYS_MS,
  shouldStop: () => boolean = () => false,
): Promise<PaymentResult> {
  let last: ReconcileResponse | null = null;
  for (let i = 0; i < delays.length; i += 1) {
    if (shouldStop()) break;
    if (delays[i] > 0) await deps.sleep(delays[i]);
    if (shouldStop()) break;
    onProgress?.({ step: 'confirming', attempt: i + 1 });
    try {
      last = await deps.reconcile(kind, ref);
    } catch (error) {
      // A failed ask is not a failed payment. Keep asking until the budget is spent.
      if (i === delays.length - 1 && last === null) return { kind: 'error', message: messageFor(error) };
      continue;
    }
    const outcome = interpretReconcile(last);
    if (isFinal(outcome)) return { kind: 'outcome', outcome, reconcile: last };
  }
  if (last) return { kind: 'outcome', outcome: interpretReconcile(last), reconcile: last };
  return { kind: 'error', message: 'We couldn’t check your payment. Please check again in a moment.' };
}

/** Open a payment and carry it through to the backend's verdict. */
export async function runPayment(
  kind: BookingKind,
  booking: AnyBooking,
  deps: PaymentDeps,
  onProgress?: (p: PaymentProgress) => void,
  shouldStop: () => boolean = () => false,
): Promise<PaymentResult> {
  const ref = booking.booking_ref;

  onProgress?.({ step: 'checking' });
  try {
    const config = await deps.config(ref);
    if (!config.configured) return { kind: 'unavailable', message: UNAVAILABLE };
    // A development server in demo mode opens no provider and can take no money. Say so
    // rather than showing a payment screen that cannot finish.
    if (config.mode === 'demo') {
      return { kind: 'unavailable', message: 'This server is in demo payment mode, so no payment can be taken.' };
    }
  } catch (error) {
    return { kind: 'error', message: messageFor(error) };
  }

  onProgress?.({ step: 'opening' });
  let checkout: CheckoutResponse;
  try {
    // The key is derived from the booking and its past attempts, so Pay Now pressed twice,
    // or again after a restart, resumes the same order instead of opening another.
    checkout = await deps.checkout(kind, ref, checkoutKey(booking));
  } catch (error) {
    return { kind: 'error', message: messageFor(error) };
  }

  if (!isSafeRedirect(checkout.redirect_url)) {
    return {
      kind: 'unavailable',
      message: 'This payment can’t be completed inside the app yet. Please contact support to pay for this booking.',
    };
  }

  onProgress?.({ step: 'in_browser' });
  try {
    await deps.openBrowser(checkout.redirect_url);
  } catch {
    // If the browser could not open, nothing was paid, but the order exists. Ask anyway:
    // the customer may already have paid from an earlier session.
  }

  return confirmPayment(kind, ref, deps, onProgress, RECONCILE_DELAYS_MS, shouldStop);
}
