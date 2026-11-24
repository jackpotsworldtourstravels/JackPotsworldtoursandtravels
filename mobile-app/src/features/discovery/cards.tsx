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

/** A destination as a photo tile with its name over the foot of the picture. */
export function DestinationCard({
  destination,
  onPress,
  width,
  subtitle,
}: {
  destination: Destination;
  onPress: () => void;
  /** Omit to fill the parent (the Explore grid). */
  width?: number;
  /** Replaces the country line ("5 packages"). */
  subtitle?: string;
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
        {subtitle || destination.country ? (
          <Text variant="caption" color="onDark" numberOfLines={1} chrome>
            {subtitle ?? destination.country}
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
          <Text variant="h3" color="ink" numberOfLines={2}>
            {attraction.name}
          </Text>
          {attraction.area_name ? (
            <Text variant="small" color="link" numberOfLines={1}>
              {attraction.area_name}
            </Text>
          ) : null}
          {attraction.description ? (
            <Text variant="small" color="textSecondary" numberOfLines={3}>
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
 * `compact` is the narrow Home rail card: name, place, rating and price only.
 */
export function HotelCard({
  hotel,
  photo,
  width,
  onPress,
  compact = false,
}: {
  hotel: HotelCardModel;
  photo: HotelPhoto;
  /** Omit to fill the parent (the results list). */
  width?: number;
  /** Opens the hotel's page. */
  onPress?: () => void;
  compact?: boolean;
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

  return (
    <CardShell width={width} label={summary} hint="Opens the hotel page" onPress={onPress}>
      <View style={styles.card}>
        <RemoteImage
          uri={photo.uri}
          alt={photo.alt}
          aspectRatio={16 / 9}
          caption={photo.kind === 'destination' ? photo.note : undefined}
          placeholderLabel={photo.kind === 'placeholder' ? photo.note : undefined}
        />
        <View style={styles.cardBody}>
          <View style={styles.titleRow}>
            <View style={styles.grow}>
              <Text variant="h3" color="ink" numberOfLines={compact ? 1 : 2}>
                {hotel.name}
              </Text>
              <View style={styles.where}>
                <Ionicons name="location-outline" size={13} color={colors.textSecondary} />
                <Text variant="small" color="textSecondary" numberOfLines={1} style={styles.grow}>
                  {hotel.location}
                </Text>
              </View>
            </View>
            {hotel.rating ? (
              <View style={styles.score} accessible accessibilityLabel={`Guest rating ${hotel.rating.toFixed(1)}, ${ratingWord(hotel.rating)}`}>
                <Ionicons name="star" size={11} color={colors.white} />
                <Text variant="caption" color="white" chrome style={styles.scoreNumber}>
                  {hotel.rating.toFixed(1)}
                </Text>
              </View>
            ) : null}
          </View>
          {!compact ? (
            <View style={styles.metaRow}>
              <Stars count={hotel.stars} />
              {hotel.amenities.length > 0 ? (
                <Text variant="caption" color="ink2" numberOfLines={1} style={styles.grow}>
                  {hotel.amenities.slice(0, 3).join('  ·  ')}
                </Text>
              ) : null}
            </View>
          ) : null}
          <View style={styles.priceRow}>
            {!compact && hotel.freeCancellation ? (
              <View style={styles.good}>
                <Ionicons name="checkmark" size={13} color={colors.success} />
                <Text variant="caption" color="success" chrome style={styles.goodText}>
                  Free cancellation
                </Text>
              </View>
            ) : (
              <View style={styles.grow} />
            )}
            {price ? (
              <View style={compact ? undefined : styles.priceRight}>
                <Text variant="h2" color="ink" style={styles.amount}>
                  {price}
                </Text>
                <Text variant="caption" color="textSecondary" chrome>
                  per night + taxes
                </Text>
              </View>
            ) : (
              <Text variant="small" color="textSecondary">
                Price on request
              </Text>
            )}
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

type IconName = keyof typeof Ionicons.glyphMap;

/** What an inclusion line is about, for the icon row. Only kinds the package actually lists are shown. */
const INCLUSION_KINDS: { test: RegExp; icon: IconName; label: string }[] = [
  { test: /hotel|stay|accommodation|resort/i, icon: 'bed-outline', label: 'Hotel' },
  { test: /breakfast|meal|dinner|lunch/i, icon: 'restaurant-outline', label: 'Meals' },
  { test: /transfer|pickup|drop/i, icon: 'car-outline', label: 'Transfers' },
  { test: /sightseeing|tour|visit|fort|church/i, icon: 'camera-outline', label: 'Sightseeing' },
  { test: /cruise|boat/i, icon: 'boat-outline', label: 'Cruise' },
  { test: /flight|air/i, icon: 'airplane-outline', label: 'Flights' },
];

/** The inclusion icons a package's own inclusion lines justify, at most four. */
export function inclusionKinds(inclusions: readonly string[]): { icon: IconName; label: string }[] {
  const out: { icon: IconName; label: string }[] = [];
  for (const k of INCLUSION_KINDS) {
    if (inclusions.some((i) => k.test.test(i)) && !out.some((o) => o.label === k.label)) out.push({ icon: k.icon, label: k.label });
  }
  return out.slice(0, 4);
}

/** A holiday package. Tappable when given `onPress`: it opens the package page. */
export function PackageCard({ pkg, width, onPress, compact = false }: { pkg: PackageSummary; width?: number; onPress?: () => void; compact?: boolean }) {
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

  const kinds = inclusionKinds(pkg.inclusions);
  const tripLabel = pkg.trip_type === 'international' ? 'International' : pkg.trip_type === 'domestic' ? 'Domestic' : pkg.trip_type === 'pilgrimage' ? 'Pilgrimage' : null;
  const duration = pkg.nights ? `${pkg.nights}N / ${pkg.days}D` : packageDuration(pkg);

  return (
    <CardShell width={width} label={summary} hint="Opens the package page" onPress={onPress}>
      <View style={styles.card}>
        <View>
          <RemoteImage
            uri={packagePhotoUrl(pkg.image)}
            alt={`${pkg.name}, a photograph of ${pkg.destination ?? 'the destination'}`}
            aspectRatio={16 / 9}
            placeholderLabel={pkg.destination ?? pkg.name}
          />
          <View style={styles.badges}>
            <View style={styles.goldBadge}>
              <Text variant="caption" color="navy900" chrome style={styles.badgeText}>
                {duration}
              </Text>
            </View>
            {tripLabel && !compact ? (
              <View style={styles.tripTag}>
                <Text variant="caption" color="white" chrome style={styles.badgeText}>
                  {tripLabel.toUpperCase()}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={styles.cardBody}>
          <Text variant="h3" color="ink" numberOfLines={compact ? 1 : 2}>
            {pkg.name}
          </Text>
          {where && !compact ? (
            <View style={styles.where}>
              <Ionicons name="location-outline" size={13} color={colors.textSecondary} />
              <Text variant="small" color="textSecondary" numberOfLines={1} style={styles.grow}>
                {where}
              </Text>
            </View>
          ) : null}
          {!compact && kinds.length > 0 ? (
            <View style={styles.kinds}>
              {kinds.map((k) => (
                <View key={k.label} style={styles.kind}>
                  <View style={styles.kindIcon}>
                    <Ionicons name={k.icon} size={15} color={colors.link} />
                  </View>
                  <Text variant="caption" color="ink2" chrome style={styles.kindLabel}>
                    {k.label}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <View style={[styles.priceRow, !compact && styles.priceRowRule]}>
            <View style={styles.grow}>
              <Text variant="caption" color={departure ? 'ink' : 'textSecondary'} chrome style={styles.depText}>
                {departure ? `Next ${departure}` : 'Dates on request'}
              </Text>
            </View>
            <View style={styles.priceRight}>
              <Text variant="caption" color="textSecondary" chrome>
                {pricing.label}
              </Text>
              <Text variant="h2" color="ink" style={styles.amount}>
                {price}
              </Text>
              <Text variant="caption" color="textSecondary" chrome>
                per person
              </Text>
            </View>
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
  card: { backgroundColor: colors.surface, borderRadius: radius.md, overflow: 'hidden', ...shadow.sm },
  cardBody: { paddingVertical: spacing.s3, paddingHorizontal: 14, gap: spacing.s2 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s2 },
  grow: { flex: 1, minWidth: 0 },
  where: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  score: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 22, paddingHorizontal: 7, borderRadius: 6, backgroundColor: colors.success },
  scoreNumber: { fontFamily: fontFamily.sansBold },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.s3, marginTop: 2 },
  priceRowRule: { paddingTop: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  priceRight: { alignItems: 'flex-end' },
  amount: { fontFamily: fontFamily.sansExtraBold },
  good: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: colors.successSoft, alignSelf: 'flex-end' },
  goodText: { fontFamily: fontFamily.sansBold },
  badges: { position: 'absolute', left: spacing.s2, top: spacing.s2, flexDirection: 'row', gap: 6 },
  goldBadge: { height: 22, paddingHorizontal: 8, borderRadius: 6, backgroundColor: colors.gold, justifyContent: 'center' },
  tripTag: { height: 22, paddingHorizontal: 8, borderRadius: 6, backgroundColor: 'rgba(10,17,32,0.8)', justifyContent: 'center' },
  badgeText: { fontFamily: fontFamily.sansBold, fontSize: 11 },
  kinds: { flexDirection: 'row', gap: spacing.s4, marginTop: 2 },
  kind: { alignItems: 'center', gap: 3 },
  kindIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  kindLabel: { fontSize: 10.5 },
  depText: { fontFamily: fontFamily.sansBold },
  fill: { width: '100%' },
  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  tileFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  tileText: { position: 'absolute', left: spacing.s3, right: spacing.s3, bottom: spacing.s3 },
  body: { padding: spacing.s4, gap: spacing.s2 },
  offer: {
    backgroundColor: colors.navy900,
    borderRadius: radius.md,
    padding: spacing.s4,
    gap: spacing.s2,
  },
  code: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    alignSelf: 'flex-start',
    marginTop: spacing.s2,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.gold,
  },
});
