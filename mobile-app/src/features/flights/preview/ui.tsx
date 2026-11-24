import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState, Text } from '@/components';
import { colors, fontFamily, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';

import { useTripDraft } from './draft';
import { type FlightLeg, type SampleAirline } from './sample';

/** Said on every screen of the UI-only flow, so nobody mistakes a sample for a live fare. */
export function SampleNotice({ compact = false }: { compact?: boolean }) {
  return (
    <View style={[styles.notice, compact && styles.noticeCompact]} accessibilityRole="text">
      <Ionicons name="information-circle-outline" size={16} color={colors.goldInk} />
      <Text variant="caption" color="ink2" style={styles.flex}>
        {compact ? 'Sample flights and prices · booking opens soon' : 'Sample flights and prices. Live airline fares and booking open soon; until then, send your trip to our team for a real quote.'}
      </Text>
    </View>
  );
}

export function AirlineBadge({ airline, size = 28 }: { airline: SampleAirline; size?: number }) {
  return (
    <View style={[styles.badge, { width: size, height: size, borderRadius: size / 3.2, backgroundColor: airline.color }]}>
      <Text variant="caption" chrome color="white" style={[styles.badgeText, { fontSize: size * 0.36 }]}>
        {airline.code}
      </Text>
    </View>
  );
}

/** One tab per flight of the trip: "Trip 1 · HYD → DEL", ticked once a flight is chosen for it. */
export function LegTabs({ legs, current, done, onChange }: { legs: readonly FlightLeg[]; current: number; done: (i: number) => boolean; onChange: (i: number) => void }) {
  if (legs.length < 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} accessibilityRole="tablist">
      {legs.map((leg, i) => {
        const on = i === current;
        const ok = done(i);
        return (
          <Pressable
            key={`${leg.from}-${leg.to}-${i}`}
            onPress={() => onChange(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Trip ${i + 1}, ${leg.from} to ${leg.to}${ok ? ', chosen' : ''}`}
            style={[styles.tab, on ? styles.tabOn : styles.tabOff]}
          >
            <View style={styles.tabTop}>
              {ok ? <Ionicons name="checkmark-circle" size={13} color={on ? colors.success : '#3CCB8E'} /> : null}
              <Text variant="caption" chrome style={[styles.tabKicker, { color: on ? colors.goldInk : ok ? '#3CCB8E' : colors.onDark2 }]}>
                TRIP {i + 1}
              </Text>
            </View>
            <Text variant="bodyStrong" chrome color={on ? 'ink' : 'white'}>
              {leg.from} → {leg.to}
            </Text>
            <Text variant="caption" color={on ? 'textSecondary' : 'onDark2'}>
              {formatShortDate(leg.date)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** "Who is this for": one card per traveller with a status line under the name. */
export function PassengerTabs({ people, active, onChange }: { people: { index: number; name: string; status: string; done: boolean }[]; active: number; onChange: (index: number) => void }) {
  return (
    <View style={styles.people} accessibilityRole="tablist" accessibilityLabel="Traveller">
      {people.map((p) => {
        const on = p.index === active;
        return (
          <Pressable
            key={p.index}
            onPress={() => onChange(p.index)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${p.name}, ${p.status}`}
            style={[styles.person, on && styles.personOn]}
          >
            <View style={[styles.avatar, on && styles.avatarOn]}>
              <Text variant="caption" chrome color={on ? 'white' : 'navy900'} style={styles.badgeText}>
                {p.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0]?.toUpperCase())
                  .join('')}
              </Text>
            </View>
            <View style={styles.flex}>
              <Text variant="small" chrome color="ink" numberOfLines={1} style={styles.badgeText}>
                {p.name}
              </Text>
              <Text variant="caption" color={p.done ? 'success' : 'textSecondary'} numberOfLines={1}>
                {p.status}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A section card's heading row. */
export function CardTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={styles.cardTitle}>
      <Text variant="h3" color="ink" accessibilityRole="header" style={styles.flex}>
        {children}
      </Text>
      {right}
    </View>
  );
}

/** Shown when a screen of the flow is opened without a search behind it (a cold start, a stale link). */
export function NoTrip() {
  const router = useRouter();
  return (
    <EmptyState
      icon="airplane-outline"
      title="Start with a flight search"
      message="Choose where and when you’re flying, then pick your flights."
      actionLabel="Search flights"
      onAction={() => router.replace('/flights')}
    />
  );
}

export function useHasTrip(): boolean {
  return useTripDraft().search !== null;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    backgroundColor: '#FFFCF4',
    borderWidth: 1,
    borderColor: '#F1D9A6',
    borderRadius: 12,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
  },
  noticeCompact: { paddingVertical: 6 },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: fontFamily.sansExtraBold },
  tabs: { gap: spacing.s2, paddingVertical: spacing.s1 },
  tab: { minWidth: 132, borderRadius: 14, paddingHorizontal: spacing.s3, paddingVertical: spacing.s2, gap: 1 },
  tabOn: { backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.gold },
  tabOff: { backgroundColor: colors.navy800, borderWidth: 1, borderColor: colors.navy600 },
  tabTop: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tabKicker: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.4 },
  cardTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  person: {
    flexGrow: 1,
    flexBasis: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    minHeight: 54,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.s3,
  },
  personOn: { borderWidth: 2, borderColor: colors.primary },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  avatarOn: { backgroundColor: colors.primary },
});
