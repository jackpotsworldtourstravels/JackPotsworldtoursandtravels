import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthGate, EditorialHero, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { HotelWishlistRow, PackageWishlistRow } from '@/features/account/components/WishlistRows';
import { accountKeys, useWishlist } from '@/features/account/hooks';
import { splitWishlist } from '@/features/account/wishlist';
import { bookingKeys } from '@/features/booking/hooks';
import { colors, spacing } from '@/theme';
import { SiteFooter } from '@/features/home/SiteFooter';

/**
 * Hotels and tour packages the customer saved. The server keeps only "a hotel,
 * id 4"; each row is filled in from the same public pages the app already
 * shows, so what is on screen is what the catalogue says today. Items saved on
 * the website that the app cannot show (flights, cruises) are counted, not hidden.
 */
function WishlistList() {
  const router = useRouter();
  const wishlist = useWishlist();

  if (wishlist.isPending) return <LoadingState message="Loading your wishlist…" />;
  if (wishlist.isError) return <ErrorState error={wishlist.error} onRetry={() => void wishlist.refetch()} retrying={wishlist.isRefetching} />;

  const { shown, hiddenCount } = splitWishlist(wishlist.data);
  return (
    <View style={styles.list}>
      {shown.length === 0 ? (
        <EmptyState
          icon="heart-outline"
          title="Nothing saved yet"
          message="Tap “Save to wishlist” on a hotel or tour package and it will wait for you here."
          actionLabel="Explore destinations"
          onAction={() => router.push('/explore')}
        />
      ) : (
        <>
          <Text variant="small" color="muted" accessibilityLiveRegion="polite">
            {shown.length} saved item{shown.length === 1 ? '' : 's'}
          </Text>
          {shown.map((item) => (item.item_type === 'hotel' ? <HotelWishlistRow key={item.id} item={item} /> : <PackageWishlistRow key={item.id} item={item} />))}
        </>
      )}
      {hiddenCount > 0 ? (
        <Text variant="small" color="muted" align="center">
          {hiddenCount} item{hiddenCount === 1 ? '' : 's'} saved on our website (flights or cruises) {hiddenCount === 1 ? 'isn’t' : 'aren’t'} shown in the app.
        </Text>
      ) : null}
    </View>
  );
}

export default function WishlistScreen() {
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
      <EditorialHero crumb="Wishlist" kicker="Saved for later" title="My" accent="wishlist." />
      <View style={[styles.content, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <AuthGate title="Your wishlist" message="Sign in to save hotels and tour packages you like.">
          <WishlistList />
        </AuthGate>
      </View>
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  list: { gap: spacing.s3 },
});
