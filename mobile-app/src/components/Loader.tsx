import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

/**
 * The app's two loaders, built from React Native's own Animated API (no extra native module):
 *
 *   TakeoffLoader  a gold plane rolls down a runway, lifts off and climbs away, then the next one starts. For the
 *                  big waits: a screen or a section loading, a search running, a payment being confirmed.
 *   CircleLoader   a plain gold arc turning on a ring. Inside buttons and small inline spots, where a plane would
 *                  be too busy.
 *
 * Both hold still when the phone's "reduce motion" setting is on, and in tests (an endless animation would keep the
 * test runner waiting).
 */

type Tone = 'onLight' | 'onDark';

const ANIMATE = process.env.NODE_ENV !== 'test';

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduce(value))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** A 0→1 value that repeats forever (unless motion is reduced). */
export function useLoop(duration: number, easing: (t: number) => number = Easing.linear) {
  const [value] = useState(() => new Animated.Value(0));
  const reduce = useReduceMotion();
  useEffect(() => {
    if (!ANIMATE || reduce) return;
    const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [duration, easing, reduce, value]);
  return value;
}

export function CircleLoader({ size = 20, tone = 'onLight', label = 'Loading' }: { size?: number; tone?: Tone; label?: string }) {
  const spin = useLoop(900);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const stroke = Math.max(2, Math.round(size / 9));
  const ring = { width: size, height: size, borderRadius: size / 2, borderWidth: stroke };
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={{ width: size, height: size }}>
      <View style={[StyleSheet.absoluteFill, ring, { borderColor: tone === 'onDark' ? colors.navyTrack : colors.line }]} />
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          ring,
          { borderColor: 'transparent', borderTopColor: tone === 'onDark' ? colors.gold : colors.goldDeep, transform: [{ rotate }] },
        ]}
      />
    </View>
  );
}

/**
 * CSS keyframe timing, which eases EACH segment between two keyframes (the mockup's cubic-bezier(.45,0,.55,1)),
 * turned into one Animated interpolation: every segment is sampled along the curve so a single linear 0→1 loop
 * reproduces it.
 */
const SEGMENT_EASE = Easing.bezier(0.45, 0, 0.55, 1);

function keyframes(stops: readonly (readonly [number, number])[], steps = 6): { inputRange: number[]; outputRange: number[] } {
  const inputRange = [stops[0][0]];
  const outputRange = [stops[0][1]];
  for (let i = 1; i < stops.length; i++) {
    const [t0, v0] = stops[i - 1];
    const [t1, v1] = stops[i];
    for (let k = 1; k <= steps; k++) {
      inputRange.push(t0 + ((t1 - t0) * k) / steps);
      outputRange.push(v0 + (v1 - v0) * SEGMENT_EASE(k / steps));
    }
  }
  return { inputRange, outputRange };
}

/** The mockup's colours, for the take-off on navy and on a light page. */
const PALETTE = {
  onDark: { runway: '#13294A', dash: '#D4AF5A', dashOpacity: 0.55, shadow: '#000000', shadowOpacity: 0.4, tail: '#B48A2E', body: '#E9CD85', wing: '#D4AF5A', detail: '#B48A2E', wheel: '#7A5C16', cockpit: '#07111F', light: '#D4AF5A' },
  onLight: { runway: '#E4E7EC', dash: '#B48A2E', dashOpacity: 0.7, shadow: '#0B1D35', shadowOpacity: 0.35, tail: '#8A6A1F', body: '#C9A24B', wing: '#B48A2E', detail: '#8A6A1F', wheel: '#7A5C16', cockpit: '#07111F', light: '#B48A2E' },
} as const;

const LIGHT_EASE = Easing.inOut(Easing.ease);

/** One runway edge light: brightens and dims on a 1.3 s cycle, each a little after the one before. */
function RunwayLight({ t, phase, left, top, size, color }: { t: Animated.Value; phase: number; left: number; top: number; size: number; color: string }) {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let k = 0; k <= 26; k++) {
    const x = k / 26;
    const p = (((x - phase) % 1) + 1) % 1;
    const rise = p < 0.5 ? LIGHT_EASE(p / 0.5) : LIGHT_EASE((1 - p) / 0.5);
    inputRange.push(x);
    outputRange.push(0.25 + 0.75 * rise);
  }
  return <Animated.View style={{ position: 'absolute', left, top, width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: t.interpolate({ inputRange, outputRange }) }} />;
}

/**
 * The take-off, drawn from the mockup's own shapes: a side-view airliner (tail fin, tailplane, body, swept wing,
 * engine, cockpit window, cabin windows, wheels) on a runway whose centre line streams past. One 2.6 s loop: fade in
 * and roll (0–50%), lift the nose (50–62%), climb away and fade (62–100%), with the mockup's easing on every leg. The
 * shadow stays on the ground and shrinks as the plane leaves it; on navy the runway's edge lights pulse in turn.
 *
 * Geometry is in the mockup's 200 × 100 units (its SVG viewBox "0 10 200 100") scaled by `width`.
 */
