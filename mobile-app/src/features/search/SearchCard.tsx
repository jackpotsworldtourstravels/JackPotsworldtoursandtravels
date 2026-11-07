import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Chip, ChipRow } from '@/components/layout';
import { Text } from '@/components/Text';
import { TRIP_TYPES } from '@/features/discovery/packages';
import { FlightSearchForm } from '@/features/flights/FlightSearchForm';
import { TrustStrip } from '@/features/home/TrustStrip';
import { colors, gradients, radius, shadow, spacing } from '@/theme';
import type { Destination, PackageQuery } from '@/types/discovery';

import { DestinationPicker } from './DestinationPicker';
import { StayFields } from './StayFields';
import { DEFAULT_PARTY, type Party } from './party';
import { defaultStay, stayProblem } from './stay';

/**
 * The website's four service tabs, in its order (booking-card.js): Flights, Hotels, Tour Packages, Gaming
 * Tour Packages. Flights is the tab that opens, as on the website. It asks what the site asks but has no live
 * supplier behind it, so its results screen says so before anything else. Gaming Tour Packages is an
 * enquiry, as on the site: a note and a link to the form, no search.
 */
export type SearchTab = 'flights' | 'hotels' | 'packages' | 'gaming';

const TABS: { key: SearchTab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'flights', label: 'Flights', icon: 'airplane-outline' },
  { key: 'hotels', label: 'Hotels', icon: 'bed-outline' },
  { key: 'packages', label: 'Tour Packages', icon: 'map-outline' },
  { key: 'gaming', label: 'Gaming Tour Packages', icon: 'dice-outline' },
];

const STAY_PROBLEMS = {
  invalid: 'Choose your check-in and check-out dates.',
  past: 'Check-in can’t be in the past.',
  order: 'Check-out must be after check-in.',
  too_long: 'Stays are limited to 30 nights.',
} as const;

export function SearchCard({ initialTab = 'flights' }: { initialTab?: SearchTab }) {
  const [tab, setTab] = useState<SearchTab>(initialTab);

  // The website's dock: a dark strip of tabs (the selected one ringed in gold) joined
  // to a light panel holding the form (booking-card.js, home-cinema.css .search-card).
  return (
    <View style={styles.card}>
      <LinearGradient colors={gradients.card} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <LinearGradient colors={gradients.dock} style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => {
          const selected = t.key === tab;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={t.label}
              style={[styles.tab, selected && styles.tabSelected]}
            >
              <Ionicons name={t.icon} size={20} color={selected ? colors.gold : colors.onDark2} />
              <Text variant="bodyStrong" color={selected ? 'goldLight' : 'onDark2'} chrome align="center" style={styles.tabLabel} maxFontSizeMultiplier={1.2}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </LinearGradient>

      <View style={styles.panel}>
        {tab === 'flights' ? <FlightsTab /> : tab === 'hotels' ? <HotelSearchForm /> : tab === 'packages' ? <PackageSearchForm /> : <GamingTab />}
      </View>
      <View style={styles.trust}>
        <TrustStrip />
      </View>
    </View>
  );
}

function FlightsTab() {
  const router = useRouter();
  return <FlightSearchForm onSearch={(search) => router.push({ pathname: '/flights', params: { search: JSON.stringify(search) } })} />;
}

/** The site's Gaming tab has no search: it says how it works and links to the enquiry form. */
function GamingTab() {
  const router = useRouter();
  return (
    <View style={styles.form}>
      <Text variant="body" color="ink2">
        Gaming Tour Packages are arranged by our desk, one traveller at a time. Open the enquiry form to tell us where and when you want to go.
      </Text>
      <Button title="Open the enquiry form" icon="arrow-forward" onPress={() => router.push('/gaming')} />
    </View>
  );
}

function HotelSearchForm() {
  const router = useRouter();
  const [destination, setDestination] = useState<Destination | null>(null);
  const [stay, setStay] = useState(() => defaultStay());
  const [party, setParty] = useState<Party>(DEFAULT_PARTY);
  const [attempted, setAttempted] = useState(false);

  const problem = stayProblem(stay);

  const search = () => {
    setAttempted(true);
    if (problem) return;
    router.push({
      pathname: '/hotels',
      params: {
        ...(destination ? { destination: destination.id } : {}),
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        rooms: String(party.rooms),
        adults: String(party.adults),
        children: String(party.children),
      },
    });
  };

  return (
    <View style={styles.form}>
      <DestinationPicker value={destination} onChange={setDestination} anyLabel="All destinations" />
      <StayFields stay={stay} onStayChange={setStay} party={party} onPartyChange={setParty} />
      {attempted && problem ? <Banner tone="error" message={STAY_PROBLEMS[problem]} /> : null}
      <Button title="Search hotels" icon="search" onPress={search} />
    </View>
  );
}

function PackageSearchForm() {
  const router = useRouter();
  const [destination, setDestination] = useState<Destination | null>(null);
  const [tripType, setTripType] = useState<PackageQuery['trip_type']>(undefined);

  const search = () => {
    router.push({
      pathname: '/packages',
      params: {
        ...(destination ? { destination: destination.name } : {}),
        ...(tripType ? { tripType } : {}),
      },
    });
  };

  return (
    <View style={styles.form}>
      <DestinationPicker value={destination} onChange={setDestination} anyLabel="Anywhere" />
      <View style={styles.group}>
        <Text variant="caption" color="ink2" style={styles.groupLabel}>
          Trip type
        </Text>
        <ChipRow>
          {TRIP_TYPES.map((t) => (
            <Chip key={t.label} label={t.label} selected={tripType === t.value} onPress={() => setTripType(t.value)} />
          ))}
        </ChipRow>
      </View>
      <Button title="Search packages" icon="search" onPress={search} />
    </View>
  );
}

const styles = StyleSheet.create({
  // `.search-card.is-premium`: an 18px card on a white-to-warm-white ground with a gold 30% edge.
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.cardEdge,
    ...shadow.md,
  },
  trust: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingBottom: spacing.s3 },
  // All four tabs share the width, so none is hidden off the edge of a phone; long names wrap to a second line.
  tabs: {
    flexDirection: 'row',
    gap: spacing.s1,
    padding: spacing.s2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 2,
    minHeight: 64,
    paddingVertical: spacing.s2,
    paddingHorizontal: 2,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  tabLabel: { fontSize: 12, lineHeight: 15 },
  tabSelected: { backgroundColor: colors.goldFill, borderColor: colors.goldRing },
  panel: { padding: spacing.s4 },
  form: { gap: spacing.s3 },
  group: { gap: spacing.s1 },
  groupLabel: { marginLeft: spacing.s1 },
});
