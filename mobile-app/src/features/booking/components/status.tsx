import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { colors, radius, spacing } from '@/theme';
import type { AnyBooking } from '@/types/booking';
import { formatLongDate } from '@/utils/dates';
import { formatMoney } from '@/utils/money';

import { paymentState, type PaymentState } from '../outcome';

interface BadgeStyle {
  label: string;
  bg: 'successSoft' | 'warningSoft' | 'dangerSoft' | 'infoSoft' | 'surface2';
  fg: 'success' | 'warning' | 'danger' | 'info' | 'ink2';
}

const BADGES: Record<PaymentState, BadgeStyle> = {
  paid: { label: 'Confirmed', bg: 'successSoft', fg: 'success' },
  received_unconfirmed: { label: 'Payment under review', bg: 'warningSoft', fg: 'warning' },
  refunded: { label: 'Refunded', bg: 'infoSoft', fg: 'info' },
  cancelled: { label: 'Cancelled', bg: 'surface2', fg: 'ink2' },
  not_started: { label: 'Awaiting payment', bg: 'warningSoft', fg: 'warning' },
  in_progress: { label: 'Payment in progress', bg: 'infoSoft', fg: 'info' },
  failed: { label: 'Payment not completed', bg: 'dangerSoft', fg: 'danger' },
};

/**
 * One word for where a booking stands. It is derived from what the backend said
 * (the booking's status and its payments), never from anything the app did.
 * A completed trip reads "Completed" rather than "Confirmed".
 */
export function bookingBadge(booking: Pick<AnyBooking, 'status' | 'payments'>): BadgeStyle {
  if (booking.status === 'completed') return { label: 'Completed', bg: 'surface2', fg: 'ink2' };
  return BADGES[paymentState(booking)];
}

export function StatusBadge({ booking }: { booking: Pick<AnyBooking, 'status' | 'payments'> }) {
  const b = bookingBadge(booking);
  return (
    <View style={[styles.badge, { backgroundColor: colors[b.bg] }]}>
      <Text variant="caption" color={b.fg} chrome>
        {b.label}
      </Text>
    </View>
  );
}

export function bookingTitle(booking: AnyBooking): string {
  return booking.product_type === 'hotel' ? booking.hotel_name : booking.package_name;
}

/** "5 Nov 2026 to 8 Nov 2026, 3 nights" or "Departs 24 Oct 2026, 2 travellers" */
export function bookingWhen(booking: AnyBooking): string {
  if (booking.product_type === 'hotel') {
    return `${formatLongDate(booking.check_in_date)} to ${formatLongDate(booking.check_out_date)} · ${booking.nights} night${booking.nights === 1 ? '' : 's'}`;
  }
  return `Departs ${formatLongDate(booking.departure_date)} · ${booking.pax_count} traveller${booking.pax_count === 1 ? '' : 's'}`;
}

/** One booking in the list. Opens the booking's own page, where payment happens. */
export function BookingRowCard({ booking, onPress }: { booking: AnyBooking; onPress: () => void }) {
  const total = formatMoney(booking.total_amount, { currency: booking.currency });
  const badge = bookingBadge(booking);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${booking.booking_ref}, ${bookingTitle(booking)}, ${badge.label}, ${total}`}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card style={styles.row}>
        <View style={styles.rowText}>
          <Text variant="caption" color="goldInk" chrome>
            {booking.product_type === 'hotel' ? 'HOTEL' : 'TOUR PACKAGE'} · {booking.booking_ref}
          </Text>
          <Text variant="title" color="navy800" numberOfLines={2}>
            {bookingTitle(booking)}
          </Text>
          <Text variant="small" color="muted" numberOfLines={2}>
            {bookingWhen(booking)}
          </Text>
          <View style={styles.foot}>
            <StatusBadge booking={booking} />
            <Text variant="bodyStrong" color="navy800">
              {total}
            </Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.muted} />
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: 'flex-start', paddingHorizontal: spacing.s3, paddingVertical: 4, borderRadius: radius.pill },
  pressed: { opacity: 0.9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  rowText: { flex: 1, gap: spacing.s1 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3, marginTop: spacing.s2 },
});
