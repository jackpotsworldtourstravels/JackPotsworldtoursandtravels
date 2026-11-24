import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Card, PriceTag, Screen, StepIndicator, StickyFooter, Text } from '@/components';
import { airportByCode } from '@/features/flights/airports';
import { partySummary } from '@/features/flights/flightForm';
import { useTripDraft } from '@/features/flights/preview/draft';
import { rupees, tripTotals } from '@/features/flights/preview/extras';
import { FLIGHT_STEPS } from '@/features/flights/preview/flow';
import { durationLabel, legsOf } from '@/features/flights/preview/sample';
import { AirlineBadge, NoTrip, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';

/**
 * REVIEW YOUR TRIP. One card per flight (Trip 1, Trip 2, …) with its timeline, baggage and fare, then the price of
 * the whole trip. All sample data until a flight supplier is connected.
 */
export default function FlightReviewScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  const search = draft.search;
  const legs = search ? legsOf(search) : [];
  if (!search || draft.picks.length !== legs.length || !draft.picks.every(Boolean)) {
    return (
      <Screen header={{ title: 'Review your trip', back: true, tone: 'light' }}>
        <NoTrip />
      </Screen>
    );
  }
  const totals = tripTotals(draft);
  const adults = search.party.adults + search.party.children;

  return (
    <Screen
      header={{ title: 'Review your trip', subtitle: `${legs.length} flight${legs.length === 1 ? '' : 's'} · ${partySummary(search.party)} · ${search.cabin}`, back: true, tone: 'light' }}
      scroll
      footer={
        <StickyFooter actionTitle="Continue" onAction={() => router.push('/flights/book/travellers')}>
          <PriceTag amount={totals.fares + totals.taxes} note="Sample total · incl. taxes" size="md" />
        </StickyFooter>
      }
    >
      <StepIndicator steps={FLIGHT_STEPS} current={0} />
      <SampleNotice />
      {legs.map((leg, i) => {
        const f = draft.picks[i]!;
        const from = airportByCode(leg.from);
        const to = airportByCode(leg.to);
        return (
          <View key={`${leg.from}-${leg.to}-${i}`} style={styles.trip} accessible accessibilityLabel={`Trip ${i + 1}, ${from?.city ?? leg.from} to ${to?.city ?? leg.to}, ${formatShortDate(leg.date)}, ${f.airline.name} ${f.number}, ${f.dep} to ${f.arr}`}>
            <View style={styles.tripHead}>
              <View style={styles.num}>
                <Text variant="caption" chrome color="navy900" style={styles.bold}>
                  {i + 1}
                </Text>
              </View>
              <Text variant="bodyStrong" color="white" style={styles.flex}>
                {from?.city ?? leg.from} → {to?.city ?? leg.to}
              </Text>
              <Text variant="caption" color="onDark2">
                {formatShortDate(leg.date)}
              </Text>
            </View>
            <View style={styles.tripBody}>
              <View style={styles.row}>
                <AirlineBadge airline={f.airline} size={32} />
                <View style={styles.flex}>
                  <Text variant="bodyStrong" color="ink">
                    {f.airline.name}
                  </Text>
                  <Text variant="caption" color="textSecondary">
                    {f.number} · {f.aircraft}
                  </Text>
                </View>
                <View style={[styles.pill, f.stops ? styles.pillStop : styles.pillDirect]}>
                  <Text variant="caption" chrome style={[styles.bold, { color: f.stops ? colors.warning : colors.success }]}>
                    {f.stops ? `1 stop · ${f.via}` : 'Non-stop'}
                  </Text>
                </View>
              </View>
              <View style={styles.timeline}>
                <View style={styles.timeCol}>
                  <Text variant="h3" color="ink">
                    {f.dep}
                  </Text>
                  <Text variant="h3" color="ink">
                    {f.arr}
                  </Text>
                </View>
                <View style={styles.rail}>
                  <View style={styles.dotOpen} />
                  <View style={styles.railLine} />
                  <View style={styles.dotFull} />
                </View>
                <View style={styles.places}>
                  <View>
                    <Text variant="bodyStrong" color="ink">
                      {from?.city ?? leg.from} ({leg.from})
                    </Text>
                    <Text variant="caption" color="textSecondary">
                      {from?.airportName || from?.country || ''}
                    </Text>
                    <Text variant="caption" chrome color="goldInk" style={[styles.bold, styles.dur]}>
                      {durationLabel(f.minutes)} flight
                    </Text>
                  </View>
                  <View>
                    <Text variant="bodyStrong" color="ink">
                      {to?.city ?? leg.to} ({leg.to}){f.arrDayShift ? ' · next day' : ''}
                    </Text>
                    <Text variant="caption" color="textSecondary">
                      {to?.airportName || to?.country || ''}
                    </Text>
                  </View>
                </View>
              </View>
              <View style={styles.facts}>
                <View style={styles.fact}>
                  <Ionicons name="briefcase-outline" size={15} color={colors.goldInk} />
                  <Text variant="caption" color="ink2">
                    {f.checkinKg} kg + {f.cabinKg} kg cabin
                  </Text>
                </View>
                <View style={styles.fact}>
                  <Ionicons name="pricetag-outline" size={15} color={colors.goldInk} />
                  <Text variant="caption" color="ink2">
                    {f.fare} fare{f.fare === 'Saver' ? ' · change fee applies' : ' · free date change'}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        );
      })}
      <Card style={styles.prices}>
        <Text variant="h3" color="ink" accessibilityRole="header">
          Price
        </Text>
        <View style={styles.line}>
          <Text variant="body" color="ink2" style={styles.flex}>
            Fares · {adults} seat{adults === 1 ? '' : 's'}
            {search.party.infants ? ` + ${search.party.infants} on a lap` : ''} × {legs.length} flight{legs.length === 1 ? '' : 's'}
          </Text>
          <Text variant="bodyStrong" color="ink">
            {rupees(totals.fares)}
          </Text>
        </View>
        <View style={styles.line}>
          <Text variant="body" color="ink2" style={styles.flex}>
            Taxes and airport fees
          </Text>
          <Text variant="bodyStrong" color="ink">
            {rupees(totals.taxes)}
          </Text>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  trip: { backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden' },
  tripHead: { backgroundColor: colors.navy900, flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingHorizontal: spacing.s4, paddingVertical: spacing.s3 },
  num: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  tripBody: { padding: spacing.s4, gap: spacing.s3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  pill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  pillDirect: { backgroundColor: colors.successSoft },
  pillStop: { backgroundColor: colors.warningSoft },
  timeline: { flexDirection: 'row', gap: spacing.s3 },
  timeCol: { justifyContent: 'space-between' },
  rail: { alignItems: 'center', paddingVertical: 6 },
  dotOpen: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.primary },
  railLine: { flex: 1, width: 2, backgroundColor: colors.line, marginVertical: 3 },
  dotFull: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  places: { flex: 1, gap: spacing.s4 },
  dur: { marginTop: 4 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s4, paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  prices: { gap: spacing.s2 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3 },
});
