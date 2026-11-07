import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components';
import { mapTo, Reveal, slice, useAnimatedValue, useElementTop, useScrollMotion, useScrub } from '@/features/motion/ScrollMotion';
import { colors, fontFamily, spacing } from '@/theme';

import { PROMISE } from './copy';
import { Kicker } from './Kicker';

const WORDS = PROMISE.statement;
/** The site's fill timeline: each word takes 1 unit and starts .85 after the last, so they overlap slightly. */
const TIMELINE = (WORDS.length - 1) * 0.85 + 1;

/** `.cine-why-arcs`: three circles and three ellipses, a faint gold globe that turns slowly as the section goes by. */
function Arcs({ rotate }: { rotate: Animated.AnimatedInterpolation<number> | number }) {
  const { width } = useWindowDimensions();
  const size = Math.min(width * 0.7, 980);
  const shape = (w: number, h: number, key: string) => (
    <View
      key={key}
      style={[
        styles.arc,
        {
          width: size * w,
          height: size * h,
          borderRadius: size,
          left: (size - size * w) / 2,
          top: (size - size * h) / 2,
        },
      ]}
    />
  );
  const spin =
    typeof rotate === 'number'
      ? '0deg'
      : rotate.interpolate({
          inputRange: [0, 1],
          outputRange: ['-20deg', '35deg'],
        });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.arcs,
        {
          width: size,
          height: size,
          right: -size * 0.2,
          top: '50%',
          marginTop: -size / 2,
        },
        { transform: [{ rotate: spin }] },
      ]}
    >
      {shape(0.95, 0.95, 'c1')}
      {shape(0.75, 0.75, 'c2')}
      {shape(0.55, 0.55, 'c3')}
      {shape(0.95, 0.3, 'e1')}
      {shape(0.3, 0.95, 'e2')}
      {shape(0.65, 0.95, 'e3')}
    </Animated.View>
  );
}

/**
 * A radial glow, which React Native has no gradient for: nested ellipses, each a sliver of the colour, stacked about a
 * point. `rx`/`ry` are the reach (to fully transparent) and `at` the centre, as in the site's
 * `radial-gradient(ellipse 60% 50% at 85% 0%, rgba(217,178,111,.16), transparent 70%)`.
 */
function Glow({ rgb, alpha, rx, ry, at }: { rgb: string; alpha: number; rx: number; ry: number; at: { x: number; y: number } }) {
  const steps = 8;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: steps }, (_, i) => {
        const k = 1 - i / steps;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              width: rx * 2 * k,
              height: ry * 2 * k,
              borderRadius: rx * k,
              left: at.x - rx * k,
              top: at.y - ry * k,
              backgroundColor: `rgba(${rgb},${(alpha / steps).toFixed(4)})`,
            }}
          />
        );
      })}
    </View>
  );
}

const SWEEP_STEPS = 40;

/**
 * One word of the statement (`.cine-fill`): the site sets each word twice, an outline underneath and the solid copy on
 * top, uncovered from left to right as the section is scrolled (`clip-path: inset(0 calc((1 - var(--fill)) * 100%) 0 0)`).
 * React Native has no clip-path or text stroke, so the outline is the word at 30% (the nearest honest stand-in) and the
 * "uncovering" is a window clipped to the word that grows from its left edge, with the solid copy scaled the other way
 * inside it so the letters stay still while the window opens across them.
 */
