import { createApiClient } from '@/api/client';
import { sessionEvents } from '@/api/sessionEvents';
import { tokenStore } from '@/api/tokenStore';

import { fakeAdapter, type FakeHandler } from '../helpers/fakeServer';

const BASE = 'https://api.test';

function setup(handler: FakeHandler) {
  const { adapter, requests } = fakeAdapter(handler);
  const { http } = createApiClient({ baseURL: BASE, adapter });
  return { http, requests };
}

let expired = 0;
let unsubscribe: () => void;

beforeEach(() => {
  tokenStore._resetCacheForTests();
  expired = 0;
  unsubscribe = sessionEvents.onExpired(() => {
    expired += 1;
  });
});

afterEach(() => unsubscribe());

describe('authentication header', () => {
  it('sends the stored access token as a Bearer token', async () => {
    await tokenStore.set({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    const { http, requests } = setup(() => ({ status: 200, data: { ok: true } }));

    await http.get('/api/customer/bookings');

    expect(requests[0].authorization).toBe('Bearer access-1');
  });

  it('stores tokens in the secure store, readable only while unlocked and never carried to another device', async () => {
    const SecureStore = require('expo-secure-store');
    SecureStore.setItemAsync.mockClear();
    const { Platform } = require('react-native');
    const original = Platform.OS;
    Platform.OS = 'ios';
    jest.resetModules();
    const { tokenStore: fresh } = require('@/api/tokenStore');
    await fresh.set({ accessToken: 'a', refreshToken: 'r' });
    Platform.OS = original;
    const calls = require('expo-secure-store').setItemAsync.mock.calls;
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call[2]).toEqual({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
  });

  it('sends nothing for skipAuth requests, even with a session stored', async () => {
    await tokenStore.set({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    const { http, requests } = setup(() => ({ status: 200, data: {} }));

    await http.post('/api/customer/auth/request-otp', { identifier: 'a@b.co' }, { skipAuth: true });

    expect(requests[0].authorization).toBeNull();
  });
});

describe('token refresh', () => {
  it('refreshes once on a 401, stores the new pair and replays the request', async () => {
    await tokenStore.set({ accessToken: 'old', refreshToken: 'refresh-1' });
    const { http, requests } = setup((req) => {
      if (req.url === '/api/customer/auth/refresh') {
        return { status: 200, data: { access_token: 'new', refresh_token: 'refresh-2' } };
      }
      return req.authorization === 'Bearer new'
        ? { status: 200, data: { items: [1] } }
        : { status: 401, data: { detail: 'Invalid or expired token' } };
    });

    const response = await http.get('/api/customer/bookings');

    expect(response.data).toEqual({ items: [1] });
    expect(requests.map((r) => r.url)).toEqual([
      '/api/customer/bookings',
      '/api/customer/auth/refresh',
      '/api/customer/bookings',
    ]);
    expect(requests[1].body).toEqual({ refresh_token: 'refresh-1' });
    expect(await tokenStore.getAccessToken()).toBe('new');
    expect(await tokenStore.getRefreshToken()).toBe('refresh-2');
    expect(expired).toBe(0);
  });

  it('shares ONE refresh between requests that fail together', async () => {
    await tokenStore.set({ accessToken: 'old', refreshToken: 'refresh-1' });
    const { http, requests } = setup(async (req) => {
      if (req.url === '/api/customer/auth/refresh') {
        await new Promise((r) => setTimeout(r, 20));
        return { status: 200, data: { access_token: 'new', refresh_token: 'refresh-2' } };
      }
      return req.authorization === 'Bearer new' ? { status: 200, data: {} } : { status: 401 };
    });

    await Promise.all([
      http.get('/api/customer/bookings'),
      http.get('/api/customer/hotel-bookings'),
      http.get('/api/customer/package-bookings'),
    ]);

    expect(requests.filter((r) => r.url === '/api/customer/auth/refresh')).toHaveLength(1);
  });

  it('ends the session when the refresh token is rejected', async () => {
    await tokenStore.set({ accessToken: 'old', refreshToken: 'dead' });
    const { http } = setup((req) =>
      req.url === '/api/customer/auth/refresh'
        ? { status: 401, data: { detail: 'Session ended — please log in again' } }
        : { status: 401, data: { detail: 'Invalid or expired token' } },
    );

    await expect(http.get('/api/customer/bookings')).rejects.toMatchObject({ kind: 'unauthorized' });

    expect(expired).toBe(1);
    expect(await tokenStore.getAccessToken()).toBeNull();
    expect(await tokenStore.getRefreshToken()).toBeNull();
    expect((globalThis as { __secureStoreForTests?: Map<string, string> }).__secureStoreForTests?.size).toBe(0);
  });

  it('keeps the session when the refresh fails for network reasons', async () => {
    await tokenStore.set({ accessToken: 'old', refreshToken: 'refresh-1' });
    const { http } = setup((req) => (req.url === '/api/customer/auth/refresh' ? 'network' : { status: 401 }));

    await expect(http.get('/api/customer/bookings')).rejects.toMatchObject({ kind: 'network' });

    expect(expired).toBe(0);
    expect(await tokenStore.getRefreshToken()).toBe('refresh-1');
  });

  it('does not treat a signed-out 401 as an expired session', async () => {
    const { http, requests } = setup(() => ({ status: 401, data: { detail: 'Not authenticated' } }));

    await expect(http.get('/api/customer/bookings')).rejects.toMatchObject({ kind: 'unauthorized' });

    expect(requests).toHaveLength(1); // no refresh attempted
    expect(expired).toBe(0);
  });

  it('never refreshes for skipAuth calls: a wrong code is not an expired session', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    const { http, requests } = setup(() => ({ status: 401, data: { detail: 'Incorrect code' } }));

    await expect(
      http.post('/api/customer/auth/verify-otp', { challenge_token: 'c', code: '000000' }, { skipAuth: true }),
    ).rejects.toMatchObject({ kind: 'unauthorized', message: 'Incorrect code' });

    expect(requests).toHaveLength(1);
    expect(expired).toBe(0);
  });

  it('surfaces the replayed request’s own error, not a 401', async () => {
    await tokenStore.set({ accessToken: 'old', refreshToken: 'r' });
    const { http } = setup((req) => {
      if (req.url === '/api/customer/auth/refresh') {
        return { status: 200, data: { access_token: 'new', refresh_token: 'r2' } };
      }
      return req.authorization === 'Bearer new'
        ? { status: 404, data: { detail: 'Booking not found.' } }
        : { status: 401 };
    });

    await expect(http.get('/api/customer/bookings/JPB000001')).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Booking not found.',
    });
  });
});

describe('writes are never retried automatically', () => {
  it('sends a timed-out booking exactly once', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    const { http, requests } = setup(() => 'timeout');

    await expect(http.post('/api/customer/hotel-bookings', { idempotency_key: 'k-12345678' })).rejects.toMatchObject({
      kind: 'timeout',
    });

    expect(requests).toHaveLength(1);
  });

  it('sends a 503 on checkout exactly once', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    const { http, requests } = setup(() => ({ status: 503, data: { detail: 'Payments are unavailable.' } }));

    await expect(http.post('/api/customer/bookings/JPB1/checkout', {})).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'Payments are unavailable.',
    });

    expect(requests).toHaveLength(1);
  });
});
