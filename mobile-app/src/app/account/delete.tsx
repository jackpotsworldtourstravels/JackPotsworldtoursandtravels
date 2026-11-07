import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { engagementApi } from '@/api/endpoints/engagement';
import { isApiError } from '@/api/errors';
import { AuthGate, Banner, Button, Card, Checkbox, LoadingState, Screen, Text, TextField } from '@/components';
import { formatWhen } from '@/features/account/format';
import { useSupportTickets } from '@/features/account/hooks';
import {
  deletionMessage,
  deletionSchema,
  findOpenDeletionRequest,
  MUST_BE_KEPT,
  openBookingRefs,
  RESPONSE_DAYS,
  WILL_BE_DELETED,
  type DeletionFormInput,
  type DeletionFormOutput,
} from '@/features/account/deletion';
import { readDeletionRequest, recordDeletionRequest } from '@/features/account/localRequests';
import { SUPPORT_EMAIL, SUPPORT_PHONE_DISPLAY } from '@/features/account/support';
import { useMyBookings } from '@/features/booking/hooks';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useAuth } from '@/providers/AuthProvider';
import { spacing } from '@/theme';
import type { SupportTicket } from '@/types/account';
import type { Customer } from '@/types/api';

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <View style={styles.bullets}>
      {items.map((t) => (
        <Text key={t} variant="body" color="ink2">
          • {t}
        </Text>
      ))}
    </View>
  );
}

function Explanation({ guest }: { guest: boolean }) {
  return (
    <>
      <Banner
        tone="warning"
        message={`This sends a request to our team by email. It does NOT delete your account straight away. Your account stays as it is, and keeps working, until our team has completed the request. We aim to reply within ${RESPONSE_DAYS} days.`}
      />
      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk" accessibilityRole="header">
          What we can delete
        </Text>
        <Bullets items={WILL_BE_DELETED} />
      </Card>
      <Card style={styles.card}>
        <Text variant="eyebrow" color="goldInk" accessibilityRole="header">
          What we must keep
        </Text>
        <Text variant="small" color="muted">
          The law, not us, decides this. Our privacy policy explains it in full.
        </Text>
        <Bullets items={MUST_BE_KEPT} />
      </Card>
      <Text variant="small" color="muted">
        {guest
          ? 'You are using the app as a guest, so we have no email address for you. Give one below: our team replies by email. They will check who you are before acting, as our privacy policy describes.'
          : 'Our team will check who you are before acting, as our privacy policy describes. Signing out does not delete anything.'}
      </Text>
    </>
  );
}

function OpenBookings({ refs, failed }: { refs: readonly string[]; failed: boolean }) {
  if (failed) {
    return <Banner tone="info" message="We couldn’t check your bookings just now. If you have a trip coming up, our team will contact you before deleting anything it needs." />;
  }
  if (refs.length === 0) return null;
  return (
    <Banner
      tone="warning"
      message={`You have ${refs.length} open booking${refs.length === 1 ? '' : 's'} (${refs.slice(0, 5).join(', ')}${refs.length > 5 ? ` and ${refs.length - 5} more` : ''}). Records for a trip that hasn’t happened yet are kept until it is over, so we can’t complete your request until then. You can still send it now. An unpaid booking can be cancelled from its own page first.`}
    />
  );
}

function Sent({ email }: { email: string }) {
  const router = useRouter();
  return (
    <View style={styles.stack}>
      <Banner
        tone="success"
        message={`We’ve sent your request to our team by email. Your account has NOT been deleted yet: they will review it and reply to ${email}, aiming within ${RESPONSE_DAYS} days.`}
      />
      <Button title="Back to Help and support" onPress={() => router.replace('/support')} />
    </View>
  );
}

function AlreadyAsked({ ticket }: { ticket: SupportTicket }) {
  const router = useRouter();
  return (
    <Card style={styles.card}>
      <Text variant="h3" color="navy800" accessibilityRole="header">
        You’ve already asked us to delete your account
      </Text>
      <Text variant="body" color="ink2">
        We received your request on {formatWhen(ticket.created_at)}. It is with our team, who will contact you. Your account has not been deleted yet.
      </Text>
      <Button title="View your request" onPress={() => router.push({ pathname: '/support/[id]', params: { id: String(ticket.id) } })} />
    </Card>
  );
}

/** The phone remembers a request it sent by email; there is nothing on the server to look up. */
function AskedByEmail({ askedAt }: { askedAt: string }) {
  const router = useRouter();
  return (
    <Card style={styles.card}>
      <Text variant="h3" color="navy800" accessibilityRole="header">
        You’ve already asked us to delete your account
      </Text>
      <Text variant="body" color="ink2">
        You asked on {formatWhen(askedAt)}, from this phone. We sent it to our team by email, and they reply by email. Your account has not been deleted yet.
      </Text>
      <Text variant="small" color="muted">
        If you haven’t heard back, call {SUPPORT_PHONE_DISPLAY} or write to {SUPPORT_EMAIL}.
      </Text>
      <Button title="Send our team a message" variant="outline" onPress={() => router.push('/support/new')} />
    </Card>
  );
}

