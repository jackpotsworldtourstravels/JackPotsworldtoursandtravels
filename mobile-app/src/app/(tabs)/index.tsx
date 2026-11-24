import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, Skeleton, Text } from '@/components';
import { SectionHeader } from '@/components/layout';
import { useUnreadCount } from '@/features/account/hooks';
import { bookingTitle, bookingWhen } from '@/features/booking/components/status';
import { groupBookings } from '@/features/booking/groups';
import { useMyBookings } from '@/features/booking/hooks';
import { DestinationCard, HotelCard, PackageCard } from '@/features/discovery/cards';
import { discoveryKeys, useCoupons, useDestinations, useHotels, usePackages } from '@/features/discovery/hooks';
import { fromListItem, photoForListItem, sortHotels } from '@/features/discovery/hotels';
import { FlightSearchForm } from '@/features/flights/FlightSearchForm';
import { SideMenu } from '@/features/navigation/SideMenu';
import { OFFER_PRODUCT, VoucherCard, type OfferProduct } from '@/features/offers/VoucherCard';
import { HotelSearchForm, PackageSearchForm } from '@/features/search/SearchCard';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, radius, spacing } from '@/theme';

const DEST_WIDTH = 132;
const CARD_WIDTH = 252;
const RAIL_SIZE = 8;

type Service = 'flights' | 'hotels' | 'holidays';
const SERVICES: { value: Service; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'flights', label: 'Flights', icon: 'airplane-outline' },
  { value: 'hotels', label: 'Hotels', icon: 'bed-outline' },
  { value: 'holidays', label: 'Holidays', icon: 'map-outline' },
];

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * HOME. The navy band: ≡ menu at the left, notifications and the profile at the right, then a greeting. A white card
 * overlaps the band with the search itself (Flights · Hotels · Holidays), so the first thing a customer can do is
 * search. Below: the trip that needs them next (unpaid first), offers, then destinations, featured stays and
 * packages from the real catalogue. Each section loads and fails on its own.
 */
