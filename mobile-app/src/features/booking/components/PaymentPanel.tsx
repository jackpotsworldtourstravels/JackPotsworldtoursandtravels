import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { hotelApi, packageApi } from '@/api/endpoints/booking';
import { isApiError } from '@/api/errors';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { TakeoffLoader } from '@/components/Loader';
import { Text } from '@/components/Text';
import { colors, fontFamily, radius, spacing } from '@/theme';
import type { AnyBooking } from '@/types/booking';
import { formatMoney } from '@/utils/money';

import { bookingKeys } from '../hooks';
import { canCancel, canPay, payBy, paymentState, type PaymentState } from '../outcome';
import type { PaymentProgress, PaymentResult } from '../payment';
import type { BookingKind } from '../refs';
import { usePayment } from '../usePayment';

/** The three stages a customer sees while paying; each covers one or more of usePayment's steps. */
const STEPS: { label: string; steps: PaymentProgress['step'][] }[] = [
  { label: 'Opening a secure payment', steps: ['checking', 'opening'] },
  { label: 'Completing it in the secure page', steps: ['in_browser'] },
  { label: 'Confirming with the bank', steps: ['confirming'] },
];

const PROGRESS_TEXT: Record<PaymentProgress['step'], string> = {
  checking: 'Checking payment options…',
  opening: 'Opening a secure payment…',
  in_browser: 'Complete your payment in the secure page. Afterwards it may show our website: just close it to come back here.',
  confirming: 'Confirming with the bank…',
};

/** States whose own banner is shown whether or not a payment result is on screen. */
const ALWAYS_SHOWN: readonly PaymentState[] = ['paid', 'received_unconfirmed', 'refunded', 'cancelled'];

function resultBanner(result: PaymentResult) {
  if (result.kind === 'unavailable' || result.kind === 'error') {
    return <Banner tone="error" message={result.message} />;
  }
  switch (result.outcome) {
    case 'paid':
      return <Banner tone="success" message="Payment received. Your booking is confirmed." />;
    case 'received_unconfirmed':
      return (
        <Banner
          tone="warning"
          message="We’ve received your payment, but your booking isn’t confirmed yet. Please contact support with your booking reference, and don’t pay again."
        />
      );
    case 'waiting':
      return (
        <Banner
          tone="info"
          message="We haven’t heard back from the bank yet. If you completed the payment it can take a few minutes. Tap Check payment status before trying to pay again."
        />
      );
    case 'failed':
    case 'cancelled':
    case 'expired':
      return <Banner tone="error" message="The payment wasn’t completed and you haven’t been charged. You can try again." />;
    case 'refunded':
      return <Banner tone="info" message="This payment was refunded." />;
    default:
      return null;
  }
}

/**
 * Pay for a booking, check on a payment, or let go of an unpaid booking.
 *
 * Every state shown here comes from the backend's record of the booking and its
 * payments. "Confirmed" appears only when the server says the payment was
 * captured and the booking confirmed; the browser closing, a button press or a
 * redirect never changes what this panel claims.
 */
