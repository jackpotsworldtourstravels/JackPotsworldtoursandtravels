import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { enquiriesApi } from '@/api/endpoints/enquiries';
import { isApiError } from '@/api/errors';
import { Banner, Button, Card, FormCard, FormSection, PageShell, Text, TextField } from '@/components';
import { OptionalDatePickerField } from '@/components/pickers';
import { SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '@/features/account/support';
import { EMPTY_GAMING_FORM, GAMING_COPY, gamingErrors, gamingRequest, type GamingField, type GamingForm } from '@/features/gaming/gamingForm';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing } from '@/theme';
import { addDays, todayISO } from '@/utils/dates';

type Outcome = { kind: 'sent'; reference: string } | { kind: 'failed'; message: string } | { kind: 'unsure' } | null;

function Received({ reference }: { reference: string }) {
  const router = useRouter();
  return (
    <View style={styles.stack}>
      <Banner tone="success" message={`${GAMING_COPY.received.title}. ${GAMING_COPY.received.body}`} />
      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk">
          Your reference
        </Text>
        <Text variant="h2" color="navy800" selectable>
          {reference}
        </Text>
        <Text variant="h3" color="navy800" accessibilityRole="header">
          {GAMING_COPY.next.title}
        </Text>
        {GAMING_COPY.next.items.map((item) => (
          <Text key={item} variant="body" color="ink2">
            • {item}
          </Text>
        ))}
        <Text variant="body" color="ink2">
          {GAMING_COPY.talk}{' '}
          <Text variant="bodyStrong" color="goldInk" onPress={() => router.push('/support')} accessibilityRole="link">
            {GAMING_COPY.contact}
          </Text>{' '}
          {GAMING_COPY.talkTail}
        </Text>
      </Card>
    </View>
  );
}

/**
 * GAMING TOUR PACKAGES: the website's enquiry form (`gaming-packages.html`), sent to the same public endpoint
 * (`POST /api/customer/gaming-tour-enquiries`). It is an enquiry, not a search and not a booking: a person
 * calls back with a quote, and nothing is charged. There is no reference to check if an answer is lost, so
 * the screen says that plainly rather than pretending to know.
 */
export default function GamingScreen() {
  const { customer, status } = useAuth();
  const singleFlight = useSingleFlight();
  const registered = status === 'customer' && customer !== null;
  const [form, setForm] = useState<GamingForm>(() => ({
    ...EMPTY_GAMING_FORM,
    name: registered ? (customer?.full_name ?? '') : '',
    email: registered ? (customer?.email ?? '') : '',
    mobile: registered ? (customer?.mobile ?? '') : '',
  }));
  const [errors, setErrors] = useState<Partial<Record<GamingField, string>>>({});
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const today = todayISO();

  const set = (patch: Partial<GamingForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    // The site clears a field's message as soon as it is edited.
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) {
        delete next[key as GamingField];
        if (key === 'date' || key === 'time') delete next.datetime;
      }
      return next;
    });
  };

  const submit = () =>
    singleFlight(async () => {
      const found = gamingErrors(form);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
      setSending(true);
      setOutcome(null);
      try {
        const { enquiry_reference } = await enquiriesApi.submitGaming(gamingRequest(form));
        setOutcome({ kind: 'sent', reference: enquiry_reference });
      } catch (e) {
        const lost = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout');
        setOutcome(
          lost
            ? { kind: 'unsure' }
            : { kind: 'failed', message: isApiError(e) && e.kind === 'validation' ? e.message : 'We could not submit your enquiry. Please try again.' },
        );
      } finally {
        setSending(false);
      }
    });

  return (
    <PageShell title={GAMING_COPY.title} crumb="Gaming Tour Enquiry" lede={GAMING_COPY.lede} keyboard overlap={outcome?.kind !== 'sent'}>
      {outcome?.kind === 'sent' ? (
        <Received reference={outcome.reference} />
      ) : (
        <FormCard>
          <FormSection first title={GAMING_COPY.customer.title} sub={GAMING_COPY.customer.sub}>
            <TextField
              label="Full Name *"
              value={form.name}
              onChangeText={(name) => set({ name })}
              error={errors.name}
              autoComplete="name"
              placeholder="Your full name"
            />
            <TextField
              label="Email Address *"
              value={form.email}
              onChangeText={(email) => set({ email })}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              placeholder="you@example.com"
            />
            <TextField
              label="Mobile Number *"
              value={form.mobile}
              onChangeText={(mobile) => set({ mobile })}
              error={errors.mobile}
              keyboardType="phone-pad"
              autoComplete="tel"
              placeholder="+91 98765 43210"
            />
          </FormSection>

          <FormSection title={GAMING_COPY.travel.title} sub={GAMING_COPY.travel.sub}>
            <TextField label="From Airport *" value={form.from} onChangeText={(from) => set({ from })} error={errors.from} placeholder="e.g. Hyderabad (HYD)" />
            <TextField label="To Airport *" value={form.to} onChangeText={(to) => set({ to })} error={errors.to} placeholder="e.g. Bangkok (BKK)" />
            <OptionalDatePickerField appearance="field" label="Travel Date" value={form.date} min={today} max={addDays(today, 730)} onChange={(date) => set({ date })} />
            <TextField
              label="Travel Time (24-hour, HH:MM) *"
              value={form.time}
              onChangeText={(time) => set({ time })}
              error={errors.datetime}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              placeholder="10:00"
            />
            <TextField
              label="Number of Nights *"
              value={form.nights}
              onChangeText={(nights) => set({ nights: nights.replace(/[^\d]/g, '') })}
              error={errors.nights}
              keyboardType="number-pad"
              maxLength={2}
            />
          </FormSection>

          <FormSection title={GAMING_COPY.preference.title} sub={GAMING_COPY.preference.sub}>
            <TextField label="Casino Type *" value={form.casino} onChangeText={(casino) => set({ casino })} error={errors.casino} multiline maxLength={300} />
          </FormSection>

          {outcome?.kind === 'failed' ? <Banner tone="error" message={outcome.message} /> : null}
          {outcome?.kind === 'unsure' ? (
            <Banner
              tone="warning"
              message="We couldn’t confirm that your enquiry reached us, and there is no reference to check. If it did, our desk will call you back; to be sure, submit again or call us."
            />
          ) : null}
          <Button title={GAMING_COPY.submit} variant="coral" loading={sending} onPress={() => void submit()} />
          <Pressable
            onPress={() => void Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => undefined)}
            accessibilityRole="link"
            accessibilityLabel={`Call ${SUPPORT_PHONE_DISPLAY}`}
            style={styles.call}
          >
            <Text variant="bodyStrong" color="goldInk" align="center">
              {GAMING_COPY.talk} Call {SUPPORT_PHONE_DISPLAY}
            </Text>
          </Pressable>
        </FormCard>
      )}
    </PageShell>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s4 },
  card: { gap: spacing.s3 },
  call: { minHeight: 48, justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
});
