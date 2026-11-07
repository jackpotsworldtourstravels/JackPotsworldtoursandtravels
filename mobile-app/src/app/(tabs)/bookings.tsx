import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthGate, EditorialHero, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { BookingRowCard } from '@/features/booking/components/status';
import { groupBookings } from '@/features/booking/groups';
import { bookingKeys, useMyBookings } from '@/features/booking/hooks';
import { colors, spacing } from '@/theme';
import { SiteFooter } from '@/features/home/SiteFooter';

/**
 * The customer's hotel and tour package bookings, grouped as Awaiting payment,
 * Upcoming, Past and Cancelled (newest first within each). This is also how a
 * booking left unpaid, or a payment left open when the app was closed, is found
 * again: opening a row takes the customer to its page, where they can pay or
 * check the payment.
 */
function BookingsList() {
  const router = useRouter();
  const bookings = useMyBookings();

  if (bookings.isPending) return <LoadingState message="Loading your bookings…" />;
  if (bookings.isError) return <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} retrying={bookings.isRefetching} />;
  if (bookings.data.length === 0) {
    return (
      <EmptyState
        icon="briefcase-outline"
        title="No bookings yet"
        message="Hotels and tour packages you book will appear here."
        actionLabel="Explore destinations"
        onAction={() => router.push('/explore')}
      />
    );
  }
  const sections = groupBookings(bookings.data);
  return (
    <View style={styles.list}>
      <Text variant="small" color="muted" accessibilityLiveRegion="polite">
        {bookings.data.length} booking{bookings.data.length === 1 ? '' : 's'}
      </Text>
      {sections.map((section) => (
        <View key={section.group} style={styles.section}>
          <Text variant="h3" color="navy800" accessibilityRole="header">
            {section.title}
          </Text>
          {section.rows.map(({ kind, booking }) => (
            <BookingRowCard
              key={`${kind}-${booking.booking_ref}`}
              booking={booking}
              onPress={() => router.push({ pathname: '/booking/[ref]', params: { ref: booking.booking_ref } })}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export default function BookingsScreen() {
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Screen
      header
      scroll
      flush
      bottomInset={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.goldInk}
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
      <EditorialHero crumb="My Bookings" kicker="Your travel" title="My" accent="journeys." />
      <View style={[styles.content, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <AuthGate title="Your bookings" message="Sign in to see your trips, and to pay for or check a booking.">
          <BookingsList />
        </AuthGate>
      </View>
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  list: { gap: spacing.s4 },
  section: { gap: spacing.s3 },
});
