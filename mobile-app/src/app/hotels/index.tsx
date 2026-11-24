import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { BottomSheet, Button, EmptyState, ErrorState, ListSkeleton, Screen, SearchingScreen, SortFilterBar, Text, useFirstSearch } from '@/components';
import { Chip } from '@/components/layout';
import { OptionSheet } from '@/components/OptionSheet';
import { HotelCard } from '@/features/discovery/cards';
import { useDestinationHotelsInfinite, useDestinations, useHotels } from '@/features/discovery/hooks';
import {
  HOTEL_SORTS,
  filterHotels,
  fromDestinationItem,
  fromListItem,
  photoForDestinationItem,
  photoForListItem,
  sortHotels,
  type HotelCardModel,
  type HotelSort,
} from '@/features/discovery/hotels';
import type { HotelPhoto } from '@/features/media/hotelPhoto';
import { findDestination } from '@/features/search/destinations';
import { normaliseParty } from '@/features/search/party';
import { stayFromParams } from '@/features/search/stay';
import { spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';

interface Row {
  model: HotelCardModel;
  photo: HotelPhoto;
}

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const asCount = (v: string | string[] | undefined, fallback: number) => {
  const n = Number(asString(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const STAR_OPTIONS: { value: number | undefined; label: string }[] = [
  { value: undefined, label: 'Any rating' },
  { value: 3, label: '3 stars +' },
  { value: 4, label: '4 stars +' },
  { value: 5, label: '5 stars' },
];

/**
 * Hotel results: every hotel, or the ones in a destination. A compact navy header reads the search back with Edit;
 * quick-filter chips sit over the list; the floating Sort · Filter bar opens a sort sheet and a filter sheet.
 *
 * What a price here means: the catalogue's indicative nightly rate. The backend does not check a room's
 * availability for dates at this stage, and the screen says so; the exact rate for the chosen dates is worked out
 * when a stay is quoted.
 */
export default function HotelsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    destination?: string;
    checkIn?: string;
    checkOut?: string;
    rooms?: string;
    adults?: string;
    children?: string;
  }>();

  const destinationId = asString(params.destination);
  const stay = stayFromParams({ checkIn: asString(params.checkIn), checkOut: asString(params.checkOut) });
  const party = normaliseParty({
    rooms: asCount(params.rooms, 1),
    adults: asCount(params.adults, 2),
    children: Number(asString(params.children)) || 0,
  });

  const [sort, setSort] = useState<HotelSort>('recommended');
  const [minStars, setMinStars] = useState<number | undefined>(undefined);
  const [freeCancellationOnly, setFreeCancellationOnly] = useState(false);
  const [sheet, setSheet] = useState<'sort' | 'filter' | null>(null);

  const destinations = useDestinations();
  const destination = findDestination(destinations.data, destinationId);

  const all = useHotels(!destinationId);
  const mapped = useDestinationHotelsInfinite(destinationId);
  const query = destinationId ? mapped : all;
  // The first answer gets the full-screen take-off; later refreshes get the skeleton.
  const searching = useFirstSearch(query.isPending);

  // A few dozen rows at most, so this is computed on render rather than memoised.
  const rows: Row[] = destinationId
    ? (mapped.data?.pages ?? []).flatMap((p) => p.hotels).map((h) => ({ model: fromDestinationItem(h), photo: photoForDestinationItem(h) }))
    : (all.data ?? []).map((h) => ({ model: fromListItem(h), photo: photoForListItem(h) }));

  const byId = new Map(rows.map((r) => [r.model.id, r]));
  const shown: Row[] = sortHotels(
    filterHotels(
      rows.map((r) => r.model),
      { minStars, freeCancellationOnly },
    ),
    sort,
  ).map((m) => byId.get(m.id) as Row);

  const title = destination ? destination.name : destinationId ? 'Hotels' : 'All hotels';
  const guests = party.adults + party.children;
  const subtitle = `${stay ? `${formatShortDate(stay.checkIn)} – ${formatShortDate(stay.checkOut)} · ` : ''}${party.rooms} Room${party.rooms === 1 ? '' : 's'} · ${guests} Guest${guests === 1 ? '' : 's'}`;
  const filterCount = (minStars !== undefined ? 1 : 0) + (freeCancellationOnly ? 1 : 0);
  const clearFilters = () => {
    setMinStars(undefined);
    setFreeCancellationOnly(false);
  };

  return (
    <Screen
      header={{ title, subtitle, back: true, actionLabel: 'Edit', onAction: () => (router.canGoBack() ? router.back() : router.replace('/search/hotels')) }}
      scroll
      refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
      footer={
        <SortFilterBar
          actions={[
            { key: 'sort', label: 'Sort', icon: 'swap-vertical', onPress: () => setSheet('sort') },
            { key: 'filter', label: 'Filter', icon: 'options-outline', count: filterCount, onPress: () => setSheet('filter') },
          ]}
        />
      }
      contentStyle={styles.content}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipBleed}>
        <Chip label="5 stars" selected={minStars === 5} onPress={() => setMinStars(minStars === 5 ? undefined : 5)} />
        <Chip label="4 stars +" selected={minStars === 4} onPress={() => setMinStars(minStars === 4 ? undefined : 4)} />
        <Chip label="Free cancellation" icon="shield-checkmark-outline" selected={freeCancellationOnly} onPress={() => setFreeCancellationOnly((v) => !v)} />
      </ScrollView>

      {query.isPending ? (
        <ListSkeleton count={3} label="Finding stays…" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isRefetching} />
      ) : shown.length === 0 ? (
        rows.length === 0 ? (
          <EmptyState
            icon="bed-outline"
            title={destination ? `No hotels in ${destination.name} yet` : 'No hotels to show yet'}
            message={destination ? `We don’t list hotels in ${destination.name} yet. You can still see our tour packages there.` : 'Please check back soon.'}
            actionLabel={destination ? `Tour packages in ${destination.name}` : undefined}
            onAction={destination ? () => router.push({ pathname: '/packages', params: { destination: destination.name } }) : undefined}
          />
        ) : (
          <EmptyState
            icon="funnel-outline"
            title="No hotels match these filters"
            message="Try a lower star rating or turn off free cancellation."
            actionLabel={filterCount > 0 ? 'Clear filters' : undefined}
            onAction={clearFilters}
          />
        )
      ) : (
        <View style={styles.list}>
          <Text variant="caption" color="textSecondary" accessibilityLiveRegion="polite">
            {`${shown.length} hotel${shown.length === 1 ? '' : 's'}`}
            {destinationId && mapped.data ? ` of ${mapped.data.pages[0]?.total ?? shown.length}` : ''} · rates are indicative until your stay is quoted
          </Text>
          {shown.map((r) => (
            <HotelCard
              key={r.model.id}
              hotel={r.model}
              photo={r.photo}
              onPress={() =>
                router.push({
                  pathname: '/hotels/[id]',
                  params: {
                    id: r.model.id,
                    // Carry the stay the customer chose so the hotel page opens on it.
                    ...(stay ? { checkIn: stay.checkIn, checkOut: stay.checkOut } : {}),
                    rooms: String(party.rooms),
                    adults: String(party.adults),
                    children: String(party.children),
                  },
                })
              }
            />
          ))}
          {destinationId && mapped.hasNextPage ? (
            <Button title="Show more hotels" variant="outline" loading={mapped.isFetchingNextPage} onPress={() => void mapped.fetchNextPage()} />
          ) : null}
        </View>
      )}

      <SearchingScreen
        visible={searching}
        title={destination ? `Finding the best stays in ${destination.name}` : 'Finding the best stays for you'}
        subtitle={subtitle}
        onCancel={() => (router.canGoBack() ? router.back() : router.replace('/search/hotels'))}
      />
      <OptionSheet visible={sheet === 'sort'} title="Sort by" options={HOTEL_SORTS} value={sort} onChange={setSort} onClose={() => setSheet(null)} />
      <BottomSheet
        visible={sheet === 'filter'}
        title="Filters"
        onClose={() => setSheet(null)}
        footer={
          <View style={styles.sheetFoot}>
            <Button title="Clear all" variant="ghost" fullWidth={false} onPress={clearFilters} />
            <Button title={`Show ${shown.length} hotel${shown.length === 1 ? '' : 's'}`} fullWidth={false} style={styles.apply} onPress={() => setSheet(null)} />
          </View>
        }
      >
        <Text variant="label" color="textSecondary">
          Star rating
        </Text>
        <View style={styles.wrap}>
          {STAR_OPTIONS.map((o) => (
            <Chip key={o.label} label={o.label} selected={minStars === o.value} onPress={() => setMinStars(o.value)} />
          ))}
        </View>
        <Text variant="label" color="textSecondary" style={styles.gap}>
          Cancellation
        </Text>
        <View style={styles.wrap}>
          <Chip label="Free cancellation" icon="shield-checkmark-outline" selected={freeCancellationOnly} onPress={() => setFreeCancellationOnly((v) => !v)} />
        </View>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Room under the last card for the floating Sort · Filter bar.
  content: { paddingBottom: 72 },
  chipBleed: { marginHorizontal: -spacing.s4, flexGrow: 0 },
  chips: { gap: spacing.s2, paddingHorizontal: spacing.s4 },
  list: { gap: spacing.s3 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  gap: { marginTop: spacing.s2 },
  sheetFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s3 },
  apply: { flex: 1 },
});
