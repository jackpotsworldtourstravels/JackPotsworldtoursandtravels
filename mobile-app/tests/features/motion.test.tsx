import { renderHook } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import { DestinationGrid, FIRST_SHOWN } from '@/features/home/DestinationGrid';
import { mapTo, Reveal, ScrollMotionProvider, slice, useScrub, type RevealState, type ScrollMotion } from '@/features/motion/ScrollMotion';

import { destinations } from '../fixtures/discovery';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);

function motion(over: Partial<ScrollMotion> = {}): ScrollMotion {
  return {
    scrollY: new Animated.Value(0),
    viewport: 800,
    reduceMotion: false,
    content: null,
    current: () => 0,
    subscribe: () => () => undefined,
    ...over,
  };
}

const withMotion = (value: ScrollMotion) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <ScrollMotionProvider value={value}>{children}</ScrollMotionProvider>;
  };

const valueOf = (node: unknown) => (node as { __getValue: () => number }).__getValue();

describe('scrub: the scroll position mapped onto 0..1, as ScrollTrigger does', () => {
  it('runs from the element’s top at `from` of the screen height to its top at `to`', async () => {
    const m = motion();
    // An element whose top is at 1000 in a 800-high screen: it starts when its top is at the screen's foot (scroll 200)
    // and ends when its top is 15% down the screen (scroll 880).
    const { result } = await renderHook(() => useScrub({ top: 1000, height: 400 }, 1, 0.15), { wrapper: withMotion(m) });
    const progress = result.current as Animated.AnimatedInterpolation<number>;
    m.scrollY.setValue(0);
    expect(valueOf(progress)).toBe(0);
    m.scrollY.setValue(200);
    expect(valueOf(progress)).toBe(0);
    m.scrollY.setValue(540);
    expect(valueOf(progress)).toBeCloseTo(0.5, 5);
    m.scrollY.setValue(880);
    expect(valueOf(progress)).toBe(1);
    m.scrollY.setValue(5000);
    expect(valueOf(progress)).toBe(1); // it holds at the end, as a scrubbed tween does
  });

  it('can end from the element’s bottom edge (the rail draws until the list’s foot reaches the line)', async () => {
    const m = motion();
    const { result } = await renderHook(() => useScrub({ top: 1000, height: 400 }, 0.65, 0.65, true), { wrapper: withMotion(m) });
    const progress = result.current as Animated.AnimatedInterpolation<number>;
    m.scrollY.setValue(480); // top at 65% of the screen
    expect(valueOf(progress)).toBe(0);
    m.scrollY.setValue(880); // bottom at 65%
    expect(valueOf(progress)).toBe(1);
  });

  it('is simply "finished" (1) when nothing has been measured, with reduced motion, or outside a scroll screen', async () => {
    expect((await renderHook(() => useScrub(null, 1, 0))).result.current).toBe(1);
    expect((await renderHook(() => useScrub({ top: 1000, height: 10 }, 1, 0), { wrapper: withMotion(motion({ reduceMotion: true })) })).result.current).toBe(1);
    expect((await renderHook(() => useScrub({ top: 1000, height: 10 }, 1, 0), { wrapper: withMotion(motion({ viewport: 0 })) })).result.current).toBe(1);
  });

  it('maps onto ranges and onto slices of a timeline', async () => {
    const m = motion();
    const { result } = await renderHook(() => useScrub({ top: 1000, height: 400 }, 1, 0.15), { wrapper: withMotion(m) });
    const p = result.current as Animated.AnimatedInterpolation<number>;
    const scaled = mapTo(p, [0.95, 1]);
    const second = slice(p, 0.5, 1);
    m.scrollY.setValue(200);
    expect(valueOf(scaled)).toBeCloseTo(0.95, 5);
    expect(valueOf(second)).toBe(0);
    m.scrollY.setValue(880);
    expect(valueOf(scaled)).toBe(1);
    expect(valueOf(second)).toBe(1);
    expect(mapTo(1, [0.95, 1])).toBe(1); // the resting value when there is no motion
  });
});

describe('the destinations grid is laid out with explicit heights', () => {
  // On the phone every card measured {width: 328, height: 0} because `aspectRatio` is ignored for a stretched row item
  // on Android: the whole grid drew nothing and left a blank gap. Heights are now stated.
  it('gives every card a real height, with no aspectRatio to resolve', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...destinations[0], id: `place-${i}`, name: `Place ${i}`, image: null }));
    await render(<DestinationGrid destinations={many} onOpen={() => undefined} />);
    const cards = screen.getAllByRole('button', { name: /^Explore Place/ });
    expect(cards).toHaveLength(FIRST_SHOWN);
    cards.forEach((card, i) => {
      const style = StyleSheet.flatten(card.props.style);
      expect(style.aspectRatio).toBeUndefined();
      expect(style.height).toBeGreaterThan(50);
      // The site's proportions: every third card is 16:10, the rest 4:3.
      const ratio = i % 3 === 0 ? 16 / 10 : 4 / 3;
      expect(style.height).toBe(Math.round((style.width as number) / ratio));
    });
  });
});

describe('an arrival (Reveal) never leaves content hidden', () => {
  afterEach(() => jest.useRealTimers());

  it('shows at once outside a scroll screen, and with reduced motion', async () => {
    let seen: RevealState | null = null;
    await render(<Reveal>{(state) => ((seen = state), <></>)}</Reveal>);
    expect(valueOf(seen!.progress)).toBe(1);

    seen = null;
    await render(
      <ScrollMotionProvider value={motion({ reduceMotion: true })}>
        <Reveal>{(state) => ((seen = state), <></>)}</Reveal>
      </ScrollMotionProvider>,
    );
    expect(valueOf(seen!.progress)).toBe(1);
  });

  it('starts hidden in a scroll screen, and the time-based floor plays it even if it was never measured on screen', async () => {
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    let seen: RevealState | null = null;
    // No layout ever arrives in a test, so the element is never measured: the floor must still play the arrival.
    await render(
      <ScrollMotionProvider value={motion()}>
        <Reveal duration={50}>{(state) => ((seen = state), <></>)}</Reveal>
      </ScrollMotionProvider>,
    );
    expect(valueOf(seen!.progress)).toBe(0);
    expect(timing).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2600);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({ toValue: 1, duration: 50, useNativeDriver: true });
    timing.mockRestore();
  });
});
