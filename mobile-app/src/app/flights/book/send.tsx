import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Card, Screen, Text } from '@/components';
import { QuoteForm } from '@/features/flights/FlightsUnavailable';
import { passengerName, useTripDraft, type TripDraft } from '@/features/flights/preview/draft';
import { MEALS, rupees, tripTotals } from '@/features/flights/preview/extras';
import { legsOf } from '@/features/flights/preview/sample';
import { AirlineBadge, NoTrip } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';

const LEVEL_WORDS = { distance: 'wheelchair (long distances)', steps: 'wheelchair (no steps)', full: 'wheelchair (all the way to the seat)' } as const;

/** Everything the customer picked, as the lines our team reads in the email. */
function describePicks(draft: TripDraft): string[] {
  const legs = draft.search ? legsOf(draft.search) : [];
  const who = (i: number) => passengerName(draft.passengers[i], i, draft.passengers);
  const lines: string[] = [];
  draft.picks.forEach((f, i) => {
    if (!f) return;
    const l = legs[i];
    lines.push(`Flight ${i + 1}: ${f.airline.name} ${f.number}, ${l?.from} ${f.dep} to ${l?.to} ${f.arr}, ${l ? formatShortDate(l.date) : ''} (${f.fare})`);
  });
  lines.push(`Travellers: ${draft.passengers.map((p, i) => `${p.title ? `${p.title} ` : ''}${who(i)} (${p.type}${p.dateOfBirth ? `, born ${p.dateOfBirth}` : ''})`).join('; ')}`);
  Object.entries(draft.seats).forEach(([leg, byPax]) => {
    const s = Object.entries(byPax).map(([i, seat]) => `${who(Number(i))} ${seat}`);
    if (s.length) lines.push(`Seats, flight ${Number(leg) + 1}: ${s.join(', ')}`);
  });
  const meals = Object.entries(draft.meals).map(([i, id]) => `${who(Number(i))}: ${MEALS.find((m) => m.id === id)?.name ?? id}`);
  if (meals.length) lines.push(`Meals: ${meals.join('; ')}`);
  const bags = Object.entries(draft.baggage).map(([i, kg]) => `${who(Number(i))}: +${kg} kg`);
  if (bags.length) lines.push(`Extra baggage: ${bags.join('; ')}`);
  Object.entries(draft.assistance).forEach(([i, a]) => {
    const needs = [
      a.wheelchair ? LEVEL_WORDS[a.wheelchair] : null,
      a.ownMobilityAid ? 'own mobility aid' : null,
      a.visionOrHearing ? 'vision or hearing' : null,
      a.medical ? 'medical equipment (needs clearance)' : null,
      a.infant ? 'bassinet' : null,
      a.notes.trim() ? `note: ${a.notes.trim()}` : null,
    ].filter(Boolean);
    if (needs.length) lines.push(`Assistance for ${who(Number(i))}: ${needs.join(', ')}`);
  });
  if (draft.priority) lines.push('Priority check-in and boarding: yes');
  if (draft.insurance) lines.push('Travel insurance: yes');
  if (draft.contactMobile.trim()) lines.push(`Tickets to: ${draft.contactEmail.trim()} · ${draft.contactMobile.trim()}`);
  lines.push(`Sample total shown in the app: ${rupees(tripTotals(draft).total)}`);
  return lines;
}

/**
 * THE LAST STEP, while booking flights is not connected: the whole trip, what it would come to at sample prices, and
 * one honest action, sending it to our team, who quote real fares by email. Nothing is booked and nothing is paid.
 */
export default function FlightSendScreen() {
  const draft = useTripDraft();
  const search = draft.search;
  if (!search || !draft.picks.every(Boolean) || draft.picks.length === 0) {
    return (
      <Screen header={{ title: 'Your trip', back: true, tone: 'light' }}>
        <NoTrip />
      </Screen>
    );
  }
  const legs = legsOf(search);
  const totals = tripTotals(draft);
  const lines: [string, number][] = [
    ['Fares', totals.fares],
    ['Taxes and airport fees', totals.taxes],
    ['Seats', totals.seats],
    ['Meals', totals.meals],
    ['Extra baggage', totals.baggage],
    ['Priority check-in and boarding', totals.priority],
    ['Travel insurance', totals.insurance],
  ];

  return (
    <Screen header={{ title: 'Your trip', subtitle: 'Send it to our team for real fares', back: true, tone: 'light' }} scroll keyboard>
      <View style={styles.notice}>
        <View style={styles.noticeIcon}>
          <Ionicons name="airplane" size={20} color={colors.navy900} />
        </View>
        <View style={styles.flex}>
          <Text variant="bodyStrong" color="white">
            Flight booking opens soon
          </Text>
          <Text variant="small" color="onDark2">
            The flights and prices here are samples. Send this trip and our team will confirm real fares, seats and extras with you by email. Nothing is booked or charged.
          </Text>
        </View>
      </View>

      <Card style={styles.card}>
        <Text variant="h3" color="ink" accessibilityRole="header">
          Flights
        </Text>
        {draft.picks.map((f, i) =>
          f ? (
            <View key={i} style={styles.flight}>
              <AirlineBadge airline={f.airline} />
              <View style={styles.flex}>
                <Text variant="bodyStrong" color="ink">
                  {legs[i]?.from} {f.dep} → {legs[i]?.to} {f.arr}
                </Text>
                <Text variant="caption" color="textSecondary">
                  {legs[i] ? formatShortDate(legs[i].date) : ''} · {f.airline.name} {f.number} · {f.stops ? `1 stop via ${f.via}` : 'Non-stop'}
                </Text>
              </View>
            </View>
          ) : null,
        )}
        <Text variant="small" color="textSecondary">
          {draft.passengers.map((p, i) => `${p.title ? `${p.title} ` : ''}${passengerName(p, i, draft.passengers)}`).join(' · ')}
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text variant="h3" color="ink" accessibilityRole="header">
          Sample price
        </Text>
        {lines
          .filter(([, v]) => v > 0)
          .map(([label, v]) => (
            <View key={label} style={styles.line}>
              <Text variant="body" color="ink2" style={styles.flex}>
                {label}
              </Text>
              <Text variant="bodyStrong" color="ink">
                {rupees(v)}
              </Text>
            </View>
          ))}
        <View style={[styles.line, styles.totalLine]}>
          <Text variant="bodyStrong" color="ink" style={styles.flex}>
            Total at sample prices
          </Text>
          <Text variant="h2" color="ink">
            {rupees(totals.total)}
          </Text>
        </View>
      </Card>

      <Text variant="h3" color="ink" accessibilityRole="header">
        Send this trip to our team
      </Text>
      <QuoteForm search={search} details={describePicks(draft)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  notice: { flexDirection: 'row', gap: spacing.s3, backgroundColor: colors.navy900, borderRadius: 18, padding: spacing.s4 },
  noticeIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  card: { gap: spacing.s3 },
  flight: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  totalLine: { paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  bold: { fontFamily: fontFamily.sansBold },
});
