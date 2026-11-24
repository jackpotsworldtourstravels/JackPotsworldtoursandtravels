import type { Href } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { couponHeadline } from '@/features/discovery/cards';
import { colors, fontFamily, spacing } from '@/theme';
import type { Coupon } from '@/types/discovery';

export type OfferProduct = 'hotel' | 'package' | 'flight';

export const OFFER_PRODUCT: Record<OfferProduct, { label: string; stub: string; search: Href }> = {
  hotel: { label: 'HOTELS', stub: colors.primary, search: '/search/hotels' },
  flight: { label: 'FLIGHTS', stub: '#1D4E89', search: '/flights' },
  package: { label: 'HOLIDAY PACKAGES', stub: '#0F766E', search: '/search/packages' },
};

/** "40% off" -> { big: "40%", small: "OFF" }; "₹2,000 off" -> { big: "₹2,000", small: "OFF" }. */
function split(coupon: Coupon): { big: string; small: string } {
  const headline = couponHeadline(coupon);
  return headline.endsWith(' off') ? { big: headline.slice(0, -4), small: 'OFF' } : { big: 'Offer', small: '' };
}

/**
 * A coupon drawn as a tear-off voucher: a coloured stub with the discount, notches on the tear line, then what it is
 * for, its title, and the code in a dashed box. Press and hold the code to copy it (the system text selection); "Use"
 * opens the search it applies to, where the code goes in at checkout. `compact` is the Home strip's smaller card.
 */
export function VoucherCard({ coupon, product, compact = false, onUse }: { coupon: Coupon; product: OfferProduct; compact?: boolean; onUse: () => void }) {
  const p = OFFER_PRODUCT[product];
  const { big, small } = split(coupon);
  const stubWidth = compact ? 76 : 96;
  return (
    <Pressable
      onPress={onUse}
      accessibilityRole="button"
      accessibilityLabel={`${couponHeadline(coupon)}. ${coupon.title}. Code ${coupon.code}`}
      accessibilityHint="Opens the search this offer applies to"
      style={({ pressed }) => [styles.card, compact && styles.compact, pressed && styles.pressed]}
    >
      <View style={[styles.stub, { width: stubWidth, backgroundColor: p.stub }]}>
        <Text variant={compact ? 'h3' : 'h2'} color="white" chrome numberOfLines={1} adjustsFontSizeToFit style={styles.big}>
          {big}
        </Text>
        {small ? (
          <Text variant="caption" chrome color="goldLight" style={styles.small}>
            {small}
          </Text>
        ) : null}
      </View>
      <View style={[styles.notch, styles.notchTop, { left: stubWidth - 9 }]} />
      <View style={[styles.notch, styles.notchBottom, { left: stubWidth - 9 }]} />
      <View style={[styles.body, compact && styles.bodyCompact]}>
        {compact ? null : (
          <Text variant="caption" chrome color="goldInk" style={styles.product}>
            {p.label}
          </Text>
        )}
        <Text variant={compact ? 'small' : 'bodyStrong'} color="ink" numberOfLines={2} style={compact ? styles.titleCompact : undefined}>
          {coupon.title}
        </Text>
        {!compact && coupon.description ? (
          <Text variant="small" color="textSecondary" numberOfLines={2}>
            {coupon.description}
          </Text>
        ) : null}
        <View style={styles.codeRow}>
          <View style={styles.code}>
            <Text variant="caption" chrome color="ink" selectable style={styles.codeText}>
              {coupon.code}
            </Text>
          </View>
          {compact ? null : (
            <Text variant="small" chrome color="link" style={styles.use}>
              Use
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 18, overflow: 'hidden', minHeight: 104 },
  compact: { width: 252, minHeight: 84 },
  pressed: { opacity: 0.85 },
  stub: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.s2, gap: 2 },
  big: { fontFamily: fontFamily.sansExtraBold },
  small: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.6 },
  notch: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: colors.bg },
  notchTop: { top: -9 },
  notchBottom: { bottom: -9 },
  body: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s3,
    gap: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.divider,
    borderStyle: 'dashed',
    justifyContent: 'center',
  },
  bodyCompact: { paddingHorizontal: spacing.s3, paddingVertical: spacing.s2 },
  product: { letterSpacing: 0.6, fontFamily: fontFamily.sansExtraBold },
  titleCompact: { fontFamily: fontFamily.sansBold },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, marginTop: 2 },
  code: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.gold, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  codeText: { fontFamily: fontFamily.sansExtraBold, letterSpacing: 0.8 },
  use: { marginLeft: 'auto', fontFamily: fontFamily.sansExtraBold },
});
