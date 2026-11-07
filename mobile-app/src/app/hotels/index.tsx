import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Banner, Button, EditorialHero, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { Chip, ChipRow } from '@/components/layout';
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
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { colors, fontFamily, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';
import { SiteFooter } from '@/features/home/SiteFooter';

interface Row {
  model: HotelCardModel;
  photo: HotelPhoto;
}

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const asCount = (v: string | string[] | undefined, fallback: number) => {
  const n = Number(asString(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Hotel results: every hotel, or the ones in a destination.
 *
 * What a price here means: the catalogue's indicative nightly rate. The backend
 * does not check a room's availability for dates at this stage, and says so; the
 * exact rate for the chosen dates is worked out when a stay is quoted, so the
 * screen tells the customer that instead of implying the dates changed the list.
 */
export default function HotelsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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

  const destinations = useDestinations();
  const destination = findDestination(destinations.data, destinationId);

  const all = useHotels(!destinationId);
  const mapped = useDestinationHotelsInfinite(destinationId);
  const query = destinationId ? mapped : all;

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

  const title = destination ? `Hotels in ${destination.name}` : destinationId ? 'Hotels' : 'All hotels';
  const filtersActive = minStars !== undefined || freeCancellationOnly;

  return (
    <Screen header={{ back: true }} scroll flush>
      {/* The site's Hotels hero: the date ribbon, "Where you'll stay", the title, "Sample rates" and the stay summary with Edit. */}
      <EditorialHero
        crumb="Hotels"
        kicker="Where you’ll stay"
        title={title}
        pill="Sample rates"
        photoUri={destination ? destinationPhotoUrl(destination.image ?? destination.id, 'hero') : destinationPhotoUrl('hyderabad', 'hero')}
        photoAlt={destination ? `${destination.name}, a photograph of the destination` : 'A photograph of a destination'}
        ribbon={stay ? { checkIn: formatRibbonDate(stay.checkIn), checkOut: formatRibbonDate(stay.checkOut) } : undefined}
        summary={{
          title: destination?.name ?? 'All destinations',
          sub: `${stay ? `${formatShortDate(stay.checkIn)} – ${formatShortDate(stay.checkOut)} · ` : ''}${party.rooms} room${party.rooms === 1 ? '' : 's'} · ${party.adults + party.children} guest${party.adults + party.children === 1 ? '' : 's'}`,
          actionLabel: 'Edit',
          onAction: () => (router.canGoBack() ? router.back() : router.replace('/')),
        }}
        caption={destination ? `${destination.name} — destination photo, not a hotel` : undefined}
      />

      <View style={[styles.content, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <Banner tone="info" message="Prices are indicative nightly rates. Room availability and the exact price for your dates are confirmed when you book." />

        <ChipRow>
          {HOTEL_SORTS.map((s) => (
            <Chip key={s.value} label={s.label} selected={sort === s.value} onPress={() => setSort(s.value)} />
          ))}
        </ChipRow>
        <ChipRow>
          <Chip label="Any rating" selected={minStars === undefined} onPress={() => setMinStars(undefined)} />
          <Chip label="3 stars +" selected={minStars === 3} onPress={() => setMinStars(3)} />
          <Chip label="4 stars +" selected={minStars === 4} onPress={() => setMinStars(4)} />
          <Chip label="5 stars" selected={minStars === 5} onPress={() => setMinStars(5)} />
          <Chip label="Free cancellation" icon="shield-checkmark-outline" selected={freeCancellationOnly} onPress={() => setFreeCancellationOnly((v) => !v)} />
        </ChipRow>

        {query.isPending ? (
          <LoadingState message="Finding hotels…" />
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
              actionLabel={filtersActive ? 'Clear filters' : undefined}
              onAction={() => {
                setMinStars(undefined);
                setFreeCancellationOnly(false);
              }}
            />
          )
        ) : (
          <View style={styles.list}>
            <Text variant="caption" color="ink2" chrome accessibilityLiveRegion="polite" style={styles.count}>
              {`${shown.length} HOTEL${shown.length === 1 ? '' : 'S'} FOUND`}
              {destinationId && mapped.data ? ` OF ${mapped.data.pages[0]?.total ?? shown.length}` : ''}
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
      </View>
      <SiteFooter />
    </Screen>
  );
}

/** "24 Oct": the day and the month, as the site prints the ribbon's two ends. */
function formatRibbonDate(iso: string): string {
  return formatShortDate(iso).replace(/^\w+,\s*/, '');
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  list: { gap: spacing.s4 },
  count: { fontFamily: fontFamily.sansBold, fontSize: 12, letterSpacing: 1.8, color: colors.ink2 },
});
