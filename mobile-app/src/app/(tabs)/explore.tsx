import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EditorialHero, EmptyState, ErrorState, LoadingState, Screen, TextField } from '@/components';
import { Chip, ChipRow } from '@/components/layout';
import { DestinationCard } from '@/features/discovery/cards';
import { useDestinations } from '@/features/discovery/hooks';
import { filterByRegion, filterDestinations, type RegionFilter } from '@/features/search/destinations';
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { spacing } from '@/theme';
import { SiteFooter } from '@/features/home/SiteFooter';

const GAP = spacing.s3;
const MIN_TILE = 150;

/**
 * Every destination, searchable. The grid sizes itself from its own measured
 * width, so two columns on a phone become three or four on a tablet or in
 * landscape without a breakpoint table.
 */
export default function ExploreScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const destinations = useDestinations();
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState<RegionFilter>('all');
  const [gridWidth, setGridWidth] = useState(0);

  const visible = useMemo(() => filterByRegion(filterDestinations(destinations.data ?? [], query), region), [destinations.data, query, region]);

  const columns = Math.max(2, Math.floor((gridWidth + GAP) / (MIN_TILE + GAP)));
  const tileWidth = gridWidth > 0 ? Math.floor((gridWidth - GAP * (columns - 1)) / columns) : 0;

  return (
    <Screen header scroll flush bottomInset={false}>
      {/* The site's Destinations hero: how many places and countries, and "Where will you go?" */}
      <EditorialHero
        crumb="Destinations"
        kicker={
          destinations.data
            ? `${destinations.data.length} destinations · ${new Set(destinations.data.map((d) => d.country).filter(Boolean)).size} countries`
            : 'Destinations'
        }
        title="Where will"
        accent="you go?"
        uppercase
        photoUri={destinationPhotoUrl(destinations.data?.[0]?.image ?? destinations.data?.[0]?.id ?? 'dubai', 'hero')}
        photoAlt="A photograph of a destination"
      />
      <View style={[styles.content, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <TextField
          label="Search destinations"
          value={query}
          onChangeText={setQuery}
          placeholder="City, region or country"
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        <ChipRow>
          <Chip label="All" selected={region === 'all'} onPress={() => setRegion('all')} />
          <Chip label="India" selected={region === 'india'} onPress={() => setRegion('india')} />
          <Chip label="International" selected={region === 'international'} onPress={() => setRegion('international')} />
        </ChipRow>

        {destinations.isPending ? (
          <LoadingState message="Loading destinations…" />
        ) : destinations.isError ? (
          <ErrorState error={destinations.error} onRetry={() => void destinations.refetch()} retrying={destinations.isRefetching} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="search-outline"
            title="No destinations found"
            message={query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to show for that filter.'}
            actionLabel="Clear search"
            onAction={() => {
              setQuery('');
              setRegion('all');
            }}
          />
        ) : (
          <View style={styles.grid} onLayout={(e: LayoutChangeEvent) => setGridWidth(e.nativeEvent.layout.width)}>
            {tileWidth > 0
              ? visible.map((d) => (
                  <DestinationCard key={d.id} destination={d} width={tileWidth} onPress={() => router.push({ pathname: '/destination/[id]', params: { id: d.id } })} />
                ))
              : null}
          </View>
        )}
      </View>
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
});
