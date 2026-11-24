import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, EmptyState, ErrorState, ListSkeleton, Screen, Skeleton, Text } from '@/components';
import { RemoteImage } from '@/components/RemoteImage';
import { SectionHeader, Shelf, Tag } from '@/components/layout';
import { AttractionCard, HotelCard, PackageCard } from '@/features/discovery/cards';
import { useDestinationAttractions, useDestinationHotels, useDestinationLocations, useDestinations, usePackages } from '@/features/discovery/hooks';
import { fromDestinationItem, photoForDestinationItem } from '@/features/discovery/hotels';
import { sortPackages } from '@/features/discovery/packages';
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { findDestination } from '@/features/search/destinations';
import { spacing } from '@/theme';

const PREVIEW_COUNT = 3;
const ATTRACTION_WIDTH = 240;

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * One destination: where to go, where to stay and what to book. Each section
 * loads on its own, and a destination with nothing mapped says so plainly rather
 * than showing an empty box (most destinations have no hotels listed yet).
 */
export default function DestinationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const id = asString(useLocalSearchParams<{ id: string }>().id);

  const destinations = useDestinations();
  const destination = findDestination(destinations.data, id);

  const locations = useDestinationLocations(id);
  const attractions = useDestinationAttractions(id);
  const hotels = useDestinationHotels(id);
  const packages = usePackages(destination ? { destination: destination.name } : {});

  if (destinations.isPending) {
    return (
      <Screen header={{ back: true, title: "Destination" }}>
        <ListSkeleton count={2} />
      </Screen>
    );
  }
  if (destinations.isError) {
    return (
      <Screen header={{ back: true, title: "Destination" }}>
        <ErrorState error={destinations.error} onRetry={() => void destinations.refetch()} />
      </Screen>
    );
  }
  if (!destination) {
    return (
      <Screen header={{ back: true, title: "Destination" }}>
        <EmptyState
          icon="map-outline"
          title="We couldn’t find that destination"
          message="It may have been removed."
          actionLabel="Explore destinations"
          onAction={() => router.replace('/explore')}
        />
      </Screen>
    );
  }

  const name = destination.name;
  const hotelPage = hotels.data;
  const hotelPreview = (hotelPage?.hotels ?? []).slice(0, PREVIEW_COUNT);
  const packagePreview = sortPackages(packages.data ?? [], 'recommended').slice(0, PREVIEW_COUNT);
  // Areas are a garnish: if that request fails the section simply doesn't show.
  const areas = (locations.data ?? []).filter((l) => l.hotel_count > 0);

  return (
    <Screen header={{ back: true, title: name, subtitle: destination.country ?? undefined }} scroll flush>
      <RemoteImage uri={destinationPhotoUrl(destination.image ?? destination.id, 'hero')} alt={`${name}, a photograph of the destination`} height={200} placeholderLabel={name} />

      <View style={[styles.body, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        {/* Places to visit */}
        {attractions.isPending ? (
          <Skeleton height={180} radius={12} />
        ) : attractions.isError ? (
          <ErrorState error={attractions.error} title="Couldn’t load places to visit" onRetry={() => void attractions.refetch()} />
        ) : attractions.data.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Discover" title="Places to visit" />
            <Shelf
              data={attractions.data}
              keyExtractor={(a) => a.id}
              itemWidth={ATTRACTION_WIDTH}
              renderItem={({ item }) => <AttractionCard attraction={item} width={ATTRACTION_WIDTH} />}
            />
          </View>
        ) : null}

        {/* Where to stay */}
        <View style={styles.section}>
          <SectionHeader
            eyebrow="Stay"
            title={`Hotels in ${name}`}
            actionLabel={hotelPage && hotelPage.total > 0 ? 'See all' : undefined}
            onAction={() => router.push({ pathname: '/hotels', params: { destination: destination.id } })}
          />
          {hotels.isPending ? (
            <ListSkeleton count={1} />
          ) : hotels.isError ? (
            <ErrorState error={hotels.error} title="Couldn’t load hotels" onRetry={() => void hotels.refetch()} />
          ) : hotelPreview.length === 0 ? (
            <Card>
              <Text variant="bodyStrong" color="ink">
                No hotels listed in {name} yet
              </Text>
              <Text variant="small" color="textSecondary">
                We’re adding stays here. Tour packages to {name} include accommodation.
              </Text>
            </Card>
          ) : (
            <>
              {hotelPreview.map((h) => (
                <HotelCard
                  key={h.id}
                  hotel={fromDestinationItem(h)}
                  photo={photoForDestinationItem(h)}
                  onPress={() => router.push({ pathname: '/hotels/[id]', params: { id: h.id } })}
                />
              ))}
              {areas.length > 0 ? (
                <View style={styles.tags} accessible accessibilityLabel={`Areas with hotels: ${areas.map((a) => a.name).join(', ')}`}>
                  {areas.map((a) => (
                    <Tag key={a.id} label={`${a.name} · ${a.hotel_count}`} />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>

        {/* What to book */}
        <View style={styles.section}>
          <SectionHeader
            eyebrow="Book"
            title={`Packages to ${name}`}
            actionLabel={(packages.data?.length ?? 0) > PREVIEW_COUNT ? 'See all' : undefined}
            onAction={() => router.push({ pathname: '/packages', params: { destination: name } })}
          />
          {packages.isPending ? (
            <ListSkeleton count={1} />
          ) : packages.isError ? (
            <ErrorState error={packages.error} title="Couldn’t load packages" onRetry={() => void packages.refetch()} />
          ) : packagePreview.length === 0 ? (
            <Card>
              <Text variant="bodyStrong" color="ink">
                No packages to {name} right now
              </Text>
              <Text variant="small" color="textSecondary">
                Browse all our tour packages for more ideas.
              </Text>
              <Button title="All tour packages" variant="outline" fullWidth={false} onPress={() => router.push('/packages')} />
            </Card>
          ) : (
            packagePreview.map((p) => <PackageCard key={p.id} pkg={p} onPress={() => router.push({ pathname: '/packages/[id]', params: { id: p.id } })} />)
          )}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  section: { gap: spacing.s3 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
});
