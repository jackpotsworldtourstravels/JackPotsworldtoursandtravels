import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EditorialHero, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { Chip, ChipRow } from '@/components/layout';
import { PackageCard } from '@/features/discovery/cards';
import { usePackages } from '@/features/discovery/hooks';
import { PACKAGE_SORTS, sortPackages, type PackageSort } from '@/features/discovery/packages';
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { colors, fontFamily, spacing } from '@/theme';
import type { PackageQuery } from '@/types/discovery';
import { SiteFooter } from '@/features/home/SiteFooter';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const isTripType = (v: string | undefined): v is NonNullable<PackageQuery['trip_type']> => v === 'domestic' || v === 'international' || v === 'pilgrimage';

/** `.pkl-cat`: the site's three trip categories and its one-line description of each. */
const CATEGORIES = [
  { value: 'domestic', title: 'Domestic', blurb: 'Trips inside India — beaches, hills and cities.', icon: 'location-outline' },
  { value: 'pilgrimage', title: 'Pilgrimage', blurb: 'Temple towns and holy circuits, planned end to end.', icon: 'business-outline' },
  { value: 'international', title: 'International', blurb: 'Visas, flights and hotels, arranged as one trip.', icon: 'globe-outline' },
] as const;

/**
 * Tour packages, optionally for one destination (by its NAME: that is what the
 * packages endpoint filters on) and one trip type. Filtering happens on the
 * server; ordering happens here. The layout is the website's `packages.html`:
 * the "Journeys, already planned." hero, three category cards that filter the
 * list, a count and a sort, then the package cards.
 */
export default function PackagesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ destination?: string; tripType?: string }>();
  const destination = asString(params.destination);
  const initialTrip = asString(params.tripType);

  const [tripType, setTripType] = useState<PackageQuery['trip_type']>(isTripType(initialTrip) ? initialTrip : undefined);
  const [sort, setSort] = useState<PackageSort>('recommended');

  const query = usePackages({ destination, trip_type: tripType });
  // The category cards print how many packages each holds, so they count the whole list, not the filtered one.
  const everything = usePackages({ destination });
  const counts = {
    domestic: (everything.data ?? []).filter((p) => p.trip_type === 'domestic').length,
    pilgrimage: (everything.data ?? []).filter((p) => p.trip_type === 'pilgrimage').length,
    international: (everything.data ?? []).filter((p) => p.trip_type === 'international').length,
  };
  const packages = useMemo(() => sortPackages(query.data ?? [], sort), [query.data, sort]);

  return (
    <Screen header={{ back: true }} scroll flush>
      {/* The site's Tour Packages hero: "Journeys, already planned.", and what is being looked at, with Edit. */}
      <EditorialHero
        crumb="Tour packages"
        kicker="Tour packages"
        title="Journeys,"
        accent="already planned."
        uppercase
        photoUri={destinationPhotoUrl(destination ? destination.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'goa', 'hero')}
        photoAlt="A photograph of a destination"
        summary={{
          tone: 'paper',
          title: destination ?? 'All destinations',
          sub: 'Any month',
          actionLabel: 'Edit',
          onAction: () => (router.canGoBack() ? router.back() : router.replace('/')),
        }}
      />

      <View style={[styles.content, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        {CATEGORIES.map((c) => {
          const active = tripType === c.value;
          const count = counts[c.value];
          return (
            <Pressable
              key={c.value}
              onPress={() => setTripType(active ? undefined : c.value)}
              accessibilityRole="button"
              accessibilityLabel={c.title}
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [styles.category, active && styles.categoryActive, pressed && styles.pressed]}
            >
              <View style={[styles.categoryIcon, active && styles.categoryIconActive]}>
                <Ionicons name={c.icon} size={22} color={active ? colors.white : colors.ink2} />
              </View>
              <View style={styles.categoryText}>
                <Text variant="h3" color="navy800" style={styles.categoryTitle}>
                  {c.title}
                </Text>
                <Text variant="small" color="muted">
                  {c.blurb}
                </Text>
                <View style={styles.countPill}>
                  <Text variant="caption" color="navy800" chrome style={styles.countText}>
                    {count === 0 ? 'None on sale yet' : `${count} package${count === 1 ? '' : 's'}`}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        })}

        <ChipRow>
          {PACKAGE_SORTS.map((s) => (
            <Chip key={s.value} label={s.label} selected={sort === s.value} onPress={() => setSort(s.value)} />
          ))}
        </ChipRow>

        {query.isPending ? (
          <LoadingState message="Finding packages…" />
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
            <Text variant="caption" color="ink2" chrome accessibilityLiveRegion="polite" style={styles.count}>
              {`${packages.length} PACKAGE${packages.length === 1 ? '' : 'S'}`}
            </Text>
            {packages.map((p) => (
              <PackageCard key={p.id} pkg={p} onPress={() => router.push({ pathname: '/packages/[id]', params: { id: p.id } })} />
            ))}
          </View>
        )}
      </View>
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  list: { gap: spacing.s4 },
  count: { fontFamily: fontFamily.sansBold, fontSize: 12, letterSpacing: 1.8 },
  category: { flexDirection: 'row', gap: spacing.s4, padding: 18, borderRadius: 20, backgroundColor: colors.white, borderWidth: 1, borderColor: 'transparent' },
  categoryActive: { borderColor: colors.gold },
  categoryIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EFEAE0' },
  categoryIconActive: { backgroundColor: colors.navy800 },
  categoryText: { flex: 1, gap: 6 },
  categoryTitle: { fontFamily: fontFamily.displayBold, fontSize: 22, lineHeight: 26 },
  countPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
    marginTop: 2,
  },
  countText: { fontFamily: fontFamily.sansBold, fontSize: 12.5 },
  pressed: { opacity: 0.9 },
});
