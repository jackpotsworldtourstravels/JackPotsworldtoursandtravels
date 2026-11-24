import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { PriceTag, Screen, StepIndicator, StickyFooter, Text } from '@/components';
import { passengerName, seated, tripDraft, useTripDraft } from '@/features/flights/preview/draft';
import { rupees, SEAT_ROWS, seatPrice, tripTotals } from '@/features/flights/preview/extras';
import { FLIGHT_STEPS } from '@/features/flights/preview/flow';
import { legsOf } from '@/features/flights/preview/sample';
import { NoTrip, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';

const LEFT = ['A', 'B', 'C'];
const RIGHT = ['D', 'E', 'F'];
const SEAT = 34;

/** Which seats other people already have on this flight: invented, but the same every time for the same flight. */
function takenSeats(key: string): Set<string> {
  let h = 7;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const taken = new Set<string>();
  for (let row = SEAT_ROWS.first; row <= SEAT_ROWS.last; row += 1) {
    for (const l of [...LEFT, ...RIGHT]) {
      h = (h * 1103515245 + 12345) >>> 0;
      if ((h >>> 16) % 100 < 42) taken.add(`${row}${l}`);
    }
  }
  return taken;
}

/**
 * CHOOSE YOUR SEATS. One flight at a time (tabs when the trip has more than one); tap a traveller, then a seat. Exit
 * rows have extra legroom for a fee, the front rows are quicker off; the rest are free. Seats are optional: skip, and
 * the airline assigns them at check-in. Sample cabin and prices until a flight supplier is connected.
 */
export default function FlightSeatsScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  const [leg, setLeg] = useState(0);
  const people = draft.passengers.map((p, i) => ({ p, i })).filter(({ p }) => seated(p));
  const [active, setActive] = useState(people[0]?.i ?? 0);

  const search = draft.search;
  const legs = search ? legsOf(search) : [];
  const flight = draft.picks[leg];
  const taken = useMemo(() => takenSeats(flight?.id ?? `leg-${leg}`), [flight?.id, leg]);

  if (!search || !flight) {
    return (
      <Screen header={{ title: 'Choose your seats', back: true }}>
        <NoTrip />
      </Screen>
    );
  }

  const mine = draft.seats[leg] ?? {};
  const owner = (seat: string) => Object.entries(mine).find(([, s]) => s === seat)?.[0];
  const totals = tripTotals(draft);
  const chosen = Object.values(draft.seats).reduce((n, byPax) => n + Object.keys(byPax).length, 0);

  const choose = (seat: string) => {
    const holder = owner(seat);
    if (holder !== undefined && Number(holder) !== active) return;
    tripDraft.set((s) => {
      const forLeg = { ...(s.seats[leg] ?? {}) };
      if (forLeg[active] === seat) delete forLeg[active];
      else forLeg[active] = seat;
      return { seats: { ...s.seats, [leg]: forLeg } };
    });
    const next = people.find(({ i }) => i !== active && !mine[i]);
    if (next && mine[active] !== seat) setActive(next.i);
  };

  const initialsOf = (i: number) => {
    const p = draft.passengers[i];
    const name = passengerName(p, i, draft.passengers);
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('');
  };

  const seatView = (row: number, letter: string) => {
    const id = `${row}${letter}`;
    const holder = owner(id);
    const isMine = holder !== undefined;
    const isTaken = taken.has(id) && !isMine;
    const price = seatPrice(id);
    const label = `Seat ${id}, ${isMine ? `chosen for ${passengerName(draft.passengers[Number(holder)], Number(holder), draft.passengers)}` : isTaken ? 'taken' : price ? `${rupees(price)}` : 'free'}`;
    return (
      <Pressable
        key={id}
        disabled={isTaken}
        onPress={() => choose(id)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: isTaken, selected: isMine }}
        style={[styles.seat, isMine ? styles.seatMine : isTaken ? styles.seatTaken : price >= 350 ? styles.seatExtra : price ? styles.seatFront : styles.seatFree]}
      >
        {isMine ? (
          <Text variant="caption" chrome color="white" style={styles.seatText}>
            {initialsOf(Number(holder))}
          </Text>
        ) : isTaken ? (
          <Ionicons name="close" size={12} color={colors.textDisabled} />
        ) : null}
      </Pressable>
    );
  };

  const rows = Array.from({ length: SEAT_ROWS.last - SEAT_ROWS.first + 1 }, (_, k) => SEAT_ROWS.first + k);

  return (
    <Screen
      header={{ title: 'Choose your seats', subtitle: `${flight.airline.name} ${flight.number} · ${legs[leg]?.from} → ${legs[leg]?.to}`, back: true }}
      scroll
      footer={
        <StickyFooter actionTitle="Continue" onAction={() => router.push('/flights/book/extras')}>
          <PriceTag amount={totals.seats} note={chosen ? `${chosen} seat${chosen === 1 ? '' : 's'} chosen` : 'Optional · or the airline assigns them'} size="md" />
        </StickyFooter>
      }
    >
      <StepIndicator steps={FLIGHT_STEPS} current={2} />
      <SampleNotice compact />

      {legs.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.legRow}>
          {legs.map((l, i) => (
            <Pressable key={i} onPress={() => setLeg(i)} accessibilityRole="tab" accessibilityState={{ selected: leg === i }} style={[styles.legChip, leg === i && styles.legChipOn]}>
              <Text variant="small" chrome color={leg === i ? 'white' : 'ink2'} style={styles.bold}>
                Trip {i + 1} · {l.from} → {l.to}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.people} accessibilityRole="tablist" accessibilityLabel="Choosing a seat for">
        {people.map(({ p, i }) => {
          const on = active === i;
          const seat = mine[i];
          return (
            <Pressable
              key={i}
              onPress={() => setActive(i)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[styles.person, on && styles.personOn]}
            >
              <View style={[styles.avatar, on && styles.avatarOn]}>
                <Text variant="caption" chrome color={on ? 'white' : 'navy900'} style={styles.bold}>
                  {initialsOf(i)}
                </Text>
              </View>
              <View style={styles.flex}>
                <Text variant="small" chrome color="ink" numberOfLines={1} style={styles.bold}>
                  {passengerName(p, i, draft.passengers)}
                </Text>
                <Text variant="caption" color={seat ? 'success' : 'textSecondary'}>
                  {seat ? `Seat ${seat}` : 'No seat yet'}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.legend}>
        {[
          { s: styles.seatFree, t: 'Free' },
          { s: styles.seatFront, t: 'Front ₹250' },
          { s: styles.seatExtra, t: 'Legroom ₹350' },
          { s: styles.seatMine, t: 'Yours' },
          { s: styles.seatTaken, t: 'Taken' },
        ].map((k) => (
          <View key={k.t} style={styles.key}>
            <View style={[styles.keySwatch, k.s]} />
            <Text variant="caption" color="ink2">
              {k.t}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.cabin}>
        <View style={styles.letters} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {LEFT.map((l) => (
            <Text key={l} variant="caption" chrome color="textSecondary" align="center" style={styles.letter}>
              {l}
            </Text>
          ))}
          <View style={styles.aisle} />
          {RIGHT.map((l) => (
            <Text key={l} variant="caption" chrome color="textSecondary" align="center" style={styles.letter}>
              {l}
            </Text>
          ))}
        </View>
        {rows.map((row) => {
          const exit = (SEAT_ROWS.exit as readonly number[]).includes(row);
          return (
            <View key={row} style={[styles.row, row === SEAT_ROWS.exit[0] && styles.exitGap]}>
              {LEFT.map((l) => seatView(row, l))}
              <View style={styles.aisle}>
                <Text variant="caption" chrome color={exit ? 'goldInk' : 'textDisabled'} style={styles.bold}>
                  {row}
                </Text>
              </View>
              {RIGHT.map((l) => seatView(row, l))}
            </View>
          );
        })}
        <Text variant="caption" color="textSecondary" align="center" style={styles.exitNote}>
          Rows {SEAT_ROWS.exit.join(' and ')} are exit rows: extra legroom, for travellers able to help in an emergency.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  legRow: { gap: spacing.s2 },
  legChip: { minHeight: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.s3, justifyContent: 'center' },
  legChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  person: { flexGrow: 1, flexBasis: '45%', flexDirection: 'row', alignItems: 'center', gap: spacing.s2, minHeight: 54, borderRadius: 14, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface, paddingHorizontal: spacing.s3 },
  personOn: { borderWidth: 2, borderColor: colors.primary },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  avatarOn: { backgroundColor: colors.primary },
  legend: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: spacing.s3, rowGap: spacing.s1 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  keySwatch: { width: 14, height: 14, borderRadius: 4 },
  cabin: {
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 140,
    borderTopRightRadius: 140,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    paddingTop: 64,
    paddingBottom: spacing.s5,
    paddingHorizontal: spacing.s4,
    gap: 8,
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 3,
  },
  letters: { flexDirection: 'row', gap: 6 },
  letter: { width: SEAT },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  exitGap: { marginTop: 10 },
  aisle: { width: 28, alignItems: 'center' },
  seat: { width: SEAT, height: SEAT, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  seatFree: { borderWidth: 1.5, borderColor: '#B9C3D1', backgroundColor: colors.surface },
  seatFront: { borderWidth: 1.5, borderColor: '#8FA8C8', backgroundColor: '#EEF3FA' },
  seatExtra: { borderWidth: 1.5, borderColor: colors.gold, backgroundColor: '#FBF3DF' },
  seatMine: { backgroundColor: colors.primary },
  seatTaken: { backgroundColor: '#D9DEE6' },
  seatText: { fontFamily: fontFamily.sansExtraBold, fontSize: 11 },
  exitNote: { maxWidth: 260, alignSelf: 'center', marginTop: spacing.s2 },
});
