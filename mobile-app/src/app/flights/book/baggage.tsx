import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { PriceTag, Screen, StickyFooter, Text } from '@/components';
import { passengerName, seated, tripDraft, useTripDraft } from '@/features/flights/preview/draft';
import { BAGGAGE_OPTIONS, rupees, tripTotals } from '@/features/flights/preview/extras';
import { NoTrip, PassengerTabs, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';

/** EXTRA BAGGAGE. What each ticket already includes, then extra check-in weight per traveller, for every flight. */
export default function FlightBaggageScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  const people = draft.passengers.map((p, i) => ({ p, i })).filter(({ p }) => seated(p));
  const [active, setActive] = useState(people[0]?.i ?? 0);
  const first = draft.picks.find(Boolean);
  if (!draft.search || people.length === 0 || !first) {
    return (
      <Screen header={{ title: 'Extra baggage', back: true, tone: 'light' }}>
        <NoTrip />
      </Screen>
    );
  }
  const legs = draft.picks.length || 1;
  const totals = tripTotals(draft);
  const extra = draft.baggage[active];
  const name = passengerName(draft.passengers[active], active, draft.passengers);
  const choose = (kg: number) =>
    tripDraft.set((s) => {
      const baggage = { ...s.baggage };
      if (baggage[active] === kg) delete baggage[active];
      else baggage[active] = kg;
      return { baggage };
    });

  return (
    <Screen
      header={{ title: 'Extra baggage', subtitle: legs > 1 ? `Applies to all ${legs} flights` : undefined, back: true, tone: 'light' }}
      scroll
      footer={
        <StickyFooter actionTitle="Done" onAction={() => router.back()}>
          <PriceTag amount={totals.baggage} note={extra ? `${name.split(' ')[0]}: +${extra} kg (${first.checkinKg + extra} kg in all)` : 'Nothing extra added'} size="md" />
        </StickyFooter>
      }
    >
      <SampleNotice compact />
      <PassengerTabs
        people={people.map(({ p, i }) => ({ index: i, name: passengerName(p, i, draft.passengers), status: draft.baggage[i] ? `+${draft.baggage[i]} kg added` : 'No extra', done: Boolean(draft.baggage[i]) }))}
        active={active}
        onChange={setActive}
      />
      <View style={styles.included}>
        <Text variant="caption" chrome color="goldLight" style={styles.kicker}>
          INCLUDED IN {name.split(' ')[0].toUpperCase()}’S TICKET
        </Text>
        <View style={styles.pair}>
          <View style={styles.box}>
            <Ionicons name="briefcase-outline" size={22} color={colors.goldLight} />
            <Text variant="h2" color="white">
              {first.checkinKg} kg
            </Text>
            <Text variant="caption" color="onDark2">
              Check-in · 1 bag
            </Text>
          </View>
          <View style={styles.box}>
            <Ionicons name="bag-handle-outline" size={22} color={colors.goldLight} />
            <Text variant="h2" color="white">
              {first.cabinKg} kg
            </Text>
            <Text variant="caption" color="onDark2">
              Cabin · 1 bag
            </Text>
          </View>
        </View>
      </View>
      <Text variant="h3" color="ink" accessibilityRole="header">
        Add check-in weight
      </Text>
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel={`Extra check-in weight for ${name}`}>
        {BAGGAGE_OPTIONS.map((o) => {
          const on = extra === o.kg;
          return (
            <Pressable
              key={o.kg}
              onPress={() => choose(o.kg)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`Plus ${o.kg} kilograms, ${rupees(o.price * legs)}`}
              style={[styles.option, on && styles.optionOn]}
            >
              {on ? (
                <View style={styles.tick}>
                  <Ionicons name="checkmark" size={12} color={colors.white} />
                </View>
              ) : null}
              <Text variant="h2" color="ink">
                +{o.kg} kg
              </Text>
              <Text variant="small" chrome color="textSecondary" style={styles.bold}>
                {rupees(o.price * legs)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.note}>
        <Ionicons name="information-circle-outline" size={16} color={colors.goldInk} />
        <Text variant="small" color="textSecondary" style={styles.flex}>
          Adding weight now usually costs less than paying at the airport. Real prices are set by the airline.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  included: { backgroundColor: colors.navy900, borderRadius: 18, padding: spacing.s4, gap: spacing.s3 },
  kicker: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.5 },
  pair: { flexDirection: 'row', gap: spacing.s3 },
  box: { flex: 1, backgroundColor: colors.navy800, borderRadius: 14, padding: spacing.s3, gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  option: { flexGrow: 1, flexBasis: '30%', minHeight: 84, borderRadius: 16, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', gap: 2 },
  optionOn: { borderWidth: 2, borderColor: colors.gold, backgroundColor: '#FFFCF4' },
  tick: { position: 'absolute', top: 8, right: 8, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  note: { flexDirection: 'row', gap: spacing.s2, alignItems: 'flex-start' },
});
