import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { newIdempotencyKey } from '@/api/idempotency';

/**
 * DUPLICATE-BOOKING PROTECTION
 *
 * `POST /hotel-bookings` and `POST /package-bookings` take an `idempotency_key`:
 * send the same key twice and the server returns the booking it already made
 * instead of making another (unique per customer). That only protects the
 * customer if the app sends the SAME key when it is repeating the SAME booking,
 * and a DIFFERENT key when the customer has changed their mind. Both halves
 * matter:
 *
 *  - Same key after a timeout, a double tap or a crash: the first request may
 *    have succeeded without the app ever hearing, so the retry must not create a
 *    second booking.
 *  - A new key once the form changes: the server returns the old booking for an
 *    old key WITHOUT comparing the payload, so reusing a key after the customer
 *    edited a name, a date or a coupon would silently hand back the stale one.
 *
 * So a key is bound to a fingerprint of exactly what is being booked. The
 * fingerprint is a SHA-256 of the request, so the stored record holds no
 * names, emails or passport numbers, only an opaque hash and a random key.
 * Records live in SecureStore so a retry after the app was killed still finds
 * its key, and expire after an hour, by which time the booking either exists
 * or the attempt is long dead.
 *
 * Once a booking has been created and shown, its entry is deleted, so booking
 * the same trip again on purpose gets a fresh key and a fresh booking.
 */
export type AttemptScope = 'hotel' | 'package';

export interface AttemptEntry {
  /** SHA-256 of scope + request, hex. */
  hash: string;
  key: string;
  /** Epoch milliseconds. */
  at: number;
}

const STORAGE_KEY = 'jp.booking_attempts';
export const ATTEMPT_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 8;

/** JSON with object keys sorted, so equal requests always serialise equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  const body = Object.keys(object)
    .filter((k) => object[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(object[k])}`);
  return `{${body.join(',')}}`;
}

/** An opaque fingerprint of what is being booked. Never includes the idempotency key itself. */
export async function fingerprint(scope: AttemptScope, request: object): Promise<string> {
  const { idempotency_key: _ignored, ...rest } = request as Record<string, unknown>;
  void _ignored;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${scope}:${stableStringify(rest)}`);
}

/**
 * Choose the key for a fingerprint. Pure: takes the stored entries, returns the
 * key and the entries to store next. A live entry for the same fingerprint is
 * reused; anything else gets a fresh key. Expired entries are dropped.
 */
export function pickKey(
  entries: readonly AttemptEntry[],
  hash: string,
  now: number,
  make: () => string = newIdempotencyKey,
): { key: string; entries: AttemptEntry[] } {
  const live = entries.filter((e) => now - e.at < ATTEMPT_TTL_MS);
  const existing = live.find((e) => e.hash === hash);
  if (existing) return { key: existing.key, entries: live };
  const entry: AttemptEntry = { hash, key: make(), at: now };
  return { key: entry.key, entries: [...live, entry].slice(-MAX_ENTRIES) };
}

export function dropEntry(entries: readonly AttemptEntry[], hash: string): AttemptEntry[] {
  return entries.filter((e) => e.hash !== hash);
}

// ---- storage -------------------------------------------------------------

// Browser preview only: memory, never localStorage.
let memory: AttemptEntry[] | null = null;
const persistent = Platform.OS !== 'web';

function isEntry(value: unknown): value is AttemptEntry {
  const e = value as AttemptEntry;
  return Boolean(e) && typeof e.hash === 'string' && typeof e.key === 'string' && typeof e.at === 'number';
}

async function load(): Promise<AttemptEntry[]> {
  if (!persistent) return memory ?? [];
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    // Unreadable means "no record", which only costs a fresh key.
    return [];
  }
}

async function save(entries: AttemptEntry[]): Promise<void> {
  if (!persistent) {
    memory = entries;
    return;
  }
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Failing to persist degrades restart-protection only; in-flight protection still holds.
  }
}

/** The key to send for this booking request: reused for an identical retry, fresh for anything else. */
export async function keyFor(scope: AttemptScope, request: object, now: number = Date.now()): Promise<string> {
  const hash = await fingerprint(scope, request);
  const { key, entries } = pickKey(await load(), hash, now);
  await save(entries);
  return key;
}

/** Call once a booking has been created and the customer has seen it. */
export async function forget(scope: AttemptScope, request: object): Promise<void> {
  const hash = await fingerprint(scope, request);
  await save(dropEntry(await load(), hash));
}

/** Test hook. */
export function _resetAttemptMemoryForTests(): void {
  memory = null;
}
