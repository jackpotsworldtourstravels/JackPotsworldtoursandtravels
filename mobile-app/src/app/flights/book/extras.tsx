import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Card, PriceTag, Screen, StepIndicator, StickyFooter, Text } from '@/components';
import { passengerName, seated, tripDraft, useTripDraft } from '@/features/flights/preview/draft';
import { INSURANCE_PRICE, MEALS, PRIORITY_PRICE, rupees, tripTotals } from '@/features/flights/preview/extras';
import { FLIGHT_STEPS } from '@/features/flights/preview/flow';
import { NoTrip, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';

type IconName = keyof typeof Ionicons.glyphMap;

function Row({ icon, title, detail, price, added, href, tint }: { icon: IconName; title: string; detail: string; price: number; added: boolean; href: Href; tint?: boolean }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}${added ? `, added, ${rupees(price)}` : ', not added'}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.icon, tint && styles.iconGold]}>
        <Ionicons name={icon} size={22} color={tint ? colors.goldInk : colors.primary} />
      </View>
      <View style={styles.flex}>
        <Text variant="bodyStrong" color="ink">
          {title}
        </Text>
        <Text variant="small" color="textSecondary" numberOfLines={2}>
          {detail}
        </Text>
      </View>
      {added ? (
        <View style={styles.right}>
          {price ? (
            <Text variant="bodyStrong" color="ink">
              {rupees(price)}
            </Text>
          ) : null}
          <View style={styles.added}>
            <Text variant="caption" chrome color="success" style={styles.bold}>
              Added
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.addBtn}>
          <Text variant="small" chrome color="link" style={styles.bold}>
            Add
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * ADD EXTRAS. Everything a traveller can add to the flights, in one place, each with what is added and what it
 * costs; then two switches for the whole trip. A running total at the bottom. Sample prices until a flight supplier
 * is connected: real ones come from each airline.
 */
export default function FlightExtrasScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  if (!draft.search || draft.passengers.length === 0) {
    return (
      <Screen header={{ title: 'Add extras', back: true }}>
        <NoTrip />
      </Screen>
    );
  }
  const totals = tripTotals(draft);
  const name = (i: number) => passengerName(draft.passengers[i], i, draft.passengers).split(' ')[0];
  const seatList = Object.values(draft.seats).flatMap((byPax) => Object.values(byPax));
  const meals = Object.entries(draft.meals).map(([i, id]) => `${name(Number(i))}: ${MEALS.find((m) => m.id === id)?.name ?? ''}`);
  const bags = Object.entries(draft.baggage).map(([i, kg]) => `${name(Number(i))}: +${kg} kg`);
  const help = Object.entries(draft.assistance).filter(([, a]) => a.wheelchair || a.ownMobilityAid || a.visionOrHearing || a.medical || a.infant || a.notes.trim());
  const travellers = draft.passengers.filter(seated).length;

  return (
    <Screen
      header={{ title: 'Add extras', subtitle: `${draft.picks.length} flight${draft.picks.length === 1 ? '' : 's'} · ${draft.passengers.length} traveller${draft.passengers.length === 1 ? '' : 's'}`, back: true }}
      scroll
      footer={
        <StickyFooter actionTitle="Continue" onAction={() => router.push('/flights/book/send')}>
          <PriceTag amount={totals.extras} note={`Extras for ${draft.passengers.length} traveller${draft.passengers.length === 1 ? '' : 's'}`} size="md" />
        </StickyFooter>
      }
    >
      <StepIndicator steps={FLIGHT_STEPS} current={3} />
      <SampleNotice compact />
      <Card style={styles.list}>
        <Row icon="grid-outline" title="Seats" detail={seatList.length ? seatList.join(', ') : 'Choose where you sit'} price={totals.seats} added={seatList.length > 0} href="/flights/book/seats" />
        <Row icon="restaurant-outline" title="Meals" detail={meals.length ? meals.join(' · ') : 'Pre-book a hot meal on board'} price={totals.meals} added={meals.length > 0} href="/flights/book/meals" />
        <Row icon="briefcase-outline" title="Extra baggage" detail={bags.length ? bags.join(' · ') : 'Add check-in weight for less than at the airport'} price={totals.baggage} added={bags.length > 0} href="/flights/book/baggage" />
        <Row
          icon="accessibility-outline"
          title="Special assistance"
          detail={help.length ? help.map(([i]) => name(Number(i))).join(', ') + ' · request saved' : 'Wheelchair, medical needs, travelling with an infant · free'}
          price={0}
          added={help.length > 0}
          href="/flights/book/assistance"
          tint
        />
      </Card>

      <Text variant="h3" color="ink" accessibilityRole="header" style={styles.more}>
        More for your trip
      </Text>
      <Card style={styles.list}>
        <View style={styles.toggle}>
          <View style={styles.flex}>
            <Text variant="bodyStrong" color="ink">
              Priority check-in and boarding
            </Text>
            <Text variant="small" color="textSecondary">
              Skip the queues · {rupees(PRIORITY_PRICE)} per traveller
              {draft.priority ? ` · ${rupees(PRIORITY_PRICE * travellers)}` : ''}
            </Text>
          </View>
          <Switch
            value={draft.priority}
            onValueChange={(v) => tripDraft.set({ priority: v })}
            trackColor={{ true: colors.primary, false: colors.line }}
            thumbColor={colors.white}
            accessibilityLabel="Priority check-in and boarding"
          />
        </View>
        <View style={[styles.toggle, styles.noRule]}>
          <View style={styles.flex}>
            <Text variant="bodyStrong" color="ink">
              Travel insurance
            </Text>
            <Text variant="small" color="textSecondary">
              Delays, missed flights, lost bags · {rupees(INSURANCE_PRICE)} per traveller
            </Text>
          </View>
          <Switch
            value={draft.insurance}
            onValueChange={(v) => tripDraft.set({ insurance: v })}
            trackColor={{ true: colors.primary, false: colors.line }}
            thumbColor={colors.white}
            accessibilityLabel="Travel insurance"
          />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.8 },
  list: { paddingVertical: spacing.s1, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingVertical: spacing.s3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  icon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  iconGold: { backgroundColor: '#FBF3DF' },
  right: { alignItems: 'flex-end', gap: 3 },
  added: { backgroundColor: colors.successSoft, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  addBtn: { minHeight: 36, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary, paddingHorizontal: spacing.s3, justifyContent: 'center' },
  more: { marginTop: spacing.s2 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingVertical: spacing.s3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  noRule: { borderBottomWidth: 0 },
});