export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { status, customer } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [service, setService] = useState<Service>('hotels');

  const destinations = useDestinations();
  const hotels = useHotels();
  const packages = usePackages({});
  const unread = useUnreadCount();
  const bookings = useMyBookings();
  const hotelOffers = useCoupons('hotel');
  const flightOffers = useCoupons('flight');
  const packageOffers = useCoupons('package');

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: discoveryKeys.all });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  const isCustomer = status === 'customer' && customer;
  const first = isCustomer ? customer.full_name.trim().split(/\s+/)[0] : null;
  const initials = isCustomer
    ? customer.full_name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase())
        .join('')
    : null;
  const side = { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right };

  // The trip that needs the customer next: one waiting for payment first, otherwise the next upcoming one.
  const sections = bookings.data ? groupBookings(bookings.data) : [];
  const next = sections.find((s) => s.group === 'awaiting')?.rows[0] ?? sections.find((s) => s.group === 'upcoming')?.rows[0] ?? null;
  const nextNeedsPayment = next ? sections.find((s) => s.group === 'awaiting')?.rows[0] === next : false;

  const offers: { coupon: NonNullable<typeof hotelOffers.data>[number]; product: OfferProduct }[] = [
    ...(hotelOffers.data ?? []).slice(0, 2).map((coupon) => ({ coupon, product: 'hotel' as const })),
    ...(flightOffers.data ?? []).slice(0, 1).map((coupon) => ({ coupon, product: 'flight' as const })),
    ...(packageOffers.data ?? []).slice(0, 2).map((coupon) => ({ coupon, product: 'package' as const })),
  ];

  // The same mapping and photo rule as the hotel results: a city photo is labelled, never passed off as the hotel.
  const allRows = (hotels.data ?? []).map((h) => ({ model: fromListItem(h), photo: photoForListItem(h) }));
  const rowById = new Map(allRows.map((r) => [r.model.id, r]));
  // Featured means best-rated: a hotel with no guest rating yet (an internal test listing among them) is not featured.
  const hotelRows = sortHotels(
    allRows.map((r) => r.model).filter((m) => m.rating !== null),
    'recommended',
  )
    .slice(0, RAIL_SIZE)
    .map((m) => rowById.get(m.id) as (typeof allRows)[number]);
  // Gaming Tour Packages stay disabled: nothing but holiday packages reaches Home.
  const packageRows = (packages.data ?? []).filter((p) => p.category !== 'gaming').slice(0, RAIL_SIZE);

  return (
    <Screen scroll flush bottomInset={false} statusBar="light" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.white} />}>
      <View style={[styles.band, side, { paddingTop: insets.top + spacing.s3 }]}>
        <View style={styles.topRow}>
          <Pressable onPress={() => setMenuOpen(true)} accessibilityRole="button" accessibilityLabel="Open menu" style={({ pressed }) => [styles.menuBtn, pressed && styles.dim]}>
            <Ionicons name="menu" size={24} color={colors.white} />
          </Pressable>
          <View style={styles.topRight}>
            <Pressable
              onPress={() => router.push('/notifications')}
              accessibilityRole="button"
              accessibilityLabel={unread.data ? `Notifications, ${unread.data} unread` : 'Notifications'}
              style={({ pressed }) => [styles.round, pressed && styles.dim]}
            >
              <Ionicons name="notifications-outline" size={21} color={colors.white} />
              {unread.data ? <View style={styles.unreadDot} /> : null}
            </Pressable>
            <Pressable onPress={() => router.push('/profile')} accessibilityRole="button" accessibilityLabel="Your profile" style={({ pressed }) => [styles.avatar, pressed && styles.dim]}>
              {initials ? (
                <Text variant="bodyStrong" chrome color="goldLight">
                  {initials}
                </Text>
              ) : (
                <Ionicons name="person-outline" size={20} color={colors.goldLight} />
              )}
            </Pressable>
          </View>
        </View>
        <View style={styles.greeting}>
          <Text variant="hero" color="white" accessibilityRole="header" numberOfLines={1} style={styles.hello}>
            {first ? `${greeting()}, ${first}` : 'Welcome'}
          </Text>
          <Text variant="body" color="onDark2">
            Where would you like to go next?
          </Text>
        </View>
      </View>

      <View style={[styles.overlap, side]}>
        <View style={styles.card}>
          <View style={styles.tabs} accessibilityRole="tablist">
            {SERVICES.map((s) => {
              const on = service === s.value;
              return (
                <Pressable
                  key={s.value}
                  onPress={() => setService(s.value)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  style={[styles.tab, on && styles.tabOn]}
                >
                  <Ionicons name={s.icon} size={18} color={on ? colors.primary : colors.textSecondary} />
                  <Text variant="small" chrome color={on ? 'ink' : 'textSecondary'} style={on ? styles.tabTextOn : styles.tabText}>
                    {s.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {service === 'hotels' ? (
            <HotelSearchForm />
          ) : service === 'holidays' ? (
            <PackageSearchForm />
          ) : (
            <View style={styles.flightForm}>
              <FlightSearchForm onSearch={(search) => router.push({ pathname: '/flights', params: { search: JSON.stringify(search) } })} />
            </View>
          )}
        </View>

        {next ? (
          <Pressable
            onPress={() => router.push({ pathname: '/booking/[ref]', params: { ref: next.booking.booking_ref } })}
            accessibilityRole="button"
            accessibilityLabel={`${bookingTitle(next.booking)}, ${bookingWhen(next.booking)}, ${nextNeedsPayment ? 'pay now' : 'upcoming'}`}
            style={({ pressed }) => [styles.trip, nextNeedsPayment && styles.tripDue, pressed && styles.dim]}
          >
            <View style={styles.tripIcon}>
              <Ionicons name="ticket-outline" size={22} color={colors.goldInk} />
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong" color="ink" numberOfLines={1}>
                {bookingTitle(next.booking)}
              </Text>
              <Text variant="small" color="textSecondary" numberOfLines={1}>
                {bookingWhen(next.booking)}
              </Text>
            </View>
            <View style={[styles.pill, nextNeedsPayment ? styles.pillDue : styles.pillUp]}>
              <Text variant="caption" chrome style={nextNeedsPayment ? styles.pillDueText : styles.pillUpText}>
                {nextNeedsPayment ? 'Pay now' : 'Upcoming'}
              </Text>
            </View>
          </Pressable>
        ) : null}
      </View>

      {offers.length > 0 ? (
        <View style={styles.rail}>
          <View style={side}>
            <SectionHeader title="Offers for you" actionLabel="See all" onAction={() => router.push('/offers')} />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.railContent, side]}>
            {offers.map(({ coupon, product }) => (
              <VoucherCard key={`${product}-${coupon.code}`} coupon={coupon} product={product} compact onUse={() => router.push(OFFER_PRODUCT[product].search)} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      <Rail
        title="Popular destinations"
        onViewAll={() => router.push('/explore')}
        query={destinations}
        skeletonWidth={DEST_WIDTH}
        skeletonHeight={172}
        data={(destinations.data ?? []).slice(0, RAIL_SIZE)}
        keyOf={(d) => d.id}
        render={(d) => <DestinationCard destination={d} width={DEST_WIDTH} onPress={() => router.push({ pathname: '/destination/[id]', params: { id: d.id } })} />}
        side={side}
      />

      <Rail
        title="Featured stays"
        onViewAll={() => router.push('/hotels')}
        query={hotels}
        skeletonWidth={CARD_WIDTH}
        skeletonHeight={226}
        data={hotelRows}
        keyOf={(r) => r.model.id}
        render={(r) => <HotelCard hotel={r.model} photo={r.photo} width={CARD_WIDTH} compact onPress={() => router.push({ pathname: '/hotels/[id]', params: { id: r.model.id } })} />}
        side={side}
      />

      <Rail
        title="Holiday packages"
        onViewAll={() => router.push('/packages')}
        query={packages}
        skeletonWidth={CARD_WIDTH}
        skeletonHeight={232}
        data={packageRows}
        keyOf={(p) => String(p.id)}
        render={(p) => <PackageCard pkg={p} width={CARD_WIDTH} compact onPress={() => router.push({ pathname: '/packages/[id]', params: { id: String(p.id) } })} />}
        side={side}
      />
      <View style={styles.end} />

      <SideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
    </Screen>
  );
}

/** A titled horizontal rail with "See all", a skeleton while it loads and a small retry if it fails. */
function Rail<T>({
  title,
  onViewAll,
  query,
  data,
  keyOf,
  render,
  skeletonWidth,
  skeletonHeight,
  side,
}: {
  title: string;
  onViewAll: () => void;
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  data: T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  skeletonWidth: number;
  skeletonHeight: number;
  side: { paddingLeft: number; paddingRight: number };
}) {
  if (!query.isPending && !query.isError && data.length === 0) return null;
  return (
    <View style={styles.rail}>
      <View style={side}>
        <SectionHeader title={title} actionLabel="See all" onAction={onViewAll} />
      </View>
      {query.isPending ? (
        <View style={[styles.skRow, side]}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={skeletonWidth} height={skeletonHeight} radius={radius.lg} />
          ))}
        </View>
      ) : query.isError ? (
        <View style={[styles.railError, side]}>
          <Text variant="small" color="textSecondary" style={styles.flex}>
            Couldn’t load {title.toLowerCase()}.
          </Text>
          <Button title="Retry" size="sm" variant="outline" fullWidth={false} onPress={() => void query.refetch()} />
        </View>
      ) : (
        <FlatList
          horizontal
          data={data}
          keyExtractor={keyOf}
          renderItem={({ item }) => <>{render(item)}</>}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.railContent, side]}
          // The card shadow needs room to show under the rail.
          style={styles.railList}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  dim: { opacity: 0.7 },
  band: { backgroundColor: colors.navy900, paddingBottom: 92, gap: spacing.s5 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  menuBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.navy700, alignItems: 'center', justifyContent: 'center' },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.navy700, alignItems: 'center', justifyContent: 'center' },
  unreadDot: { position: 'absolute', top: 10, right: 11, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold, borderWidth: 2, borderColor: colors.navy700 },
  avatar: { width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  greeting: { gap: 4, paddingHorizontal: spacing.s1 },
  hello: { fontSize: 25, lineHeight: 31, letterSpacing: -0.3 },
  overlap: { marginTop: -76, gap: spacing.s3 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    overflow: 'hidden',
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 6,
  },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider },
  tab: { flex: 1, height: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.gold },
  tabText: { fontFamily: fontFamily.sansSemiBold, fontSize: 14 },
  tabTextOn: { fontFamily: fontFamily.sansExtraBold, fontSize: 14 },
  flightForm: { padding: spacing.s3 },
  trip: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: spacing.s3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  tripDue: { borderColor: '#F1D9A6' },
  tripIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: '#FDF6E7', alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6 },
  pillDue: { backgroundColor: '#FEF0E0' },
  pillUp: { backgroundColor: colors.successSoft },
  pillDueText: { color: '#9A4A06', fontFamily: fontFamily.sansExtraBold },
  pillUpText: { color: colors.success, fontFamily: fontFamily.sansExtraBold },
  rail: { marginTop: spacing.s6, gap: spacing.s2 },
  railList: { overflow: 'visible' },
  railContent: { gap: spacing.s3, paddingBottom: spacing.s2, paddingTop: spacing.s1 },
  skRow: { flexDirection: 'row', gap: spacing.s3, overflow: 'hidden' },
  railError: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  end: { height: spacing.s8 },
});
