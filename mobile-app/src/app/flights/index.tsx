import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components';
import { FlightSearchForm } from '@/features/flights/FlightSearchForm';
import { FlightsUnavailable } from '@/features/flights/FlightsUnavailable';
import { airportByCode } from '@/features/flights/airports';
import { parseFlightSearch, partySummary, type FlightSearch } from '@/features/flights/flightForm';
import { SearchLanding } from '@/features/search/SearchLanding';
import { colors, radius, spacing } from '@/theme';
import { formatShortDate } from '@/utils/dates';

/** The sample-flight previews: development builds only, and never under test, where the page is checked as customers see it. */
const SHOW_PREVIEWS = __DEV__ && process.env.NODE_ENV !== 'test';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * FLIGHTS. The flight search (the website's rules: trip type, airports, dates, travellers and class, special fare),
 * with an honest ending. There is no live flight supplier behind the app, so a search does not list fares and
 * nothing can be booked or paid: under the form it says so, reads the search back, and offers a quote from the
 * team. When a real supplier exists, its results replace that block, behind `useFlightCapability()`.
 */
export default function FlightsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ search?: string }>();
  // A search carried from elsewhere in the app. A parameter that is not a well-formed search is ignored.
  const carried = useMemo(() => parseFlightSearch(asString(params.search)), [params.search]);
  const [searched, setSearched] = useState<FlightSearch | null>(carried);

  const from = searched?.trip === 'multi' ? searched.legs[0]?.from : searched?.from;
  const to = searched?.trip === 'multi' ? searched.legs[searched.legs.length - 1]?.to : searched?.to;
  const when = searched ? (searched.trip === 'multi' ? searched.legs[0]?.date : searched.depart) : null;

  return (
    <SearchLanding
      title="Flights"
      below={
        searched ? (
          <>
            {/* The results header: what was searched, in one line, as a results list would open. */}
            <View style={styles.summary} accessible accessibilityLabel={`Results for ${from ?? ''} to ${to ?? ''}`}>
              <Text variant="h3" color="white">
                {`${airportByCode(from)?.code ?? from ?? '?'} → ${airportByCode(to)?.code ?? to ?? '?'}`}
              </Text>
              <Text variant="small" color="onDark2">
                {[when ? formatShortDate(when) : null, partySummary(searched.party), searched.cabin].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <FlightsUnavailable search={searched} />
            {/* Development builds only: the booking screens built ahead of a flight supplier, on sample flights. */}
            {SHOW_PREVIEWS ? (
              <View style={styles.preview}>
                <Text variant="caption" color="onDark2">
                  Development build · sample data
                </Text>
                <Button
                  title="Preview the new flight booking"
                  variant="secondary"
                  icon="airplane-outline"
                  onPress={() => router.push({ pathname: '/flights/book/results', params: { search: JSON.stringify(searched) } })}
                />
                <Button title="Preview a booked flight" variant="outline" icon="ticket-outline" onPress={() => router.push('/flights/booked/trip')} />
              </View>
            ) : null}
          </>
        ) : null
      }
    >
      <FlightSearchForm initial={carried ?? undefined} onSearch={setSearched} />
    </SearchLanding>
  );
}

const styles = StyleSheet.create({
  preview: { gap: spacing.s2, padding: spacing.s3, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.gold },
  summary: { backgroundColor: colors.navy900, borderRadius: radius.md, paddingVertical: spacing.s3, paddingHorizontal: spacing.s4, gap: 2 },
});
