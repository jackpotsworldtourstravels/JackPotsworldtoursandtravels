import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/Card';
import { RemoteImage } from '@/components/RemoteImage';
import { Stars } from '@/components/layout';
import { Text } from '@/components/Text';
import type { HotelPhoto } from '@/features/media/hotelPhoto';
import { attractionPhotoUrl, destinationPhotoUrl, packagePhotoUrl } from '@/features/media/mediaUrl';
import { colors, fontFamily, radius, shadow, spacing } from '@/theme';
import type { Coupon, Destination, DestinationAttraction, PackageSummary } from '@/types/discovery';
import { formatShortDate } from '@/utils/dates';
import { formatMoney } from '@/utils/money';

import { packageDuration, packagePlace, packagePricing } from './packages';
import type { HotelCardModel } from './hotels';

/**
 * A card is a button when it leads somewhere and a plain, readable summary when
 * it does not. Either way a screen reader gets ONE sentence for the whole card.
 */
function CardShell({ width, label, hint, onPress, children }: { width?: number; label: string; hint?: string; onPress?: () => void; children: React.ReactNode }) {
  const style = width ? { width } : styles.fill;
  if (!onPress) {
    return (
      <View style={style} accessible accessibilityLabel={label}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      style={({ pressed }) => [style, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      {children}
    </Pressable>
  );
}

export const SHELF_CARD_WIDTH = 272;
export const DESTINATION_CARD_WIDTH = 156;

/** A destination as a tall photo tile with its name over the foot of the picture. */
export function DestinationCard({
  destination,
  onPress,
  width,
}: {
  destination: Destination;
  onPress: () => void;
  /** Omit to fill the parent (the Explore grid). */
  width?: number;
}) {
  const label = destination.country ? `${destination.name}, ${destination.country}` : destination.name;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Explore ${label}`}
      style={({ pressed }) => [width ? { width } : styles.fill, pressed && styles.pressed]}
    >
      <RemoteImage
        uri={destinationPhotoUrl(destination.image ?? destination.id)}
        alt={`${destination.name}, a photograph of the destination`}
        aspectRatio={4 / 5}
        rounded
        placeholderLabel={destination.name}
      />
      <LinearGradient colors={['transparent', 'rgba(6,10,18,0.82)']} style={styles.tileFade} pointerEvents="none" />
      <View style={styles.tileText} pointerEvents="none">
        <Text variant="h3" color="white" numberOfLines={1}>
          {destination.name}
        </Text>
        {destination.country ? (
          <Text variant="caption" color="onDark" numberOfLines={1} chrome>
            {destination.country}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A place worth visiting, with the area it is in. Not tappable: there is no place page yet. */
export function AttractionCard({ attraction, width }: { attraction: DestinationAttraction; width: number }) {
  return (
    <View style={{ width }} accessible accessibilityLabel={`${attraction.name}${attraction.area_name ? `, ${attraction.area_name}` : ''}`}>
      <Card flush>
        <RemoteImage
          uri={attractionPhotoUrl(attraction.id)}
          alt={`${attraction.name}, a photograph of the place`}
          aspectRatio={16 / 10}
          placeholderLabel={attraction.name}
        />
        <View style={styles.body}>
          <Text variant="title" color="navy800" numberOfLines={2}>
            {attraction.name}
          </Text>
          {attraction.area_name ? (
            <Text variant="small" color="goldInk" numberOfLines={1}>
              {attraction.area_name}
            </Text>
          ) : null}
          {attraction.description ? (
            <Text variant="small" color="muted" numberOfLines={3}>
              {attraction.description}
            </Text>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

/**
 * A hotel. `photo` is resolved by the caller under the website's "never another
 * hotel's picture" rule, so a city photo arrives with its caption already set.
 *
 * Tappable when given `onPress`: it opens the hotel page, where rooms are chosen.
 */
export function HotelCard({
  hotel,
  photo,
  width,
  onPress,
}: {
  hotel: HotelCardModel;
  photo: HotelPhoto;
  /** Omit to fill the parent (the results list). */
  width?: number;
  /** Opens the hotel's page. */
  onPress?: () => void;
}) {
  const price = hotel.pricePerNight ? formatMoney(hotel.pricePerNight, { currency: hotel.currency }) : null;
  const summary = [
    `${hotel.name}, ${hotel.stars} star`,
    hotel.location,
    hotel.rating ? `guest rating ${hotel.rating.toFixed(1)}` : null,
    price ? `from ${price} per night` : null,
    hotel.freeCancellation ? 'free cancellation' : null,
  ]
    .filter(Boolean)
    .join(', ');

  const parts = hotel.location
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const area = parts[0] ?? '';
  const city = parts.length > 1 ? parts[parts.length - 1] : '';
  const [firstPlan, ...otherPlans] = hotel.mealPlans;
  const included = firstPlan !== undefined && !/^\s*room only\s*$/i.test(firstPlan);

  return (
    <CardShell width={width} label={summary} hint="Opens the hotel page" onPress={onPress}>
      <View style={styles.hotelCard}>
        <RemoteImage
          uri={photo.uri}
          alt={photo.alt}
          aspectRatio={16 / 10}
          caption={photo.kind === 'destination' ? photo.note : undefined}
          placeholderLabel={photo.kind === 'placeholder' ? photo.note : undefined}
        />
        {/* `.hc-body`: area and city, the name, stars and the guest score, the facts of this rate, the property's own words. */}
        <View style={styles.hotelBody}>
          {area || city ? (
            <Text variant="caption" color="goldInk" chrome style={styles.hotelKicker}>
              {[area, city].filter(Boolean).join('  ·  ').toUpperCase()}
            </Text>
          ) : null}
          <Text variant="h2" color="navy800" numberOfLines={2} style={styles.hotelName}>
            {hotel.name}
          </Text>
          <View style={styles.hotelMeta}>
            <Stars count={hotel.stars} />
            {hotel.rating ? (
              <View style={styles.score}>
                <Text variant="caption" color="white" chrome style={styles.scoreNumber}>
                  {hotel.rating.toFixed(1)}
                </Text>
                <Text variant="caption" color="navy800" chrome style={styles.scoreWord}>
                  {ratingWord(hotel.rating)}
                </Text>
              </View>
            ) : null}
          </View>
          {firstPlan || hotel.freeCancellation || hotel.distanceKm ? (
            <View style={styles.facts}>
              {firstPlan ? <Fact label="At this rate" value={firstPlan} good={included} /> : null}
              {hotel.freeCancellation ? <Fact label="Cancellation" value="Free cancellation" good /> : null}
              {hotel.distanceKm ? <Fact label="Airport" value={`${hotel.distanceKm} km`} /> : null}
            </View>
          ) : null}
          {otherPlans.length > 0 ? (
            <Text variant="small" color="ink2" style={styles.line}>
              <Text variant="caption" color="muted" chrome style={styles.lineLabel}>
                ALSO OFFERED{'  '}
              </Text>
              {otherPlans.join(' · ')}
            </Text>
          ) : null}
          {hotel.cancellationPolicy ? (
            <Text variant="small" color="muted" numberOfLines={2}>
              {hotel.cancellationPolicy}
            </Text>
          ) : null}
          {hotel.amenities.length > 0 ? (
            <Text variant="small" color="ink2" numberOfLines={2} style={styles.amenities}>
              {hotel.amenities.slice(0, 5).join('  ·  ')}
            </Text>
          ) : null}
        </View>

        {/* `.hc-folio`: the lowest nightly rate and a coral "View rooms". Taxes and the stay total are worked out when a stay is quoted. */}
        <View style={styles.folio}>
          {price ? (
            <View>
              <Text variant="caption" color="muted" chrome style={styles.folioLabel}>
                LOWEST NIGHTLY RATE
              </Text>
              <Text variant="h2" color="navy800" style={styles.folioAmount}>
                {price}
              </Text>
              <Text variant="small" color="muted">
                per room, per night
              </Text>
            </View>
          ) : (
            <Text variant="small" color="muted">
              Price on request
            </Text>
          )}
          <View style={styles.viewRooms}>
            <Text variant="caption" color="white" chrome style={styles.viewRoomsText}>
              VIEW ROOMS
            </Text>
            <Ionicons name="arrow-forward" size={16} color={colors.white} />
          </View>
        </View>
      </View>
    </CardShell>
  );
}

/** The site's guest-score word (`ratingWord()` in hotel-results.js). */
export function ratingWord(rating: number): string {
  if (rating >= 4.5) return 'Excellent';
  if (rating >= 4.0) return 'Very Good';
  if (rating >= 3.5) return 'Good';
  return 'Pleasant';
}

/** `.hc-fact`: a small-capitals label and its value in a pill; green when it is a good thing to have. */
function Fact({ label, value, good = false }: { label: string; value: string; good?: boolean }) {
  return (
    <View style={[styles.fact, good && styles.factGood]}>
      <Text variant="caption" color="muted" chrome style={styles.factLabel}>
        {label.toUpperCase()}
      </Text>
      <Text variant="caption" color={good ? 'success' : 'navy800'} chrome style={styles.factValue}>
        {value}
      </Text>
    </View>
  );
}

/** A holiday package. Tappable when given `onPress`: it opens the package page. */
export function PackageCard({ pkg, width, onPress }: { pkg: PackageSummary; width?: number; onPress?: () => void }) {
  const pricing = packagePricing(pkg);
  const price = formatMoney(pricing.amount);
  const departure = pricing.nextDeparture ? formatShortDate(pricing.nextDeparture) : null;
  const where = packagePlace(pkg);

  const summary = [
    pkg.name,
    where || null,
    packageDuration(pkg),
    `${pricing.label.toLowerCase()} ${price}`,
    departure ? `leaves ${departure}` : 'no departure dates listed',
  ]
    .filter(Boolean)
    .join(', ');

  const ticks = pkg.inclusions.slice(0, 3);
  const tripLabel = pkg.trip_type === 'international' ? 'International' : pkg.trip_type === 'domestic' ? 'Domestic' : pkg.trip_type === 'pilgrimage' ? 'Pilgrimage' : null;

  return (
    <CardShell width={width} label={summary} hint="Opens the package page" onPress={onPress}>
      <View style={styles.hotelCard}>
        <View>
          <RemoteImage
            uri={packagePhotoUrl(pkg.image)}
            alt={`${pkg.name}, a photograph of ${pkg.destination ?? 'the destination'}`}
            aspectRatio={16 / 10}
            placeholderLabel={pkg.destination ?? pkg.name}
          />
          {tripLabel ? (
            <View style={styles.tripTag}>
              <Text variant="caption" color="white" chrome style={styles.tripTagText}>
                {tripLabel.toUpperCase()}
              </Text>
            </View>
          ) : null}
        </View>
        {/* `.pkl-card-body`: the name, where, how long, three of what is included, then the price and "View details". */}
        <View style={styles.hotelBody}>
          <Text variant="h2" color="navy800" numberOfLines={2} style={styles.hotelName}>
            {pkg.name}
          </Text>
          {where ? (
            <View style={styles.where}>
              <Ionicons name="location-outline" size={14} color={colors.goldInk} />
              <Text variant="small" color="muted" numberOfLines={1}>
                {where}
              </Text>
            </View>
          ) : null}
          <Text variant="caption" color="goldInk" chrome style={styles.days}>
            {pkg.nights ? `${pkg.days} DAYS / ${pkg.nights} NIGHTS` : packageDuration(pkg).toUpperCase()}
          </Text>
          {ticks.length > 0 ? (
            <View style={styles.ticks}>
              {ticks.map((t) => (
                <View key={t} style={styles.tick}>
                  <Ionicons name="checkmark-circle-outline" size={16} color={colors.success} />
                  <Text variant="small" color="ink2" style={styles.tickText}>
                    {t}
                  </Text>
                </View>
              ))}
            </View>
          ) : pkg.blurb ? (
            <Text variant="small" color="ink2" numberOfLines={3}>
              {pkg.blurb}
            </Text>
          ) : null}
        </View>

        <View style={styles.folio}>
          <View style={styles.pkgPriceRow}>
            <View>
              <Text variant="caption" color="muted" chrome style={styles.folioLabel}>
                {pricing.label.toUpperCase()}
              </Text>
              <Text variant="h2" color="navy800" style={styles.folioAmount}>
                {price}
              </Text>
              <Text variant="small" color="muted">
                per person
              </Text>
            </View>
            <Text variant="caption" color={departure ? 'goldInk' : 'muted'} chrome style={styles.pkgDates}>
              {departure ? `Next ${departure}` : 'Dates on request'}
            </Text>
          </View>
          <View style={styles.viewDetails}>
            <Text variant="caption" color="white" chrome style={styles.viewRoomsText}>
              VIEW DETAILS
            </Text>
            <Ionicons name="arrow-forward" size={16} color={colors.white} />
          </View>
        </View>
      </View>
    </CardShell>
  );
}

/** The headline of a coupon: "40% off" or "₹2,000 off". */
export function couponHeadline(coupon: Pick<Coupon, 'discount_type' | 'discount_value'>): string {
  const raw = coupon.discount_value.trim();
  if (coupon.discount_type === 'percent') {
    // "40.00" -> "40", "12.50" -> "12.5": a string edit, never a float.
    const clean = raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
    return `${clean}% off`;
  }
  if (coupon.discount_type === 'flat') return `${formatMoney(raw)} off`;
  return 'Special offer';
}

/** An offer with its code. Informational: applying a code happens at checkout (Phase 5). */
export function OfferCard({ coupon, width }: { coupon: Coupon; width: number }) {
  return (
    <View style={[styles.offer, { width }]} accessible accessibilityLabel={`${couponHeadline(coupon)}. ${coupon.title}. ${coupon.description ?? ''} Code ${coupon.code}`}>
      <Text variant="h2" color="gold">
        {couponHeadline(coupon)}
      </Text>
      <Text variant="bodyStrong" color="white" numberOfLines={2}>
        {coupon.title}
      </Text>
      {coupon.description ? (
        <Text variant="small" color="onDark2" numberOfLines={3}>
          {coupon.description}
        </Text>
      ) : null}
      <View style={styles.code}>
        <Text variant="caption" color="onDark2" chrome>
          CODE
        </Text>
        <Text variant="bodyStrong" color="goldLight" selectable>
          {coupon.code}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // `.hr-card`: a white card, 20px corners, the photograph, the facts, and a cream price block at the foot.
  hotelCard: { backgroundColor: colors.white, borderRadius: 20, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, ...shadow.sm },
  hotelBody: { padding: 18, gap: spacing.s3 },
  hotelKicker: { fontSize: 10.5, letterSpacing: 1.6, fontFamily: fontFamily.sansBold },
  hotelName: { fontFamily: fontFamily.displayBold, fontSize: 24, lineHeight: 28, letterSpacing: -0.3 },
  hotelMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, flexWrap: 'wrap' },
  score: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scoreNumber: {
    backgroundColor: colors.navy800,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
    overflow: 'hidden',
    fontFamily: fontFamily.sansBold,
    fontSize: 12.5,
  },
  scoreWord: { fontFamily: fontFamily.sansSemiBold, fontSize: 12.5 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.surface2 },
  factGood: { backgroundColor: colors.successSoft },
  factLabel: { fontSize: 9.5, letterSpacing: 1, fontFamily: fontFamily.sansBold },
  factValue: { fontSize: 12.5, fontFamily: fontFamily.sansSemiBold },
  line: { lineHeight: 20 },
  lineLabel: { fontSize: 9.5, letterSpacing: 1, fontFamily: fontFamily.sansBold },
  amenities: { paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  folio: { padding: 18, gap: spacing.s4, backgroundColor: '#FBF8F2', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  folioLabel: { fontSize: 10, letterSpacing: 1.4, fontFamily: fontFamily.sansBold },
  folioAmount: { fontFamily: fontFamily.displayBold, fontSize: 30, lineHeight: 36 },
  viewRooms: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 50, borderRadius: 999, backgroundColor: colors.coral },
  tripTag: { position: 'absolute', left: 14, top: 14, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9, backgroundColor: 'rgba(10,17,32,0.72)' },
  tripTagText: { fontSize: 11, letterSpacing: 1.2, fontFamily: fontFamily.sansBold },
  where: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  days: { fontSize: 11, letterSpacing: 1.4, fontFamily: fontFamily.sansBold },
  ticks: { gap: 8, marginTop: 2 },
  tick: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tickText: { flex: 1, lineHeight: 20 },
  pkgPriceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.s3 },
  pkgDates: { fontSize: 12.5, fontFamily: fontFamily.sansSemiBold, flexShrink: 1, textAlign: 'right' },
  viewDetails: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 50, borderRadius: 999, backgroundColor: colors.navy800 },
  viewRoomsText: { fontSize: 12.5, letterSpacing: 1.8, fontFamily: fontFamily.sansBold },
  fill: { width: '100%' },
  pressed: { opacity: 0.9 },
  tileFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  tileText: { position: 'absolute', left: spacing.s3, right: spacing.s3, bottom: spacing.s3 },
  body: { padding: spacing.s4, gap: spacing.s2 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s2 },
  grow: { flex: 1 },
  rating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.s2,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.warningSoft,
  },
  // Wraps rather than squeezing: "₹12,500 / night" stays on one line and the tag or
  // date drops beneath it when the card is too narrow for both.
  footRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    columnGap: spacing.s3,
    rowGap: spacing.s2,
    marginTop: spacing.s1,
  },
  price: { flexGrow: 1, flexShrink: 0 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  departure: { flexDirection: 'row', alignItems: 'center', gap: spacing.s1, maxWidth: 120 },
  offer: {
    backgroundColor: colors.navy800,
    borderRadius: radius.lg,
    padding: spacing.s5,
    gap: spacing.s2,
    borderWidth: 1,
    borderColor: colors.gold,
  },
  code: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    alignSelf: 'flex-start',
    marginTop: spacing.s2,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.gold,
  },
});
