import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState, ErrorState, ListSkeleton, Screen, Text } from '@/components';
import { Chip } from '@/components/layout';
import { useCoupons } from '@/features/discovery/hooks';
import { VoucherCard, OFFER_PRODUCT, type OfferProduct } from '@/features/offers/VoucherCard';
import { colors, spacing } from '@/theme';
import type { Coupon } from '@/types/discovery';

type Filter = 'all' | OfferProduct;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'hotel', label: 'Hotels' },
  { value: 'flight', label: 'Flights' },
  { value: 'package', label: 'Holidays' },
];

/** Every coupon the website publishes, by product: `GET /api/coupons?product=…`, the same list the site shows. */
export default function OffersScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const hotel = useCoupons('hotel');
  const flight = useCoupons('flight');
  const pkg = useCoupons('package');
  const queries = { hotel, flight, package: pkg } as const;

  const rows: { coupon: Coupon; product: OfferProduct }[] = (['hotel', 'flight', 'package'] as OfferProduct[])
    .filter((p) => filter === 'all' || filter === p)
    .flatMap((p) => (queries[p].data ?? []).map((coupon) => ({ coupon, product: p })));

  const relevant = filter === 'all' ? [hotel, flight, pkg] : [queries[filter]];
  const pending = relevant.every((q) => q.isPending);
  const failed = relevant.every((q) => q.isError);
  const refreshing = relevant.some((q) => q.isRefetching);

  return (
    <Screen
      header={{ title: 'Offers', subtitle: 'Coupons you can use today', back: true }}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => relevant.forEach((q) => void q.refetch())} tintColor={colors.goldDeep} />}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipBleed}>
        {FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} selected={filter === f.value} onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>
      {pending ? (
        <ListSkeleton count={3} photo={0} />
      ) : failed ? (
        <ErrorState error={relevant[0].error} onRetry={() => relevant.forEach((q) => void q.refetch())} />
      ) : rows.length === 0 ? (
        <EmptyState icon="pricetag-outline" title="No offers right now" message="New coupons appear here as soon as they go live." />
      ) : (
        <View style={styles.list}>
          {rows.map(({ coupon, product }) => (
            <VoucherCard key={`${product}-${coupon.code}`} coupon={coupon} product={product} onUse={() => router.push(OFFER_PRODUCT[product].search)} />
          ))}
          <Text variant="caption" color="textSecondary" align="center" style={styles.hint}>
            Press and hold a code to copy it, then enter it at checkout.
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chipBleed: { marginHorizontal: -spacing.s4, flexGrow: 0 },
  chips: { paddingHorizontal: spacing.s4, gap: spacing.s2 },
  list: { gap: spacing.s3 },
  hint: { marginTop: spacing.s2 },
});
