import { createContext, type ComponentRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/**
 * SCROLL MOTION: the website's scroll-driven animation, for a phone.
 *
 * The website's Home animates with GSAP ScrollTrigger (`frontend/assets/js/home-cinema.js`): things ARRIVE (fade, rise,
 * settle) when their top edge crosses a line of the viewport, and a few things are SCRUBBED (tied to the scroll
 * position: the Why panel opening, the rail drawing, the statement filling, the finale photograph opening). This is the
 * same model with React Native's built-in `Animated`, no extra native module:
 *   - `<Reveal>`   arrives once, when its top crosses `startAt` of the viewport height (ScrollTrigger `start: 'top 90%'`).
 *   - `useScrub()` maps the scroll position between two viewport lines onto 0..1 (ScrollTrigger `scrub`).
 * Everything that moves is opacity or transform, so it runs on the native thread. With "reduce motion" on, nothing
 * moves: everything is simply where it ends up, as `prefers-reduced-motion` does on the site.
 *
 * NOTHING IS LEFT HIDDEN. The site's own comment (`heal()`) explains why: a trigger measured at the wrong moment must
 * not leave content blank for good. Every hidden-until-arrival element here is re-measured as the page settles, shows
 * itself the moment it is on screen, and has a time-based floor under it.
 */
export interface ScrollMotion {
  scrollY: Animated.Value;
  /** Height of the scroll viewport (0 until the first layout). */
  viewport: number;
  reduceMotion: boolean;
  /** Called with every scroll offset. Returns the unsubscribe. */
  subscribe: (fn: (y: number) => void) => () => void;
  /** The scrolling content's wrapper (set by `setContent`): positions are measured relative to it. */
  content: ViewRef | null;
  /** The latest scroll offset. */
  current: () => number;
}

type ViewRef = ComponentRef<typeof View>;

const ScrollMotionContext = createContext<ScrollMotion | null>(null);

export function ScrollMotionProvider({ value, children }: { value: ScrollMotion; children: ReactNode }) {
  return <ScrollMotionContext.Provider value={value}>{children}</ScrollMotionContext.Provider>;
}

/** The page's motion state, or null outside a scroll-motion screen (then everything simply shows). */
export function useScrollMotion(): ScrollMotion | null {
  return useContext(ScrollMotionContext);
}

/** An Animated.Value created once per component (the lint-clean form of `useRef(new Animated.Value()).current`). */
export function useAnimatedValue(initial: number): Animated.Value {
  const [value] = useState(() => new Animated.Value(initial));
  return value;
}

/** State and handlers for a scrolling screen that supports motion. `Screen` calls this and spreads `scrollProps`. */
export function useScrollMotionState() {
  const scrollY = useAnimatedValue(0);
  // Mutable bookkeeping, held in one stable object so no ref is read while rendering.
  const [store] = useState(() => ({ y: 0, listeners: new Set<(y: number) => void>() }));
  const [content, setContent] = useState<ViewRef | null>(null);
  const [viewport, setViewport] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduceMotion(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const [onScroll] = useState(() =>
    Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
      listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        store.y = e.nativeEvent.contentOffset.y;
        store.listeners.forEach((fn) => fn(store.y));
      },
    }),
  );

  const value = useMemo<ScrollMotion>(
    () => ({
      scrollY,
      viewport,
      reduceMotion,
      content,
      current: () => store.y,
      subscribe: (fn) => {
        store.listeners.add(fn);
        return () => {
          store.listeners.delete(fn);
        };
      },
    }),
    [scrollY, viewport, reduceMotion, content, store],
  );

  const onScrollLayout = useCallback((e: LayoutChangeEvent) => setViewport(e.nativeEvent.layout.height), []);

  return {
    value,
    setContent,
    scrollProps: {
      onScroll,
      scrollEventThrottle: 16,
      onLayout: onScrollLayout,
    },
  };
}

interface Measured {
  top: number;
  height: number;
}

/**
 * Where an element sits in the scrolling content. Put `ref={attach}` and `onLayout` on a plain (never transformed) View.
 * Re-measures whenever the View's own frame changes and whenever `remeasure()` is called (the page above it may have
 * grown as images arrived, which does not change this View's own frame). `attach` is a callback ref.
 */
export function useElementTop() {
  const motion = useScrollMotion();
  const content = motion?.content ?? null;
  const [node, setNode] = useState<ViewRef | null>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);

  const remeasure = useCallback(() => {
    if (!node || !content) return;
    try {
      node.measureLayout(
        content,
        (_x, y, _w, h) => setMeasured((prev) => (prev && Math.abs(prev.top - y) < 1 && Math.abs(prev.height - h) < 1 ? prev : { top: y, height: h })),
        () => undefined,
      );
    } catch {
      // Not attached yet; the next layout or scroll will measure it.
    }
  }, [node, content]);

  // The first measurement, once both ends are attached.
  useEffect(() => {
    remeasure();
  }, [remeasure]);

  return { attach: setNode, measured, remeasure, onLayout: remeasure };
}

