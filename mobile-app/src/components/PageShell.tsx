import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontFamily, shadow, spacing } from '@/theme';

import { SiteFooter } from '@/features/home/SiteFooter';

import { CONTENT_MAX_WIDTH, Screen, type ScreenProps } from './Screen';
import { Text } from './Text';

/**
 * THE WEBSITE'S SERVICE-PAGE FRAME (`gaming-packages.html`, `.ge-hero` and `.ge-card`, measured on the live page at 390px):
 * a navy hero (160deg, #16263F to #0F1B2E) holding a breadcrumb ("Home > Gaming Tour Enquiry"), the page title in
 * Playfair 700 at 30px on 34.5px lines, and a 16px lede; under it a white card (20px corners, a warm 1px edge, a deep
 * soft shadow, 22px of padding) that rides up over the hero's foot. The page's own title is the hero's, so the header
 * above carries only the logo and the back arrow, and no long title is ever cut off there.
 */
export interface PageShellProps extends Pick<ScreenProps, 'keyboard' | 'refreshControl'> {
  /** The page title, as the hero prints it. */
  title: string;
  /** What follows "Home ›" in the breadcrumb. Defaults to the title. */
  crumb?: string;
  lede?: string;
  /** Anything that belongs in the hero under the lede (a pill, a date ribbon). */
  heroExtra?: ReactNode;
  /** Pull the content up over the hero's foot, as the card does. Off for pages whose first thing is not a card. */
  overlap?: boolean;
  children: ReactNode;
}

export function PageShell({ title, crumb, lede, heroExtra, overlap = true, keyboard, refreshControl, children }: PageShellProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const side = { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right };
  return (
    <Screen header={{ back: true }} scroll flush keyboard={keyboard} refreshControl={refreshControl}>
      <LinearGradient colors={['#16263F', '#0F1B2E']} start={{ x: 0.35, y: 0 }} end={{ x: 0.65, y: 1 }} style={[styles.hero, side, overlap && styles.heroOverlap]}>
        <View style={styles.column}>
          <View style={styles.crumbs}>
            <Pressable onPress={() => router.replace('/')} accessibilityRole="link" accessibilityLabel="Home" hitSlop={8}>
              <Text variant="body" color="onDark" style={styles.crumb}>
                Home
              </Text>
            </Pressable>
            <Text variant="body" color="onDark2" style={styles.crumb}>
              {'›'}
            </Text>
            <Text variant="body" color="onDark2" style={styles.crumb}>
              {crumb ?? title}
            </Text>
          </View>
          <Text variant="display" color="white" accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {lede ? (
            <Text variant="body" color="onDark" style={styles.lede}>
              {lede}
            </Text>
          ) : null}
          {heroExtra}
        </View>
      </LinearGradient>
      <View style={[styles.content, { paddingLeft: 12 + insets.left, paddingRight: 12 + insets.right }, overlap && styles.contentOverlap]}>
        <View style={styles.column}>{children}</View>
      </View>
      <SiteFooter />
    </Screen>
  );
}

/** `.ge-card`: the white card the page's form or results sit in. */
export function FormCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, shadow.md, style]}>{children}</View>;
}

/**
 * `.ge-section-h` and `.ge-section-sub`: a coral 12px/800 tracked-capitals heading and a muted line, then the fields.
 * Sections inside one card are divided by a hairline, as the site draws them.
 */
export function FormSection({ title, sub, children, first = false }: { title: string; sub?: string; children: ReactNode; first?: boolean }) {
  return (
    <View style={[styles.section, !first && styles.sectionDivider]}>
      <View style={styles.sectionHead}>
        <Text variant="caption" color="coral" accessibilityRole="header" style={styles.sectionTitle}>
          {title.toUpperCase()}
        </Text>
        {sub ? (
          <Text variant="small" color="muted" style={styles.sectionSub}>
            {sub}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // `.ge-hero`: the page's own header already sits above, so the hero keeps only the 48px under its copy.
  hero: { paddingTop: spacing.s6, paddingBottom: 48 },
  heroOverlap: { paddingBottom: 72 },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', gap: spacing.s3 },
  crumbs: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  crumb: { fontSize: 14, lineHeight: 20 },
  title: { fontFamily: fontFamily.displayBold, fontSize: 30, lineHeight: 34.5, letterSpacing: -0.3 },
  lede: { fontSize: 16, lineHeight: 26, color: 'rgba(255,255,255,0.86)' },
  content: { paddingBottom: spacing.s6 },
  contentOverlap: { marginTop: -48 },
  card: { backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 22, gap: spacing.s5 },
  section: { gap: spacing.s4 },
  sectionDivider: { paddingTop: spacing.s5, borderTopWidth: 1, borderTopColor: colors.line },
  sectionHead: { gap: 4 },
  sectionTitle: { fontFamily: fontFamily.sansBold, fontSize: 12, lineHeight: 14, letterSpacing: 0.84 },
  sectionSub: { fontSize: 14, lineHeight: 20 },
});
