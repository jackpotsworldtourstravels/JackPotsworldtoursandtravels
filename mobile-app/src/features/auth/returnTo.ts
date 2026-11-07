import type { Href } from 'expo-router';

/**
 * COMING BACK AFTER SIGN-IN
 *
 * A visitor browses and fills in a booking form signed out; the app asks them to
 * sign in only when they confirm. Sign-in lives in a navigator group that is
 * REMOVED the moment a session exists (so a signed-in customer can never navigate
 * back to it). What the router does with the screens underneath at that moment is
 * the router's business and differs by platform: the web build lands on Home,
 * a native stack may reveal the screen the customer left. The app does not rely
 * on either. It records where the customer was and, once signed in, takes them
 * back if they are not already there.
 *
 * Two things are held, in memory only (never storage, never route params, which
 * end up in the URL on web):
 *
 *  - the place to return to (a route and its query, no secrets);
 *  - the booking form they had filled in, so a screen that was torn down comes
 *    back with names and details intact. A draft is only handed to the screen for
 *    the SAME route, is deleted as soon as that screen has read it, and expires.
 *
 * Both are forgotten if the customer backs out of sign-in without signing in.
 */
export const RETURN_TTL_MS = 15 * 60 * 1000;
/**
 * Once the customer has been taken back, a screen that was torn down reads its form
 * within moments. A screen that was never torn down never reads it, so the copy
 * is thrown away shortly after rather than waiting out the full expiry.
 */
export const HANDOFF_MS = 5_000;

export interface Draft {
  kind: 'hotel' | 'package';
  values: unknown;
  coupon: string | undefined;
}

interface Pending {
  /** The pathname as the router reports it, to recognise "already back". */
  at: string;
  href: Href;
  /** The screen was a tab (Home, Bookings, Profile...), which is reached by switching tab, not by dismissing screens. */
  tab: boolean;
  made: number;
}

interface StoredDraft extends Draft {
  route: string;
  /** Epoch ms after which it is no longer offered. */
  until: number;
}

let pending: Pending | null = null;
let draft: StoredDraft | null = null;

type Params = Record<string, string | string[] | undefined>;

const entries = (params: Params): [string, string][] =>
  Object.entries(params)
    .flatMap(([k, v]): [string, string][] => (v === undefined ? [] : Array.isArray(v) ? v.map((x): [string, string] => [k, x]) : [[k, v]]))
    .sort(([a], [b]) => a.localeCompare(b));

/** A stable identity for "this screen with these parameters". */
export function routeKey(pathname: string, params: Params): string {
  return `${pathname}?${entries(params).map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/** A path with its query, which the router can open. */
export function hrefFor(pathname: string, params: Params): Href {
  const query = new URLSearchParams(entries(params)).toString();
  return (query ? `${pathname}?${query}` : pathname) as Href;
}

const fresh = (made: number, now: number) => now - made < RETURN_TTL_MS;

export const returnTo = {
  set(target: { at: string; href: Href; tab?: boolean }, saved?: Draft & { route: string }, now: number = Date.now()): void {
    pending = { at: target.at, href: target.href, tab: target.tab ?? false, made: now };
    draft = saved ? { ...saved, until: now + RETURN_TTL_MS } : null;
  },

  /** The place to return to, once; null when there is none or it has expired. */
  take(now: number = Date.now()): { at: string; href: Href; tab: boolean } | null {
    const target = pending;
    pending = null;
    if (!target || !fresh(target.made, now)) {
      draft = null;
      return null;
    }
    if (draft) draft.until = Math.min(draft.until, now + HANDOFF_MS);
    return { at: target.at, href: target.href, tab: target.tab };
  },

  /** The saved form for exactly this route, if there is one. Reading does not delete it: see `clearDraft`. */
  draftFor(kind: Draft['kind'], route: string, now: number = Date.now()): Draft | null {
    if (!draft || draft.kind !== kind || draft.route !== route || now >= draft.until) return null;
    return { kind: draft.kind, values: draft.values, coupon: draft.coupon };
  },

  clearDraft(): void {
    draft = null;
  },

  clear(): void {
    pending = null;
    draft = null;
  },

  /** Whether a detour is waiting to be completed (not checking its age: `take` does). */
  isPending(): boolean {
    return pending !== null;
  },
};
