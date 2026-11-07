import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EditorialHero, Screen } from '@/components';
import { FlightSearchForm } from '@/features/flights/FlightSearchForm';
import { FlightsUnavailable } from '@/features/flights/FlightsUnavailable';
import { airportByCode } from '@/features/flights/airports';
import { parseFlightSearch, partySummary, type FlightSearch } from '@/features/flights/flightForm';
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { colors, shadow, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';
import { SiteFooter } from '@/features/home/SiteFooter';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The destination photograph the site's Flights hero uses for an origin (its city's own photo, when it has one). */
const CITY_PHOTO: Record<string, string> = {
  Hyderabad: 'hyderabad',
  Delhi: 'delhi',
  Bengaluru: 'bengaluru',
  Kolkata: 'kolkata',
  Mumbai: 'mumbai',
  Goa: 'goa',
  Dubai: 'dubai',
};

/**
 * FLIGHTS. The website's flight search, with an honest ending.
 *
 * The hero is the site's ("Your journey / Departures from Hyderabad" and the search summary). The form is the
 * site's (trip type, airports, dates, passengers, cabin, special fare, and its validation). There is no live
 * flight supplier behind the app, so a search does not list fares and nothing here can be booked or paid: it
 * says so, and offers a quote from the team. The site's own "Sample schedule" is not shown as if it were live.
 * When a real supplier exists, its results join below the form, behind `useFlightCapability()`.
 */
export default function FlightsScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ search?: string }>();
  // A search carried from Home. A parameter that is not a well-formed search is ignored.
  const carried = useMemo(() => parseFlightSearch(asString(params.search)), [params.search]);
  const [searched, setSearched] = useState<FlightSearch | null>(carried);

  const from = searched?.trip === 'multi' ? searched.legs[0]?.from : searched?.from;
  const to = searched?.trip === 'multi' ? searched.legs[searched.legs.length - 1]?.to : searched?.to;
  const fromCity = from ? (airportByCode(from)?.city ?? from) : null;
  const toCity = to ? (airportByCode(to)?.city ?? to) : null;
  const when = searched ? (searched.trip === 'multi' ? searched.legs[0]?.date : searched.depart) : null;

  return (
    <Screen header={{ back: true }} scroll flush keyboard>
      <EditorialHero
        crumb="Flights"
        kicker={searched ? 'Your journey' : 'Flights'}
        title={searched && fromCity ? `Departures from ${fromCity}` : 'Where to next?'}
        pill="No live fares yet"
        photoUri={destinationPhotoUrl(CITY_PHOTO[fromCity ?? ''] ?? 'hyderabad', 'hero')}
        photoAlt={`${fromCity ?? 'A city'}, a photograph of the destination`}
        summary={
          searched
            ? {
                title: `${fromCity ?? '?'} → ${toCity ?? '?'}`,
                sub: [when ? formatShortDate(when) : null, partySummary(searched.party), searched.cabin].filter(Boolean).join(' | '),
                tone: 'paper',
              }
            : undefined
        }
      />
      <View style={[styles.content, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <View style={[styles.card, shadow.md]}>
          <FlightSearchForm initial={carried ?? undefined} onSearch={setSearched} />
        </View>
        {searched ? <FlightsUnavailable search={searched} /> : null}
      </View>
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  card: { backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 18 },
});
