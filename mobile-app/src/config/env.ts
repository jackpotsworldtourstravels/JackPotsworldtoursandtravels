import { Platform } from 'react-native';

export type AppEnvironment = 'development' | 'staging' | 'production';

export interface AppEnv {
  /** Backend origin, no trailing slash. Always https outside development. */
  apiBaseUrl: string;
  appEnv: AppEnvironment;
}

const ENVIRONMENTS: readonly AppEnvironment[] = ['development', 'staging', 'production'];

export interface RawEnv {
  apiBaseUrl?: string;
  appEnv?: string;
  /** True in development builds (Metro / Expo Go / dev client). */
  isDev: boolean;
  platform: string;
}

/**
 * The emulator-to-host addresses a development build falls back to when
 * EXPO_PUBLIC_API_BASE_URL is unset. Android's emulator reaches the host
 * machine at 10.0.2.2; the iOS simulator shares the host's loopback.
 */
function devDefault(platform: string): string {
  return platform === 'android' ? 'http://10.0.2.2:8000' : 'http://127.0.0.1:8000';
}

/**
 * Validate and normalise the build-time configuration.
 *
 * Pure, so every rule is unit-tested. It throws instead of returning a
 * best-effort value: a release build that guessed an API address would send
 * customer tokens somewhere nobody chose.
 */
export function parseEnv(raw: RawEnv): AppEnv {
  const appEnv = (raw.appEnv ?? (raw.isDev ? 'development' : 'production')) as AppEnvironment;
  if (!ENVIRONMENTS.includes(appEnv)) {
    throw new Error(
      `EXPO_PUBLIC_APP_ENV must be one of ${ENVIRONMENTS.join(', ')} (got "${raw.appEnv}").`,
    );
  }

  let base = (raw.apiBaseUrl ?? '').trim();
  if (!base) {
    if (!raw.isDev) {
      throw new Error(
        'EXPO_PUBLIC_API_BASE_URL is not set. Release builds need an explicit https:// API address; see .env.example.',
      );
    }
    base = devDefault(raw.platform);
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`EXPO_PUBLIC_API_BASE_URL is not a valid URL: "${base}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must start with https:// (or http:// in development).');
  }
  // Production and staging carry real customer sessions: TLS is not optional.
  if (url.protocol === 'http:' && (!raw.isDev || appEnv !== 'development')) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL must use https:// outside a development build. Plain http is for local testing only.',
    );
  }
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL must be an origin only (scheme, host, optional port), with no path or query.',
    );
  }

  return { apiBaseUrl: url.origin, appEnv };
}

// Expo replaces `process.env.EXPO_PUBLIC_*` only when written out in full like
// this, so the two reads below must not be turned into a dynamic lookup.
export const env: AppEnv = parseEnv({
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
  isDev: __DEV__,
  platform: Platform.OS,
});
