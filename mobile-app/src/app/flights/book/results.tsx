import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PriceTag, Screen, StickyFooter, Text } from '@/components';
import { Chip } from '@/components/layout';
import { parseFlightSearch, partySummary, type FlightSearch } from '@/features/flights/flightForm';
import { tripDraft, useTripDraft } from '@/features/flights/preview/draft';
import { tripTotals } from '@/features/flights/preview/extras';
import { durationLabel, legsOf, sampleDayPrices, sampleFlights, type SampleFlight } from '@/features/flights/preview/sample';
import { AirlineBadge, LegTabs, NoTrip, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, radius, spacing } from '@/theme';
import { formatShortDate, type ISODate } from '@/utils/dates';
import { formatMoney } from '@/utils/money';

type Sort = 'cheapest' | 'fastest' | 'earliest';
const SORTS: { value: Sort; label: string }[] = [
  { value: 'cheapest', label: 'Cheapest' },
  { value: 'fastest', label: 'Fastest' },
  { value: 'earliest', label: 'Earliest' },
];

const TRIP_LABEL = { oneway: 'One way', round: 'Round trip', multi: 'Multi-city' } as const;

/** Move one flight of the search to another day; the flight picked for it no longer applies. */
function withDate(search: FlightSearch, leg: number, date: ISODate): FlightSearch {
  if (search.trip === 'multi') return { ...search, legs: search.legs.map((l, i) => (i === leg ? { ...l, date } : l)) };
  return leg === 0 ? { ...search, depart: date } : { ...search, ret: date };
}

