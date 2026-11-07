import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';

import type { AuthContextValue } from '@/providers/AuthProvider';

/**
 * Shared doubles for screen tests. Each test file wires them in with
 *
 *   jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
 *   jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);
 *
 * so a screen can be driven by route params and a chosen sign-in state, and the
 * test can see exactly where it navigated.
 */
export const router = {
  push: jest.fn(),
  dismissTo: jest.fn(),
  navigate: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};

export const routeParams: { current: Record<string, string> } = { current: {} };
/** Where the router says the app is, and its first segment (`(auth)` while signing in). */
export const routeLocation: { pathname: string; segments: string[] } = { pathname: '/book/hotel', segments: ['book', 'hotel'] };

export const routerModule = {
  useRouter: () => router,
  useLocalSearchParams: () => routeParams.current,
  useGlobalSearchParams: () => routeParams.current,
  usePathname: () => routeLocation.pathname,
  useSegments: () => routeLocation.segments,
};

const customer = {
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
};

function auth(over: Partial<AuthContextValue>): AuthContextValue {
  return {
    status: 'signedOut',
    customer: null,
    sessionExpired: false,
    hasSession: false,
    requestOtp: jest.fn(),
    resendOtp: jest.fn(),
    verifyOtp: jest.fn(),
    signUp: jest.fn(),
    startGuest: jest.fn(),
    signOut: jest.fn(),
    refreshSession: jest.fn(),
    setCustomer: jest.fn(),
    ...over,
  };
}

export const authState: { current: AuthContextValue } = { current: auth({}) };

export const authModule = {
  useAuth: () => authState.current,
  AuthProvider: ({ children }: { children: ReactNode }) => children,
};

export const signIn = () => {
  authState.current = auth({ status: 'customer', customer, hasSession: true });
};
export const signInAsGuest = () => {
  authState.current = auth({
    status: 'guest',
    hasSession: true,
    customer: { ...customer, is_guest: true, email: null, mobile: null, full_name: 'Guest' },
  });
};
export const signOut = () => {
  authState.current = auth({});
};

export function resetNavigation(params: Record<string, string> = {}, location = { pathname: '/book/hotel', segments: ['book', 'hotel'] }) {
  Object.values(router).forEach((fn) => fn.mockClear());
  router.canGoBack.mockReturnValue(true);
  routeParams.current = params;
  routeLocation.pathname = location.pathname;
  routeLocation.segments = location.segments;
  signIn();
}

export async function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  // `render` is async in this version of Testing Library: wait for it before returning.
  const result = await render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, result };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
