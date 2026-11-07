import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { AuthGate, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { formatWhen } from '@/features/account/format';
import { useMyBookings } from '@/features/booking/hooks';
import { paymentRows, type PaymentRow } from '@/features/booking/paymentHistory';
import { paymentStatusLabel } from '@/features/booking/outcome';
import { spacing } from '@/theme';
import { formatMoney } from '@/utils/money';

function Entry({ entry }: { entry: PaymentRow }) {
  const router = useRouter();
  const body = (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Text variant="title" color="navy800" style={styles.grow}>
          {formatMoney(entry.amount, { currency: entry.currency })}
        </Text>
        <Text variant="bodyStrong" color={entry.status === 'captured' ? 'success' : entry.status === 'refunded' ? 'info' : 'ink2'}>
          {paymentStatusLabel(entry.status)}
        </Text>
      </View>
      <Text variant="small" color="muted">
        {entry.booking_ref} · {entry.method} · {formatWhen(entry.created_at)}
      </Text>
      {entry.status === 'refunded' ? (
        <Text variant="small" color="ink2">
          This payment was refunded.
        </Text>
      ) : null}
      {entry.provider_reference ? (
        <Text variant="caption" color="muted" selectable>
          Reference {entry.provider_reference}
        </Text>
      ) : null}
    </Card>
  );
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/booking/[ref]', params: { ref: entry.booking_ref } })}
      accessibilityRole="button"
      accessibilityLabel={`${entry.booking_ref}, ${paymentStatusLabel(entry.status)}, ${formatMoney(entry.amount, { currency: entry.currency })}`}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {body}
    </Pressable>
  );
}

function PaymentList() {
  const bookings = useMyBookings();

  if (bookings.isPending) return <LoadingState message="Loading your payments…" />;
  if (bookings.isError) return <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} retrying={bookings.isRefetching} />;
  const rows = paymentRows(bookings.data);
  if (rows.length === 0) {
    return <EmptyState icon="card-outline" title="No payments yet" message="Payments you make for bookings, and any refunds, will appear here." />;
  }
  return (
    <View style={styles.list}>
      {rows.map((entry, i) => (
        <Entry key={`${entry.booking_ref}-${entry.created_at}-${i}`} entry={entry} />
      ))}
    </View>
  );
}

/**
 * Every payment attempt on this customer's hotel and package bookings, as the
 * backend recorded it, with refunds shown as the backend reports them. (Flight
 * payments made on the website are not shown: the app does not sell flights.) Read-only: nothing here starts,
 * changes or confirms a payment, and a row's word ("Paid", "Refunded") is the
 * backend's status, never something the app worked out.
 */
export default function PaymentsScreen() {
  return (
    <Screen header={{ title: 'Payments', back: true }} scroll>
      <AuthGate title="Your payments" message="Sign in to see your payments and refunds.">
        <PaymentList />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.s3 },
  card: { gap: spacing.s1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3 },
  grow: { flex: 1 },
  pressed: { opacity: 0.9 },
});

