import { act, renderHook } from '@testing-library/react-native';

import { HANDOFF_MS, hrefFor, RETURN_TTL_MS, returnTo, routeKey } from '@/features/auth/returnTo';
import { SETTLE_MS, useReturnAfterSignIn } from '@/features/auth/useReturnTo';

import { resetNavigation, routeLocation, router } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);

const HOTEL = { at: '/book/hotel', href: '/book/hotel?hotelId=4&roomId=10' as never, tab: false };
const PROFILE_TAB = { at: '/profile', href: '/profile' as never, tab: true };
const DRAFT = { kind: 'hotel' as const, values: { email: 'a@example.com' }, coupon: 'STAYMORE', route: '/book/hotel?hotelId=4&roomId=10' };

beforeEach(() => {
  returnTo.clear();
  resetNavigation({}, { pathname: '/book/hotel', segments: ['book', 'hotel'] });
});

describe('route identity', () => {
  it('is the same for the same screen and parameters in any order, and differs when a parameter does', () => {
    expect(routeKey('/book/hotel', { roomId: '10', hotelId: '4' })).toBe(routeKey('/book/hotel', { hotelId: '4', roomId: '10' }));
    expect(routeKey('/book/hotel', { hotelId: '4', roomId: '11' })).not.toBe(routeKey('/book/hotel', { hotelId: '4', roomId: '10' }));
    expect(routeKey('/book/hotel', { hotelId: '4', gone: undefined })).toBe(routeKey('/book/hotel', { hotelId: '4' }));
  });

  it('builds an openable path with its query, and a bare path when there is none', () => {
    expect(hrefFor('/book/hotel', { roomId: '10', hotelId: '4' })).toBe('/book/hotel?hotelId=4&roomId=10');
    expect(hrefFor('/bookings', {})).toBe('/bookings');
  });
});

describe('the store', () => {
  it('hands the place back once, and only once', () => {
    returnTo.set(HOTEL);
    expect(returnTo.take()).toEqual(HOTEL);
    expect(returnTo.take()).toBeNull();
  });

  it('lets a place go stale: a detour from long ago must not pull someone back later', () => {
    returnTo.set(HOTEL, DRAFT, 1_000);
    expect(returnTo.take(1_000 + RETURN_TTL_MS + 1)).toBeNull();
    expect(returnTo.draftFor('hotel', DRAFT.route, 1_000 + 1)).toBeNull(); // the draft went with it
  });

  it('gives a saved form only to the same kind of booking on the same route, and not once stale', () => {
    returnTo.set(HOTEL, DRAFT, 5_000);
    expect(returnTo.draftFor('hotel', DRAFT.route, 5_001)?.values).toEqual({ email: 'a@example.com' });
    expect(returnTo.draftFor('package', DRAFT.route, 5_001)).toBeNull();
    expect(returnTo.draftFor('hotel', '/book/hotel?hotelId=4&roomId=11', 5_001)).toBeNull();
    expect(returnTo.draftFor('hotel', DRAFT.route, 5_000 + RETURN_TTL_MS + 1)).toBeNull();
  });

  it('stops offering a saved form a few seconds after the customer has been taken back, so an unclaimed copy cannot linger', () => {
    returnTo.set(HOTEL, DRAFT, 10_000);
    expect(returnTo.take(20_000)).toEqual(HOTEL);
    expect(returnTo.draftFor('hotel', DRAFT.route, 20_000 + HANDOFF_MS - 1)).not.toBeNull();
    expect(returnTo.draftFor('hotel', DRAFT.route, 20_000 + HANDOFF_MS)).toBeNull();
  });

  it('keeps no draft when none was offered, and forgets it when asked', () => {
    returnTo.set(HOTEL);
    expect(returnTo.draftFor('hotel', DRAFT.route)).toBeNull();
    returnTo.set(HOTEL, DRAFT);
    returnTo.clearDraft();
    expect(returnTo.draftFor('hotel', DRAFT.route)).toBeNull();
    expect(returnTo.take()).toEqual(HOTEL);
  });
});

