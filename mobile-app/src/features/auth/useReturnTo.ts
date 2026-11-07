import { useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { hrefFor, returnTo, routeKey, type Draft } from './returnTo';

/**
 * How long the router must sit still before the app decides whether the customer
 * is already back. When the session appears, the sign-in group is removed and the
 * router passes through intermediate screens (seen on web: sign-in, verify, Home)
 * before it settles, in a few frames, on whatever remains of the old stack. Acting
 * on one of those passing screens would open a second copy of the booking form
 * on top of the first.
 */
export const SETTLE_MS = 400;

/** The screen the customer is on, as the router sees it right now. */
function useRoute() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const segments = useSegments() as string[];
  return { pathname, key: routeKey(pathname, params), href: hrefFor(pathname, params), tab: segments[0] === '(tabs)' };
}

/**
 * Send a signed-out customer to sign in (or sign up) and bring them back here.
 * Pass the booking form as `draft` if there is one to keep.
 */
export function useAuthDetour() {
  const router = useRouter();
  const route = useRoute();
  return (to: '/sign-in' | '/sign-up', draft?: Draft) => {
    returnTo.set({ at: route.pathname, href: route.href, tab: route.tab }, draft ? { ...draft, route: route.key } : undefined);
    router.push(to);
  };
}

/**
 * The form this screen had before the customer left to sign in, if they are
 * coming back to it. Read once when the screen mounts and deleted straight
 * after, so it can never leak into a later visit.
 */
export function useRestoredDraft<T>(kind: Draft['kind']): { values: T; coupon: string | undefined } | null {
  const { key } = useRoute();
  const [restored] = useState(() => {
    const found = returnTo.draftFor(kind, key);
    return found ? { values: found.values as T, coupon: found.coupon } : null;
  });
  useEffect(() => {
    returnTo.clearDraft();
  }, []);
  return restored;
}

/**
 * Mounted once at the root. When a session appears after a detour to sign-in,
 * return to where the customer was: once the router has settled, if it already
 * shows that screen there is nothing to do; if not, open it. Backing out of
 * sign-in forgets the detour, so signing in later from somewhere else is never
 * hijacked.
 */
export function useReturnAfterSignIn(hasSession: boolean): void {
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments() as string[];
  const inAuth = segments[0] === '(auth)';
  const sawAuth = useRef(false);

  useEffect(() => {
    if (inAuth) {
      sawAuth.current = true;
      return;
    }
    if (!hasSession) {
      if (sawAuth.current) {
        sawAuth.current = false;
        returnTo.clear();
      }
      return;
    }
    sawAuth.current = false;
    if (!returnTo.isPending()) return;

    // Any change of screen re-runs this effect and cancels the timer, so when it fires
    // `pathname` is the one the router came to rest on.
    const timer = setTimeout(() => {
      const target = returnTo.take();
      if (!target) return;
      if (pathname === target.at) returnTo.clearDraft();
      // A tab is reached by switching to it. Any other screen: back to it if it is still in the stack
      // (form and all), otherwise open it in place of wherever the router left the customer. Never a
      // second copy on top.
      else if (target.tab) router.navigate(target.href);
      else router.dismissTo(target.href);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [hasSession, inAuth, pathname, router]);
}
