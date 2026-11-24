import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState, ErrorState, ListSkeleton, Screen, SearchingScreen, SortFilterBar, Text, useFirstSearch } from '@/components';
import { Chip } from '@/components/layout';
import { OptionSheet } from '@/components/OptionSheet';
import { PackageCard } from '@/features/discovery/cards';
import { usePackages } from '@/features/discovery/hooks';
import { PACKAGE_SORTS, sortPackages, type PackageSort } from '@/features/discovery/packages';
import { spacing } from '@/theme';
import type { PackageQuery } from '@/types/discovery';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const isTripType = (v: string | undefined): v is NonNullable<PackageQuery['trip_type']> => v === 'domestic' || v === 'international' || v === 'pilgrimage';

const TRIPS = [
  { value: 'domestic', title: 'Domestic' },
  { value: 'international', title: 'International' },
  { value: 'pilgrimage', title: 'Pilgrimage' },
] as const;

/**
 * Holiday packages, optionally for one destination (by its NAME: that is what the packages endpoint filters on)
 * and one trip type. Filtering happens on the server; ordering happens here. A compact navy header reads the search
 * back with Edit; trip-type chips filter; the floating Sort bar opens the sort sheet. Gaming Tour Packages are
 * disabled and never listed.
 */
export default function PackagesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ destination?: string; tripType?: string }>();
  const destination = asString(params.destination);
  const initialTrip = asString(params.tripType);

  const [tripType, setTripType] = useState<PackageQuery['trip_type']>(isTripType(initialTrip) ? initialTrip : undefined);
  const [sort, setSort] = useState<PackageSort>('recommended');
  const [sortOpen, setSortOpen] = useState(false);

  const query = usePackages({ destination, trip_type: tripType });
  // The chips show how many packages each trip type holds, so they count the whole list, not the filtered one.
  const everything = usePackages({ destination });
  const counts = {
    domestic: (everything.data ?? []).filter((p) => p.trip_type === 'domestic').length,
    pilgrimage: (everything.data ?? []).filter((p) => p.trip_type === 'pilgrimage').length,
    international: (everything.data ?? []).filter((p) => p.trip_type === 'international').length,
  };
  const packages = useMemo(() => sortPackages((query.data ?? []).filter((p) => p.category !== 'gaming'), sort), [query.data, sort]);
  const tripTitle = TRIPS.find((t) => t.value === tripType)?.title;
  // The first answer gets the full-screen take-off; changing the trip type later shows the skeleton.
  const searching = useFirstSearch(query.isPending);

  return (
    <Screen
      header={{
        title: destination ?? 'Holiday Packages',
        subtitle: [tripTitle ?? 'All trip types', everything.data ? `${everything.data.length} package${everything.data.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
        back: true,
        actionLabel: 'Edit',
        onAction: () => (router.canGoBack() ? router.back() : router.replace('/search/packages')),
      }}
      scroll
      refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
      footer={<SortFilterBar actions={[{ key: 'sort', label: `Sort: ${PACKAGE_SORTS.find((s) => s.value === sort)?.label ?? 'Recommended'}`, icon: 'swap-vertical', onPress: () => setSortOpen(true) }]} />}
      contentStyle={styles.content}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipBleed}>
        <Chip label="All" selected={tripType === undefined} onPress={() => setTripType(undefined)} />
        {TRIPS.filter((t) => counts[t.value] > 0 || tripType === t.value).map((t) => (
          <Chip key={t.value} label={t.title} selected={tripType === t.value} onPress={() => setTripType(tripType === t.value ? undefined : t.value)} />
        ))}
      </ScrollView>

      {query.isPending ? (
        <ListSkeleton count={3} label="Finding holidays…" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isRefetching} />
      ) : packages.length === 0 ? (
        <EmptyState
          icon="map-outline"
          title="No packages found"
          message={destination || tripType ? 'We have no packages for that combination right now. Try another trip type or destination.' : 'Please check back soon.'}
          actionLabel={tripType ? 'Show all trip types' : undefined}
          onAction={tripType ? () => setTripType(undefined) : undefined}
        />
      ) : (
        <View style={styles.list}>
          <Text variant="caption" color="textSecondary" accessibilityLiveRegion="polite">
            {`${packages.length} package${packages.length === 1 ? '' : 's'}`} · prices per person
          </Text>
          {packages.map((p) => (
            <PackageCard key={p.id} pkg={p} onPress={() => router.push({ pathname: '/packages/[id]', params: { id: p.id } })} />
          ))}
        </View>
      )}
      <SearchingScreen
        visible={searching}
        title={destination ? `Finding holidays in ${destination}` : 'Finding holidays for you'}
        subtitle={tripTitle ?? 'All trip types'}
        onCancel={() => (router.canGoBack() ? router.back() : router.replace('/search/packages'))}
      />
      <OptionSheet visible={sortOpen} title="Sort by" options={PACKAGE_SORTS} value={sort} onChange={setSort} onClose={() => setSortOpen(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Room under the last card for the floating Sort bar.
  content: { paddingBottom: 72 },
  chipBleed: { marginHorizontal: -spacing.s4, flexGrow: 0 },
  chips: { gap: spacing.s2, paddingHorizontal: spacing.s4 },
  list: { gap: spacing.s3 },
});
