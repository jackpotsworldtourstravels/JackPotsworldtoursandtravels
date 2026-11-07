import axios, {
  type AxiosAdapter,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

import { env } from '@/config/env';

import { ApiError, toApiError } from './errors';
import { sessionEvents } from './sessionEvents';
import { tokenStore } from './tokenStore';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Send no Authorization header and never try a token refresh. For the
     * endpoints that exist to *create* a session (sign-in, OTP, refresh), where
     * a 401 means "wrong code", not "your session expired".
     */
    skipAuth?: boolean;
    /** Internal: this request has already been replayed once after a refresh. */
    _retried?: boolean;
  }
}

/** Every call gives up after this long (the backend's slowest route is a supplier search). */
export const REQUEST_TIMEOUT_MS = 15_000;

const REFRESH_PATH = '/api/customer/auth/refresh';

export interface ApiClientOptions {
  baseURL: string;
  timeout?: number;
  /** Replace the network transport. Used by tests only. */
  adapter?: AxiosAdapter;
}

export interface ApiClient {
  http: AxiosInstance;
}

/**
 * The one HTTP client for the backend.
 *
 * - Attaches the customer's bearer token.
 * - On a 401, refreshes the token ONCE (shared by every request that failed at
 *   the same moment) and replays the request. Replaying is safe even for a
 *   POST: the 401 comes from the auth dependency, before any handler ran.
 * - If the refresh token itself is rejected, clears the session and tells the
 *   app. If the refresh failed for a network reason, the session is kept: a
 *   bad tunnel must not sign a customer out.
 * - Never retries anything else. A request that timed out may or may not have
 *   been processed, so repeating a booking or payment call here could create
 *   a second one. Read-only retries belong to TanStack Query; writes carry an
 *   idempotency key and are retried only by the customer pressing the button
 *   again (see idempotency.ts).
 * - Keeps no request or response bodies and logs nothing.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  // eslint-disable-next-line import/no-named-as-default-member -- `axios.create` is the documented entry point
  const http = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
    adapter: options.adapter,
  });

  // The refresh call must not pass through the interceptors below, or an
  // expired refresh token would try to refresh itself forever.
  // eslint-disable-next-line import/no-named-as-default-member -- as above
  const bare = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
    adapter: options.adapter,
  });

  let refreshing: Promise<string> | null = null;

  async function expireSession(): Promise<void> {
    await tokenStore.clear();
    sessionEvents.emitExpired();
  }

  async function refreshAccessToken(): Promise<string> {
    const refreshToken = await tokenStore.getRefreshToken();
    if (!refreshToken) throw new ApiError('unauthorized');

    try {
      const { data } = await bare.post<{ access_token: string; refresh_token: string }>(
        REFRESH_PATH,
        { refresh_token: refreshToken },
      );
      await tokenStore.set({ accessToken: data.access_token, refreshToken: data.refresh_token });
      return data.access_token;
    } catch (error) {
      const apiError = toApiError(error);
      // Only a definite "no" ends the session. Timeouts, offline and 5xx leave
      // the tokens alone so the next attempt can still succeed.
      if (!apiError.retryable) await expireSession();
      throw apiError;
    }
  }

  function refreshOnce(): Promise<string> {
    if (!refreshing) {
      refreshing = refreshAccessToken().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  http.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    if (!config.skipAuth) {
      const token = await tokenStore.getAccessToken();
      if (token) config.headers.set('Authorization', `Bearer ${token}`);
    }
    return config;
  });

  http.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      const original = (error as { config?: InternalAxiosRequestConfig }).config;
      const status = (error as { response?: { status?: number } }).response?.status;

      if (status === 401 && original && !original.skipAuth && !original._retried) {
        // No refresh token means there never was a session (a signed-out
        // visitor hit an authenticated route); that is not an "expired" event.
        const hadSession = (await tokenStore.getRefreshToken()) !== null;
        if (!hadSession) throw toApiError(error);

        original._retried = true;
        try {
          const token = await refreshOnce();
          original.headers.set('Authorization', `Bearer ${token}`);
          return await http.request(original);
        } catch (refreshError) {
          // The replayed request's own failure (e.g. a 404 or 400) is the real
          // answer; a failed refresh surfaces as the original 401.
          if (refreshError instanceof ApiError && refreshError.kind === 'unauthorized') {
            throw toApiError(error);
          }
          throw toApiError(refreshError);
        }
      }

      throw toApiError(error);
    },
  );

  return { http };
}

/** The app-wide client, pointed at the configured backend. */
export const apiClient = createApiClient({ baseURL: env.apiBaseUrl });
export const http = apiClient.http;