export function PaymentPanel({
  kind,
  booking,
  autoCheck = false,
}: {
  kind: BookingKind;
  booking: AnyBooking;
  /** On first show, if a payment was left open, ask the backend where it stands (once, quietly). */
  autoCheck?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pay, check, progress, result, busy } = usePayment(kind, booking);
  const state = paymentState(booking);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // A customer who paid and then left the app (or whose app was killed mid-payment) comes back to a
  // booking whose payment is still "in progress". Settling that is the backend's job; one quiet ask
  // lets it say so, without the customer having to find the Check button.
  // It is for a payment found open on arrival only. Starting a payment here opens an order, which makes the
  // next read of the booking look "in progress" too; pressing Pay therefore counts as asking, or this would
  // wipe what Pay just reported and start polling for a payment that was never opened.
  const asked = useRef(false);
  useEffect(() => {
    if (autoCheck && !asked.current && state === 'in_progress') {
      asked.current = true;
      void check();
    }
  }, [autoCheck, state, check]);
  const startPayment = () => {
    asked.current = true;
    void pay();
  };

  const cancel = useMutation({
    mutationFn: async (): Promise<AnyBooking> =>
      kind === 'hotel' ? hotelApi.cancel(booking.booking_ref) : packageApi.cancel(booking.booking_ref),
    onSuccess: async () => {
      setConfirmingCancel(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: bookingKeys.one(kind, booking.booking_ref) }),
        queryClient.invalidateQueries({ queryKey: bookingKeys.mine() }),
      ]);
    },
  });

  const total = formatMoney(booking.total_amount, { currency: booking.currency });
  const deadline = payBy(booking.created_at);
  const payable = canPay(booking);

  return (
    <View style={styles.panel}>
      {state === 'paid' ? (
        <Card style={styles.confirmed}>
          <View style={styles.tick}>
            <Ionicons name="checkmark" size={30} color={colors.white} />
          </View>
          <Text variant="h2" color="ink" align="center" accessibilityRole="header">
            Booking confirmed
          </Text>
          <Text variant="body" color="ink2" align="center">
            Payment received. This booking is confirmed.
          </Text>
        </Card>
      ) : null}
      {state === 'received_unconfirmed' ? (
        <Banner
          tone="warning"
          message="We’ve received your payment, but this booking isn’t confirmed yet. Please contact support with your booking reference, and don’t pay again."
        />
      ) : null}
      {state === 'refunded' ? <Banner tone="info" message="This payment was refunded." /> : null}
      {state === 'cancelled' ? <Banner tone="info" message="This booking was cancelled." /> : null}
      {state === 'in_progress' && !result ? (
        <Banner
          tone="info"
          message="A payment was started for this booking. If you’ve already paid, check its status. Otherwise you can pick up where you left off."
        />
      ) : null}
      {state === 'failed' && !result ? (
        <Banner tone="error" message="The last payment attempt didn’t go through, and you haven’t been charged. You can try again." />
      ) : null}

      {/* Once the booking has been re-read, the banner for these states above already says it; saying it twice
          would just be noise. (A failed attempt's banner is hidden while a result is showing, so that one stays.) */}
      {result && !(result.kind === 'outcome' && result.outcome === state && ALWAYS_SHOWN.includes(state)) ? resultBanner(result) : null}

      {progress ? (
        <Card style={styles.progress}>
          <TakeoffLoader width={200} label={PROGRESS_TEXT[progress.step]} />
          <View style={styles.steps} accessibilityRole="list">
            {STEPS.map((step, i) => {
              const at = STEPS.findIndex((st) => st.steps.includes(progress.step));
              const done = i < at;
              const current = i === at;
              return (
                <View key={step.label} style={styles.step}>
                  <View style={[styles.stepDot, done && styles.stepDone, current && styles.stepNow]}>
                    {done ? <Ionicons name="checkmark" size={12} color={colors.white} /> : null}
                  </View>
                  <Text variant={current ? 'bodyStrong' : 'body'} color={done || current ? 'ink' : 'textSecondary'}>
                    {step.label}
                  </Text>
                </View>
              );
            })}
          </View>
          <Text variant="small" color="textSecondary" align="center" accessibilityLiveRegion="polite">
            {PROGRESS_TEXT[progress.step]}
            {progress.step === 'confirming' && progress.attempt > 1 ? ` (check ${progress.attempt})` : ''}
          </Text>
          <Text variant="caption" color="textSecondary" align="center">
            Please don’t press back or close the app.
          </Text>
        </Card>
      ) : null}

      {payable ? (
        <>
          <View style={styles.hold}>
            <Ionicons name="time-outline" size={18} color={colors.warning} />
            <Text variant="small" color="ink" style={styles.grow}>
              Amount due {total}. Please pay by{' '}
              {deadline.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; after that the booking can no
              longer be paid for.
            </Text>
          </View>
          <View style={styles.amount}>
            <View style={styles.amountTop}>
              <View style={styles.grow}>
                <Text variant="caption" color="onDark2">
                  Amount to pay
                </Text>
                <Text variant="hero" color="white" style={styles.amountValue}>
                  {total}
                </Text>
              </View>
              <View style={styles.refPill}>
                <Text variant="caption" chrome color="navy900" style={styles.refText}>
                  {booking.booking_ref}
                </Text>
              </View>
            </View>
            <View style={styles.secure}>
              <Ionicons name="lock-closed" size={14} color={colors.goldLight} />
              <Text variant="caption" color="onDark2" style={styles.grow}>
                UPI, cards and net banking on the next screen
              </Text>
            </View>
          </View>
          <Button
            title={state === 'in_progress' ? 'Continue to payment' : `Pay ${total}`}
            icon="lock-closed"
            loading={busy}
            onPress={startPayment}
          />
          {state === 'in_progress' || state === 'failed' ? (
            <Button
              title="Check payment status"
              variant="outline"
              disabled={busy}
              onPress={() => void check()}
            />
          ) : null}
          <Text variant="caption" color="textSecondary" align="center">
            Payments are processed securely by our payment partner. We never see or store your card or UPI details.
          </Text>
        </>
      ) : null}

      {canCancel(booking) ? (
        confirmingCancel ? (
          <View style={styles.confirm}>
            <Banner tone="warning" message="Cancel this booking? It hasn’t been paid for, so nothing will be charged." />
            {cancel.isError ? (
              <Banner tone="error" message={isApiError(cancel.error) ? cancel.error.message : 'Something went wrong. Please try again.'} />
            ) : null}
            <Button title="Yes, cancel booking" variant="danger" loading={cancel.isPending} onPress={() => cancel.mutate()} />
            <Button title="Keep booking" variant="ghost" disabled={cancel.isPending} onPress={() => setConfirmingCancel(false)} />
          </View>
        ) : (
          <Button title="Cancel booking" variant="ghost" disabled={busy} onPress={() => setConfirmingCancel(true)} />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing.s3 },
  grow: { flex: 1, minWidth: 0 },
  confirm: { gap: spacing.s2 },
  confirmed: { alignItems: 'center', gap: spacing.s2, paddingVertical: spacing.s5 },
  tick: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 6,
    borderColor: colors.successSoft,
    marginBottom: spacing.s1,
  },
  progress: { alignItems: 'center', gap: spacing.s3, paddingVertical: spacing.s4 },
  steps: { alignSelf: 'stretch', gap: spacing.s2, paddingHorizontal: spacing.s2 },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 28 },
  stepDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  stepDone: { backgroundColor: colors.success, borderColor: colors.success },
  stepNow: { borderColor: colors.gold, borderWidth: 6 },
  hold: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.s2,
    padding: spacing.s3,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: '#F3D9A4',
  },
  amount: { backgroundColor: colors.navy900, borderRadius: 20, padding: spacing.s4, gap: spacing.s3 },
  amountTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3 },
  amountValue: { fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  refPill: { backgroundColor: colors.gold, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 4 },
  refText: { fontFamily: fontFamily.sansExtraBold },
  secure: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.navy600 },
});