function DeleteForm({
  customer,
  guest,
  openRefs,
  bookingsFailed,
  onSent,
}: {
  customer: Customer;
  guest: boolean;
  openRefs: readonly string[];
  bookingsFailed: boolean;
  onSent: (email: string) => void;
}) {
  const singleFlight = useSingleFlight();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The team replies by email, so an address is required when the account has none.
  const needsEmail = guest || !customer.email;

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<DeletionFormInput, unknown, DeletionFormOutput>({
    resolver: zodResolver(deletionSchema(needsEmail)),
    defaultValues: { reason: '', contact: '', confirmed: false },
  });

  const send = handleSubmit((values) =>
    singleFlight(async () => {
      setSending(true);
      setError(null);
      try {
        const message = deletionMessage({ customer, guest, openRefs, reason: values.reason, contact: values.contact });
        await engagementApi.sendContactMessage(message);
        await recordDeletionRequest(customer.customer_code);
        onSent(message.email);
      } catch (e) {
        // An email cannot be looked up afterwards, so a lost answer is said plainly and the customer decides.
        const lost = isApiError(e) && (e.kind === 'network' || e.kind === 'timeout');
        setError(
          lost
            ? 'We couldn’t confirm that your request reached us. It may already have, so check your email for our reply before sending it again, or call us.'
            : `We couldn’t send your request just now. Please try again in a moment, or call ${SUPPORT_PHONE_DISPLAY} or email ${SUPPORT_EMAIL}.`,
        );
      } finally {
        setSending(false);
      }
    }),
  );

  return (
    <View style={styles.stack}>
      <Explanation guest={guest} />
      <OpenBookings refs={openRefs} failed={bookingsFailed} />

      <Controller control={control} name="contact" render={({ field: { value, onChange, onBlur } }) => (
        <TextField
          label={needsEmail ? 'Email address we can reply to' : 'Another email or mobile number (optional)'}
          value={value}
          onChangeText={onChange}
          onBlur={onBlur}
          error={errors.contact?.message}
          helper={needsEmail ? 'Required. Our team replies by email.' : `We’ll reply to ${customer.email} unless you add another.`}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
      )} />
      <Controller control={control} name="reason" render={({ field: { value, onChange, onBlur } }) => (
        <TextField label="Reason (optional)" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.reason?.message} multiline maxLength={500} />
      )} />
      <Controller control={control} name="confirmed" render={({ field: { value, onChange } }) => (
        <Checkbox
          label="I understand this is a request, that it doesn’t delete my account straight away, and that records the law requires will be kept."
          checked={value}
          onChange={onChange}
          error={errors.confirmed?.message}
        />
      )} />

      {error ? <Banner tone="error" message={error} /> : null}
      <Button title="Send deletion request" variant="danger" loading={sending} onPress={() => void send()} />
    </View>
  );
}

function DeleteContent() {
  const { customer, status } = useAuth();
  const bookings = useMyBookings();
  const tickets = useSupportTickets();
  // Held here, not in the form: once sent, nothing else may replace the confirmation.
  const [sentTo, setSentTo] = useState<string | null>(null);
  // `undefined` until the phone's memory has been read.
  const [askedAt, setAskedAt] = useState<string | null | undefined>(undefined);
  const code = customer?.customer_code;

  useEffect(() => {
    let live = true;
    if (!code) return undefined;
    void readDeletionRequest(code).then((at) => {
      if (live) setAskedAt(at);
    });
    return () => {
      live = false;
    };
  }, [code]);

  if (sentTo !== null) return <Sent email={sentTo} />;
  if (!customer) return <LoadingState />;
  if (tickets.isPending || bookings.isPending || askedAt === undefined) return <LoadingState message="One moment…" />;

  // A request made before this app sent them by email is still on the account: keep showing it.
  const existing = tickets.isSuccess ? findOpenDeletionRequest(tickets.data) : null;
  if (existing) return <AlreadyAsked ticket={existing} />;
  if (askedAt) return <AskedByEmail askedAt={askedAt} />;

  const guest = status === 'guest';
  const refs = bookings.isSuccess ? openBookingRefs(bookings.data) : [];
  return <DeleteForm customer={customer} guest={guest} openRefs={refs} bookingsFailed={bookings.isError} onSent={setSentTo} />;
}

/**
 * "Delete my account", as a REQUEST to our team, sent by email (see features/account/deletion.ts). It explains what
 * will and will not be deleted, warns about open bookings without blocking, and says plainly that nothing is deleted
 * until a person has completed it.
 */
export default function DeleteAccountScreen() {
  return (
    <Screen header={{ title: 'Delete my account', back: true }} scroll keyboard bottomInset>
      <AuthGate title="Delete my account" message="Sign in, or continue as a guest, so we know which account you mean.">
        <DeleteContent />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.s3 },
  card: { gap: spacing.s2 },
  bullets: { gap: spacing.s2 },
});

