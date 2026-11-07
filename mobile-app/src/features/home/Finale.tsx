import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Animated, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components';
import { RemoteImage } from '@/components/RemoteImage';
import { destinationPhotoUrl } from '@/features/media/mediaUrl';
import { mapTo, Reveal, useElementTop, useScrub } from '@/features/motion/ScrollMotion';
import { colors, fontFamily, spacing } from '@/theme';

import { FINALE } from './copy';
import { Kicker } from './Kicker';
import { NewsletterForm } from './NewsletterForm';

const SAMPLES = 12;

/**
 * The finale's photograph (`.cine-finale-media`): it OPENS THROUGH A CIRCLE as the section arrives
 * (`clip-path: circle(12% -> 120% at 50% 62%)`) while settling from a push-in (scale 1.32 -> 1.04), then drifts
 * a little as the section leaves (`yPercent` -4 -> 4). React Native has no clip-path, so the circle is a round,
 * clipping View that GROWS (scale .1 -> 1) around the same point, with the photograph inside it scaled the other
 * way and shifted so that it stays exactly where the section draws it: the picture does not zoom, the window does.
 */
function FinaleMedia({ width, height, top, measured }: { width: number; height: number; top: number; measured: { top: number; height: number } | null }) {
  const open = useScrub(measured, 1, 0.05);
  const leave = useScrub(measured, 0, 0, true);

  const cx = width * 0.5;
  const cy = height * 0.62;
  // The site's radius is 120% of sqrt((w^2 + h^2) / 2); the mask is that circle at full size.
  const diameter = 2 * 1.2 * Math.sqrt((width * width + height * height) / 2);
  // Where the section's centre sits relative to the circle's centre.
  const oy = height / 2 - cy;

  const progress = Array.from({ length: SAMPLES }, (_, i) => i / (SAMPLES - 1));
  const scale = progress.map((p) => 0.1 + 0.9 * p);
  const maskScale = mapTo(open, scale);
  const counterScale = mapTo(
    open,
    scale.map((s) => 1 / s),
  );
  const counterShift = mapTo(
    open,
    scale.map((s) => oy * (1 / s - 1)),
  );
  const push = mapTo(open, [1.32, 1.04]);
  const drift = mapTo(leave, [-0.045 * height, 0.045 * height]);

  return (
    <View style={[StyleSheet.absoluteFill, { top }]} pointerEvents="none">
      <Animated.View
        style={[
          styles.mask,
          {
            width: diameter,
            height: diameter,
            borderRadius: diameter / 2,
            left: cx - diameter / 2,
            top: cy - diameter / 2,
          },
          { transform: [{ scale: maskScale }] },
        ]}
      >
        <Animated.View
          style={{
            position: 'absolute',
            width,
            height,
            left: diameter / 2 - cx,
            top: diameter / 2 - cy,
            transform: [{ translateY: counterShift }, { scale: counterScale }],
          }}
        >
          <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateY: drift }, { scale: push }] }]}>
            <RemoteImage uri={destinationPhotoUrl('kashmir', 'hero')} alt="Dal Lake, Srinagar" style={StyleSheet.absoluteFill} />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/**
 * "Ready to go?" (`.cine-finale` in index.html and `setupFinale()` in home-cinema.js): the call to action and the
 * newsletter over the website's own Dal Lake photograph. The copy rises into place line by line, "Plan your
 * journey" settles with an elastic overshoot, and the photograph opens through a circle as the section arrives.
 * (The site's gold route line across the scene needs a drawing library the app does not carry, and its contact
 * form appears on "Plan your journey", which here goes to Help and support.)
 */
