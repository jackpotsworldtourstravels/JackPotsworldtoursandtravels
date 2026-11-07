import { useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Animated, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CONTENT_MAX_WIDTH, ErrorState, HeaderActions, LoadingState, Screen, Text } from '@/components';
import { RemoteImage } from '@/components/RemoteImage';
import { discoveryKeys, useDestinations } from '@/features/discovery/hooks';
import { DESTINATIONS, HERO } from '@/features/home/copy';
import { DestinationGrid } from '@/features/home/DestinationGrid';
import { Finale } from '@/features/home/Finale';
import { Kicker } from '@/features/home/Kicker';
import { PromiseSection } from '@/features/home/PromiseSection';
import { SiteFooter } from '@/features/home/SiteFooter';
import { heroPhotoUrl } from '@/features/media/mediaUrl';
import { mapTo, Reveal, useScrollMotion } from '@/features/motion/ScrollMotion';
import { SearchCard } from '@/features/search/SearchCard';
import { colors, fontFamily, spacing } from '@/theme';

/** Home is a stack of full-width bands (the Screen is `flush`), so a band that holds content pads itself, in the reading column. */
function Pad({ children, style }: { children: ReactNode; style?: object }) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.pad, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }, style]}>{children}</View>;
}

/** The hero's copy lifts and fades as the page is scrolled away (`setupHero()`: y -80 on a phone, opacity 1 to 0). */
function HeroCopy({ children }: { children: ReactNode }) {
  const motion = useScrollMotion();
  if (!motion || motion.reduceMotion) return <>{children}</>;
  const fade = motion.scrollY.interpolate({ inputRange: [0, 320], outputRange: [0, 1], extrapolate: 'clamp' });
  return <Animated.View style={{ opacity: mapTo(fade, [1, 0]), transform: [{ translateY: mapTo(fade, [0, -80]) }] }}>{children}</Animated.View>;
}

/**
 * THE WEBSITE'S HOME PAGE (`frontend/index.html`), in the website's order: the Dubai photograph with the headline
 * and the booking card (its four service tabs and trust strip are inside the card), the destinations grid, "Travel
 * without limits." with its eight promises, "Ready to go?" with the newsletter, and the footer.
 *
 * The website's Home has NO hotel shelf, package shelf or offers band: they were removed from the page and each
 * service has its own page, so the app's Home does not invent them either. Hotels and Tour Packages are the
 * second and third tabs, the menu, and the Explore tab. (The site's "Your upcoming journey" and "Recommended for
 * you" sections show only for a signed-in or returning visitor and are a later stage.)
 */
export default function HomeScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const destinations = useDestinations();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: discoveryKeys.all });
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  return (
    <Screen
      header={{ right: <HeaderActions /> }}
      scroll
      flush
      scrollMotion
      bottomInset={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.goldInk} />}
    >
      {/* The website's hero: the Dubai blue-hour photograph, full width, the headline over it. */}
      <View style={styles.hero}>
        <RemoteImage uri={heroPhotoUrl()} alt="Dubai skyline at night" style={StyleSheet.absoluteFill} />
        {/* `.cine-shade`: dark at the top for the header, clear through the middle, dark again at the foot. */}
        <LinearGradient
          colors={['rgba(4,7,14,0.66)', 'rgba(4,7,14,0.08)', 'rgba(4,7,14,0)', 'rgba(4,7,14,0.62)', 'rgba(6,10,18,0.96)']}
          locations={[0, 0.26, 0.52, 0.82, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <Pad style={styles.heroText}>
          <HeroCopy>
            <Text variant="display" color="white" accessibilityRole="header" accessibilityLabel={`${HERO.line1} ${HERO.accent} ${HERO.line2}`} style={styles.headline}>
              {HERO.line1.toUpperCase()}
              {'\n'}
              <Text variant="display" color="gold" style={styles.accent}>
                {HERO.accent.toUpperCase()}
              </Text>{' '}
              {HERO.line2.toUpperCase()}
            </Text>
          </HeroCopy>
        </Pad>
      </View>

      {/* The search dock rides up over the foot of the photograph, as on the website. */}
      <Pad style={styles.dock}>
        <SearchCard />
      </Pad>

      {/* Destinations */}
      <Pad style={styles.section}>
        <Reveal y={60} duration={1400} startAt={0.85}>
          <View style={styles.destHead}>
            <Kicker text={DESTINATIONS.kicker} />
            <Text variant="h1" color="navy800" accessibilityRole="header" accessibilityLabel={`${DESTINATIONS.title1} ${DESTINATIONS.title2}`} style={styles.destTitle}>
              {DESTINATIONS.title1}
              {'\n'}
              <Text variant="h1" color="goldInk" style={styles.destAccent}>
                {DESTINATIONS.title2}
              </Text>
            </Text>
            <Text variant="body" color="muted" style={styles.lede}>
              {DESTINATIONS.lede}
            </Text>
          </View>
        </Reveal>
        {destinations.isPending ? (
          <LoadingState message="Loading destinations…" />
        ) : destinations.isError ? (
          <ErrorState error={destinations.error} title="Couldn’t load destinations" onRetry={() => void destinations.refetch()} />
        ) : (
          <DestinationGrid destinations={destinations.data} onOpen={(d) => router.push({ pathname: '/destination/[id]', params: { id: d.id } })} />
        )}
      </Pad>

      <PromiseSection />
      <Finale />
      <SiteFooter />
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  // The photograph is a night skyline above dark water. The headline sits over the sky at
  // the top, in normal flow so a larger font setting makes the hero taller instead of
  // spilling out of it; the bottom padding leaves room for the search dock that rides up
  // over the foot of the photograph.
  hero: { minHeight: 480, justifyContent: 'flex-start', backgroundColor: colors.night, overflow: 'hidden' },
  // The site's copy column is 32px in from each edge at this width, which is what sets "AWAITS" and "YOU." on separate lines.
  heroText: { paddingTop: spacing.s7, paddingBottom: spacing.s10 + spacing.s5, paddingLeft: spacing.s7, paddingRight: spacing.s7 },
  // The website's h1 at a 390px viewport, measured on the live page: Playfair 500, 55.44px on 51px lines, -1.11px tracking.
  headline: { fontSize: 55.4, lineHeight: 51, letterSpacing: -1.1 },
  accent: { fontFamily: fontFamily.displayItalic, fontSize: 55.4, lineHeight: 51, letterSpacing: -1.1 },
  dock: { marginTop: -spacing.s10 },
  section: { gap: spacing.s4, marginTop: spacing.s7 },
  destHead: { gap: spacing.s3 },
  // `.cine-h2`: Playfair 500, line-height .94, tracking -.025em, scaled to a phone (the site's clamp floors at 42px).
  destTitle: { fontSize: 42, lineHeight: 40, letterSpacing: -1 },
  destAccent: { fontFamily: fontFamily.displayItalic, fontSize: 42, lineHeight: 40, letterSpacing: -1 },
  lede: { lineHeight: 26 },
});
