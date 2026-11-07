import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { useRequestCancellation } from '@/features/account/hooks';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { spacing } from '@/theme';
import type { CancellationRequest } from '@/types/account';
import type { AnyBooking } from '@/types/booking';

import { canRequestCancellation } from '../groups';

const REASON_MAX = 500;

/** The server's own words for "there is already an open request"; said to the customer as reassurance, not as an error. */
const isAlreadyOpen = (error: unknown) => isApiError(error) && error.status === 400 && /already open/i.test(error.message);

/**
 * Asking the desk to review cancelling a PAID booking. This is a request, said so
 * on the screen: it cancels nothing and refunds nothing by itself; a person
 * checks it against the cancellation policy and gets back to the customer. The
 * server refuses a second open request, and the customer is told they already
 * have one. (There is no endpoint to read a request's progress back, so the app
 * shows the reference it was given and no status it cannot know.)
 */
function CancellationRequestCard({ booking }: { booking: AnyBooking }) {
  const request = useRequestCancellation();
  const singleFlight = useSingleFlight();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState<CancellationRequest | null>(null);
  const [alreadyOpen, setAlreadyOpen] = useState(false);

  if (sent) {
    return (
      <Banner
        tone="success"
        message={`We’ve received your cancellation request (${sent.cancellation_id}). It doesn’t cancel the booking by itself: our team will review it and contact you.`}
      />
    );
  }
  if (alreadyOpen) {
    return <Banner tone="info" message="You’ve already asked us to cancel this booking. Our team will be in touch." />;
  }
  if (!open) {
    return <Button title="Ask us to cancel this booking" variant="outline" onPress={() => setOpen(true)} />;
  }

  const send = () =>
    singleFlight(async () => {
      try {
        const trimmed = reason.trim().slice(0, REASON_MAX);
        setSent(await request.mutateAsync({ booking_ref: booking.booking_ref, reason: trimmed === '' ? null : trimmed }));
      } catch (e) {
        if (isAlreadyOpen(e)) setAlreadyOpen(true);
      }
    });

  return (
    <View style={styles.form}>
      <Banner
        tone="info"
        message="This sends a request to our team. It doesn’t cancel your booking or refund anything by itself: we review it against the cancellation policy and contact you."
      />
      <TextField
        label="Reason (optional)"
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={REASON_MAX}
        placeholder="Anything that helps us review it"
      />
      {request.isError && !isAlreadyOpen(request.error) ? (
        <Banner tone="error" message={isApiError(request.error) ? request.error.message : 'Something went wrong. Please try again.'} />
      ) : null}
      <Button title="Send request" loading={request.isPending} onPress={() => void send()} />
      <Button title="Not now" variant="ghost" disabled={request.isPending} onPress={() => setOpen(false)} />
    </View>
  );
}

/** "Need help?" at the foot of a booking: a support request with this booking's reference on it, and a cancellation request where one is possible. */
export function BookingHelp({ booking }: { booking: AnyBooking }) {
  const router = useRouter();
  return (
    <Card style={styles.card}>
      <Text variant="eyebrow" color="goldInk">
        Need help?
      </Text>
      <Text variant="small" color="muted">
        Questions about this booking, a change, or something that doesn’t look right.
      </Text>
      <Button
        title="Get help with this booking"
        variant="outline"
        onPress={() => router.push({ pathname: '/support/new', params: { ref: booking.booking_ref } })}
      />
      {canRequestCancellation(booking) ? <CancellationRequestCard booking={booking} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.s3 },
  form: { gap: spacing.s3 },
});