describe('returning after sign-in', () => {
  const go = (to: { pathname: string; segments: string[] }) => {
    routeLocation.pathname = to.pathname;
    routeLocation.segments = to.segments;
  };
  const AUTH = { pathname: '/sign-in', segments: ['(auth)', 'sign-in'] };
  const VERIFY = { pathname: '/verify', segments: ['(auth)', 'verify'] };
  const HOME = { pathname: '/', segments: ['(tabs)'] };
  const BOOKING = { pathname: '/book/hotel', segments: ['book', 'hotel'] };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function mount(session = false) {
    return renderHook(({ s }: { s: boolean }) => useReturnAfterSignIn(s), { initialProps: { s: session } });
  }
  /** Let the router sit still long enough for the app to decide. */
  const settle = () => act(async () => void jest.advanceTimersByTime(SETTLE_MS + 10));

  it('does not decide while the router is still moving: it passes through other screens before it settles', async () => {
    const hook = await mount();
    returnTo.set(HOTEL, DRAFT);
    go(AUTH);
    await hook.rerender({ s: false });

    // As on web: the session appears, then sign-in, verify and Home flash by before the old booking screen is back.
    await hook.rerender({ s: true });
    go(VERIFY);
    await hook.rerender({ s: true });
    go(HOME);
    await hook.rerender({ s: true });
    await act(async () => void jest.advanceTimersByTime(SETTLE_MS / 2));
    go(BOOKING);
    await hook.rerender({ s: true });
    await settle();

    expect(router.dismissTo).not.toHaveBeenCalled(); // no second copy of the form on top of the first
    expect(returnTo.isPending()).toBe(false);
    expect(returnTo.draftFor('hotel', DRAFT.route)).toBeNull();
  });

  it('opens the screen the customer left when the router settles somewhere else', async () => {
    const hook = await mount();
    returnTo.set(HOTEL, DRAFT);
    go(AUTH);
    await hook.rerender({ s: false });

    go(HOME);
    await hook.rerender({ s: true });
    expect(router.dismissTo).not.toHaveBeenCalled(); // not yet: it might still be moving
    await settle();

    expect(router.dismissTo).toHaveBeenCalledTimes(1);
    expect(router.dismissTo).toHaveBeenCalledWith(HOTEL.href);
    expect(returnTo.isPending()).toBe(false);
    expect(returnTo.draftFor('hotel', DRAFT.route)).not.toBeNull(); // kept for the screen about to mount
  });

  it('switches back to a TAB with navigate: dismissing screens cannot reach a tab, and a second copy must not be pushed', async () => {
    const hook = await mount();
    returnTo.set(PROFILE_TAB);
    go(AUTH);
    await hook.rerender({ s: true });

    go(HOME);
    await hook.rerender({ s: true });
    await settle();

    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith('/profile');
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('does nothing when the router already shows that screen again (a native stack), and drops the saved form', async () => {
    const hook = await mount();
    returnTo.set(HOTEL, DRAFT);
    go(AUTH);
    await hook.rerender({ s: false });

    go(BOOKING);
    await hook.rerender({ s: true });
    await settle();

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(returnTo.draftFor('hotel', DRAFT.route)).toBeNull();
  });

  it('waits while the sign-in screens are still showing, however long that takes', async () => {
    const hook = await mount();
    returnTo.set(HOTEL);
    go(AUTH);
    await hook.rerender({ s: false });
    await hook.rerender({ s: true });
    await settle();

    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(returnTo.isPending()).toBe(true);
  });

  it('forgets the detour if the customer backs out of sign-in, so a later sign-in elsewhere is not hijacked', async () => {
    const hook = await mount();
    returnTo.set(HOTEL, DRAFT);
    go(AUTH);
    await hook.rerender({ s: false });

    go(BOOKING); // closed the sign-in screen without signing in
    await hook.rerender({ s: false });
    expect(returnTo.isPending()).toBe(false);

    go({ pathname: '/profile', segments: ['(tabs)', 'profile'] });
    await hook.rerender({ s: false });
    go(HOME);
    await hook.rerender({ s: true }); // signs in later, from somewhere else
    await settle();

    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('does not push anyone anywhere when there was no detour', async () => {
    const hook = await mount();
    go(AUTH);
    await hook.rerender({ s: false });
    go(HOME);
    await hook.rerender({ s: true });
    await settle();
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('does not push for a detour that has expired', async () => {
    const hook = await mount();
    returnTo.set(HOTEL, undefined, Date.now() - RETURN_TTL_MS - 1);
    go(AUTH);
    await hook.rerender({ s: false });
    go(HOME);
    await hook.rerender({ s: true });
    await settle();
    expect(router.dismissTo).not.toHaveBeenCalled();
  });
});
