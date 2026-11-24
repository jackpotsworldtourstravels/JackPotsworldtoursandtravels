import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { FieldDivider, SegmentedControl } from '@/components/ui';
import { TRIP_TYPES } from '@/features/discovery/packages';
import { spacing } from '@/theme';
import type { Destination, PackageQuery } from '@/types/discovery';

import { DestinationPicker } from './DestinationPicker';
import { StayFields } from './StayFields';
import { DEFAULT_PARTY, type Party } from './party';
import { defaultStay, stayProblem } from './stay';

/**
 * The hotel and holiday-package search forms. Each sits in the white card of its search screen (`/search/hotels`,
 * `/search/packages`) and hands a validated search to the results route. The flight form is `FlightSearchForm`.
 * Gaming Tour Packages are disabled, so there is no gaming search anywhere.
 */

const STAY_PROBLEMS = {
  invalid: 'Choose your check-in and check-out dates.',
  past: 'Check-in can’t be in the past.',
  order: 'Check-out must be after check-in.',
  too_long: 'Stays are limited to 30 nights.',
} as const;

export function HotelSearchForm({ initialDestination = null }: { initialDestination?: Destination | null }) {
  const router = useRouter();
  const [destination, setDestination] = useState<Destination | null>(initialDestination);
  const [stay, setStay] = useState(() => defaultStay());
  const [party, setParty] = useState<Party>(DEFAULT_PARTY);
  const [attempted, setAttempted] = useState(false);

  const problem = stayProblem(stay);

  const search = () => {
    setAttempted(true);
    if (problem) return;
    router.push({
      pathname: '/hotels',
      params: {
        ...(destination ? { destination: destination.id } : {}),
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        rooms: String(party.rooms),
        adults: String(party.adults),
        children: String(party.children),
      },
    });
  };

  return (
    <View>
      <DestinationPicker value={destination} onChange={setDestination} anyLabel="All destinations" appearance="card" />
      <FieldDivider inset={false} />
      <StayFields stay={stay} onStayChange={setStay} party={party} onPartyChange={setParty} appearance="card" />
      <View style={styles.foot}>
        {attempted && problem ? <Banner tone="error" message={STAY_PROBLEMS[problem]} /> : null}
        <Button title="Search hotels" caps onPress={search} />
      </View>
    </View>
  );
}

type TripValue = 'all' | NonNullable<PackageQuery['trip_type']>;

export function PackageSearchForm() {
  const router = useRouter();
  const [destination, setDestination] = useState<Destination | null>(null);
  const [tripType, setTripType] = useState<PackageQuery['trip_type']>(undefined);

  const search = () => {
    router.push({
      pathname: '/packages',
      params: {
        ...(destination ? { destination: destination.name } : {}),
        ...(tripType ? { tripType } : {}),
      },
    });
  };

  return (
    <View>
      <View style={styles.pad}>
        <SegmentedControl<TripValue>
          options={TRIP_TYPES.map((t) => ({ value: (t.value ?? 'all') as TripValue, label: t.label }))}
          value={(tripType ?? 'all') as TripValue}
          onChange={(v) => setTripType(v === 'all' ? undefined : (v as PackageQuery['trip_type']))}
          accessibilityLabel="Trip type"
        />
      </View>
      <FieldDivider inset={false} />
      <DestinationPicker value={destination} onChange={setDestination} anyLabel="Anywhere" appearance="card" />
      <View style={styles.foot}>
        <Button title="Search packages" caps onPress={search} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: spacing.s3 },
  foot: { padding: spacing.s3, paddingTop: spacing.s5, gap: spacing.s3 },
});