function FlightRow({ flight, selected, onPress }: { flight: SampleFlight; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${flight.airline.name} ${flight.number}, ${flight.dep} to ${flight.arr}, ${flight.stops ? `1 stop via ${flight.via}` : 'non-stop'}, ${formatMoney(flight.price)} per adult${selected ? ', selected' : ''}`}
      style={({ pressed }) => [styles.card, selected && styles.cardOn, pressed && styles.pressed]}
    >
      <View style={styles.cardTop}>
        <AirlineBadge airline={flight.airline} />
        <Text variant="small" chrome color="ink2" style={[styles.flex, styles.bold]}>
          {flight.airline.name} · {flight.number}
        </Text>
        {selected ? (
          <View style={styles.pickedPill}>
            <Text variant="caption" chrome color="white" style={styles.bold}>
              Selected
            </Text>
          </View>
        ) : flight.freeMeal ? (
          <View style={styles.mealPill}>
            <Text variant="caption" chrome color="success" style={styles.bold}>
              Free meal
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.cardMid}>
        <View>
          <Text variant="h2" color="ink">
            {flight.dep}
          </Text>
        </View>
        <View style={styles.line}>
          <Text variant="caption" color="textSecondary">
            {durationLabel(flight.minutes)}
          </Text>
          <View style={styles.track}>
            <View style={styles.rule} />
            {flight.stops ? <View style={styles.stopDot} /> : null}
            <View style={styles.rule} />
          </View>
          <Text variant="caption" chrome style={[styles.bold, { color: flight.stops ? colors.warning : colors.success }]}>
            {flight.stops ? `1 stop · ${flight.via}` : 'Non-stop'}
          </Text>
        </View>
        <View style={styles.right}>
          <Text variant="h2" color="ink">
            {flight.arr}
            {flight.arrDayShift ? <Text variant="caption" color="warning">{` +${flight.arrDayShift}`}</Text> : null}
          </Text>
        </View>
        <View style={styles.price}>
          <Text variant="h3" color="ink">
            {formatMoney(flight.price)}
          </Text>
          <Text variant="caption" color="textSecondary">
            per adult
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * FLIGHT RESULTS (UI-only, sample flights). One trip at a time: the tabs at the top are the trip's flights, the strip
 * under them moves this flight to another day, and choosing a flight moves on to the next one that still needs one.
 */
export default function FlightResultsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ search?: string }>();
  const draft = useTripDraft();
  const [leg, setLeg] = useState(0);
  const [sort, setSort] = useState<Sort>('cheapest');

  // A search handed in by the flights screen starts a new trip (unless it is the trip already open).
  const incoming = useMemo(() => parseFlightSearch(Array.isArray(params.search) ? params.search[0] : params.search), [params.search]);
  useEffect(() => {
    if (incoming && JSON.stringify(incoming) !== JSON.stringify(tripDraft.get().search)) tripDraft.start(incoming, legsOf(incoming).length);
  }, [incoming]);

  const search = draft.search;
  const legs = search ? legsOf(search) : [];
  const current = legs[leg];
  // Seven sample flights: cheap enough to work out on every render.
  const all = current && search ? sampleFlights(current, search.cabin) : [];
  const flights = sort === 'cheapest' ? [...all].sort((a, b) => Number(a.price) - Number(b.price)) : sort === 'fastest' ? [...all].sort((a, b) => a.minutes - b.minutes) : all;

  if (!search || !current) {
    return (
      <Screen header={{ title: 'Flights', back: true }}>
        <NoTrip />
      </Screen>
    );
  }

  const days = sampleDayPrices(current, search.cabin);
  const allPicked = draft.picks.length === legs.length && draft.picks.every(Boolean);
  const totals = tripTotals(draft);
  const route = search.trip === 'multi' ? [legs[0].from, ...legs.map((l) => l.to)].join(' → ') : `${legs[0].from} → ${legs[0].to}`;

  const pick = (flight: SampleFlight) => {
    tripDraft.set((s) => ({ picks: s.picks.map((p, i) => (i === leg ? flight : p)) }));
    const next = draft.picks.findIndex((p, i) => i !== leg && !p);
    if (next >= 0) setLeg(next);
  };
  const moveDay = (date: ISODate) => {
    if (date === current.date) return;
    const moved = withDate(search, leg, date);
    tripDraft.set((s) => ({ search: moved, picks: s.picks.map((p, i) => (i === leg ? null : p)) }));
  };

  return (
    <Screen
      header={{ title: route, subtitle: `${TRIP_LABEL[search.trip]} · ${partySummary(search.party)} · ${search.cabin}`, back: true, actionLabel: 'Edit', onAction: () => router.back() }}
      scroll
      flush
      footer={
        <StickyFooter actionTitle="Review trip" disabled={!allPicked} onAction={() => router.push('/flights/book/review')}>
          <PriceTag amount={totals.fares + totals.taxes} note={allPicked ? `${legs.length > 1 ? `All ${legs.length} flights` : 'Your flight'} · incl. taxes` : `Choose ${legs.length > 1 ? 'a flight for each trip' : 'a flight'}`} size="md" />
        </StickyFooter>
      }
    >
      {legs.length > 1 ? (
        <View style={[styles.band, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
          <LegTabs legs={legs} current={leg} done={(i) => Boolean(draft.picks[i])} onChange={setLeg} />
        </View>
      ) : null}
      <View style={styles.days}>
        {days.map((d) => {
          const on = d.date === current.date;
          return (
            <Pressable
              key={d.date}
              onPress={() => moveDay(d.date)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${formatShortDate(d.date)}, from ${formatMoney(d.price)}`}
              style={[styles.day, on && styles.dayOn]}
            >
              <Text variant="caption" chrome color={on ? 'ink' : 'ink2'} style={on ? styles.bold : undefined}>
                {formatShortDate(d.date)}
              </Text>
              <Text variant="caption" color="textSecondary">
                {formatMoney(d.price)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.body, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <View style={styles.sorts}>
          {SORTS.map((s) => (
            <Chip key={s.value} label={s.label} selected={sort === s.value} onPress={() => setSort(s.value)} />
          ))}
        </View>
        <SampleNotice compact />
        <View style={styles.legHead}>
          <Ionicons name="airplane" size={16} color={colors.goldInk} />
          <Text variant="bodyStrong" color="ink" style={styles.flex}>
            {legs.length > 1 ? `Trip ${leg + 1}: ` : ''}
            {current.from} → {current.to} · {formatShortDate(current.date)}
          </Text>
          <Text variant="caption" color="textSecondary">
            {flights.length} flights
          </Text>
        </View>
        {flights.map((f) => (
          <FlightRow key={f.id} flight={f} selected={draft.picks[leg]?.id === f.id} onPress={() => pick(f)} />
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.85 },
  band: { backgroundColor: colors.navy900, paddingBottom: spacing.s3 },
  days: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  day: { flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', gap: 2, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  dayOn: { borderBottomColor: colors.gold },
  body: { gap: spacing.s3, paddingTop: spacing.s3 },
  sorts: { flexDirection: 'row', gap: spacing.s2 },
  legHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, marginTop: spacing.s1 },
  card: { backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.divider, padding: spacing.s3, gap: spacing.s3 },
  cardOn: { borderWidth: 2, borderColor: colors.gold, backgroundColor: '#FFFCF4' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  pickedPill: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  mealPill: { backgroundColor: colors.successSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  cardMid: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  line: { flex: 1, alignItems: 'center', gap: 3 },
  track: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: 3 },
  rule: { flex: 1, height: 1.5, backgroundColor: colors.line },
  stopDot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5, borderColor: colors.warning, backgroundColor: colors.surface },
  right: { alignItems: 'flex-end' },
  price: { alignItems: 'flex-end', minWidth: 78, marginLeft: spacing.s1 },
  amount: { borderRadius: radius.md },
});
