import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { packageApi } from '@/api/endpoints/booking';
import { isApiError } from '@/api/errors';
import { Banner, Button, Card, Screen, Text, TextField } from '@/components';
import { Stepper } from '@/components/pickers';
import { cleanMobile } from '@/features/auth/schemas';
import { parseId } from '@/features/booking/refs';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const tidy = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');

const schema = z.object({
  name: z.string().transform(tidy).pipe(z.string().min(1, 'Enter your name.').max(150, 'That name is too long.')),
  email: z.string().trim().pipe(z.email('Enter a valid email address.')),
  mobile: z
    .string()
    .transform(cleanMobile)
    .pipe(z.string().regex(/^\+?\d{8,15}$/, 'Enter a valid mobile number: 8 to 15 digits, optionally starting with +.')),
  message: z.string().trim().min(1, 'Tell us when you’d like to travel and anything we should know.').max(4000, 'Please keep this under 4,000 characters.'),
});
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

/**
 * "Enquire about dates": the website's enquiry form, for a package with nothing
 * open to book. It creates an ENQUIRY (a request for a call back), not a booking,
 * and is not idempotent on the server, so the form submits once and then shows
 * the reference instead of a form that could be sent again.
 */
export default function EnquireScreen() {
  const router = useRouter();
  const { customer } = useAuth();
  const params = useLocalSearchParams<{ packageId?: string; packageName?: string }>();
  const packageId = parseId(params.packageId);
  const packageName = (asString(params.packageName) ?? '').slice(0, 200);

  const [travellers, setTravellers] = useState(2);
  const [done, setDone] = useState<{ reference: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const singleFlight = useSingleFlight();
  const [sending, setSending] = useState(false);

  const registered = customer && !customer.is_guest ? customer : null;
  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: registered?.full_name ?? '',
      email: registered?.email ?? '',
      mobile: registered?.mobile ?? '',
      message: '',
    },
  });

  const submit = handleSubmit((values) =>
    singleFlight(async () => {
      setSending(true);
      setError(null);
      try {
        const res = await packageApi.enquire({
          name: values.name,
          email: values.email,
          mobile: values.mobile,
          package_id: packageId,
          package_name: packageName || 'Tour package',
          number_of_travellers: travellers,
          message: values.message,
        });
        setDone({ reference: res.enquiry_reference, message: res.message });
      } catch (e) {
        // An enquiry is not idempotent: if the answer was lost, say so plainly rather than inviting a duplicate.
        const unsure = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout');
        setError(
          unsure
            ? 'We couldn’t confirm that your enquiry was sent. Please wait a moment and try once more; if it reaches us twice, our team will simply merge them.'
            : isApiError(e)
              ? e.message
              : 'Something went wrong. Please try again.',
        );
      } finally {
        setSending(false);
      }
    }),
  );

  if (done) {
    return (
      <Screen header={{ title: 'Enquiry sent', back: true }} scroll>
        <Card>
          <Text variant="h2" color="navy800" accessibilityRole="header">
            Thank you
          </Text>
          <Text variant="body" color="ink2">
            {done.message}
          </Text>
          <Text variant="caption" color="muted">
            Your reference
          </Text>
          <Text variant="title" color="navy800" selectable>
            {done.reference}
          </Text>
        </Card>
        <Button title="Back to packages" onPress={() => router.replace('/packages')} />
      </Screen>
    );
  }

  return (
    <Screen header={{ title: 'Enquire about dates', back: true }} scroll keyboard bottomInset>
      {packageName ? (
        <Card>
          <Text variant="eyebrow" color="goldInk">
            Package
          </Text>
          <Text variant="h3" color="navy800">
            {packageName}
          </Text>
        </Card>
      ) : null}
      <Text variant="body" color="muted">
        Tell us when you’d like to travel. This sends an enquiry to our team; it doesn’t book anything or take any payment.
      </Text>

      <Controller control={control} name="name" render={({ field: { value, onChange, onBlur } }) => (
        <TextField label="Your name" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.name?.message} autoComplete="name" autoCapitalize="words" />
      )} />
      <Controller control={control} name="email" render={({ field: { value, onChange, onBlur } }) => (
        <TextField label="Email" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.email?.message} autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address" />
      )} />
      <Controller control={control} name="mobile" render={({ field: { value, onChange, onBlur } }) => (
        <TextField label="Mobile number" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.mobile?.message} helper="Include your country code, for example +91." autoComplete="tel" keyboardType="phone-pad" />
      )} />
      <Card>
        <Stepper label="Travellers" value={travellers} min={1} max={12} onChange={setTravellers} />
      </Card>
      <Controller control={control} name="message" render={({ field: { value, onChange, onBlur } }) => (
        <TextField label="Your message" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.message?.message} multiline maxLength={4000} placeholder="Preferred dates, number of nights, anything we should know" />
      )} />

      {error ? <Banner tone="error" message={error} /> : null}
      <Button title="Send enquiry" loading={sending} onPress={() => void submit()} />
    </Screen>
  );
}
