import { Ionicons } from '@expo/vector-icons';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, Text } from '@/components';
import { durationLabel } from '@/features/flights/preview/sample';
import { sampleFlightBooking, type BookedSegment, type BookedTraveller } from '@/features/flights/preview/sampleBooking';
import { AirlineBadge, LegTabs, PassengerTabs, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';
import { formatLongDate } from '@/utils/dates';

/** A stand-in barcode: bars of varied width from the PNR, drawn with Views. Decorative; the PNR is printed under it. */
function Barcode({ seed }: { seed: string }) {
  const bars = Array.from({ length: 46 }, (_, i) => {
    const c = seed.charCodeAt(i % seed.length) + i * 7;
    return { w: (c % 3) + 1, gap: ((c >> 2) % 2) + 1 };
  });
  return (
    <View style={styles.barcode} accessible={false} importantForAccessibility="no-hide-descendants">
      {bars.map((b, i) => (
        <View key={i} style={{ width: b.w, marginRight: b.gap, height: 48, backgroundColor: colors.navy900 }} />
      ))}
    </View>
  );
}

function Field({ label, value, align = 'left' }: { label: string; value: string; align?: 'left' | 'right' | 'center' }) {
  return (
    <View style={[styles.field, align === 'right' && styles.right, align === 'center' && styles.center]}>
      <Text variant="caption" chrome color="textSecondary" style={styles.label}>
        {label}
      </Text>
      <Text variant="bodyStrong" color="ink" selectable>
        {value}
      </Text>
    </View>
  );
}

function Pass({ segment, traveller, leg }: { segment: BookedSegment; traveller: BookedTraveller; leg: number }) {
  const seat = traveller.seats[leg] && traveller.seats[leg] !== '—' ? traveller.seats[leg] : 'At check-in';
  return (
    <View style={styles.pass} accessible accessibilityLabel={`E-ticket for ${traveller.title} ${traveller.name}, ${segment.airline.name} ${segment.number}, ${segment.from} to ${segment.to}, ${formatLongDate(segment.date)}, departs ${segment.dep}, seat ${seat}, PNR ${segment.pnr}`}>
      <View style={styles.passHead}>
        <AirlineBadge airline={segment.airline} size={30} />
        <View style={styles.flex}>
          <Text variant="bodyStrong" color="white">
            {segment.airline.name}
          </Text>
          <Text variant="caption" color="onDark2">
            {segment.number} · {segment.fare}
          </Text>
        </View>
        <Text variant="caption" chrome color="goldLight" style={styles.kicker}>
          E-TICKET
        </Text>
      </View>

      <View style={styles.passBody}>
        <View style={styles.route}>
          <View>
            <Text variant="display" color="ink" style={styles.code}>
              {segment.from}
            </Text>
            <Text variant="caption" color="textSecondary">
              {segment.fromCity}
            </Text>
          </View>
          <View style={styles.mid}>
            <Ionicons name="airplane" size={20} color={colors.gold} />
            <Text variant="caption" color="textSecondary">
              {durationLabel(segment.minutes)}
            </Text>
          </View>
          <View style={styles.right}>
            <Text variant="display" color="ink" style={styles.code}>
              {segment.to}
            </Text>
            <Text variant="caption" color="textSecondary">
              {segment.toCity}
            </Text>
          </View>
        </View>

        <View style={styles.grid}>
          <Field label="PASSENGER" value={`${traveller.title} ${traveller.name}`} />
          <Field label="DATE" value={formatLongDate(segment.date)} align="right" />
        </View>
        <View style={styles.grid}>
          <Field label="DEPARTS" value={segment.dep} />
          <Field label="ARRIVES" value={segment.arr} align="center" />
          <Field label="SEAT" value={seat} align="right" />
        </View>
        <View style={styles.grid}>
          <Field label="GATE" value="Opens 3h before" />
          <Field label="BAGGAGE" value={`${traveller.checkinKg} kg + 7 kg`} align="right" />
        </View>
      </View>

      {/* The tear line, with the two half-circle notches of a paper ticket. */}
      <View style={styles.tear}>
        <View style={[styles.notch, styles.notchLeft]} />
        <View style={styles.perforation} />
        <View style={[styles.notch, styles.notchRight]} />
      </View>

      <View style={styles.passFoot}>
        <Barcode seed={`${segment.pnr}${traveller.name}`} />
        <Text variant="caption" color="textSecondary">
          PNR
        </Text>
        <Text variant="h2" color="ink" selectable style={styles.pnr}>
          {segment.pnr}
        </Text>
      </View>
    </View>
  );
}

/**
 * THE E-TICKET (preview). One pass per traveller per flight, in the shape people expect from an airline: route,
 * time, seat, PNR, a barcode. Below it, what to carry and when to reach the airport. Sample data.
 */
export default function FlightTicketScreen() {
  const [leg, setLeg] = useState(0);
  const [who, setWho] = useState(0);
  if (!__DEV__) return <Redirect href="/flights" />;
  const booking = sampleFlightBooking();
  const segment = booking.segments[leg];
  const traveller = booking.travellers[who];

  return (
    <Screen header={{ title: 'E-ticket', subtitle: booking.ref, back: true }} scroll>
      <SampleNotice compact />
      <LegTabs
        legs={booking.segments.map((s) => ({ from: s.from, to: s.to, date: s.date }))}
        current={leg}
        done={() => true}
        onChange={setLeg}
      />
      <PassengerTabs
        people={booking.travellers.map((t, i) => ({ index: i, name: t.name, status: `Seat ${t.seats[leg] && t.seats[leg] !== '—' ? t.seats[leg] : 'at check-in'}`, done: true }))}
        active={who}
        onChange={setWho}
      />
      <Pass segment={segment} traveller={traveller} leg={leg} />

      <View style={styles.tips}>
        {[
          ['time-outline', 'Reach the airport 2 hours before a domestic flight, 3 before an international one.'],
          ['id-card-outline', 'Carry a photo ID matching this name. Passport for international flights.'],
          ['phone-portrait-outline', 'Web check-in opens 48 hours before departure.'],
        ].map(([icon, line]) => (
          <View key={line} style={styles.tip}>
            <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={18} color={colors.goldInk} />
            <Text variant="small" color="ink2" style={styles.flex}>
              {line}
            </Text>
          </View>
        ))}
      </View>
      <Button title="Download PDF" variant="outline" icon="download-outline" disabled onPress={() => undefined} />
      <Text variant="caption" color="textSecondary" align="center">
        The PDF ticket arrives by email once flight booking is live.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  right: { alignItems: 'flex-end' },
  center: { alignItems: 'center' },
  kicker: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 1 },
  label: { fontFamily: fontFamily.sansBold, letterSpacing: 0.6, fontSize: 10 },
  pass: { borderRadius: 22, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.divider },
  passHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, backgroundColor: colors.navy900, padding: spacing.s4 },
  passBody: { padding: spacing.s4, gap: spacing.s4 },
  route: { flexDirection: 'row', alignItems: 'center' },
  code: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 1 },
  mid: { flex: 1, alignItems: 'center', gap: 2 },
  grid: { flexDirection: 'row', gap: spacing.s3 },
  field: { flex: 1, gap: 2 },
  tear: { flexDirection: 'row', alignItems: 'center', height: 24 },
  notch: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.bg },
  notchLeft: { marginLeft: -12 },
  notchRight: { marginRight: -12 },
  perforation: { flex: 1, borderTopWidth: 2, borderStyle: 'dashed', borderColor: colors.line, marginHorizontal: spacing.s2 },
  passFoot: { alignItems: 'center', padding: spacing.s4, paddingTop: spacing.s2, gap: 2 },
  barcode: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.s2 },
  pnr: { letterSpacing: 4 },
  tips: { gap: spacing.s3, backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.divider, padding: spacing.s4 },
  tip: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3 },
});
