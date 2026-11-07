import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Banner } from '@/components/Banner';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { FieldButton, FieldRow, OptionalDatePickerField, Stepper } from '@/components/pickers';
import { colors, radius, spacing } from '@/theme';
import { addDays, todayISO, type ISODate } from '@/utils/dates';

import { airportLabel, airportSubLabel, matchAirports } from './airports';
import {
  CABINS,
  FARES,
  MAX_LEGS,
  MIN_LEGS,
  TRIP_TYPES,
  clampParty,
  defaultFlightSearch,
  flightProblem,
  maxChildren,
  maxInfants,
  partySummary,
  PAX,
  type FlightParty,
  type FlightSearch,
  type Leg,
  type TripType,
} from './flightForm';

/** An airport, chosen from the website's list with a search box. */
function AirportField({ label, value, onChange }: { label: string; value: string | null; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => matchAirports(query), [query]);
  const sub = value ? airportSubLabel(value) : '';
  return (
    <>
      <FieldButton
        label={label}
        value={value ? airportLabel(value) : undefined}
        sub={sub || undefined}
        placeholder="City or airport"
        icon="location-outline"
        onPress={() => setOpen(true)}
      />
      <BottomSheet visible={open} title={label} onClose={() => setOpen(false)}>
        <TextField label="City or airport" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} placeholder="Type a city or code" />
        {query.trim() === '' ? (
          <Text variant="caption" color="muted">
            Popular airports
          </Text>
        ) : null}
        <FlatList
          data={results}
          keyExtractor={(a) => a.code}
          keyboardShouldPersistTaps="handled"
          style={styles.results}
          ListEmptyComponent={
            <Text variant="body" color="muted">
              No airport matches “{query.trim()}”.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                onChange(item.code);
                setQuery('');
                setOpen(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${item.city} (${item.code})`}
              style={({ pressed }) => [styles.airportRow, pressed && styles.pressed]}
            >
              <Ionicons name="airplane-outline" size={20} color={colors.goldInk} />
              <View style={styles.airportText}>
                <Text variant="bodyStrong" color="navy800">
                  {item.city} ({item.code})
                </Text>
                <Text variant="small" color="muted">
                  {item.airportName ? `${item.airportName}, ${item.country}` : item.country}
                </Text>
              </View>
            </Pressable>
          )}
        />
      </BottomSheet>
    </>
  );
}

/** The website's cabin dropdown, as a tile that opens a short list. */
function CabinField({ value, onChange }: { value: (typeof CABINS)[number]; onChange: (cabin: (typeof CABINS)[number]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FieldButton label="Cabin" value={value} icon="ticket-outline" onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title="Cabin" onClose={() => setOpen(false)}>
        {CABINS.map((c) => (
          <Pressable
            key={c}
            onPress={() => {
              onChange(c);
              setOpen(false);
            }}
            accessibilityRole="button"
            accessibilityLabel={c}
            accessibilityState={{ selected: c === value }}
            style={({ pressed }) => [styles.airportRow, pressed && styles.pressed]}
          >
            <Text variant="bodyStrong" color="navy800" style={styles.airportText}>
              {c}
            </Text>
            {c === value ? <Ionicons name="checkmark" size={20} color={colors.goldInk} /> : null}
          </Pressable>
        ))}
      </BottomSheet>
    </>
  );
}

/** A special-fare pill: the website's pale-gold wash and gold edge when chosen. */
function FarePill({ label, icon, selected, onPress }: { label: string; icon: keyof typeof Ionicons.glyphMap; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={[styles.fare, selected && styles.fareSelected]}
    >
      <Ionicons name={icon} size={16} color={selected ? colors.goldInk : colors.ink2} />
      <Text variant="bodyStrong" color="navy800" chrome numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const FARE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  regular: 'radio-button-on-outline',
  student: 'school-outline',
  armed: 'shield-checkmark-outline',
  senior: 'accessibility-outline',
  marine: 'boat-outline',
};

function PassengersField({ value, onChange }: { value: FlightParty; onChange: (party: FlightParty) => void }) {
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<FlightParty>) => onChange(clampParty({ ...value, ...patch }));
  const seatsLeft = PAX.MAX_SEATED - value.adults - value.children;
  return (
    <>
      <FieldButton label="Passengers" value={partySummary(value)} icon="person-outline" onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title="Passengers" onClose={() => setOpen(false)}>
        <Stepper label="Adults" value={value.adults} min={1} max={PAX.MAX_ADULTS} hint="12 years and over" onChange={(adults) => update({ adults })} />
        <Stepper
          label="Children"
          value={value.children}
          min={0}
          max={maxChildren(value.adults)}
          hint={`2 to 11 years. ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`}
          onChange={(children) => update({ children })}
        />
        <Stepper label="Infants" value={value.infants} min={0} max={maxInfants(value.adults)} hint="Under 2 years, on a lap" onChange={(infants) => update({ infants })} />
        <Button title="Done" onPress={() => setOpen(false)} />
      </BottomSheet>
    </>
  );
}

/**
 * The website's flight search card (booking-card.js, Flights tab): trip type, From and To
 * airports with a swap, dates, passengers, cabin and "Select a special fare", and "Search Flights".
 * A multi-city trip is two to five flights. The card refuses what the site refuses, in the
 * site's words. It searches nothing here: `onSearch` hands over a valid search.
 */
export function FlightSearchForm({ initial, onSearch }: { initial?: FlightSearch; onSearch: (search: FlightSearch) => void }) {
  const today = todayISO();
  const max = addDays(today, 365);
  const [search, setSearch] = useState<FlightSearch>(() => initial ?? defaultFlightSearch(today));
  const [attempted, setAttempted] = useState(false);
  const problem = flightProblem(search);
  const patch = (p: Partial<FlightSearch>) => setSearch((s) => ({ ...s, ...p }));

  const setLeg = (i: number, change: Partial<Leg>) =>
    setSearch((s) => ({ ...s, legs: s.legs.map((l, idx) => (idx === i ? { ...l, ...change } : l)) }));

  const go = () => {
    setAttempted(true);
    if (!problem) onSearch(search);
  };

  const fare = FARES.find((f) => f.id === search.fare) ?? FARES[0];

  return (
    <View style={styles.form}>
      <View style={styles.trips} accessibilityRole="tablist">
        {TRIP_TYPES.map((t) => {
          const selected = search.trip === t.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => patch({ trip: t.id as TripType })}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={t.label}
              style={[styles.trip, selected && styles.tripSelected]}
            >
              <Text variant="bodyStrong" color={selected ? 'white' : 'navy800'} chrome align="center" style={styles.tripLabel}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {search.trip === 'multi' ? (
        <View style={styles.form}>
          {search.legs.map((leg, i) => (
            <View key={i} style={styles.leg}>
              <View style={styles.legHead}>
                <Text variant="eyebrow" color="goldInk">
                  Flight {i + 1}
                </Text>
                {search.legs.length > MIN_LEGS ? (
                  <Pressable
                    onPress={() => setSearch((s) => ({ ...s, legs: s.legs.filter((_, idx) => idx !== i) }))}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove flight ${i + 1}`}
                    hitSlop={8}
                  >
                    <Text variant="bodyStrong" color="goldInk">
                      Remove
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <AirportField label="From Airport" value={leg.from} onChange={(from) => setLeg(i, { from })} />
              <AirportField label="To Airport" value={leg.to} onChange={(to) => setLeg(i, { to })} />
              <OptionalDatePickerField
                label="Departure"
                value={leg.date}
                min={i > 0 && search.legs[i - 1].date ? (search.legs[i - 1].date as ISODate) : today}
                max={max}
                onChange={(date) => setLeg(i, { date })}
              />
            </View>
          ))}
          <Button
            title="Add another flight"
            variant="outline"
            icon="add"
            disabled={search.legs.length >= MAX_LEGS}
            onPress={() =>
              setSearch((s) => {
                const last = s.legs[s.legs.length - 1];
                return { ...s, legs: [...s.legs, { from: last.to, to: null, date: last.date }] };
              })
            }
          />
          {search.legs.length >= MAX_LEGS ? (
            <Text variant="small" color="muted">
              Up to {MAX_LEGS} flights in one itinerary.
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.form}>
          <AirportField label="From Airport" value={search.from} onChange={(from) => patch({ from })} />
          <Pressable
            onPress={() => patch({ from: search.to, to: search.from })}
            accessibilityRole="button"
            accessibilityLabel="Swap origin and destination"
            style={styles.swap}
          >
            <Ionicons name="swap-vertical" size={20} color={colors.goldInk} />
          </Pressable>
          <AirportField label="To Airport" value={search.to} onChange={(to) => patch({ to })} />
          <FieldRow>
            <OptionalDatePickerField
              label="Departure"
              value={search.depart}
              min={today}
              max={max}
              onChange={(depart) => patch({ depart, ret: search.ret && search.ret < depart ? depart : search.ret })}
            />
            {search.trip === 'round' ? (
              <OptionalDatePickerField label="Return" value={search.ret} min={search.depart ?? today} max={max} onChange={(ret) => patch({ ret })} />
            ) : (
              <View />
            )}
          </FieldRow>
        </View>
      )}

      <FieldRow>
        <PassengersField value={search.party} onChange={(party) => patch({ party })} />
        <CabinField value={search.cabin} onChange={(cabin) => patch({ cabin })} />
      </FieldRow>

      {attempted && problem ? <Banner tone="error" message={problem} /> : null}
      <Button title="Search Flights" icon="airplane" onPress={go} />

      <View style={styles.group}>
        <Text variant="caption" color="muted" chrome style={styles.fareHead}>
          SELECT A SPECIAL FARE
        </Text>
        <View style={styles.chips}>
          {FARES.map((f) => (
            <FarePill key={f.id} label={f.label} icon={FARE_ICONS[f.id] ?? 'pricetag-outline'} selected={search.fare === f.id} onPress={() => patch({ fare: f.id })} />
          ))}
        </View>
        <Text variant="small" color="muted" style={styles.groupLabel}>
          {fare.note}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.s3 },
  trips: { flexDirection: 'row', gap: spacing.s1, padding: spacing.s1, borderRadius: radius.pill, backgroundColor: colors.segFill, borderWidth: 1, borderColor: 'rgba(21,27,39,0.06)' },
  trip: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, paddingHorizontal: spacing.s2 },
  tripSelected: { backgroundColor: colors.navy800 },
  tripLabel: { fontSize: 13, lineHeight: 17 },
  swap: {
    alignSelf: 'center',
    width: 44,
    height: 44,
    marginVertical: -spacing.s2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.goldInk,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  leg: { gap: spacing.s3, padding: spacing.s3, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  legHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  group: { gap: spacing.s1 },
  // The website's options wrap onto the next line; none is left off the edge of a phone.
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  fareHead: { marginLeft: spacing.s1, letterSpacing: 1.05, fontWeight: '600', fontSize: 10.5 },
  fare: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, minHeight: 44, paddingHorizontal: spacing.s3, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.fieldLine, backgroundColor: colors.white },
  fareSelected: { borderColor: colors.goldRing, backgroundColor: '#FBF3E0' },
  groupLabel: { marginLeft: spacing.s1 },
  results: { maxHeight: 320 },
  airportRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  airportText: { flex: 1 },
  pressed: { opacity: 0.85 },
});
