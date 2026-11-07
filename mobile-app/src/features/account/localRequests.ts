import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * A MEMORY OF HAVING ASKED, KEPT ON THIS PHONE.
 *
 * An account-deletion request now goes to the team by email (the website's contact channel), and an email leaves
 * nothing the app can look up afterwards: no ticket, no reference. So the phone remembers, per account code, WHEN
 * the request was sent, and the Delete screen shows "you asked on that date" instead of offering a second request.
 * It is a convenience, not a record: clearing the app's data forgets it (the team still has the email), and it says
 * nothing about whether the request has been acted on. It holds a date and the account code, no personal details.
 */
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

// The web preview has no secure store: memory only, so a reload forgets.
const memory = new Map<string, string>();

// SecureStore keys may contain letters, digits, ".", "-" and "_".
const key = (customerCode: string) => `deletion-asked.${customerCode.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export async function recordDeletionRequest(customerCode: string, at: Date = new Date()): Promise<void> {
  const value = at.toISOString();
  try {
    if (Platform.OS === 'web') memory.set(key(customerCode), value);
    else await SecureStore.setItemAsync(key(customerCode), value, OPTIONS);
  } catch {
    // Not being able to remember must never turn a sent request into an error.
  }
}

/** When this account's deletion request was sent from this phone (ISO), or null. */
export async function readDeletionRequest(customerCode: string): Promise<string | null> {
  try {
    const value = Platform.OS === 'web' ? (memory.get(key(customerCode)) ?? null) : await SecureStore.getItemAsync(key(customerCode));
    return value && !Number.isNaN(new Date(value).getTime()) ? value : null;
  } catch {
    return null;
  }
}
