import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { engagementApi } from '@/api/endpoints/engagement';
import { isApiError } from '@/api/errors';
import { Banner, Button, Card, Text, TextField } from '@/components';
import { SUPPORT_EMAIL, SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '@/features/account/support';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';

import { FARES, partySummary, type FlightSearch } from './flightForm';
import { buildFlightQuoteRequest, describeTrip } from './flightQuote';

const contactSchema = z.object({
  name: z.string().trim().min(1, 'Tell us your name.').max(120, 'That is too long.'),
  email: z.email('Enter an email address we can reply to.'),
});

/** Why there are no flights to show, and the one thing the app can honestly do instead. */
export const UNAVAILABLE_TITLE = 'Live flight fares aren’t available in the app yet';
export const UNAVAILABLE_BODY =
  'Searching and booking flights here needs a live airline supplier, and that is not connected yet. So we do not show fares, and we cannot take a flight booking or a payment in the app. Our team can quote you: send your search and they will reply by email, or call us.';

function QuoteForm({ search }: { search: FlightSearch }) {
  const { customer, status } = useAuth();
  const singleFlight = useSingleFlight();
  const registered = status === 'customer' && customer !== null;
  const [name, setName] = useState(registered ? (customer?.full_name ?? '') : '');
  const [email, setEmail] = useState(registered ? (customer?.email ?? '') : '');
  const [mobile, setMobile] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string }>({});
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<'sent' | 'failed' | 'unsure' | null>(null);

  const send = () =>
    singleFlight(async () => {
      const parsed = contactSchema.safeParse({ name, email: email.trim() });
      if (!parsed.success) {
        const flat = parsed.error.flatten().fieldErrors;
        setFieldErrors({ name: flat.name?.[0], email: flat.email?.[0] });
        return;
      }
      setFieldErrors({});
      setSending(true);
      setOutcome(null);
      try {
        await engagementApi.sendContactMessage(buildFlightQuoteRequest({ search, name: parsed.data.name, email: parsed.data.email, mobile }));
        setOutcome('sent');
      } catch (e) {
        // A lost answer may still have been delivered; a refusal (rate limit, mail down) was not.
        const lost = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout');
        setOutcome(lost ? 'unsure' : 'failed');
      } finally {
        setSending(false);
      }
    });

  if (outcome === 'sent') {
    return <Banner tone="success" message={`We’ve sent your flight request to our team. They will reply to ${email.trim()}. No fare has been quoted yet, and nothing has been booked or charged.`} />;
  }

  return (
    <View style={styles.stack}>
      <TextField label="Your name" value={name} onChangeText={setName} error={fieldErrors.name} autoComplete="name" />
      <TextField
        label="Email we can reply to"
        value={email}
        onChangeText={setEmail}
        error={fieldErrors.email}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
      />
      <TextField label="Mobile number (optional)" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" />
      {outcome === 'failed' ? (
        <Banner tone="error" message={`We couldn’t send that just now. Please try again in a moment, or call ${SUPPORT_PHONE_DISPLAY} or email ${SUPPORT_EMAIL}.`} />
      ) : null}
      {outcome === 'unsure' ? (
        <Banner tone="warning" message="We couldn’t confirm that your request reached us. It may already have, so check your email for our reply before sending it again." />
      ) : null}
      <Button title="Request a quote" loading={sending} onPress={() => void send()} />
    </View>
  );
}

/**
 * What a flight search leads to in the app today: nothing to book, and nothing pretending to be. The website's
 * own flights page lists a one-day "Sample schedule"; the app does not show sample fares as if they were live.
 */
export function FlightsUnavailable({ search }: { search: FlightSearch }) {
  const fare = FARES.find((f) => f.id === search.fare)?.label ?? 'Regular';
  return (
    <View style={styles.stack}>
      <Banner tone="info" message={UNAVAILABLE_TITLE} />
      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk">
          Your search
        </Text>
        {describeTrip(search).map((line) => (
          <Text key={line} variant="bodyStrong" color="navy800">
            {line}
          </Text>
        ))}
        <Text variant="small" color="muted">
          {partySummary(search.party)} · {search.cabin} · {fare} fare
        </Text>
        <Text variant="body" color="ink2">
          {UNAVAILABLE_BODY}
        </Text>
      </Card>
      <Card style={styles.card}>
        <Text variant="h3" color="navy800" accessibilityRole="header">
          Ask our team for a quote
        </Text>
        <QuoteForm search={search} />
      </Card>
      <Button title={`Call ${SUPPORT_PHONE_DISPLAY}`} variant="outline" icon="call-outline" onPress={() => void Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => undefined)} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
  card: { gap: spacing.s3 },
});
