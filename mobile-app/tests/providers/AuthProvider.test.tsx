import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';

import { authApi } from '@/api/endpoints/auth';
import { ApiError } from '@/api/errors';
import { sessionEvents } from '@/api/sessionEvents';
import { tokenStore } from '@/api/tokenStore';
import { returnTo } from '@/features/auth/returnTo';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import type { Customer, TokenResponse } from '@/types/api';

jest.mock('@/api/endpoints/auth', () => ({
  authApi: {
    me: jest.fn(),
    requestOtp: jest.fn(),
    resendOtp: jest.fn(),
    verifyOtp: jest.fn(),
    signUp: jest.fn(),
    startGuest: jest.fn(),
    claimGuest: jest.fn(),
    logout: jest.fn(),
  },
}));

const api = authApi as jest.Mocked<typeof authApi>;

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    customer_code: 'CUS-000001',
    full_name: 'Asha Rao',
    email: 'asha@example.com',
    mobile: '+919876543210',
    date_of_birth: null,
    status: 'active',
    email_verified: true,
    mobile_verified: false,
    gender: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    country: null,
    postal_code: null,
    profile_photo: null,
    last_login: null,
    created_at: null,
    is_guest: false,
    ...over,
  };
}

function tokens(who: Customer | null, access = 'access-new', refresh = 'refresh-new'): TokenResponse {
  return { access_token: access, refresh_token: refresh, token_type: 'bearer', customer: who };
}

let queryClient: QueryClient;

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

async function mount() {
  const hook = await renderHook(() => useAuth(), { wrapper });
  return hook.result;
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  tokenStore._resetCacheForTests();
  queryClient = new QueryClient();
});

describe('launch', () => {
  it('is signed out, without calling the server, when nothing is stored', async () => {
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    expect(api.me).not.toHaveBeenCalled();
    expect(auth.current.hasSession).toBe(false);
  });

  it('restores a stored account session', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    api.me.mockResolvedValue(customer());

    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('customer'));
    expect(auth.current.customer?.customer_code).toBe('CUS-000001');
    expect(auth.current.hasSession).toBe(true);
  });

  it('restores a guest session as a guest', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    api.me.mockResolvedValue(customer({ is_guest: true, email: null, mobile: null }));

    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('guest'));
  });

  it('throws away a session the server refuses', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    api.me.mockRejectedValue(new ApiError('unauthorized'));

    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    expect(await tokenStore.getAccessToken()).toBeNull();
    expect(await tokenStore.getRefreshToken()).toBeNull();
  });

  it('keeps the tokens when offline at launch, and recovers on retry', async () => {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    api.me.mockRejectedValueOnce(new ApiError('network'));

    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('unavailable'));
    expect(await tokenStore.getRefreshToken()).toBe('r');

    api.me.mockResolvedValue(customer());
    await act(async () => {
      await auth.current.refreshSession();
    });
    await waitFor(() => expect(auth.current.status).toBe('customer'));
  });
});

