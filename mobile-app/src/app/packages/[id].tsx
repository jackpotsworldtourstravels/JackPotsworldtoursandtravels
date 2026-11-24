import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { isApiError } from '@/api/errors';
import { Accordion, Button, Card, EmptyState, ErrorState, GoldBadge, ImageCarousel, ListSkeleton, PriceTag, Screen, StatusPill, StickyFooter, Text } from '@/components';
import { DetailScroll, type DetailSection } from '@/components/DetailScroll';
import { Stars } from '@/components/layout';
import { Stepper } from '@/components/pickers';
import { WishlistButton } from '@/features/account/components/WishlistButton';
import { IndicativeNotice } from '@/features/booking/components/Quote';
import { usePackageDetail } from '@/features/booking/hooks';
import { bookableDepartures, maxTravellers } from '@/features/booking/packageRequest';
import { parseId } from '@/features/booking/refs';
import { packageDuration, packagePlace } from '@/features/discovery/packages';
import { packagePhotoUrl } from '@/features/media/mediaUrl';
import { colors, fontFamily, radius, spacing } from '@/theme';
import { formatLongDate, formatShortDate } from '@/utils/dates';
import { formatMoney } from '@/utils/money';

type Key = 'overview' | 'itinerary' | 'inclusions' | 'exclusions' | 'hotels' | 'dates' | 'policies';

