import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { PriceTag, Screen, StickyFooter, Text } from '@/components';
import { Chip } from '@/components/layout';
import { passengerName, seated, tripDraft, useTripDraft } from '@/features/flights/preview/draft';
import { MEALS, rupees, tripTotals, type Diet, type Meal } from '@/features/flights/preview/extras';
import { NoTrip, PassengerTabs, SampleNotice } from '@/features/flights/preview/ui';
import { colors, fontFamily, spacing } from '@/theme';

type Filter = 'all' | Diet | 'drinks';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'veg', label: 'Veg' },
  { value: 'nonveg', label: 'Non-veg' },
  { value: 'jain', label: 'Jain' },
  { value: 'drinks', label: 'Drinks' },
];

/** India's food marks: a green square with a dot for vegetarian, a brown one with a triangle otherwise. Shape and colour both differ. */
function DietMark({ diet }: { diet: Diet }) {
  const veg = diet !== 'nonveg';
  const c = veg ? colors.success : '#A3341C';
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={veg ? 'Vegetarian' : 'Non-vegetarian'} style={[styles.mark, { borderColor: c }]}>
      {veg ? <View style={[styles.markDot, { backgroundColor: c }]} /> : <View style={[styles.markTri, { borderBottomColor: c }]} />}
    </View>
  );
}

/** MEALS. One meal per traveller, served on every flight of the trip. Sample menu and prices. */
export default function FlightMealsScreen() {
  const router = useRouter();
  const draft = useTripDraft();
  const people = draft.passengers.map((p, i) => ({ p, i })).filter(({ p }) => seated(p));
  const [active, setActive] = useState(people[0]?.i ?? 0);
  const [filter, setFilter] = useState<Filter>('all');
  if (!draft.search || people.length === 0) {
    return (
      <Screen header={{ title: 'Meals', back: true, tone: 'light' }}>
        <NoTrip />
      </Screen>
    );
  }
  const legs = draft.picks.length || 1;
  const totals = tripTotals(draft);
  const chosen = draft.meals[active];
  const shown = MEALS.filter((m) => (filter === 'all' ? true : filter === 'drinks' ? m.drink : m.diet === filter && !m.drink));
  const toggle = (meal: Meal) =>
    tripDraft.set((s) => {
      const meals = { ...s.meals };
      if (meals[active] === meal.id) delete meals[active];
      else meals[active] = meal.id;
      return { meals };
    });

  return (
    <Screen
      header={{ title: 'Meals', subtitle: legs > 1 ? `Served on all ${legs} flights` : 'Served on board', back: true, tone: 'light' }}
      scroll
      footer={
        <StickyFooter actionTitle="Done" onAction={() => router.back()}>
          <PriceTag amount={totals.meals} note={`${Object.keys(draft.meals).length} meal${Object.keys(draft.meals).length === 1 ? '' : 's'}${legs > 1 ? ` × ${legs} flights` : ''}`} size="md" />
        </StickyFooter>
      }
    >
      <SampleNotice compact />
      <PassengerTabs
        people={people.map(({ p, i }) => ({ index: i, name: passengerName(p, i, draft.passengers), status: draft.meals[i] ? '1 meal added' : 'No meal yet', done: Boolean(draft.meals[i]) }))}
        active={active}
        onChange={setActive}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} selected={filter === f.value} onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>
      {shown.map((meal) => {
        const on = chosen === meal.id;
        return (
          <View key={meal.id} style={[styles.card, on && styles.cardOn]}>
            <View style={styles.tile}>
              <Ionicons name={meal.drink ? 'cafe-outline' : 'restaurant-outline'} size={24} color={colors.goldInk} />
            </View>
            <View style={styles.flex}>
              <View style={styles.tagRow}>
                <DietMark diet={meal.diet} />
                <Text variant="caption" chrome color="textSecondary" style={styles.bold}>
                  {meal.drink ? 'Drink' : meal.diet === 'jain' ? 'Jain' : meal.diet === 'veg' ? 'Vegetarian' : 'Non-vegetarian'}
                </Text>
              </View>
              <Text variant="bodyStrong" color="ink">
                {meal.name}
              </Text>
              <Text variant="small" color="textSecondary">
                {meal.description}
              </Text>
              <View style={styles.foot}>
                <Text variant="h3" color="ink">
                  {rupees(meal.price)}
                </Text>
                <Pressable
                  onPress={() => toggle(meal)}
                  accessibilityRole="button"
                  accessibilityLabel={`${on ? 'Remove' : 'Add'} ${meal.name}`}
                  style={({ pressed }) => [styles.btn, on ? styles.btnOn : styles.btnOff, pressed && styles.pressed]}
                >
                  <Text variant="small" chrome color={on ? 'white' : 'link'} style={styles.bold}>
                    {on ? 'Added ✓' : 'Add'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  bold: { fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.8 },
  filters: { gap: spacing.s2 },
  card: { flexDirection: 'row', gap: spacing.s3, backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.divider, padding: spacing.s3 },
  cardOn: { borderWidth: 2, borderColor: colors.gold, backgroundColor: '#FFFCF4' },
  tile: { width: 60, height: 60, borderRadius: 14, backgroundColor: '#FBF3DF', alignItems: 'center', justifyContent: 'center' },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  mark: { width: 14, height: 14, borderWidth: 1.5, borderRadius: 3, alignItems: 'center', justifyContent: 'center' },
  markDot: { width: 6, height: 6, borderRadius: 3 },
  markTri: { width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderBottomWidth: 7, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.s2 },
  btn: { minHeight: 36, minWidth: 82, borderRadius: 12, paddingHorizontal: spacing.s3, alignItems: 'center', justifyContent: 'center' },
  btnOn: { backgroundColor: colors.primary },
  btnOff: { borderWidth: 1.5, borderColor: colors.primary },
});
