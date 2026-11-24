import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { AuthGate, EmptyState, ErrorState, ListSkeleton, Screen, SegmentedControl, Text } from '@/components';
import { BookingRowCard } from '@/features/booking/components/status';
import { groupBookings, type BookingGroup } from '@/features/booking/groups';
import { bookingKeys, useMyBookings } from '@/features/booking/hooks';
import { colors, spacing } from '@/theme';

type Tab = 'upcoming' | 'completed' | 'cancelled';

/** Which booking groups each tab shows. Awaiting payment is upcoming travel, so it leads the Upcoming tab. */
const TAB_GROUPS: Record<Tab, BookingGroup[]> = {
  upcoming: ['awaiting', 'upcoming'],
  completed: ['past'],
  cancelled: ['cancelled'],
};

const EMPTY: Record<Tab, { title: string; message: string }> = {
  upcoming: { title: 'No upcoming trips', message: 'Hotels and holiday packages you book will appear here.' },
  completed: { title: 'No completed trips yet', message: 'Trips you have finished will be kept here.' },
  cancelled: { title: 'Nothing cancelled', message: 'Cancelled and refunded bookings will appear here.' },
};

/**
 * The customer's hotel and holiday-package bookings: Upcoming (awaiting payment first) · Completed · Cancelled.
 * This is also how a booking left unpaid, or a payment left open when the app was closed, is found again: opening a
 * row takes the customer to its page, where they can pay or check the payment.
 */
function BookingsList({ tab }: { tab: Tab }) {
  const router = useRouter();
  const bookings = useMyBookings();

  if (bookings.isPending) return <ListSkeleton count={2} photo={0} />;
  if (bookings.isError) return <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} retrying={bookings.isRefetching} />;
  if (bookings.data.length === 0) {
    return <EmptyState icon="ticket-outline" title="No bookings yet" message="Hotels and tour packages you book will appear here." actionLabel="Explore destinations" onAction={() => router.push('/explore')} />;
  }
  const sections = groupBookings(bookings.data).filter((s) => TAB_GROUPS[tab].includes(s.group));
  if (sections.length === 0) return <EmptyState icon="ticket-outline" title={EMPTY[tab].title} message={EMPTY[tab].message} />;
  const count = sections.reduce((n, s) => n + s.rows.length, 0);
  // A heading only where a tab holds two groups (Upcoming: awaiting payment, then the rest); elsewhere the tab names it.
  const headed = TAB_GROUPS[tab].length > 1;
  return (
    <View style={styles.list}>
      <Text variant="caption" color="textSecondary" accessibilityLiveRegion="polite">
        {count} booking{count === 1 ? '' : 's'}
      </Text>
      {sections.map((section) => (
        <View key={section.group} style={styles.section}>
          {headed ? (
            <Text variant="label" color="textSecondary" accessibilityRole="header">
              {section.title}
            </Text>
          ) : null}
          {section.rows.map(({ kind, booking }) => (
            <BookingRowCard key={`${kind}-${booking.booking_ref}`} booking={booking} onPress={() => router.push({ pathname: '/booking/[ref]', params: { ref: booking.booking_ref } })} />
          ))}
        </View>
      ))}
    </View>
  );
}

export default function BookingsScreen() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('upcoming');
  return (
    <Screen
      header={{ title: 'My Bookings', tone: 'light' }}
      scroll
      bottomInset={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.link}
          onRefresh={async () => {
            setRefreshing(true);
            try {
              await queryClient.invalidateQueries({ queryKey: bookingKeys.mine() });
            } finally {
              setRefreshing(false);
            }
          }}
        />
      }
    >
      <AuthGate title="Your bookings" message="Sign in to see your trips, and to pay for or check a booking.">
        <SegmentedControl<Tab>
          options={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'completed', label: 'Completed' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
          value={tab}
          onChange={setTab}
          accessibilityLabel="Booking status"
        />
        <BookingsList tab={tab} />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.s5 },
  section: { gap: spacing.s3 },
});
