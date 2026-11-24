import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { AuthGate, EmptyState, ErrorState, ListSkeleton, Screen, SegmentedControl, Text } from '@/components';
import { HotelWishlistRow, PackageWishlistRow } from '@/features/account/components/WishlistRows';
import { accountKeys, useWishlist } from '@/features/account/hooks';
import { splitWishlist } from '@/features/account/wishlist';
import { bookingKeys } from '@/features/booking/hooks';
import { colors, spacing } from '@/theme';

type Filter = 'all' | 'hotel' | 'package';

/**
 * Hotels and tour packages the customer saved. The server keeps only "a hotel,
 * id 4"; each row is filled in from the same public pages the app already
 * shows, so what is on screen is what the catalogue says today. Items saved on
 * the website that the app cannot show (flights, cruises) are counted, not hidden.
 */
function WishlistList({ filter }: { filter: Filter }) {
  const router = useRouter();
  const wishlist = useWishlist();

  if (wishlist.isPending) return <ListSkeleton count={2} photo={140} />;
  if (wishlist.isError) return <ErrorState error={wishlist.error} onRetry={() => void wishlist.refetch()} retrying={wishlist.isRefetching} />;

  const { shown: all, hiddenCount } = splitWishlist(wishlist.data);
  const shown = filter === 'all' ? all : all.filter((i) => i.item_type === filter);
  return (
    <View style={styles.list}>
      {all.length === 0 ? (
        <EmptyState
          icon="heart-outline"
          title="Nothing saved yet"
          message="Tap the heart on a hotel or holiday package and it will wait for you here."
          actionLabel="Explore destinations"
          onAction={() => router.push('/explore')}
        />
      ) : shown.length === 0 ? (
        <EmptyState icon="heart-outline" title={filter === 'hotel' ? 'No saved hotels' : 'No saved packages'} message="Switch to All to see everything you saved." />
      ) : (
        <>
          <Text variant="caption" color="textSecondary" accessibilityLiveRegion="polite">
            {shown.length} saved item{shown.length === 1 ? '' : 's'}
          </Text>
          {shown.map((item) => (item.item_type === 'hotel' ? <HotelWishlistRow key={item.id} item={item} /> : <PackageWishlistRow key={item.id} item={item} />))}
        </>
      )}
      {hiddenCount > 0 ? (
        <Text variant="small" color="textSecondary" align="center">
          {hiddenCount} item{hiddenCount === 1 ? '' : 's'} saved on our website (flights or cruises) {hiddenCount === 1 ? 'isn’t' : 'aren’t'} shown in the app.
        </Text>
      ) : null}
    </View>
  );
}

export default function WishlistScreen() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  return (
    <Screen
      header={{ title: 'Wishlist', tone: 'light' }}
      scroll
      bottomInset={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.link}
          onRefresh={async () => {
            setRefreshing(true);
            try {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: accountKeys.wishlist() }),
                // The saved hotels and packages are re-read too, so a rate or a name that changed shows up.
                queryClient.invalidateQueries({ queryKey: bookingKeys.all }),
              ]);
            } finally {
              setRefreshing(false);
            }
          }}
        />
      }
    >
      <AuthGate title="Your wishlist" message="Sign in to save hotels and tour packages you like.">
        <SegmentedControl<Filter>
          options={[
            { value: 'all', label: 'All' },
            { value: 'hotel', label: 'Hotels' },
            { value: 'package', label: 'Packages' },
          ]}
          value={filter}
          onChange={setFilter}
          accessibilityLabel="Show"
        />
        <WishlistList filter={filter} />
      </AuthGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.s3 },
});
