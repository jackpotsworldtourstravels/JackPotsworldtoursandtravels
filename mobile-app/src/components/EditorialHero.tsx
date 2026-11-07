import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontFamily, spacing } from '@/theme';

import { CONTENT_MAX_WIDTH } from './Screen';
import { RemoteImage } from './RemoteImage';
import { Text } from './Text';

export interface EditorialHeroProps {
  /** What follows "Home /" in the breadcrumb. */
  crumb: string;
  /** The small ruled line above the title ("Tour packages"). */
  kicker: string;
  title: string;
  /** The italic gold second line of the title. */
  accent?: string;
  /** Set the title in capitals, as the Packages and Destinations pages do. */
  uppercase?: boolean;
  /** The photograph behind the hero, under a heavy night scrim. Leave it out (undefined) for the plain night hero of the account pages. */
  photoUri?: string | null;
  photoAlt?: string;
  /** The pale-gold pill under the title ("Sample rates"). */
  pill?: string;
  /** Check-in and check-out as the Hotels page prints them above its title. */
  ribbon?: { checkIn: string; checkOut: string };
  /** The summary card at the foot of the hero: what was searched, and Edit. */
  summary?: { title: string; sub?: string; actionLabel?: string; onAction?: () => void; tone?: 'glass' | 'paper' };
  /** A line of small print under the summary ("destination photo, not a hotel"). */
  caption?: string;
}

/**
 * THE WEBSITE'S EDITORIAL HERO (Hotels, Tour Packages and Destinations): a dark photograph under a heavy scrim, a
 * breadcrumb ("Home / Tour packages"), a ruled gold kicker, a Playfair title whose second line is gold italic, and a
 * rounded summary card with a gold "Edit" pill. It is the page's own heading, so the header above carries only the logo
 * and the back arrow. (The site also draws a dotted route across the photograph; React Native has no path drawing
 * without a native library, so the ribbon's dotted rule stands in for it on the Hotels page.)
 */
