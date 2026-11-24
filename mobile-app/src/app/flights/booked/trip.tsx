import { Ionicons } from '@expo/vector-icons';
import { Redirect, useRouter, type Href } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Screen, StatusPill, Text } from '@/components';
import { rupees } from '@/features/flights/preview/extras';
import { durationLabel } from '@/features/flights/preview/sample';
import { daysUntil, sampleFlightBooking, type BookedSegment } from '@/features/flights/preview/sampleBooking';
import { AirlineBadge, CardTitle, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';
import { formatLongDate, formatShortDate } from '@/utils/dates';

type IconName = keyof typeof Ionicons.glyphMap;

const ACTIONS: { icon: IconName; label: string; href: Href }[] = [
  { icon: 'ticket-outline', label: 'E-ticket', href: '/flights/booked/ticket' },
  { icon: 'create-outline', label: 'Manage', href: '/flights/booked/manage' },
  { icon: 'close-circle-outline', label: 'Cancel', href: '/flights/booked/cancel' },
];

/** One flight of the booking: times, airports, airline, PNR. */
function SegmentCard({ segment, index, count }: { segment: BookedSegment; index: number; count: number }) {
  return (
    <Card style={styles.segment}>
      <View style={styles.segTop}>
        {count > 1 ? (
          <Text variant="caption" chrome color="goldInk" style={styles.kicker}>
            TRIP {index + 1}
          </Text>
        ) : null}
        <Text variant="caption" color="textSecondary" style={styles.flex}>
          {formatLongDate(segment.date)}
        </Text>
        <StatusPill label="Confirmed" tone="success" icon="checkmark-circle" />
      </View>
      <View style={styles.route}>
        <View>
          <Text variant="h2" color="ink">
            {segment.dep}
          </Text>
          <Text variant="bodyStrong" color="ink">
            {segment.from}
          </Text>
          <Text variant="caption" color="textSecondary">
            {segment.fromCity}
          </Text>
        </View>
        <View style={styles.line}>
          <Text variant="caption" color="textSecondary">
            {durationLabel(segment.minutes)}
          </Text>
          <View style={styles.track}>
            <View style={styles.dash} />
            <Ionicons name="airplane" size={14} color={colors.primary} />
            <View style={styles.dash} />
          </View>
          <Text variant="caption" color="success">
            Non-stop
          </Text>
        </View>
        <View style={styles.right}>
          <Text variant="h2" color="ink">
            {segment.arr}
          </Text>
          <Text variant="bodyStrong" color="ink">
            {segment.to}
          </Text>
          <Text variant="caption" color="textSecondary">
            {segment.toCity}
          </Text>
        </View>
      </View>
      <View style={styles.segFoot}>
        <AirlineBadge airline={segment.airline} size={24} />
        <Text variant="small" color="ink2" style={styles.flex}>
          {segment.airline.name} · {segment.number} · {segment.fare}
        </Text>
        <Text variant="small" chrome color="ink" style={styles.bold} selectable>
          PNR {segment.pnr}
        </Text>
      </View>
    </Card>
  );
}

/**
 * A BOOKED FLIGHT (preview). What a customer sees after paying for flights: the trip, its flights and PNRs, who is
 * flying, what was paid, and the three things they come back for (the e-ticket, changes, cancelling). Sample data
 * only, reachable from the development preview until a flight supplier is connected.
 */
export default function BookedFlightScreen() {
  const router = useRouter();
  if (!__DEV__) return <Redirect href="/flights" />;
  const booking = sampleFlightBooking();
  const first = booking.segments[0];
  const last = booking.segments[booking.segments.length - 1];
  const days = daysUntil(first.date);

  return (
    <Screen header={{ title: 'Your flight', subtitle: booking.ref, back: true }} scroll>
      <SampleNotice compact />

      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <StatusPill label="Booking confirmed" tone="success" icon="checkmark-circle" />
          <Text variant="caption" color="onDark2">
            {days > 0 ? `In ${days} days` : 'Today'}
          </Text>
        </View>
        <Text variant="h1" color="white">
          {booking.segments.map((s) => s.from).join(' → ')} → {last.to}
        </Text>
        <Text variant="small" color="onDark2">
          {formatShortDate(first.date)} – {formatShortDate(last.date)} · {booking.segments.length} flights · {booking.travellers.length} travellers
        </Text>
        <View style={styles.actions}>
          {ACTIONS.map((a) => (
            <Pressable
              key={a.label}
              onPress={() => router.push(a.href)}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Ionicons name={a.icon} size={22} color={colors.goldLight} />
              <Text variant="caption" chrome color="white" style={styles.bold}>
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {booking.segments.map((s, i) => (
        <SegmentCard key={s.pnr} segment={s} index={i} count={booking.segments.length} />
      ))}

      <Card style={styles.card}>
        <CardTitle>Travellers</CardTitle>
        {booking.travellers.map((t, i) => (
          <View key={t.name} style={[styles.person, i > 0 && styles.divided]}>
            <View style={styles.avatar}>
              <Text variant="caption" chrome color="white" style={styles.bold}>
                {t.name
                  .split(' ')
                  .map((w) => w[0])
                  .join('')}
              </Text>
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong" color="ink">
                {t.title} {t.name}
              </Text>
              <Text variant="caption" color="textSecondary">
                Seat {t.seats.filter((s) => s !== '—').join(', ') || 'at check-in'} · {t.checkinKg} kg check-in{t.meal ? ` · ${t.meal}` : ''}
              </Text>
            </View>
          </View>
        ))}
      </Card>

      <Card style={styles.card}>
        <CardTitle right={<StatusPill label="Paid" tone="success" />}>Payment</CardTitle>
        <View style={styles.payRow}>
          <Text variant="body" color="ink2" style={styles.flex}>
            Paid on {formatShortDate(booking.paidOn)}
          </Text>
          <Text variant="h2" color="ink">
            {rupees(booking.paid)}
          </Text>
        </View>
        <Text variant="caption" color="textSecondary">
          Fares, taxes, seats, meals and baggage for everyone on this booking.
        </Text>
      </Card>

      <View style={styles.help}>
        <Ionicons name="headset-outline" size={18} color={colors.goldInk} />
        <Text variant="small" color="ink2" style={styles.flex}>
          Need help with this trip? Our team answers 24×7 on call and WhatsApp.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.8 },
  kicker: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.5 },
  hero: { backgroundColor: colors.navy900, borderRadius: 20, padding: spacing.s4, gap: spacing.s2 },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', gap: spacing.s2, marginTop: spacing.s2 },
  action: { flex: 1, minHeight: 64, borderRadius: 14, backgroundColor: colors.navy800, borderWidth: 1, borderColor: colors.navy600, alignItems: 'center', justifyContent: 'center', gap: 4 },
  segment: { gap: spacing.s3 },
  segTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  route: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  right: { alignItems: 'flex-end' },
  line: { flex: 1, alignItems: 'center', gap: 2 },
  track: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: 4 },
  dash: { flex: 1, height: 1.5, backgroundColor: colors.line },
  segFoot: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  card: { gap: spacing.s3 },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  divided: { paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  payRow: { flexDirection: 'row', alignItems: 'center' },
  help: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, backgroundColor: '#FFFCF4', borderWidth: 1, borderColor: '#F1D9A6', borderRadius: 14, padding: spacing.s3 },
});
