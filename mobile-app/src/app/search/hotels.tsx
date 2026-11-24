import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { Chip } from '@/components/layout';
import { useDestinations, useHotels } from '@/features/discovery/hooks';
import { HotelSearchForm } from '@/features/search/SearchCard';
import { SearchLanding } from '@/features/search/SearchLanding';
import { spacing } from '@/theme';

/** "Banjara Hills, Hyderabad" -> "Hyderabad": the city a listed hotel is in. */
function hotelCity(location: string): string {
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * HOTEL SEARCH. Destination, dates (one range calendar, with the nights) and rooms & guests, then Search Hotels.
 * Under the form: the cities the catalogue really has hotels in, with how many, as one-tap searches.
 */
export default function HotelSearchScreen() {
  const router = useRouter();
  const hotels = useHotels();
  const destinations = useDestinations();

  const counts = new Map<string, number>();
  for (const h of hotels.data ?? []) {
    const city = hotelCity(h.location ?? '');
    if (city) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  const cities = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <SearchLanding
      title="Hotels"
      below={
        cities.length > 0 ? (
          <>
            <Text variant="label" color="textSecondary">
              Cities with hotels
            </Text>
            <View style={styles.chips}>
              {cities.map(([city, n]) => {
                const dest = (destinations.data ?? []).find((d) => d.name.toLowerCase() === city.toLowerCase());
                return (
                  <Chip
                    key={city}
                    label={`${city} · ${n}`}
                    icon="location-outline"
                    onPress={() => router.push({ pathname: '/hotels', params: dest ? { destination: dest.id } : {} })}
                  />
                );
              })}
            </View>
          </>
        ) : null
      }
    >
      <HotelSearchForm />
    </SearchLanding>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
});
