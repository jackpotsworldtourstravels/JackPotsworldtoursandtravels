import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Where the customer's session tokens live.
 *
 * Native: Keychain (iOS) / Keystore-backed encrypted preferences (Android) via
 * Expo SecureStore. Web (development preview only): memory, never
 * localStorage, so a browser build can't leave a bearer token on disk.
 *
 * A copy is cached in memory so the HTTP layer does not make a native call on
 * every request. The cache is the only thing read synchronously; SecureStore is
 * the source of truth across launches.
 */
const ACCESS_KEY = 'jp.access_token';
const REFRESH_KEY = 'jp.refresh_token';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const persistent = Platform.OS !== 'web';

/**
 * iOS: readable only while the phone is unlocked, and never carried to another
 * device by a backup or restore. (The Keychain can still outlive an uninstall on the
 * same phone; signing out revokes the tokens on the server for that case.)
 */
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

let cache: { access: string | null; refresh: string | null } | null = null;

async function readKey(key: string): Promise<string | null> {
  if (!persistent) return null;
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // An unreadable entry (changed biometrics, restored backup on a new
    // device) is the same as no session: the customer signs in again.
    return null;
  }
}

async function load() {
  if (!cache) {
    const [access, refresh] = await Promise.all([readKey(ACCESS_KEY), readKey(REFRESH_KEY)]);
    cache = { access, refresh };
  }
  return cache;
}

export const tokenStore = {
  async getAccessToken(): Promise<string | null> {
    return (await load()).access;
  },

  async getRefreshToken(): Promise<string | null> {
    return (await load()).refresh;
  },

  async set(pair: TokenPair): Promise<void> {
    cache = { access: pair.accessToken, refresh: pair.refreshToken };
    if (!persistent) return;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, pair.accessToken, OPTIONS),
      SecureStore.setItemAsync(REFRESH_KEY, pair.refreshToken, OPTIONS),
    ]);
  },

  async clear(): Promise<void> {
    cache = { access: null, refresh: null };
    if (!persistent) return;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => undefined),
      SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => undefined),
    ]);
  },

  /** Test hook: forget the in-memory copy so the next read goes to storage. */
  _resetCacheForTests(): void {
    cache = null;
  },
};