describe('signing in', () => {
  it('stores the tokens and adopts the profile the server returned', async () => {
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    api.verifyOtp.mockResolvedValue(tokens(customer()));

    await act(async () => {
      await auth.current.verifyOtp('challenge', ' 123456 ');
    });

    expect(api.verifyOtp).toHaveBeenCalledWith('challenge', '123456');
    expect(auth.current.status).toBe('customer');
    expect(await tokenStore.getAccessToken()).toBe('access-new');
    expect(await tokenStore.getRefreshToken()).toBe('refresh-new');
  });

  it('wipes cached data from the previous identity', async () => {
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    queryClient.setQueryData(['bookings'], [{ ref: 'JPB000001' }]);
    api.verifyOtp.mockResolvedValue(tokens(customer()));

    await act(async () => {
      await auth.current.verifyOtp('c', '123456');
    });

    expect(queryClient.getQueryData(['bookings'])).toBeUndefined();
  });

  it('a wrong code leaves the app signed out and stores nothing', async () => {
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    api.verifyOtp.mockRejectedValue(new ApiError('validation', { message: 'Incorrect code' }));

    await act(async () => {
      await expect(auth.current.verifyOtp('c', '000000')).rejects.toThrow('Incorrect code');
    });

    expect(auth.current.status).toBe('signedOut');
    expect(await tokenStore.getAccessToken()).toBeNull();
  });

  it('hands a guest’s activity to the account, using the guest’s own token as proof', async () => {
    await tokenStore.set({ accessToken: 'guest-access', refreshToken: 'guest-refresh' });
    api.me.mockResolvedValue(customer({ is_guest: true, email: null, mobile: null }));
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('guest'));

    api.verifyOtp.mockResolvedValue(tokens(customer(), 'acct-access', 'acct-refresh'));
    api.claimGuest.mockResolvedValue({ claimed: true });

    await act(async () => {
      await auth.current.verifyOtp('c', '123456');
    });

    expect(api.claimGuest).toHaveBeenCalledWith('guest-access');
    expect(auth.current.status).toBe('customer');
    expect(await tokenStore.getAccessToken()).toBe('acct-access');
  });

  it('a failed guest claim never undoes the sign-in', async () => {
    await tokenStore.set({ accessToken: 'guest-access', refreshToken: 'guest-refresh' });
    api.me.mockResolvedValue(customer({ is_guest: true }));
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('guest'));

    api.verifyOtp.mockResolvedValue(tokens(customer()));
    api.claimGuest.mockRejectedValue(new ApiError('server'));

    await act(async () => {
      await auth.current.verifyOtp('c', '123456');
    });

    expect(auth.current.status).toBe('customer');
  });

  it('does not try to claim when a signed-out visitor signs in', async () => {
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    api.verifyOtp.mockResolvedValue(tokens(customer()));

    await act(async () => {
      await auth.current.verifyOtp('c', '123456');
    });

    expect(api.claimGuest).not.toHaveBeenCalled();
  });

  it('starting a guest session makes the visitor a guest', async () => {
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('signedOut'));
    api.startGuest.mockResolvedValue(tokens(customer({ is_guest: true, email: null, mobile: null })));

    await act(async () => {
      await auth.current.startGuest();
    });

    expect(auth.current.status).toBe('guest');
    expect(auth.current.hasSession).toBe(true);
  });
});

describe('signing out and expiry', () => {
  async function signedIn() {
    await tokenStore.set({ accessToken: 'a', refreshToken: 'r' });
    api.me.mockResolvedValue(customer());
    const auth = await mount();
    await waitFor(() => expect(auth.current.status).toBe('customer'));
    return auth;
  }

  it('signs out: revokes on the server, clears tokens and the cache', async () => {
    const auth = await signedIn();
    queryClient.setQueryData(['bookings'], [1]);
    api.logout.mockResolvedValue({ message: 'ok' });

    await act(async () => {
      await auth.current.signOut();
    });

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(auth.current.status).toBe('signedOut');
    expect(auth.current.customer).toBeNull();
    expect(await tokenStore.getAccessToken()).toBeNull();
    expect(queryClient.getQueryData(['bookings'])).toBeUndefined();
  });

  it('also forgets an unsent booking form (names, passport numbers) held for the person who signed out', async () => {
    const auth = await signedIn();
    api.logout.mockResolvedValue({ message: 'ok' });
    returnTo.set({ at: '/book/hotel', href: '/book/hotel' as never }, { kind: 'hotel', values: { passport: 'N1234567' }, coupon: undefined, route: '/book/hotel?x=1' });

    await act(async () => {
      await auth.current.signOut();
    });

    expect(returnTo.isPending()).toBe(false);
    expect(returnTo.draftFor('hotel', '/book/hotel?x=1')).toBeNull();
  });

  it('still signs out on this phone when the server can’t be reached', async () => {
    const auth = await signedIn();
    api.logout.mockRejectedValue(new ApiError('network'));

    await act(async () => {
      await auth.current.signOut();
    });

    expect(auth.current.status).toBe('signedOut');
    expect(await tokenStore.getRefreshToken()).toBeNull();
  });

  it('moves to signed-out, flagged as expired, when the HTTP layer reports the session gone', async () => {
    const auth = await signedIn();
    queryClient.setQueryData(['bookings'], [1]);

    await act(async () => {
      sessionEvents.emitExpired();
    });

    expect(auth.current.status).toBe('signedOut');
    expect(auth.current.sessionExpired).toBe(true);
    expect(queryClient.getQueryData(['bookings'])).toBeUndefined();

    api.verifyOtp.mockResolvedValue(tokens(customer()));
    await act(async () => {
      await auth.current.verifyOtp('c', '123456');
    });
    expect(auth.current.sessionExpired).toBe(false);
  });
});