/**
 * ScrollTrigger `scrub` for an element: 0 when its top edge is at `from` of the viewport height (from the top: 1 is
 * the bottom edge) and 1 when it reaches `to`; `toBottom` measures the end from the element's bottom edge instead.
 * Returns an Animated node, or the number 1 (the resting state) when there is no motion to run.
 */
export function useScrub(measured: Measured | null, from: number, to: number, toBottom = false): Animated.AnimatedInterpolation<number> | number {
  const motion = useScrollMotion();
  if (!motion || motion.reduceMotion || !measured || motion.viewport === 0) return 1;
  const start = measured.top - motion.viewport * from;
  const end = (toBottom ? measured.top + measured.height : measured.top) - motion.viewport * to;
  if (!(end > start)) return 1;
  return motion.scrollY.interpolate({
    inputRange: [start, end],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
}

/** A scrub mapped onto a sub-range of 0..1 (for a timeline: each word fills in its own slice). */
export function slice(progress: Animated.AnimatedInterpolation<number> | number, from: number, to: number): Animated.AnimatedInterpolation<number> | number {
  if (typeof progress === 'number') return progress;
  return progress.interpolate({
    inputRange: [from, to],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
}

/** Map a scrub onto any numeric range. */
export function mapTo(progress: Animated.AnimatedInterpolation<number> | number, outputs: number[], inputs?: number[]): Animated.AnimatedInterpolation<number> | number {
  if (typeof progress === 'number') return outputs[outputs.length - 1];
  const inputRange = inputs ?? outputs.map((_, i) => i / (outputs.length - 1));
  return progress.interpolate({
    inputRange,
    outputRange: outputs,
    extrapolate: 'clamp',
  });
}

/** If the content has not been measured this long after mounting, an element shows itself anyway. */
const FLOOR_MS = 2500;

export interface RevealState {
  /** 0 before arrival, 1 after: drive extra detail (a photograph developing) from it. */
  progress: Animated.Value;
}

/**
 * Arrives once, as ScrollTrigger's `start: 'top 90%'` + `toggleActions: 'play none none none'` do: when the
 * element's top edge crosses `startAt` of the viewport height it fades in while rising `y` and settling from `scale`.
 * `children` may be a function of the arrival progress for anything that should develop with it.
 */
export function Reveal({
  children,
  style,
  y = 40,
  scale = 1,
  duration = 1200,
  delay = 0,
  startAt = 0.9,
  spring = false,
}: {
  children: ReactNode | ((state: RevealState) => ReactNode);
  style?: StyleProp<ViewStyle>;
  y?: number;
  scale?: number;
  duration?: number;
  delay?: number;
  startAt?: number;
  /** An elastic settle (the site's "Plan your journey" button) rather than an ease-out. */
  spring?: boolean;
}) {
  const motion = useScrollMotion();
  const { attach, measured, remeasure, onLayout } = useElementTop();
  const instant = !motion || motion.reduceMotion;
  const progress = useAnimatedValue(instant ? 1 : 0);
  const played = useRef(instant);

  const play = useCallback(() => {
    if (played.current) return;
    played.current = true;
    if (spring)
      Animated.spring(progress, {
        toValue: 1,
        delay,
        friction: 4.5,
        tension: 55,
        useNativeDriver: true,
      }).start();
    else
      Animated.timing(progress, {
        toValue: 1,
        duration,
        delay,
        easing: Easing.out(Easing.exp),
        useNativeDriver: true,
      }).start();
  }, [delay, duration, progress, spring]);

  useEffect(() => {
    if (played.current || !motion) return;
    const trigger = (scrollY: number) => {
      if (measured && scrollY + motion.viewport * startAt >= measured.top) play();
    };
    trigger(motion.current());
    let lastCheck = 0;
    const unsubscribe = motion.subscribe((scrollY) => {
      trigger(scrollY);
      // The page above may still be growing (images arriving): look again, not on every frame.
      const now = Date.now();
      if (!played.current && now - lastCheck > 200) {
        lastCheck = now;
        remeasure();
      }
    });
    return unsubscribe;
  }, [measured, motion, play, remeasure, startAt]);

  // The floor: whatever the measurements said, nothing stays hidden.
  useEffect(() => {
    if (played.current) return;
    const timer = setTimeout(() => {
      if (!motion || motion.viewport === 0 || !measured || measured.top <= motion.current() + motion.viewport) play();
    }, FLOOR_MS);
    return () => clearTimeout(timer);
  }, [measured, motion, play]);

  const opacity = progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, 1, 1],
  });
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [y, 0],
  });
  const scaleValue = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [scale, 1],
  });

  return (
    // The plain outer View is what is measured: a transformed View would report its moved position.
    <View ref={attach} onLayout={onLayout} style={style}>
      <Animated.View style={{ opacity, transform: [{ translateY }, { scale: scaleValue }] }}>
        {typeof children === 'function' ? children({ progress }) : children}
      </Animated.View>
    </View>
  );
}
