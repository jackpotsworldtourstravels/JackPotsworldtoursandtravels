import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Banner } from '@/components/Banner';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { SearchListScreen } from '@/components/SearchListScreen';
import { Text } from '@/components/Text';
import { Chip } from '@/components/layout';
import { OptionalDatePickerField, Stepper } from '@/components/pickers';
import { FieldCard, FieldDivider, FieldSplit, LocationPairField, SegmentedControl } from '@/components/ui';
import { colors, fontFamily, radius, spacing } from '@/theme';
import { addDays, todayISO, type ISODate } from '@/utils/dates';

import { airportByCode, airportLabel, matchAirports } from './airports';
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

/** An airport, chosen from the website's list on a full-screen search page. */
function AirportField({ label, shortLabel, value, onChange }: { label: string; shortLabel: string; value: string | null; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => matchAirports(query), [query]);
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const airport = airportByCode(value);
  const sub = airport ? [airport.city, airport.airportName ?? airport.country].filter(Boolean).join(' · ') : undefined;
  return (
    <>
      <FieldCard
        label={shortLabel}
        value={value ?? undefined}
        sub={sub}
        placeholder="Select"
        size="lg"
        accessibilityLabel={`${label}: ${value ? airportLabel(value) : 'not set'}`}
        onPress={() => setOpen(true)}
      />
      <SearchListScreen
        visible={open}
        title={shortLabel}
        query={query}
        onQueryChange={setQuery}
        placeholder="City or airport"
        onClose={close}
        empty={
          <Text variant="body" color="textSecondary" align="center">
            No airport matches “{query.trim()}”.
          </Text>
        }
        sections={[
          {
            title: query.trim() === '' ? 'Popular airports' : 'Airports',
            data: results.map((a) => ({
              key: a.code,
              code: a.code,
              title: a.city,
              subtitle: a.airportName ?? undefined,
              trailing: a.country,
              selected: a.code === value,
              accessibilityLabel: `${a.city} (${a.code})`,
              onPress: () => {
                onChange(a.code);
                close();
              },
            })),
          },
        ]}
      />
    </>
  );
}

