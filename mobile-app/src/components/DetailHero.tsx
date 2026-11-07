import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontFamily, spacing } from '@/theme';

import { RemoteImage } from './RemoteImage';
import { CONTENT_MAX_WIDTH } from './Screen';
import { Text } from './Text';

export interface DetailHeroProps {
  photoUri?: string | null;
  photoAlt: string;
  /** The small bold line above the pills (the place's name). */
  kicker?: string;
  /** The pin pill ("Goa"). */
  place?: string;
  title: string;
  lede?: string;
  /** Glass pills under the lede: "4 Days / 3 Nights". */
  chips?: (string | { label: string; icon: keyof typeof Ionicons.glyphMap })[];
  price?: { label: string; amount: string; per: string };
  action?: { label: string; onPress: () => void };
  /** A line of small print under the button. */
  note?: string;
}

/**
 * THE WEBSITE'S DETAIL HERO (`package.html`): the destination photograph full width under a scrim, the place in a glass
 * pill, the name in Playfair 700, one line about it, how long it lasts, "Starting from" with the price, and a cream
 * button with a line of small print under it. The page's content follows.
 */
export function DetailHero({ photoUri, photoAlt, kicker, place, title, lede, chips = [], price, action, note }: DetailHeroProps) {
  const insets = useSafeAreaInsets();
  const side = { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right };
  return (
    <View style={styles.hero}>
      <RemoteImage uri={photoUri} alt={photoAlt} style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={['rgba(4,7,14,0.34)', 'rgba(4,7,14,0.58)', 'rgba(6,10,18,0.82)']}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[styles.inner, side]}>
        <View style={styles.column}>
          {kicker ? (
            <Text variant="caption" color="white" chrome style={styles.kicker}>
              {kicker}
            </Text>
          ) : null}
          {place ? (
            <View style={styles.glass}>
              <Ionicons name="location-outline" size={15} color={colors.white} />
              <Text variant="caption" color="white" chrome style={styles.glassText}>
                {place}
              </Text>
            </View>
          ) : null}
          <Text variant="display" color="white" accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {lede ? (
            <Text variant="body" color="onDark" style={styles.lede}>
              {lede}
            </Text>
          ) : null}
          {chips.length > 0 ? (
            <View style={styles.chips}>
              {chips.map((c) => {
                const chip = typeof c === 'string' ? { label: c, icon: 'calendar-outline' as const } : c;
                return (
                  <View key={chip.label} style={styles.glass}>
                    <Ionicons name={chip.icon} size={15} color={colors.white} />
                    <Text variant="caption" color="white" chrome style={styles.glassText}>
                      {chip.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
          {price ? (
            <View style={styles.price}>
              <Text variant="caption" color="onDark" chrome style={styles.priceLabel}>
                {price.label.toUpperCase()}
              </Text>
              <Text variant="display" color="white" style={styles.amount}>
                {price.amount}
              </Text>
              <Text variant="caption" color="onDark" chrome style={styles.per}>
                {price.per}
              </Text>
            </View>
          ) : null}
          {action ? (
            <Pressable
              onPress={action.onPress}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            >
              <Text variant="caption" color="navy800" chrome style={styles.buttonText}>
                {action.label.toUpperCase()}
              </Text>
              <Ionicons name="arrow-forward" size={16} color={colors.navy800} />
            </Pressable>
          ) : null}
          {note ? (
            <Text variant="small" color="onDark" style={styles.note}>
              {note}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.night, overflow: 'hidden' },
  inner: { paddingTop: spacing.s7, paddingBottom: spacing.s7 },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', gap: spacing.s3 },
  kicker: { fontFamily: fontFamily.sansBold, fontSize: 14 },
  glass: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  glassText: { fontFamily: fontFamily.sansBold, fontSize: 13.5 },
  title: { fontFamily: fontFamily.displayBold, fontSize: 40, lineHeight: 44, letterSpacing: -0.6 },
  lede: { fontSize: 16, lineHeight: 25 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  price: { marginTop: spacing.s3, gap: 2 },
  priceLabel: { fontFamily: fontFamily.sansBold, fontSize: 12.5, letterSpacing: 1.4 },
  amount: { fontFamily: fontFamily.displayBold, fontSize: 36, lineHeight: 42 },
  per: { fontFamily: fontFamily.sansBold, fontSize: 13 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 56,
    borderRadius: 999,
    backgroundColor: '#F8F4EC',
    marginTop: spacing.s2,
  },
  buttonText: { fontFamily: fontFamily.sansBold, fontSize: 13, letterSpacing: 1.5 },
  note: { fontSize: 14, lineHeight: 21 },
  pressed: { opacity: 0.88 },
});