function Bullets({ items, icon, color }: { items: string[]; icon: keyof typeof Ionicons.glyphMap; color: string }) {
  return (
    <View style={styles.bullets}>
      {items.map((item) => (
        <View key={item} style={styles.bullet}>
          <Ionicons name={icon} size={18} color={color} />
          <Text variant="body" color="ink2" style={styles.grow}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * One holiday package: photo, title block with its duration, sticky tabs and a sticky price footer.
 * Tabs appear only for what this package really has (no empty Itinerary or Hotels box when none is published).
 *
 * Departure prices are INDICATIVE (the catalogue's per-person figure) and the page says so; the server quotes the
 * real total, with GST, on the next screen. Departures already in the past are filtered out, and a package with
 * nothing bookable offers an enquiry instead of a date that cannot be sold.
 */
export default function PackageDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = parseId(params.id);
  const detail = usePackageDetail(id);

  const [chosenId, setChosenId] = useState<number | null>(null);
  const [pax, setPax] = useState(2);
  const [jump, setJump] = useState<{ key: Key; seq: number }>({ key: 'dates', seq: 0 });

  if (id === null) {
    return (
      <Screen header={{ back: true, title: 'Package' }}>
        <EmptyState icon="map-outline" title="We couldn’t find that package" message="The link may be old or mistyped." actionLabel="See all packages" onAction={() => router.replace('/packages')} />
      </Screen>
    );
  }
  if (detail.isPending) {
    return (
      <Screen header={{ back: true, title: 'Package' }} scroll>
        <ListSkeleton count={2} photo={220} />
      </Screen>
    );
  }
  if (detail.isError) {
    const missing = isApiError(detail.error) && detail.error.kind === 'not_found';
    return (
      <Screen header={{ back: true, title: 'Package' }}>
        {missing ? (
          <EmptyState icon="map-outline" title="We couldn’t find that package" message="It may no longer be listed." actionLabel="See all packages" onAction={() => router.replace('/packages')} />
        ) : (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isRefetching} />
        )}
      </Screen>
    );
  }

  const pkg = detail.data;
  const departures = bookableDepartures(pkg.departures);
  const chosen = departures.find((d) => d.id === chosenId) ?? departures[0] ?? null;
  const cap = chosen ? maxTravellers(chosen) : 0;
  const travellers = Math.min(pax, Math.max(cap, 1));
  const place = packagePlace(pkg);
  const enquire = () => router.push({ pathname: '/packages/enquire', params: { packageId: String(id), packageName: pkg.name } });
  const book = () =>
    chosen &&
    router.push({
      pathname: '/book/package',
      params: { packageId: String(id), departureId: String(chosen.id), pax: String(travellers) },
    });
  const tripLabel = pkg.trip_type === 'international' ? 'International' : pkg.trip_type === 'domestic' ? 'Domestic' : pkg.trip_type === 'pilgrimage' ? 'Pilgrimage' : null;

  const sections: DetailSection<Key>[] = [
    {
      key: 'overview',
      label: 'Overview',
      content: (
        <>
          {pkg.description || pkg.blurb ? (
            <Text variant="body" color="ink2">
              {pkg.description || pkg.blurb}
            </Text>
          ) : null}
          {pkg.highlights.length > 0 ? (
            <Card>
              <Text variant="h3" color="ink">
                Highlights
              </Text>
              <Bullets items={pkg.highlights} icon="sparkles-outline" color={colors.link} />
            </Card>
          ) : null}
        </>
      ),
    },
  ];
  if (pkg.itinerary.length > 0) {
    sections.push({
      key: 'itinerary',
      label: 'Itinerary',
      content: (
        <>
          <Text variant="h3" color="ink" accessibilityRole="header">
            Day by day
          </Text>
          <Card style={styles.timeline}>
            {[...pkg.itinerary]
              .sort((a, b) => a.day_number - b.day_number)
              .map((day, i, all) => (
                <View key={day.day_number} style={styles.dayRow}>
                  <View style={styles.rail}>
                    <View style={styles.dayDot}>
                      <Text variant="caption" color="white" chrome style={styles.dayNum}>
                        {day.day_number}
                      </Text>
                    </View>
                    {i < all.length - 1 ? <View style={styles.railLine} /> : null}
                  </View>
                  <View style={styles.grow}>
                    <Accordion title={`Day ${day.day_number} · ${day.title}`} initiallyOpen={i === 0} last={i === all.length - 1}>
                      {day.location ? (
                        <Text variant="caption" color="textSecondary">
                          {day.location}
                        </Text>
                      ) : null}
                      {day.description ? (
                        <Text variant="small" color="ink2">
                          {day.description}
                        </Text>
                      ) : null}
                      {day.meals.length > 0 ? (
                        <Text variant="caption" color="textSecondary">
                          Meals: {day.meals.join(', ')}
                        </Text>
                      ) : null}
                    </Accordion>
                  </View>
                </View>
              ))}
          </Card>
        </>
      ),
    });
  }
  if (pkg.inclusions.length > 0) {
    sections.push({
      key: 'inclusions',
      label: 'Inclusions',
      content: (
        <Card>
          <Text variant="h3" color="ink" accessibilityRole="header">
            What’s included
          </Text>
          <Bullets items={pkg.inclusions} icon="checkmark-circle" color={colors.success} />
        </Card>
      ),
    });
  }
  if (pkg.exclusions.length > 0) {
    sections.push({
      key: 'exclusions',
      label: 'Exclusions',
      content: (
        <Card>
          <Text variant="h3" color="ink" accessibilityRole="header">
            Not included
          </Text>
          <Bullets items={pkg.exclusions} icon="close-circle" color={colors.danger} />
        </Card>
      ),
    });
  }
  if (pkg.hotels.length > 0) {
    sections.push({
      key: 'hotels',
      label: 'Hotels',
      content: (
        <>
          <Text variant="h3" color="ink" accessibilityRole="header">
            Where you stay
          </Text>
          {pkg.hotels.map((h, i) => (
            <Card key={`${h.hotel_name}-${i}`} style={styles.tight}>
              <Text variant="h3" color="ink">
                {h.hotel_name}
              </Text>
              <Text variant="small" color="textSecondary">
                {[h.city, h.room_type, h.nights ? `${h.nights} night${h.nights === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
              </Text>
              {h.star_rating ? <Stars count={h.star_rating} /> : null}
            </Card>
          ))}
        </>
      ),
    });
  }
  sections.push({
    key: 'dates',
    label: 'Dates',
    content: (
      <>
        <Text variant="h3" color="ink" accessibilityRole="header">
          Departures
        </Text>
        {departures.length === 0 ? (
          <Card>
            <Text variant="bodyStrong" color="ink">
              No departure dates are open for booking right now
            </Text>
            <Text variant="small" color="textSecondary">
              Tell us when you’d like to travel and our team will get back to you with dates and a price.
            </Text>
            <Button title="Enquire about dates" variant="outline" onPress={enquire} />
          </Card>
        ) : (
          <>
            <IndicativeNotice what="price" />
            {departures.map((d) => {
              const selected = chosen?.id === d.id;
              return (
                <Pressable
                  key={d.id}
                  onPress={() => setChosenId(d.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${formatLongDate(d.date)}, indicative ${formatMoney(d.price)} per person, ${d.seats_left} seats left`}
                  style={({ pressed }) => [styles.departure, selected && styles.departureSelected, pressed && styles.pressed]}
                >
                  <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={22} color={selected ? colors.navy900 : colors.textDisabled} />
                  <View style={styles.grow}>
                    <Text variant="bodyStrong" color="ink">
                      {formatLongDate(d.date)}
                    </Text>
                    <Text variant="caption" color={d.seats_left <= 5 ? 'warning' : 'textSecondary'}>
                      {d.seats_left} seat{d.seats_left === 1 ? '' : 's'} left
                    </Text>
                  </View>
                  <View style={styles.priceCol}>
                    <Text variant="h3" color="ink" style={styles.amount}>
                      {formatMoney(d.price)}
                    </Text>
                    <Text variant="caption" color="textSecondary">
                      per person
                    </Text>
                  </View>
                </Pressable>
              );
            })}
            {chosen ? (
              <Card>
                <Stepper label="Travellers" value={travellers} min={1} max={cap} onChange={setPax} hint={`Up to ${cap} on this departure`} />
              </Card>
            ) : null}
          </>
        )}
      </>
    ),
  });
  sections.push({
    key: 'policies',
    label: 'Policies',
    content: (
      <Card style={styles.policies}>
        <Accordion title="Cancellation policy" initiallyOpen last>
          <Text variant="body" color="ink2">
            {pkg.cancellation_policy || 'The cancellation terms for your departure are shown on the booking screen before you pay.'}
          </Text>
        </Accordion>
      </Card>
    ),
  });

  return (
    <Screen
      statusBar="light"
      footer={
        departures.length > 0 && chosen ? (
          <StickyFooter actionTitle="Book now" caps onAction={() => void book()}>
            <PriceTag amount={chosen.price} unit="per person" note={`Indicative · ${formatShortDate(chosen.date)} · ${travellers} traveller${travellers === 1 ? '' : 's'}`} />
          </StickyFooter>
        ) : (
          <StickyFooter actionTitle="Enquire" onAction={enquire}>
            <PriceTag amount={pkg.priceFrom} lead="Starting" unit="per person" note="Dates on request" />
          </StickyFooter>
        )
      }
    >
      <DetailScroll
        jumpRequest={jump}
        media={<ImageCarousel photos={[{ uri: packagePhotoUrl(pkg.image, 'hero'), alt: `${pkg.name}, a photograph of ${pkg.destination ?? 'the destination'}` }]} height={240} />}
        actions={<WishlistButton type="package" id={Number(pkg.id)} appearance="heart" />}
        title={
          <>
            <Text variant="h1" color="ink" accessibilityRole="header">
              {pkg.name}
            </Text>
            <View style={styles.chips}>
              <GoldBadge label={pkg.nights ? `${pkg.nights}N / ${pkg.days}D` : packageDuration(pkg)} />
              {tripLabel ? <StatusPill label={tripLabel} tone="info" /> : null}
              {departures[0] ? <StatusPill label={`Next: ${formatShortDate(departures[0].date)}`} tone="success" /> : null}
              {pkg.hotel_category ? <Stars count={pkg.hotel_category} /> : null}
            </View>
            {place ? (
              <View style={styles.row}>
                <Ionicons name="location-outline" size={15} color={colors.textSecondary} />
                <Text variant="small" color="textSecondary">
                  {place}
                </Text>
              </View>
            ) : null}
            {departures.length > 0 ? (
              <Pressable onPress={() => setJump((j) => ({ key: 'dates', seq: j.seq + 1 }))} accessibilityRole="link" accessibilityLabel={`See all ${departures.length} departure dates`} hitSlop={6}>
                <Text variant="bodyStrong" color="link">
                  {departures.length} departure date{departures.length === 1 ? '' : 's'} ›
                </Text>
              </Pressable>
            ) : null}
          </>
        }
        sections={sections}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  bullets: { gap: spacing.s2 },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3 },
  tight: { gap: 4 },
  timeline: { paddingVertical: spacing.s2 },
  dayRow: { flexDirection: 'row', gap: spacing.s3 },
  rail: { alignItems: 'center', paddingTop: 14 },
  dayDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.navy900, alignItems: 'center', justifyContent: 'center' },
  dayNum: { fontFamily: fontFamily.sansExtraBold, fontSize: 11 },
  railLine: { flex: 1, width: 2, backgroundColor: colors.line, marginTop: 4 },
  departure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: 64,
    padding: spacing.s3,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  departureSelected: { borderColor: colors.navy900 },
  pressed: { opacity: 0.85 },
  priceCol: { alignItems: 'flex-end' },
  amount: { fontFamily: fontFamily.sansExtraBold },
  policies: { paddingVertical: 0 },
});