export function Finale() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { attach, measured, onLayout } = useElementTop();
  const height = measured?.height ?? 0;

  return (
    <View ref={attach} onLayout={onLayout} style={styles.wrap}>
      {height > 0 ? (
        <FinaleMedia width={width} height={height} top={0} measured={measured} />
      ) : (
        <RemoteImage uri={destinationPhotoUrl('kashmir', 'hero')} alt="Dal Lake, Srinagar" style={StyleSheet.absoluteFill} />
      )}
      {/* `.cine-finale-shade`: dark from the left and dark at the top and foot, so the copy reads. */}
      <LinearGradient
        colors={['rgba(5,8,15,0.9)', 'rgba(5,8,15,0.6)', 'rgba(5,8,15,0.4)', 'rgba(5,8,15,0.66)']}
        locations={[0, 0.42, 0.7, 1]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(6,10,18,0.95)', 'rgba(6,10,18,0.2)', 'rgba(6,10,18,0.25)', '#0A1628']}
        locations={[0, 0.22, 0.7, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.content}>
        <Reveal y={30} startAt={0.92}>
          <Kicker text={FINALE.kicker} onDark />
        </Reveal>
        <View accessible accessibilityRole="header" accessibilityLabel={`${FINALE.title1} ${FINALE.accent}`}>
          <Reveal y={70} duration={1400} startAt={0.92}>
            <Text variant="display" color="white" style={styles.title} accessibilityElementsHidden importantForAccessibility="no">
              {FINALE.title1.toUpperCase()}
            </Text>
          </Reveal>
          <Reveal y={70} duration={1400} delay={140} startAt={0.92}>
            <Text variant="display" color="gold" style={[styles.title, styles.accent]} accessibilityElementsHidden importantForAccessibility="no">
              {FINALE.accent.toUpperCase()}
            </Text>
          </Reveal>
        </View>
        <Reveal y={28} delay={350} startAt={0.92}>
          <Text variant="body" color="onDark" style={styles.lede}>
            {FINALE.lede}
          </Text>
        </Reveal>
        <Reveal y={28} scale={0.86} delay={450} startAt={0.95} spring style={styles.ctaWrap}>
          <Pressable
            onPress={() => router.push('/support')}
            accessibilityRole="button"
            accessibilityLabel={FINALE.cta}
            style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
          >
            <Text variant="caption" color="white" chrome style={styles.ctaText}>
              {FINALE.cta.toUpperCase()}
            </Text>
            <Ionicons name="arrow-forward" size={18} color={colors.white} />
          </Pressable>
        </Reveal>

        <Reveal y={28} delay={550} startAt={0.95}>
          <View style={styles.news}>
            <Text variant="bodyStrong" color="white" accessibilityRole="header" style={styles.newsHead}>
              {FINALE.newsletter.heading}
            </Text>
            <Text variant="small" color="onDark2" style={styles.newsText}>
              {FINALE.newsletter.text}
            </Text>
            <NewsletterForm />
          </View>
        </Reveal>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.s8,
    overflow: 'hidden',
    backgroundColor: colors.night,
  },
  mask: { position: 'absolute', overflow: 'hidden' },
  // `.cine-finale`: 120px above and 80px below the copy on a phone.
  content: {
    gap: spacing.s4,
    paddingHorizontal: spacing.s5,
    paddingTop: 120,
    paddingBottom: 80,
  },
  // `.cine-finale-title`: Playfair 500 upper-case, 56px on .88 lines, -.025em.
  title: { fontSize: 56, lineHeight: 49, letterSpacing: -1.4 },
  accent: { fontFamily: fontFamily.displayItalic },
  lede: {
    marginTop: spacing.s3,
    fontSize: 15,
    lineHeight: 26,
    color: 'rgba(255,255,255,0.76)',
    maxWidth: 340,
  },
  ctaWrap: { alignSelf: 'flex-start', marginTop: spacing.s3 },
  // `.cine-cta-solid`: a coral pill, 12.5px capitals at .18em, the arrow after the words.
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 52,
    paddingLeft: 26,
    paddingRight: 22,
    borderRadius: 999,
    backgroundColor: colors.coral,
  },
  ctaText: { fontSize: 12.5, letterSpacing: 2.25, fontWeight: '700' },
  pressed: { opacity: 0.88 },
  news: {
    gap: spacing.s1,
    marginTop: spacing.s7,
    paddingTop: 26,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.14)',
  },
  newsHead: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.28,
    fontFamily: fontFamily.sansBold,
  },
  newsText: {
    fontSize: 13,
    lineHeight: 19,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: spacing.s3,
  },
});
