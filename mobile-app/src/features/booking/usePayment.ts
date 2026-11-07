import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AnyBooking } from '@/types/booking';

import { bookingKeys } from './hooks';
import { openHostedPage } from './hostedPage';
import { confirmPayment, liveDeps, runPayment, type PaymentProgress, type PaymentResult } from './payment';
import type { BookingKind } from './refs';

/**
 * Drives payment for one booking from a screen.
 *
 * `pay` runs the whole path (config, checkout, hosted page, reconcile);
 * `check` only asks the backend where the payment stands (for a customer who
 * paid and came back, or whose last answer was "still waiting"). Both are
 * single-flight: a second press while one is running does nothing, so a nervous
 * double tap cannot open two checkouts.
 *
 * After either finishes the booking is re-read from the backend, so what the
 * screen shows afterwards is the server's record, not this hook's opinion.
 */
export function usePayment(kind: BookingKind, booking: AnyBooking) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<PaymentProgress | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ref = booking.booking_ref;

  const settle = useCallback(
    async (next: PaymentResult) => {
      if (mounted.current) {
        setResult(next);
        setProgress(null);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: bookingKeys.one(kind, ref) }),
        queryClient.invalidateQueries({ queryKey: bookingKeys.mine() }),
      ]);
    },
    [kind, queryClient, ref],
  );

  const guarded = useCallback(
    async (work: () => Promise<PaymentResult>) => {
      if (running.current) return;
      running.current = true;
      if (mounted.current) setResult(null);
      try {
        await settle(await work());
      } finally {
        running.current = false;
        if (mounted.current) setProgress(null);
      }
    },
    [settle],
  );

  const onProgress = useCallback((p: PaymentProgress) => {
    if (mounted.current) setProgress(p);
  }, []);
  const stopped = useCallback(() => !mounted.current, []);

  const pay = useCallback(
    () => guarded(() => runPayment(kind, booking, liveDeps(openHostedPage), onProgress, stopped)),
    [booking, guarded, kind, onProgress, stopped],
  );

  const check = useCallback(
    () => guarded(() => confirmPayment(kind, ref, liveDeps(openHostedPage), onProgress, [0, 2000, 4000], stopped)),
    [guarded, kind, onProgress, ref, stopped],
  );

  return { pay, check, progress, result, busy: progress !== null };
}
