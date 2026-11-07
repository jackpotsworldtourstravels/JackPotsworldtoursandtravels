import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Linking, StyleSheet, View } from 'react-native';

import { engagementApi } from '@/api/endpoints/engagement';
import { isApiError } from '@/api/errors';
import { Banner, Button, Card, FormCard, PageShell, Text, TextField } from '@/components';
import {
  bookingHelpSubject,
  contactPayload,
  MESSAGE_UNSURE,
  messageSchema,
  SUPPORT_EMAIL,
  SUPPORT_PHONE,
  SUPPORT_PHONE_DISPLAY,
  type MessageFormInput,
  type MessageFormOutput,
} from '@/features/account/support';
import { parseBookingRef } from '@/features/booking/refs';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

type Outcome = { kind: 'sent'; email: string } | { kind: 'failed' } | { kind: 'unsure' } | null;

function MessageForm({ bookingRef, subject }: { bookingRef: string | null; subject: string }) {
  const router = useRouter();
  const { customer, status } = useAuth();
  const singleFlight = useSingleFlight();
  const registered = status === 'customer' && customer !== null;
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<MessageFormInput, unknown, MessageFormOutput>({
    resolver: zodResolver(messageSchema),
    defaultValues: {
      name: registered ? (customer?.full_name ?? '') : '',
      email: registered ? (customer?.email ?? '') : '',
      subject: bookingRef ? bookingHelpSubject({ booking_ref: bookingRef }) : subject,
      message: '',
    },
  });

  const send = handleSubmit((values) =>
    singleFlight(async () => {
      setSending(true);
      setOutcome(null);
      try {
        await engagementApi.sendContactMessage(contactPayload(values));
        setOutcome({ kind: 'sent', email: values.email });
      } catch (e) {
        // The message is emailed and nothing is stored, so a lost answer cannot be checked: say that plainly.
        setOutcome(isApiError(e) && (e.kind === 'network' || e.kind === 'timeout') ? { kind: 'unsure' } : { kind: 'failed' });
      } finally {
        setSending(false);
      }
    }),
  );

  if (outcome?.kind === 'sent') {
    return (
      <View style={styles.stack}>
        <Banner tone="success" message={`We’ve sent your message to our team. They will reply by email to ${outcome.email}.`} />
        <Button title="Back to Help and support" onPress={() => router.replace('/support')} />
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      {bookingRef ? (
        <Card>
          <Text variant="eyebrow" color="goldInk">
            About booking
          </Text>
          <Text variant="title" color="navy800">
            {bookingRef}
          </Text>
        </Card>
      ) : null}
      <Text variant="body" color="muted">
        Tell us what you need. Our team replies by email, so give an address you check.
      </Text>
      <Controller
        control={control}
        name="name"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Your name" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.name?.message} autoComplete="name" maxLength={120} />
        )}
      />
      <Controller
        control={control}
        name="email"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Email we can reply to"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.email?.message}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
          />
        )}
      />
      <Controller
        control={control}
        name="subject"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Subject (optional)" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.subject?.message} maxLength={200} />
        )}
      />
      <Controller
        control={control}
        name="message"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField label="Message" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.message?.message} multiline maxLength={5000} />
        )}
      />
      {outcome?.kind === 'failed' ? (
        <Banner tone="error" message={`We couldn’t send that just now. Please try again in a moment, or call ${SUPPORT_PHONE_DISPLAY} or email ${SUPPORT_EMAIL}.`} />
      ) : null}
      {outcome?.kind === 'unsure' ? <Banner tone="warning" message={MESSAGE_UNSURE} /> : null}
      <Button title="Send message" variant="coral" loading={sending} onPress={() => void send()} />
      <Button
        title={`Call ${SUPPORT_PHONE_DISPLAY}`}
        variant="outline"
        icon="call-outline"
        onPress={() => void Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => undefined)}
      />
    </View>
  );
}

/**
 * A message to our team, sent the way the website's contact form sends one (an email to the business, answered by
 * email). Open to anyone: no account is needed. Optionally about one of the customer's bookings (`?ref=JPH000123`)
 * or a subject carried from another screen (`?subject=`). The reference is checked before it goes near a subject line.
 */
export default function NewMessageScreen() {
  const params = useLocalSearchParams<{ ref?: string; subject?: string }>();
  const parsed = parseBookingRef(asString(params.ref));
  const subject = (asString(params.subject) ?? '').slice(0, 200);
  return (
    <PageShell
      title="Send us a message"
      crumb="Contact Us"
      lede="Questions about a booking, a refund, or planning something big? Send us a message and our team will reply by email."
      keyboard
    >
      <FormCard>
        <MessageForm bookingRef={parsed ? parsed.ref : null} subject={subject} />
      </FormCard>
    </PageShell>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
});
