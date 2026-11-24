import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { RemoteImage } from '@/components/RemoteImage';
import { Text } from '@/components';
import { SectionHeader } from '@/components/layout';
import { usePackages } from '@/features/discovery/hooks';
import { packagePricing } from '@/features/discovery/packages';
import { packagePhotoUrl } from '@/features/media/mediaUrl';
import { PackageSearchForm } from '@/features/search/SearchCard';
import { SearchLanding } from '@/features/search/SearchLanding';
import { colors, radius, shadow, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';
import { formatMoney } from '@/utils/money';

/**
 * HOLIDAY PACKAGE SEARCH. Domestic / International, a destination, then Search Packages. Under the form: the
 * packages with the soonest real departures, each with its next date and price per person.
 * Gaming Tour Packages are disabled and never listed.
 */
export default function PackageSearchScreen() {
  const router = useRouter();
  const packages = usePackages({});

  const soon = (packages.data ?? [])
    .filter((p) => p.category !== 'gaming')
    .map((p) => ({ p, pricing: packagePricing(p) }))
    .filter((x) => x.pricing.nextDeparture)
    .sort((a, b) => (a.pricing.nextDeparture as string).localeCompare(b.pricing.nextDeparture as string))
    .slice(0, 4);

  return (
    <SearchLanding
      title="Holiday Packages"
      below={
        soon.length > 0 ? (
          <>
            <SectionHeader title="Departing soon" actionLabel="View All" onAction={() => router.push('/packages')} />
            <View style={styles.list}>
              {soon.map(({ p, pricing }, i) => (
                <Pressable
                  key={p.id}
                  onPress={() => router.push({ pathname: '/packages/[id]', params: { id: p.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`${p.name}, next departure ${formatShortDate(pricing.nextDeparture as string)}, ${formatMoney(pricing.amount)} per person`}
                  style={({ pressed }) => [styles.row, i > 0 && styles.rowDivider, pressed && styles.pressed]}
                >
                  <RemoteImage uri={packagePhotoUrl(p.image)} alt="" style={styles.thumb} />
                  <View style={styles.flex}>
                    <Text variant="h3" color="ink" numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text variant="small" color="textSecondary">
                      {p.nights ? `${p.nights}N / ${p.days}D · ` : ''}
                      {formatShortDate(pricing.nextDeparture as string)}
                    </Text>
                  </View>
                  <View style={styles.price}>
                    <Text variant="h3" color="ink">
                      {formatMoney(pricing.amount)}
                    </Text>
                    <Text variant="caption" color="textSecondary">
                      per person
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        ) : null
      }
    >
      <PackageSearchForm />
    </SearchLanding>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  list: { backgroundColor: colors.surface, borderRadius: radius.md, ...shadow.sm, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, padding: spacing.s3 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  pressed: { backgroundColor: colors.bg },
  thumb: { width: 60, height: 60, borderRadius: radius.sm },
  price: { alignItems: 'flex-end' },
});
