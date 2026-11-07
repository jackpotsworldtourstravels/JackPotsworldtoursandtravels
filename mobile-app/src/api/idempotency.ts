import * as Crypto from 'expo-crypto';

/**
 * A key that identifies ONE customer intention: "book this stay", "pay for this
 * booking".
 *
 * The backend accepts 8-64 characters for `idempotency_key` on booking create
 * and on every checkout, and uses it to collapse a double-tap, a reload or a
 * retry after a timeout into one booking / one payment order (unique index per
 * customer / per booking). A UUID is 36 characters.
 *
 * RULE FOR CALLERS: generate the key when the customer first presses the
 * button and keep it (in state or a ref) until that attempt has a final answer.
 * Generating a fresh key per request defeats the whole mechanism. Pressing
 * the button again for a *new* attempt gets a new key.
 */
export function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}
