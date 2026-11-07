import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiError } from '@/api/errors';
import { Button, Card, DetailHero, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { SectionHeader, Tag } from '@/components/layout';
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
import { spacing } from '@/theme';
import type { RoomOption } from '@/types/booking';
import { nightsBetween } from '@/utils/dates';
import { formatMoney } from '@/utils/money';
import { SiteFooter } from '@/features/home/SiteFooter';

const asString = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const asCount = (v: string | string[] | undefined, fallback: number) => {
  const n = Number(asString(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * One hotel: photo, facts, amenities, policy and its rooms.
 *
 * Every price on this page is INDICATIVE, the catalogue's nightly rate, and says
 * so. Choosing a room does not book anything: it carries the room, dates and
 * guests to the booking screen, where the server prices them and the customer
 * sees that figure before committing to anything.
 */
export default function HotelDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
      <Screen header={{ back: true }}>
        <EmptyState
          icon="bed-outline"
          title="We couldn’t find that hotel"
          message="The link may be old or mistyped."
          actionLabel="See all hotels"
          onAction={() => router.replace('/hotels')}
        />
      </Screen>
    );
  }
  if (detail.isPending) {
    return (
      <Screen header={{ back: true }}>
        <LoadingState message="Loading hotel…" />
      </Screen>
    );
  }
  if (detail.isError) {
    const missing = isApiError(detail.error) && detail.error.kind === 'not_found';
    return (
      <Screen header={{ back: true }}>
        {missing ? (
          <EmptyState
            icon="bed-outline"
            title="We couldn’t find that hotel"
            message="It may no longer be listed."
            actionLabel="See all hotels"
            onAction={() => router.replace('/hotels')}
          />
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
    <Screen header={{ back: true }} scroll flush>
      {/* The site's detail hero, with the website's rule kept: a destination photograph says it is not this hotel. */}
      <DetailHero
        photoUri={photo.uri}
        photoAlt={photo.alt}
        kicker={hotel.location.split(',')[0]?.trim() || undefined}
        place={hotel.location}
        title={hotel.name}
        chips={[
          { label: `${hotel.stars}-star hotel`, icon: 'star-outline' },
          ...(rating ? [{ label: `${rating.toFixed(1)} ${ratingWord(rating)}`, icon: 'ribbon-outline' as const }] : []),
          ...(hotel.distanceKm ? [{ label: `${Number(hotel.distanceKm)} km from the airport`, icon: 'airplane-outline' as const }] : []),
        ]}
        note={photo.kind === 'destination' ? photo.note : photo.kind === 'placeholder' ? photo.note : undefined}
      />

      <View style={[styles.body, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        <WishlistButton type="hotel" id={id} />

        {hotel.description ? (
          <Text variant="body" color="ink2">
            {hotel.description}
          </Text>
        ) : null}

        {hotel.amenities.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Amenities" />
            <View style={styles.tags}>
              {hotel.amenities.map((a) => (
                <Tag key={a} label={a} />
              ))}
            </View>
          </View>
        ) : null}

        {hotel.cancellation_policy ? (
          <Card>
            <Text variant="eyebrow" color="goldInk">
              Cancellation policy
            </Text>
            <Text variant="body" color="ink2">
              {hotel.cancellation_policy}
            </Text>
          </Card>
        ) : null}

        <View style={styles.section}>
          <SectionHeader eyebrow="Your stay" title="Dates and guests" />
          <Card style={styles.stay}>
            <StayFields stay={stay} onStayChange={setStay} party={party} onPartyChange={setParty} />
          </Card>
          <Text variant="small" color="muted" align="center">
            {partySummary(party)}
          </Text>
        </View>

        <View style={styles.section}>
          <SectionHeader eyebrow="Choose a room" title="Rooms" />
          <IndicativeNotice what="rate" />
          {hotel.rooms.length === 0 ? (
            <Card>
              <Text variant="bodyStrong" color="navy800">
                No rooms are listed for this hotel yet
              </Text>
              <Text variant="small" color="muted">
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
                  <Text variant="title" color="navy800">
                    {room.name}
                  </Text>
                  {room.description ? (
                    <Text variant="small" color="muted">
                      {room.description}
                    </Text>
                  ) : null}
                  <View style={styles.tags}>
                    {room.bed_type ? <Tag label={room.bed_type} /> : null}
                    {room.size_label ? <Tag label={room.size_label} /> : null}
                    <Tag label={`Up to ${room.max_guests} guests`} />
                    {room.meal_plan ? <Tag label={room.meal_plan} tone="gold" /> : null}
                  </View>
                  {room.perks.length > 0 ? (
                    <Text variant="small" color="ink2">
                      {room.perks.join(' · ')}
                    </Text>
                  ) : null}
                  {room.cancellation_policy ? (
                    <Text variant="small" color="muted">
                      {room.cancellation_policy}
                    </Text>
                  ) : null}
                  <View style={styles.priceRow}>
                    <View style={styles.grow}>
                      <Text variant="caption" color="muted">
                        Indicative rate
                      </Text>
                      <Text variant="title" color="navy800">
                        {formatMoney(room.price)}
                        <Text variant="small" color="muted">
                          {' '}
                          / night
                        </Text>
                      </Text>
                    </View>
                  </View>
                  {blocked ? (
                    <Text variant="small" color="warning">
                      {blocked}
                    </Text>
                  ) : (
                    <Text variant="small" color="muted">
                      {nights} night{nights === 1 ? '' : 's'}, {partySummary(party)}
                    </Text>
                  )}
                  <Button
                    title="Select this room"
                    disabled={blocked !== null}
                    onPress={() => select(room)}
                    accessibilityHint="Goes to a price our server confirms for your dates"
                  />
                </Card>
              );
            })
          )}
        </View>
      </View>
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.s4, paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  section: { gap: spacing.s3 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  stay: { gap: spacing.s3 },
  room: { gap: spacing.s2 },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.s3, marginTop: spacing.s1 },
  grow: { flex: 1 },
});
