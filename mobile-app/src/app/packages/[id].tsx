import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiError } from '@/api/errors';
import { Button, Card, DetailHero, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { SectionHeader, Stars } from '@/components/layout';
import { Stepper } from '@/components/pickers';
import { WishlistButton } from '@/features/account/components/WishlistButton';
import { IndicativeNotice } from '@/features/booking/components/Quote';
import { usePackageDetail } from '@/features/booking/hooks';
import { bookableDepartures, maxTravellers } from '@/features/booking/packageRequest';
import { parseId } from '@/features/booking/refs';
import { packageDuration, packagePlace } from '@/features/discovery/packages';
import { packagePhotoUrl } from '@/features/media/mediaUrl';
import { colors, radius, spacing } from '@/theme';
import { formatLongDate } from '@/utils/dates';
import { formatMoney } from '@/utils/money';
import { SiteFooter } from '@/features/home/SiteFooter';

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
 * One tour package: what is in it, what is not, the day-by-day, where you stay,
 * the policy, and the departures you can still book.
 *
 * Departure prices are INDICATIVE (the catalogue's per-person figure) and the
 * page says so; the server quotes the real total, with GST, on the next screen.
 * Departure dates already in the past are listed by the API, so they are filtered
 * out here, and a package with nothing bookable offers an enquiry instead of a
 * date that cannot be sold.
 */
export default function PackageDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const id = parseId(params.id);
  const detail = usePackageDetail(id);

  const [chosenId, setChosenId] = useState<number | null>(null);
  const [pax, setPax] = useState(2);

  if (id === null) {
    return (
      <Screen header={{ back: true }}>
        <EmptyState
          icon="map-outline"
          title="We couldn’t find that package"
          message="The link may be old or mistyped."
          actionLabel="See all packages"
          onAction={() => router.replace('/packages')}
        />
      </Screen>
    );
  }
  if (detail.isPending) {
    return (
      <Screen header={{ back: true }}>
        <LoadingState message="Loading package…" />
      </Screen>
    );
  }
  if (detail.isError) {
    const missing = isApiError(detail.error) && detail.error.kind === 'not_found';
    return (
      <Screen header={{ back: true }}>
        {missing ? (
          <EmptyState
            icon="map-outline"
            title="We couldn’t find that package"
            message="It may no longer be listed."
            actionLabel="See all packages"
            onAction={() => router.replace('/packages')}
          />
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

  return (
    <Screen header={{ back: true }} scroll flush>
      {/* The site's detail hero: the place, the name, a line about it, how long, "Starting from" and the one next step. */}
      <DetailHero
        photoUri={packagePhotoUrl(pkg.image, 'hero')}
        photoAlt={`${pkg.name}, a photograph of ${pkg.destination ?? 'the destination'}`}
        kicker={pkg.destination ?? undefined}
        place={place || undefined}
        title={pkg.name}
        lede={pkg.blurb || undefined}
        chips={[pkg.nights ? `${pkg.days} Days / ${pkg.nights} Nights` : packageDuration(pkg)]}
        price={{
          label: departures.length > 0 ? 'Next departure from' : 'Starting from',
          amount: formatMoney(departures.length > 0 ? departures[0].price : pkg.priceFrom),
          per: 'per person',
        }}
        action={
          departures.length === 0
            ? { label: 'Enquire about dates', onPress: () => router.push({ pathname: '/packages/enquire', params: { packageId: String(id), packageName: pkg.name } }) }
            : undefined
        }
        note={
          departures.length === 0 ? 'This trip has no scheduled departures at the moment — tell us when you want to travel and we will price those dates.' : undefined
        }
      />

      <View style={[styles.body, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}>
        {pkg.hotel_category ? <Stars count={pkg.hotel_category} /> : null}

        <WishlistButton type="package" id={Number(pkg.id)} />
        {pkg.description ? (
          <Text variant="body" color="ink2">
            {pkg.description}
          </Text>
        ) : null}

        {pkg.highlights.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Highlights" />
            <Bullets items={pkg.highlights} icon="sparkles" color={colors.goldInk} />
          </View>
        ) : null}

        {pkg.inclusions.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="What’s included" />
            <Bullets items={pkg.inclusions} icon="checkmark-circle" color={colors.success} />
          </View>
        ) : null}

        {pkg.exclusions.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Not included" />
            <Bullets items={pkg.exclusions} icon="close-circle" color={colors.danger} />
          </View>
        ) : null}

        {pkg.itinerary.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Day by day" title="Itinerary" />
            {[...pkg.itinerary]
              .sort((a, b) => a.day_number - b.day_number)
              .map((day) => (
                <Card key={day.day_number} style={styles.day}>
                  <Text variant="eyebrow" color="goldInk">
                    Day {day.day_number}
                    {day.location ? ` · ${day.location}` : ''}
                  </Text>
                  <Text variant="title" color="navy800">
                    {day.title}
                  </Text>
                  {day.description ? (
                    <Text variant="small" color="ink2">
                      {day.description}
                    </Text>
                  ) : null}
                  {day.meals.length > 0 ? (
                    <Text variant="small" color="muted">
                      Meals: {day.meals.join(', ')}
                    </Text>
                  ) : null}
                </Card>
              ))}
          </View>
        ) : null}

        {pkg.hotels.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Where you stay" title="Hotels" />
            {pkg.hotels.map((h, i) => (
              <Card key={`${h.hotel_name}-${i}`} style={styles.day}>
                <Text variant="title" color="navy800">
                  {h.hotel_name}
                </Text>
                <Text variant="small" color="muted">
                  {[h.city, h.room_type, h.nights ? `${h.nights} night${h.nights === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
                </Text>
                {h.star_rating ? <Stars count={h.star_rating} /> : null}
              </Card>
            ))}
          </View>
        ) : null}

        {pkg.cancellation_policy ? (
          <Card>
            <Text variant="eyebrow" color="goldInk">
              Cancellation policy
            </Text>
            <Text variant="body" color="ink2">
              {pkg.cancellation_policy}
            </Text>
          </Card>
        ) : null}

        <View style={styles.section}>
          <SectionHeader eyebrow="Book" title="Departures" />
          {departures.length === 0 ? (
            <Card>
              <Text variant="bodyStrong" color="navy800">
                No departure dates are open for booking right now
              </Text>
              <Text variant="small" color="muted">
                Tell us when you’d like to travel and our team will get back to you with dates and a price.
              </Text>
              <Button
                title="Enquire about dates"
                onPress={() => router.push({ pathname: '/packages/enquire', params: { packageId: String(id), packageName: pkg.name } })}
              />
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
                    style={[styles.departure, selected && styles.departureSelected]}
                  >
                    <View style={styles.grow}>
                      <Text variant="bodyStrong" color="navy800">
                        {formatLongDate(d.date)}
                      </Text>
                      <Text variant="small" color={d.seats_left <= 5 ? 'warning' : 'muted'}>
                        {d.seats_left} seat{d.seats_left === 1 ? '' : 's'} left
                      </Text>
                    </View>
                    <View style={styles.priceCol}>
                      <Text variant="caption" color="muted">
                        Indicative
                      </Text>
                      <Text variant="title" color="navy800">
                        {formatMoney(d.price)}
                      </Text>
                      <Text variant="caption" color="muted">
                        per person
                      </Text>
                    </View>
                    <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={22} color={selected ? colors.navy800 : colors.muted} />
                  </Pressable>
                );
              })}

              {chosen ? (
                <>
                  <Card>
                    <Stepper label="Travellers" value={travellers} min={1} max={cap} onChange={setPax} hint={`Up to ${cap} on this departure`} />
                  </Card>
                  <Button
                    title="Continue to booking"
                    onPress={() =>
                      router.push({
                        pathname: '/book/package',
                        params: { packageId: String(id), departureId: String(chosen.id), pax: String(travellers) },
                      })
                    }
                    accessibilityHint="Goes to a price our server confirms for your departure"
                  />
                </>
              ) : null}
            </>
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
  bullets: { gap: spacing.s2 },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3 },
  grow: { flex: 1 },
  day: { gap: spacing.s1 },
  departure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: 64,
    padding: spacing.s4,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.white,
  },
  departureSelected: { borderColor: colors.navy800, backgroundColor: colors.paper },
  priceCol: { alignItems: 'flex-end' },
});