/** A special-fare chip. */
function FarePill({ label, icon, selected, onPress }: { label: string; icon: keyof typeof Ionicons.glyphMap; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.fare, selected && styles.fareSelected, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={15} color={selected ? colors.white : colors.ink2} />
      <Text variant="small" color={selected ? 'white' : 'ink2'} chrome numberOfLines={1} style={styles.fareLabel}>
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

/** Travellers and class in one bottom sheet: steppers within the website's passenger rules, then class chips. */
function TravellersField({
  party,
  cabin,
  onParty,
  onCabin,
}: {
  party: FlightParty;
  cabin: (typeof CABINS)[number];
  onParty: (party: FlightParty) => void;
  onCabin: (cabin: (typeof CABINS)[number]) => void;
}) {
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<FlightParty>) => onParty(clampParty({ ...party, ...patch }));
  const seatsLeft = PAX.MAX_SEATED - party.adults - party.children;
  return (
    <>
      <FieldCard label="Travellers & Class" value={partySummary(party)} sub={cabin} accessibilityLabel={`Travellers & Class: ${partySummary(party)}, ${cabin}`} onPress={() => setOpen(true)} />
      <BottomSheet visible={open} title="Travellers & Class" onClose={() => setOpen(false)} footer={<Button title="Done" caps onPress={() => setOpen(false)} />}>
        <Stepper label="Adults" value={party.adults} min={1} max={PAX.MAX_ADULTS} hint="12 years and over" onChange={(adults) => update({ adults })} />
        <Stepper
          label="Children"
          value={party.children}
          min={0}
          max={maxChildren(party.adults)}
          hint={`2 to 11 years. ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`}
          onChange={(children) => update({ children })}
        />
        <Stepper label="Infants" value={party.infants} min={0} max={maxInfants(party.adults)} hint="Under 2 years, on a lap" onChange={(infants) => update({ infants })} />
        <Text variant="label" color="textSecondary" style={styles.sheetLabel}>
          Travel class
        </Text>
        <View style={styles.chips}>
          {CABINS.map((c) => (
            <Chip key={c} label={c} selected={c === cabin} onPress={() => onCabin(c)} />
          ))}
        </View>
      </BottomSheet>
    </>
  );
}

/**
 * The flight search form (the website's rules, a native layout): trip type, From and To as big airport codes with
 * a swap button, dates, travellers and class, and "Search Flights". A multi-city trip is two to five flights. The
 * form refuses what the site refuses, in the site's words. It searches nothing here: `onSearch` hands over a valid
 * search.
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
      <View style={styles.pad}>
        <SegmentedControl options={TRIP_TYPES.map((t) => ({ value: t.id as TripType, label: t.label }))} value={search.trip} onChange={(trip) => patch({ trip })} accessibilityLabel="Trip type" />
      </View>

      {search.trip === 'multi' ? (
        <View style={styles.legs}>
          {search.legs.map((leg, i) => (
            <View key={i} style={styles.leg}>
              <View style={styles.legHead}>
                <Text variant="label" color="textSecondary">
                  Flight {i + 1}
                </Text>
                {search.legs.length > MIN_LEGS ? (
                  <Pressable
                    onPress={() => setSearch((s) => ({ ...s, legs: s.legs.filter((_, idx) => idx !== i) }))}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove flight ${i + 1}`}
                    hitSlop={8}
                  >
                    <Text variant="bodyStrong" color="link" chrome>
                      Remove
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <FieldSplit>
                <AirportField label="From Airport" shortLabel="From" value={leg.from} onChange={(from) => setLeg(i, { from })} />
                <AirportField label="To Airport" shortLabel="To" value={leg.to} onChange={(to) => setLeg(i, { to })} />
              </FieldSplit>
              <FieldDivider />
              <OptionalDatePickerField
                label="Departure"
                value={leg.date}
                min={i > 0 && search.legs[i - 1].date ? (search.legs[i - 1].date as ISODate) : today}
                max={max}
                onChange={(date) => setLeg(i, { date })}
              />
            </View>
          ))}
          <View style={styles.pad}>
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
              <Text variant="small" color="textSecondary">
                Up to {MAX_LEGS} flights in one itinerary.
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        <View>
          <FieldDivider inset={false} />
          <LocationPairField
            from={<AirportField label="From Airport" shortLabel="From" value={search.from} onChange={(from) => patch({ from })} />}
            to={<AirportField label="To Airport" shortLabel="To" value={search.to} onChange={(to) => patch({ to })} />}
            onSwap={() => patch({ from: search.to, to: search.from })}
          />
          <FieldDivider inset={false} />
          <FieldSplit>
            <OptionalDatePickerField
              label="Departure"
              value={search.depart}
              min={today}
              max={max}
              appearance="card"
              onChange={(depart) => patch({ depart, ret: search.ret && search.ret < depart ? depart : search.ret })}
            />
            {search.trip === 'round' ? (
              <OptionalDatePickerField label="Return" value={search.ret} min={search.depart ?? today} max={max} appearance="card" onChange={(ret) => patch({ ret })} />
            ) : (
              <FieldCard label="Return" placeholder="+ Add" sub="Save on round trips" accessibilityLabel="Add a return flight" onPress={() => patch({ trip: 'round' })} />
            )}
          </FieldSplit>
        </View>
      )}

      <FieldDivider inset={false} />
      <TravellersField party={search.party} cabin={search.cabin} onParty={(party) => patch({ party })} onCabin={(cabin) => patch({ cabin })} />

      <View style={[styles.pad, styles.foot]}>
        {attempted && problem ? <Banner tone="error" message={problem} /> : null}
        <Button title="Search Flights" caps onPress={go} />
        <Text variant="label" color="textSecondary" style={styles.fareHead}>
          Special fares
        </Text>
        <View style={styles.chips}>
          {FARES.map((f) => (
            <FarePill key={f.id} label={f.label} icon={FARE_ICONS[f.id] ?? 'pricetag-outline'} selected={search.fare === f.id} onPress={() => patch({ fare: f.id })} />
          ))}
        </View>
        <Text variant="caption" color="textSecondary">
          {fare.note}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { paddingBottom: spacing.s1 },
  pad: { padding: spacing.s3, gap: spacing.s2 },
  foot: { paddingTop: spacing.s3, gap: spacing.s3 },
  legs: { gap: spacing.s2 },
  leg: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  legHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.s4, paddingTop: spacing.s3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  fareHead: { marginTop: spacing.s1 },
  fare: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  fareSelected: { backgroundColor: colors.navy900, borderColor: colors.navy900 },
  fareLabel: { fontFamily: fontFamily.sansSemiBold },
  sheetLabel: { marginTop: spacing.s3 },
  pressed: { opacity: 0.8 },
});