export function EditorialHero({ crumb, kicker, title, accent, uppercase = false, photoUri, photoAlt = '', pill, ribbon, summary, caption }: EditorialHeroProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const side = { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right };
  return (
    <View style={styles.hero}>
      {photoUri !== undefined ? <RemoteImage uri={photoUri} alt={photoAlt} style={StyleSheet.absoluteFill} /> : null}
      <LinearGradient
        colors={['rgba(4,7,14,0.58)', 'rgba(4,7,14,0.82)', 'rgba(6,10,18,0.97)']}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[styles.inner, side]}>
        <View style={styles.column}>
          <View style={styles.crumbs}>
            <Pressable onPress={() => router.replace('/')} accessibilityRole="link" accessibilityLabel="Home" hitSlop={8}>
              <Text variant="caption" color="onDark2" chrome style={styles.crumb}>
                Home
              </Text>
            </Pressable>
            <Text variant="caption" color="onDark2" chrome style={styles.crumb}>
              /
            </Text>
            <Text variant="caption" color="goldLight" chrome style={styles.crumb}>
              {crumb}
            </Text>
          </View>

          {ribbon ? (
            <View style={styles.ribbon} accessible accessibilityLabel={`Check-in ${ribbon.checkIn}, check-out ${ribbon.checkOut}`}>
              <View>
                <Text variant="caption" color="onDark2" chrome style={styles.ribbonLabel}>
                  CHECK-IN
                </Text>
                <Text variant="bodyStrong" color="white" style={styles.ribbonDate}>
                  {ribbon.checkIn.toUpperCase()}
                </Text>
              </View>
              <View style={styles.ribbonRule} />
              <View style={styles.ribbonEnd}>
                <Text variant="caption" color="onDark2" chrome style={styles.ribbonLabel}>
                  CHECK-OUT
                </Text>
                <Text variant="bodyStrong" color="white" style={styles.ribbonDate}>
                  {ribbon.checkOut.toUpperCase()}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.kickerRow}>
            <View style={styles.rule} />
            <Text variant="caption" color="gold" chrome style={styles.kicker}>
              {kicker.toUpperCase()}
            </Text>
          </View>
          <Text
            variant="display"
            color="white"
            accessibilityRole="header"
            accessibilityLabel={accent ? `${title} ${accent}` : title}
            style={[styles.title, uppercase && styles.upper]}
          >
            {title}
            {accent ? (
              <>
                {'\n'}
                <Text variant="display" color="gold" style={[styles.title, styles.accent, uppercase && styles.upper]}>
                  {accent}
                </Text>
              </>
            ) : null}
          </Text>
          {pill ? (
            <View style={styles.pill}>
              <Text variant="caption" color="goldLight" chrome style={styles.pillText}>
                {pill.toUpperCase()}
              </Text>
            </View>
          ) : null}

          {summary ? (
            <View style={[styles.summary, summary.tone === 'paper' && styles.summaryPaper]}>
              <View style={styles.summaryText}>
                <Text
                  variant="bodyStrong"
                  color={summary.tone === 'paper' ? 'navy800' : 'white'}
                  style={[styles.summaryTitle, summary.tone === 'paper' && styles.summaryTitlePaper]}
                  numberOfLines={2}
                >
                  {summary.title}
                </Text>
                {summary.sub ? (
                  <Text
                    variant="small"
                    color={summary.tone === 'paper' ? 'muted' : 'onDark2'}
                    numberOfLines={2}
                    style={summary.tone === 'paper' ? undefined : styles.summarySubGlass}
                  >
                    {summary.sub}
                  </Text>
                ) : null}
              </View>
              {summary.actionLabel && summary.onAction ? (
                <Pressable
                  onPress={summary.onAction}
                  accessibilityRole="button"
                  accessibilityLabel={summary.actionLabel}
                  style={({ pressed }) => [styles.edit, pressed && styles.pressed]}
                >
                  <Text variant="caption" color="navy800" chrome style={styles.editText}>
                    {summary.actionLabel.toUpperCase()}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={colors.navy800} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {caption ? (
            <Text variant="caption" color="onDark2" chrome style={styles.caption}>
              {caption}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.night, overflow: 'hidden' },
  inner: { paddingTop: spacing.s5, paddingBottom: spacing.s6 },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', gap: spacing.s4 },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  crumb: { fontSize: 13.5, lineHeight: 18, fontFamily: fontFamily.sansBold },
  ribbon: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.s3, paddingHorizontal: spacing.s1, marginTop: spacing.s4 },
  ribbonLabel: { fontSize: 9, letterSpacing: 1.2, lineHeight: 12, fontFamily: fontFamily.sansBold },
  ribbonDate: { fontFamily: fontFamily.display, fontSize: 16, lineHeight: 22, letterSpacing: 0.3 },
  ribbonRule: { flex: 1, height: 1, marginBottom: 8, borderTopWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(240,217,166,0.45)' },
  ribbonEnd: { alignItems: 'flex-end' },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: spacing.s2 },
  rule: { width: 40, height: 1, backgroundColor: 'rgba(217,178,111,0.8)' },
  kicker: { flex: 1, fontSize: 11.5, lineHeight: 16, letterSpacing: 3.4, fontFamily: fontFamily.sansSemiBold },
  title: { fontSize: 42, lineHeight: 42, letterSpacing: -0.9 },
  upper: { textTransform: 'uppercase' },
  accent: { fontFamily: fontFamily.displayItalic },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(217,178,111,0.16)' },
  pillText: { fontSize: 11.5, letterSpacing: 1.4, fontFamily: fontFamily.sansBold },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.s3,
    marginTop: spacing.s5,
    padding: 18,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  summaryText: { flex: 1, gap: 2 },
  summaryTitle: { fontFamily: fontFamily.display, fontSize: 21, lineHeight: 26 },
  summaryTitlePaper: { fontFamily: fontFamily.sansBold, fontSize: 17, lineHeight: 22 },
  summarySubGlass: { letterSpacing: 0.4, textTransform: 'uppercase', fontFamily: fontFamily.sansSemiBold, fontSize: 12.5 },
  summaryPaper: { backgroundColor: '#F8F4EC', borderColor: 'rgba(255,255,255,0.6)' },
  edit: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, minHeight: 40, borderRadius: 999, backgroundColor: colors.gold },
  editText: { fontSize: 12.5, letterSpacing: 1.1, fontFamily: fontFamily.sansBold },
  pressed: { opacity: 0.85 },
  caption: { fontSize: 12, lineHeight: 16, marginTop: -spacing.s2 },
});