function FillWord({ text, accent, fill }: { text: string; accent: boolean; fill: Animated.AnimatedInterpolation<number> | number }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const common = [styles.statement, accent && styles.accent];
  const copy = (
    <Text variant="display" color={accent ? 'gold' : 'white'} style={common} accessibilityElementsHidden importantForAccessibility="no">
      {text.toUpperCase()}
    </Text>
  );

  const samples = Array.from({ length: SWEEP_STEPS + 1 }, (_, i) => i / SWEEP_STEPS);
  const opening = mapTo(
    fill,
    samples.map((p) => Math.max(p, 0.02)),
    samples,
  );
  const counter = mapTo(
    fill,
    samples.map((p) => 1 / Math.max(p, 0.02)),
    samples,
  );

  return (
    <View style={styles.word} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      <View style={styles.dim}>{copy}</View>
      {size.width > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: size.width,
            height: size.height,
            overflow: 'hidden',
            transformOrigin: 'left',
            transform: [{ scaleX: opening }],
          }}
        >
          <Animated.View style={{ width: size.width, height: size.height, transformOrigin: 'left', transform: [{ scaleX: counter }] }}>{copy}</Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A promise: arrives from below as its top crosses 90% of the screen, and its marker lights as it crosses 65%. */
function Benefit({ item, index }: { item: (typeof PROMISE.items)[number]; index: number }) {
  const motion = useScrollMotion();
  const { attach, measured, onLayout } = useElementTop();
  const float = useAnimatedValue(0);

  // `cn-float`: the icon bobs 5px over 6s, each out of step with its neighbours.
  useEffect(() => {
    if (!motion || motion.reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: -5,
          duration: 3000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 3000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    const timer = setTimeout(() => loop.start(), (index % 3) * 1500);
    return () => {
      clearTimeout(timer);
      loop.stop();
    };
  }, [float, index, motion]);

  let lit: Animated.AnimatedInterpolation<number> | number = 1;
  if (motion && !motion.reduceMotion && measured && motion.viewport > 0) {
    const at = measured.top - motion.viewport * 0.65;
    lit = motion.scrollY.interpolate({
      inputRange: [at, at + 70],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });
  }

  return (
    <View ref={attach} onLayout={onLayout}>
      <Reveal y={60} duration={1200} startAt={0.9}>
        <View style={styles.benefit} accessible accessibilityLabel={`${item.title}. ${item.body}`}>
          <Animated.View style={[styles.iconWrap, { transform: [{ translateY: float }] }]}>
            <Animated.View style={[StyleSheet.absoluteFill, styles.iconLit, { opacity: lit }]} />
            <Ionicons name={item.icon as keyof typeof Ionicons.glyphMap} size={22} color={colors.goldLight} />
          </Animated.View>
          <View style={styles.benefitText}>
            <Text variant="bodyStrong" color="white" style={styles.benefitTitle}>
              {item.title}
            </Text>
            <Text variant="small" color="onDark2" style={styles.benefitBody}>
              {item.body}
            </Text>
          </View>
        </View>
      </Reveal>
    </View>
  );
}

/**
 * "Travel without limits." and the eight promises (`.cine-why` in index.html and `setupWhy()` in home-cinema.js).
 * The panel opens out of the page as it arrives (scale .95 to 1, the site's value below 900px), the statement fills
 * word by word as the page is scrolled, the rail draws down the list and each promise arrives and lights its marker.
 * The site's SVG arcs are drawn here as bordered circles.
 */
export function PromiseSection() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { attach: attachPanel, onLayout: onPanelLayout, measured: panelMeasured } = useElementTop();
  const { attach: attachTrack, onLayout: onTrackLayout, measured: trackMeasured } = useElementTop();

  // Panel: `top bottom` to `top 15%`. Statement: panel `top 75%` to `top 10%`. Rail: track `top 65%` to `bottom 65%`.
  const open = useScrub(panelMeasured, 1, 0.15);
  const turn = useScrub(panelMeasured, 1, 0, true);
  const fill = useScrub(panelMeasured, 0.75, 0.1);
  const rail = useScrub(trackMeasured, 0.65, 0.65, true);

  const scale = mapTo(open, [0.95, 1]);

  return (
    <View ref={attachPanel} onLayout={onPanelLayout} style={styles.outer}>
      <Animated.View style={[styles.panelFrame, { transform: [{ scale }], transformOrigin: 'top' }]}>
        <LinearGradient colors={['#0C1424', '#070B14']} style={styles.panel} onLayout={(e) => setSize(e.nativeEvent.layout)}>
          {/* The two glows: gold from the top right, coral from the bottom left. */}
          {size.height > 0 ? (
            <>
              <Glow rgb="217,178,111" alpha={0.16} rx={size.width * 0.42} ry={size.height * 0.35} at={{ x: size.width * 0.85, y: 0 }} />
              <Glow rgb="201,72,47" alpha={0.12} rx={size.width * 0.35} ry={size.height * 0.28} at={{ x: 0, y: size.height }} />
            </>
          ) : null}
          <Arcs rotate={turn} />

          <Reveal style={styles.lead} y={30} startAt={0.82}>
            <Kicker text={PROMISE.kicker} onDark />
            <View accessible accessibilityRole="header" accessibilityLabel={WORDS.join(' ')}>
              {WORDS.map((w, i) => (
                <FillWord key={w} text={w} accent={i === 1} fill={slice(fill, (i * 0.85) / TIMELINE, (i * 0.85 + 1) / TIMELINE)} />
              ))}
            </View>
            <Text variant="body" color="onDark2" style={styles.sub}>
              {PROMISE.sub}
            </Text>
          </Reveal>

          <View ref={attachTrack} onLayout={onTrackLayout} style={styles.list}>
            <View style={styles.rail}>
              <Animated.View style={[StyleSheet.absoluteFill, styles.railFill, { transformOrigin: 'top', transform: [{ scaleY: rail }] }]} />
            </View>
            {PROMISE.items.map((item, i) => (
              <Benefit key={item.title} item={item} index={i} />
            ))}
          </View>
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // `.cine-why-panel`: 8px in from each edge, 22px corners, 96px above and below.
  outer: { paddingHorizontal: spacing.s2, marginTop: spacing.s8 },
  panelFrame: { borderRadius: 22, overflow: 'hidden' },
  panel: {
    paddingTop: 96,
    paddingBottom: 96,
    paddingHorizontal: spacing.s5,
    gap: 40,
    overflow: 'hidden',
  },
  lead: { gap: spacing.s4 },
  word: { alignSelf: 'flex-start' },
  // `.cine-statement`: Playfair 500 upper-case, 54px on .9 lines, -.02em, one word to a line.
  statement: { fontSize: 54, lineHeight: 49, letterSpacing: -1.08 },
  accent: { fontFamily: fontFamily.displayItalic },
  dim: { opacity: 0.3 },
  sub: { marginTop: spacing.s3, fontSize: 16, lineHeight: 27, maxWidth: 300 },
  arcs: { position: 'absolute' },
  arc: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(217,178,111,0.14)',
  },
  list: { position: 'relative' },
  // `.cine-why-rail`: a hairline through the icon column, 34px in from the top and bottom.
  rail: {
    position: 'absolute',
    left: 27,
    top: 34,
    bottom: 34,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  railFill: { backgroundColor: colors.gold },
  benefit: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 26,
    paddingVertical: 26,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(217,178,111,0.4)',
    backgroundColor: '#0D1526',
    // The 6px ring in the page's colour that lets the rail pass behind the marker.
    shadowColor: '#070B14',
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    overflow: 'hidden',
  },
  iconLit: {
    borderRadius: 28,
    backgroundColor: '#1F1A0D',
    borderWidth: 1,
    borderColor: colors.gold,
  },
  benefitText: { flex: 1, gap: 6, paddingTop: 6 },
  benefitTitle: {
    fontSize: 18,
    lineHeight: 24,
    fontFamily: fontFamily.sansBold,
    letterSpacing: -0.09,
  },
  benefitBody: { fontSize: 14.5, lineHeight: 24 },
});
