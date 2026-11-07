import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { authApi } from '@/api/endpoints/auth';
import { isApiError } from '@/api/errors';
import { sessionEvents } from '@/api/sessionEvents';
import { tokenStore } from '@/api/tokenStore';
import { returnTo } from '@/features/auth/returnTo';
import type { Customer, LoginChallenge, SignUpRequest, TokenResponse } from '@/types/api';

/**
 * - `loading`      reading the stored session at launch
 * - `signedOut`    no session; public browsing only
 * - `guest`        a server-minted guest session (website's "continue as guest")
 * - `customer`     a signed-in account
 * - `unavailable`  tokens exist but the server couldn't be reached to confirm
 *                  them; kept so a bad connection never signs anyone out
 */
export type AuthStatus = 'loading' | 'signedOut' | 'guest' | 'customer' | 'unavailable';

export interface AuthContextValue {
  status: AuthStatus;
  customer: Customer | null;
  /** True once, after the server ended the session, until the next sign-in. */
  sessionExpired: boolean;
  /** Has a server session of any kind (guest or account). */
  hasSession: boolean;
  requestOtp(identifier: string): Promise<LoginChallenge>;
  resendOtp(challengeToken: string): Promise<LoginChallenge>;
  verifyOtp(challengeToken: string, code: string): Promise<void>;
  signUp(payload: SignUpRequest): Promise<LoginChallenge>;
  startGuest(): Promise<void>;
  signOut(): Promise<void>;
  /** Re-check the stored session (the "retry" after `unavailable`). */
  refreshSession(): Promise<void>;
  /** Swap in a freshly fetched profile (after a profile edit). */
  setCustomer(customer: Customer): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}

function statusFor(customer: Customer): AuthStatus {
  return customer.is_guest ? 'guest' : 'customer';
}

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [customer, setCustomerState] = useState<Customer | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Read inside async callbacks so they always see the latest session without
  // being re-created on every state change.
  const statusRef = useRef<AuthStatus>('loading');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const apply = useCallback((next: Customer | null, nextStatus?: AuthStatus) => {
    setCustomerState(next);
    setStatus(nextStatus ?? (next ? statusFor(next) : 'signedOut'));
  }, []);

  /** Forget the session AND everything held for the person who had it: cached data and any unsent booking form. */
  const clearLocalSession = useCallback(async () => {
    await tokenStore.clear();
    queryClient.clear();
    returnTo.clear();
    apply(null);
  }, [apply, queryClient]);

  const bootstrap = useCallback(async () => {
    const access = await tokenStore.getAccessToken();
    const refresh = await tokenStore.getRefreshToken();
    if (!access && !refresh) {
      apply(null);
      return;
    }
    try {
      apply(await authApi.me());
    } catch (error) {
      if (isApiError(error) && error.retryable) {
        // Offline at launch: keep the tokens, say so, let the customer retry.
        setCustomerState(null);
        setStatus('unavailable');
        return;
      }
      // The server said no (revoked, blocked, account gone): the stored session is dead.
      await clearLocalSession();
    }
  }, [apply, clearLocalSession]);

  useEffect(() => {
    // Reads the persisted session once at launch. State is set only after the
    // awaited native reads and the /me call resolve, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void bootstrap();
  }, [bootstrap]);

  useEffect(
    () =>
      sessionEvents.onExpired(() => {
        // The HTTP layer has already wiped the tokens; wipe the rest.
        queryClient.clear();
        apply(null);
        setSessionExpired(true);
      }),
    [apply, queryClient],
  );

  /**
   * Install a freshly issued session. If the person was browsing as a guest and
   * has just signed into an account, hand the guest's activity (wishlist,
   * bookings, enquiries) to the account first, exactly as the website does.
   * A failed claim never undoes the sign-in.
   */
  const adoptSession = useCallback(
    async (response: TokenResponse) => {
      const previousGuestToken =
        statusRef.current === 'guest' ? await tokenStore.getAccessToken() : null;

      await tokenStore.set({
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
      });
      // Anything cached belongs to the previous identity.
      queryClient.clear();

      const profile = response.customer ?? (await authApi.me());
      if (previousGuestToken && !profile.is_guest) {
        try {
          await authApi.claimGuest(previousGuestToken);
        } catch {
          // Deliberately ignored; see above.
        }
      }
      setSessionExpired(false);
      apply(profile);
    },
    [apply, queryClient],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      customer,
      sessionExpired,
      hasSession: status === 'customer' || status === 'guest',
      requestOtp: (identifier) => authApi.requestOtp(identifier.trim()),
      resendOtp: (challengeToken) => authApi.resendOtp(challengeToken),
      verifyOtp: async (challengeToken, code) => {
        await adoptSession(await authApi.verifyOtp(challengeToken, code.trim()));
      },
      signUp: (payload) => authApi.signUp(payload),
      startGuest: async () => {
        await adoptSession(await authApi.startGuest());
      },
      signOut: async () => {
        // Best effort: the server revokes the tokens, but a customer with no
        // connection must still be able to sign out of this phone.
        try {
          await authApi.logout();
        } catch {
          // Local sign-out proceeds regardless.
        }
        setSessionExpired(false);
        await clearLocalSession();
      },
      refreshSession: async () => {
        setStatus('loading');
        await bootstrap();
      },
      setCustomer: (next) => apply(next),
    }),
    [adoptSession, apply, bootstrap, clearLocalSession, customer, sessionExpired, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
