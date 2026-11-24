import { Ionicons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Card, Checkbox, Screen, StickyFooter, Text } from '@/components';
import { Chip } from '@/components/layout';
import { rupees } from '@/features/flights/preview/extras';
import { sampleFlightBooking } from '@/features/flights/preview/sampleBooking';
import { CardTitle, SampleNotice } from '@/features/flights/preview/ui';
import { colors, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';

/** Sample airline rules: a fixed fee per traveller per flight; taxes and airport fees come back; seats and meals don't. */
const AIRLINE_FEE = 3500;
const TAX_RATE = 0.18;
const REASONS = ['Plans changed', 'Booked by mistake', 'Medical reason', 'Found another flight', 'Other'];

/**
 * CANCEL FLIGHTS (preview). Pick the flights and travellers, see the refund worked out line by line, then confirm.
 * The refund is shown before the button, never after. In the preview, confirming cancels nothing.
 */
export default function FlightCancelScreen() {
  const router = useRouter();
  const booking = sampleFlightBooking();
  const [legs, setLegs] = useState<boolean[]>(() => booking.segments.map(() => true));
  const [people, setPeople] = useState<boolean[]>(() => booking.travellers.map(() => true));
  const [reason, setReason] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  if (!__DEV__) return <Redirect href="/flights" />;

  const pax = people.filter(Boolean).length;
  const chosenLegs = booking.segments.filter((_, i) => legs[i]);
  const fares = chosenLegs.reduce((s, seg) => s + seg.price * pax, 0);
  const taxes = Math.round(fares * TAX_RATE);
  const fees = chosenLegs.length * pax * AIRLINE_FEE;
  const refund = Math.max(0, fares + taxes - fees);
  const nothing = chosenLegs.length === 0 || pax === 0;

  if (done) {
    return (
      <Screen header={{ title: 'Cancellation', back: true, tone: 'light' }} scroll>
        <View style={styles.doneCard}>
          <View style={styles.doneIcon}>
            <Ionicons name="checkmark" size={30} color={colors.white} />
          </View>
          <Text variant="h2" color="ink" align="center">
            Cancellation requested
          </Text>
          <Text variant="body" color="ink2" align="center">
            {rupees(refund)} goes back to your original payment method in 5–7 working days. We’ll email you at every step.
          </Text>
        </View>
        <SampleNotice />
        <Text variant="small" color="textSecondary" align="center">
          This is a preview: nothing was cancelled.
        </Text>
        <Button title="Back to the booking" variant="outline" onPress={() => router.dismissTo('/flights/booked/trip')} />
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: 'Cancel flights', subtitle: booking.ref, back: true, tone: 'light' }}
      scroll
      footer={
        <StickyFooter actionTitle="Cancel selected" onAction={() => setConfirming(true)} disabled={nothing}>
          <View>
            <Text variant="caption" color="textSecondary">
              You get back
            </Text>
            <Text variant="h2" color="success">
              {rupees(refund)}
            </Text>
          </View>
        </StickyFooter>
      }
    >
      <SampleNotice compact />

      <Card style={styles.card}>
        <CardTitle>Which flights?</CardTitle>
        {booking.segments.map((s, i) => (
          <Checkbox
            key={s.pnr}
            label={`Trip ${i + 1}: ${s.from} → ${s.to}, ${formatShortDate(s.date)} · ${s.airline.name} ${s.number}`}
            checked={legs[i]}
            onChange={(v) => setLegs((l) => l.map((x, j) => (j === i ? v : x)))}
          />
        ))}
      </Card>

      <Card style={styles.card}>
        <CardTitle>Who is cancelling?</CardTitle>
        {booking.travellers.map((t, i) => (
          <Checkbox key={t.name} label={`${t.title} ${t.name}`} checked={people[i]} onChange={(v) => setPeople((p) => p.map((x, j) => (j === i ? v : x)))} />
        ))}
        {pax > 0 && pax < booking.travellers.length ? (
          <Text variant="small" color="textSecondary">
            The others keep their tickets on this booking.
          </Text>
        ) : null}
      </Card>

      <Card style={styles.card}>
        <CardTitle>Your refund</CardTitle>
        {nothing ? (
          <Text variant="small" color="textSecondary">
            Choose at least one flight and one traveller.
          </Text>
        ) : (
          <>
            <Row label={`Fares (${chosenLegs.length} flight${chosenLegs.length === 1 ? '' : 's'} × ${pax})`} value={rupees(fares)} />
            <Row label="Taxes and airport fees" value={rupees(taxes)} />
            <Row label={`Airline cancellation fee (${rupees(AIRLINE_FEE)} each)`} value={`− ${rupees(fees)}`} tone="danger" />
            <Row label="Our fee" value="Free" tone="success" />
            <View style={styles.total}>
              <Text variant="bodyStrong" color="ink" style={styles.flex}>
                Refund
              </Text>
              <Text variant="h2" color="success">
                {rupees(refund)}
              </Text>
            </View>
            <Text variant="caption" color="textSecondary">
              Seats, meals and extra baggage are not refunded by the airline.
            </Text>
          </>
        )}
      </Card>

      <View style={styles.reasons}>
        <Text variant="bodyStrong" color="ink">
          Why are you cancelling? (optional)
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {REASONS.map((r) => (
            <Chip key={r} label={r} selected={reason === r} onPress={() => setReason(reason === r ? null : r)} />
          ))}
        </ScrollView>
      </View>

      <BottomSheet
        visible={confirming}
        title="Cancel these flights?"
        onClose={() => setConfirming(false)}
        footer={
          <View style={styles.sheetButtons}>
            <Button
              title={`Yes, cancel and refund ${rupees(refund)}`}
              variant="danger"
              onPress={() => {
                setConfirming(false);
                setDone(true);
              }}
            />
            <Button title="Keep my booking" variant="ghost" onPress={() => setConfirming(false)} />
          </View>
        }
      >
        <Text variant="body" color="ink2">
          {chosenLegs.map((s) => `${s.from} → ${s.to}`).join(' and ')} for {pax} traveller{pax === 1 ? '' : 's'}. This can’t be undone once the airline confirms it.
        </Text>
      </BottomSheet>
    </Screen>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'success' }) {
  return (
    <View style={styles.row}>
      <Text variant="body" color="ink2" style={styles.flex}>
        {label}
      </Text>
      <Text variant="bodyStrong" color={tone ?? 'ink'}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: { gap: spacing.s3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  total: { flexDirection: 'row', alignItems: 'center', paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  reasons: { gap: spacing.s2 },
  chips: { gap: spacing.s2 },
  sheetButtons: { gap: spacing.s2 },
  doneCard: { alignItems: 'center', gap: spacing.s3, backgroundColor: colors.surface, borderRadius: 20, padding: spacing.s5 },
  doneIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
});
