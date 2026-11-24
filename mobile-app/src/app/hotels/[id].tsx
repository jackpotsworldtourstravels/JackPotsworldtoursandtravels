import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Accordion, Button, Card, EmptyState, ErrorState, ImageCarousel, ListSkeleton, PriceTag, Screen, StickyFooter, Text } from '@/components';
import { DetailScroll } from '@/components/DetailScroll';
import { Stars, Tag } from '@/components/layout';
import { WishlistButton } from '@/features/account/components/WishlistButton';
import { IndicativeNotice } from '@/features/booking/components/Quote';
import { useHotelDetail } from '@/features/booking/hooks';
import { roomFits } from '@/features/booking/hotelRequest';
import { parseId } from '@/features/booking/refs';
import { ratingWord } from '@/features/discovery/cards';
import { resolveHotelPhoto } from '@/features/media/hotelPhoto';
import { StayFields } from '@/features/search/StayFields';
import { normaliseParty, partySummary, type Party } from '@/features/search/party';
import { defaultStay, stayFromParams, stayProblem, type StayDates } from '@/features/search/stay';
import { colors, fontFamily, radius, spacing } from '@/theme';
import type { RoomOption } from '@/types/booking';
import { nightsBetween } from '@/utils/dates';
import { formatMoney } from '@/utils/money';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const asCount = (v: string | string[] | undefined, fallback: number) => {
  const n = Number(asString(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

type IconName = keyof typeof Ionicons.glyphMap;

/** A line icon for an amenity the hotel lists; anything unrecognised gets a tick. */
function amenityIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (n.includes('wi-fi') || n.includes('wifi')) return 'wifi-outline';
  if (n.includes('pool')) return 'water-outline';
  if (n.includes('spa')) return 'sparkles-outline';
  if (n.includes('gym') || n.includes('fitness')) return 'barbell-outline';
  if (n.includes('breakfast') || n.includes('restaurant')) return 'restaurant-outline';
  if (n.includes('parking')) return 'car-outline';
  if (n.includes('shuttle') || n.includes('airport')) return 'bus-outline';
  if (n.includes('view')) return 'eye-outline';
  return 'checkmark-circle-outline';
}

/**
 * One hotel: photo, title block, sticky tabs (Overview · Rooms · Amenities · Policies) and a sticky price footer.
 *
 * Every price on this page is INDICATIVE, the catalogue's nightly rate, and says so. Choosing a room does not book
 * anything: it carries the room, dates and guests to the booking screen, where the server prices them and the
 * customer sees that figure before committing to anything.
 */
export default function HotelDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    checkIn?: string;
    checkOut?: string;
    rooms?: string;
    adults?: string;
    children?: string;
  }>();
  const id = parseId(params.id);
  const detail = useHotelDetail(id);
  const [jump, setJump] = useState<{ key: 'overview' | 'rooms' | 'amenities' | 'policies'; seq: number }>({ key: 'rooms', seq: 0 });

  // Route params are untrusted: a bad stay falls back to tomorrow-for-one-night.
  const [stay, setStay] = useState<StayDates>(() => stayFromParams({ checkIn: asString(params.checkIn), checkOut: asString(params.checkOut) }) ?? defaultStay());
  const [party, setParty] = useState<Party>(() =>
    normaliseParty({
      rooms: asCount(params.rooms, 1) || 1,
      adults: asCount(params.adults, 2) || 2,
      children: asCount(params.children, 0),
    }),
  );

  if (id === null) {
    return (
      <Screen header={{ back: true, title: 'Hotel' }}>
        <EmptyState icon="bed-outline" title="We couldn’t find that hotel" message="The link may be old or mistyped." actionLabel="See all hotels" onAction={() => router.replace('/hotels')} />
      </Screen>
    );
  }
  if (detail.isPending) {
    return (
      <Screen header={{ back: true, title: 'Hotel' }} scroll>
        <ListSkeleton count={2} photo={220} />
      </Screen>
    );
  }
  if (detail.isError) {
    const missing = isApiError(detail.error) && detail.error.kind === 'not_found';
    return (
      <Screen header={{ back: true, title: 'Hotel' }}>
        {missing ? (
          <EmptyState icon="bed-outline" title="We couldn’t find that hotel" message="It may no longer be listed." actionLabel="See all hotels" onAction={() => router.replace('/hotels')} />
        ) : (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isRefetching} />
        )}
      </Screen>
    );
  }

  const hotel = detail.data;
  // The website's rule, unchanged: never present another hotel's picture as this one.
  const photo = resolveHotelPhoto(
    {
      name: hotel.name,
      location: hotel.location,
      source: hotel.source,
      hotelbeds_code: hotel.hotelbeds_code,
      provider_images: hotel.provider_images,
    },
    { size: 'hero' },
  );
  const rating = hotel.guest_rating ? Number(hotel.guest_rating) : null;
  const problem = stayProblem(stay);
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const lowest = hotel.rooms.length > 0 ? hotel.rooms.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a)).price : null;

  const select = (room: RoomOption) =>
    router.push({
      pathname: '/book/hotel',
      params: {
        hotelId: String(id),
        roomId: String(room.id),
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        rooms: String(party.rooms),
        adults: String(party.adults),
        children: String(party.children),
      },
    });

  return (
    <Screen
      statusBar="light"
      footer={
        hotel.rooms.length > 0 ? (
          <StickyFooter actionTitle="Select room" caps onAction={() => setJump((j) => ({ key: 'rooms', seq: j.seq + 1 }))}>
            <PriceTag amount={lowest} lead="from" unit="per night" note="Indicative · + taxes" size="md" />
          </StickyFooter>
        ) : undefined
      }
    >
      <DetailScroll
        jumpRequest={jump}
        media={<ImageCarousel photos={[{ uri: photo.uri, alt: photo.alt, caption: photo.kind !== 'property' ? photo.note : undefined }]} height={260} />}
        actions={<WishlistButton type="hotel" id={id} appearance="heart" />}
        title={
          <>
            <View style={styles.row}>
              <Stars count={hotel.stars} />
              <Text variant="caption" color="textSecondary">
                {hotel.stars}-star hotel
              </Text>
            </View>
            <View style={styles.titleRow}>
              <Text variant="h1" color="ink" accessibilityRole="header" style={styles.flex}>
                {hotel.name}
              </Text>
              {rating ? (
                <View style={styles.rating}>
                  <View style={styles.score}>
                    <Ionicons name="star" size={12} color={colors.white} />
                    <Text variant="bodyStrong" color="white" chrome>
                      {rating.toFixed(1)}
                    </Text>
                  </View>
                  <Text variant="caption" color="textSecondary" chrome>
                    {ratingWord(rating)}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={styles.row}>
              <Ionicons name="location-outline" size={15} color={colors.textSecondary} />
              <Text variant="small" color="textSecondary" style={styles.flex}>
                {hotel.location}
                {hotel.distanceKm ? ` · ${Number(hotel.distanceKm)} km from the airport` : ''}
              </Text>
            </View>
          </>
        }
        sections={[
          {
            key: 'overview',
            label: 'Overview',
            content: (
              <>
                {hotel.description ? (
                  <Text variant="body" color="ink2">
                    {hotel.description}
                  </Text>
                ) : null}
                <Card style={styles.stay}>
                  <Text variant="h3" color="ink" accessibilityRole="header">
                    Your stay
                  </Text>
                  <StayFields stay={stay} onStayChange={setStay} party={party} onPartyChange={setParty} />
                  <Text variant="small" color="textSecondary" align="center">
                    {partySummary(party)}
                  </Text>
                </Card>
              </>
            ),
          },
          {
            key: 'rooms',
            label: 'Rooms',
            content: (
              <>
                <Text variant="h3" color="ink" accessibilityRole="header">
                  Choose a room
                </Text>
                <IndicativeNotice what="rate" />
                {hotel.rooms.length === 0 ? (
                  <Card>
                    <Text variant="bodyStrong" color="ink">
                      No rooms are listed for this hotel yet
                    </Text>
                    <Text variant="small" color="textSecondary">
                      Please check back soon, or contact support to book.
                    </Text>
                  </Card>
                ) : (
                  hotel.rooms.map((room) => {
                    const fits = roomFits(room.max_guests, party);
                    const available = party.rooms <= room.left;
                    const blocked = !fits
                      ? `Sleeps up to ${room.max_guests}. Add rooms or choose a larger one.`
                      : !available
                        ? `Only ${room.left} of this room type.`
                        : problem
                          ? 'Choose valid dates first.'
                          : null;
                    return (
                      <Card key={room.id} style={styles.room}>
                        <View style={styles.titleRow}>
                          <Text variant="h3" color="ink" style={styles.flex}>
                            {room.name}
                          </Text>
                          {room.meal_plan && !/room only/i.test(room.meal_plan) ? <Tag label={room.meal_plan} tone="gold" /> : null}
                        </View>
                        <Text variant="small" color="textSecondary">
                          {[room.size_label, room.bed_type, `up to ${room.max_guests} guests`].filter(Boolean).join(' · ')}
                        </Text>
                        {room.description ? (
                          <Text variant="small" color="ink2">
                            {room.description}
                          </Text>
                        ) : null}
                        <View style={styles.ticks}>
                          {[room.meal_plan, ...room.perks.filter((p) => p !== room.meal_plan)].filter(Boolean).map((p) => (
                            <View key={p} style={styles.tick}>
                              <Ionicons name="checkmark" size={15} color={colors.success} />
                              <Text variant="small" color="ink2" style={styles.flex}>
                                {p}
                              </Text>
                            </View>
                          ))}
                        </View>
                        {room.cancellation_policy ? (
                          <Text variant="caption" color="success">
                            {room.cancellation_policy}
                          </Text>
                        ) : null}
                        <View style={styles.priceRow}>
                          <View style={styles.flex}>
                            <Text variant="caption" color="textSecondary">
                              Indicative rate
                            </Text>
                            <Text variant="h2" color="ink" style={styles.amount}>
                              {formatMoney(room.price)}
                              <Text variant="caption" color="textSecondary">
                                {' '}
                                / night
                              </Text>
                            </Text>
                            <Text variant="caption" color={blocked ? 'warning' : 'textSecondary'}>
                              {blocked ?? `${nights} night${nights === 1 ? '' : 's'}, ${partySummary(party)} · ${room.left} left`}
                            </Text>
                          </View>
                          <Button
                            title="Select"
                            size="sm"
                            fullWidth={false}
                            disabled={blocked !== null}
                            onPress={() => select(room)}
                            accessibilityLabel="Select this room"
                            accessibilityHint="Goes to a price our server confirms for your dates"
                          />
                        </View>
                      </Card>
                    );
                  })
                )}
              </>
            ),
          },
          ...(hotel.amenities.length > 0
            ? [
                {
                  key: 'amenities' as const,
                  label: 'Amenities',
                  content: (
                    <>
                      <Text variant="h3" color="ink" accessibilityRole="header">
                        Amenities
                      </Text>
                      <Card style={styles.grid}>
                        {hotel.amenities.map((a) => (
                          <View key={a} style={styles.amenity}>
                            <Ionicons name={amenityIcon(a)} size={20} color={colors.link} />
                            <Text variant="small" color="ink" style={styles.flex}>
                              {a}
                            </Text>
                          </View>
                        ))}
                      </Card>
                    </>
                  ),
                },
              ]
            : []),
          {
            key: 'policies',
            label: 'Policies',
            content: (
              <>
                <Text variant="h3" color="ink" accessibilityRole="header">
                  Policies
                </Text>
                <Card style={styles.policies}>
                  <Accordion title="Cancellation policy" initiallyOpen last>
                    <Text variant="body" color="ink2">
                      {hotel.cancellation_policy || 'The cancellation terms for your room are shown on the booking screen before you pay.'}
                    </Text>
                  </Accordion>
                </Card>
              </>
            ),
          },
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3 },
  rating: { alignItems: 'flex-end', gap: 2 },
  score: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 26, borderRadius: 8, backgroundColor: colors.primary },
  stay: { gap: spacing.s3 },
  room: { gap: spacing.s2 },
  ticks: { gap: 4 },
  tick: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.s3, marginTop: spacing.s1, paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  amount: { fontFamily: fontFamily.sansExtraBold },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.s3 },
  amenity: { width: '50%', flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingRight: spacing.s2 },
  policies: { paddingVertical: 0, borderRadius: radius.md },
});