export function TakeoffLoader({ width = 220, tone = 'onLight', label = 'Loading' }: { width?: number; tone?: Tone; label?: string }) {
  const t = useLoop(2600);
  const dash = useLoop(500);
  const lights = useLoop(1300);
  const s = width / 200;
  const height = width * 0.5;
  const dark = tone === 'onDark';
  const c = PALETTE[tone];
  const u = (v: number) => v * s;
  // The mockup's y runs from 10 to 110; shift everything up by 10 units.
  const Y = (v: number) => (v - 10) * s;

  const x = t.interpolate(keyframes([[0, -80 * s], [0.5, -5 * s], [0.62, 22 * s], [0.85, 70 * s], [1, 100 * s]]));
  const y = t.interpolate(keyframes([[0, 0], [0.5, 0], [0.62, -4 * s], [0.85, -38 * s], [1, -60 * s]]));
  const turn = keyframes([[0, 0], [0.5, 0], [0.62, -10], [0.85, -16], [1, -16]]);
  const rotate = t.interpolate({ inputRange: turn.inputRange, outputRange: turn.outputRange.map((d) => `${d}deg`) });
  const opacity = t.interpolate(keyframes([[0, 0], [0.08, 1], [0.85, 1], [1, 0]]));
  const shadowX = t.interpolate(keyframes([[0, -80 * s], [0.5, -5 * s], [0.62, 22 * s], [0.85, 55 * s], [1, 55 * s]]));
  const shadowScale = t.interpolate(keyframes([[0, 1], [0.5, 1], [0.62, 0.75], [0.85, 0.3], [1, 0.3]]));
  const so = c.shadowOpacity;
  const shadowOpacity = t.interpolate(keyframes([[0, 0], [0.08, so], [0.5, so], [0.62, so * 0.6], [0.85, 0], [1, 0]]));
  // stroke-dashoffset 0 → 36 every 0.5 s: two 18-unit dash periods, so the loop is seamless.
  const dashX = dash.interpolate({ inputRange: [0, 1], outputRange: [0, -36 * s] });
  const dashes = Array.from({ length: Math.ceil(172 / 18) + 3 }, (_, i) => i);

  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={{ width, height }}>
      {/* Runway, with its dashed centre line streaming left. */}
      <View style={{ position: 'absolute', left: u(8), top: Y(95), width: u(184), height: u(7), borderRadius: u(3.5), backgroundColor: c.runway }} />
      <View style={{ position: 'absolute', left: u(14), top: Y(98.5) - u(0.8), width: u(172), height: u(1.6), overflow: 'hidden' }}>
        <Animated.View style={[styles.dashRow, { transform: [{ translateX: dashX }] }]}>
          {dashes.map((i) => (
            <View key={i} style={{ width: u(8), marginRight: u(10), height: u(dark ? 1.4 : 1.6), backgroundColor: c.dash, opacity: c.dashOpacity }} />
          ))}
        </Animated.View>
      </View>
      {dark
        ? [20, 52, 84, 116, 148, 180].map((cx, i) => (
            <RunwayLight key={cx} t={lights} phase={(i * 0.15) / 1.3} left={u(cx - 1.3)} top={Y(108 - 1.3)} size={u(2.6)} color={c.light} />
          ))
        : null}

      {/* Shadow on the ground. */}
      <Animated.View
        style={{
          position: 'absolute',
          left: u(81),
          top: Y(96 - 2.4),
          width: u(38),
          height: u(4.8),
          borderRadius: u(2.4),
          backgroundColor: c.shadow,
          opacity: shadowOpacity,
          transform: [{ translateX: shadowX }, { scaleX: shadowScale }, { scaleY: shadowScale }],
        }}
      />

      {/* The plane, in its own 47 × 21 box at (76, 77). */}
      <Animated.View style={{ position: 'absolute', left: u(76), top: Y(77), width: u(47), height: u(21), opacity, transform: [{ translateX: x }, { translateY: y }, { rotate }] }}>
        {/* Tail fin and tailplane, behind the body. */}
        <View style={{ position: 'absolute', left: u(3), top: u(1), width: u(6.5), height: u(7), backgroundColor: c.tail, transform: [{ skewX: '26.6deg' }] }} />
        <View style={{ position: 'absolute', left: u(2.5), top: u(11), width: u(4), height: u(4), backgroundColor: c.tail, transform: [{ skewX: '-41deg' }] }} />
        {/* Body: round at the tail, a blunt nose. */}
        <View style={{ position: 'absolute', left: u(2), top: u(8), width: u(45), height: u(6), borderRadius: u(3), backgroundColor: c.body }} />
        {/* Swept wing, over the body. */}
        <View style={{ position: 'absolute', left: u(16), top: u(11.5), width: u(8.25), height: u(8.5), backgroundColor: c.wing, transform: [{ skewX: '-45.8deg' }] }} />
        {dark ? <View style={{ position: 'absolute', left: u(19), top: u(13.8), width: u(6), height: u(2.8), borderRadius: u(1.4), backgroundColor: c.detail }} /> : null}
        {/* Cockpit window. */}
        <View style={{ position: 'absolute', left: u(41.43), top: u(9.6), width: u(3.64), height: u(1.2), borderRadius: u(0.6), backgroundColor: c.cockpit, transform: [{ rotate: '16deg' }] }} />
        {dark ? (
          <>
            <View style={[styles.windows, { left: u(14), top: u(10.2), height: u(0.8), gap: u(1.6) }]}>
              {Array.from({ length: 8 }, (_, i) => (
                <View key={i} style={{ width: u(1.4), height: u(0.8), backgroundColor: c.detail }} />
              ))}
            </View>
            <View style={{ position: 'absolute', left: u(11.6), top: u(14.2), width: u(2.8), height: u(2.8), borderRadius: u(1.4), backgroundColor: c.wheel }} />
            <View style={{ position: 'absolute', left: u(34.6), top: u(14.2), width: u(2.8), height: u(2.8), borderRadius: u(1.4), backgroundColor: c.wheel }} />
          </>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  dashRow: { flexDirection: 'row', alignItems: 'center' },
  windows: { position: 'absolute', flexDirection: 'row' },
});
