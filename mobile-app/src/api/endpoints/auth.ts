import type {
  Customer,
  GuestClaimResponse,
  LoginChallenge,
  MessageResponse,
  SignUpRequest,
  TokenResponse,
} from '@/types/api';

import { http } from '../client';

const BASE = '/api/customer/auth';

/**
 * Every call that creates a session passes `skipAuth`: a 401 there means a wrong
 * or expired code, and must not trigger the "refresh my token" path.
 */
export const authApi = {
  /** Passwordless step 1, the same call the website's sign-in dialog makes. */
  async requestOtp(identifier: string): Promise<LoginChallenge> {
    const { data } = await http.post<LoginChallenge>(
      `${BASE}/request-otp`,
      { identifier },
      { skipAuth: true },
    );
    return data;
  },

  async resendOtp(challengeToken: string): Promise<LoginChallenge> {
    const { data } = await http.post<LoginChallenge>(
      `${BASE}/resend-otp`,
      { challenge_token: challengeToken },
      { skipAuth: true },
    );
    return data;
  },

  async verifyOtp(challengeToken: string, code: string): Promise<TokenResponse> {
    const { data } = await http.post<TokenResponse>(
      `${BASE}/verify-otp`,
      { challenge_token: challengeToken, code },
      { skipAuth: true },
    );
    return data;
  },

  async signUp(payload: SignUpRequest): Promise<LoginChallenge> {
    const { data } = await http.post<LoginChallenge>(`${BASE}/signup`, payload, { skipAuth: true });
    return data;
  },

  async startGuest(): Promise<TokenResponse> {
    const { data } = await http.post<TokenResponse>(`${BASE}/guest`, undefined, { skipAuth: true });
    return data;
  },

  /** Needs the ACCOUNT's session (normal auth) plus the guest's access token as proof. */
  async claimGuest(guestToken: string): Promise<GuestClaimResponse> {
    const { data } = await http.post<GuestClaimResponse>(`${BASE}/guest/claim`, {
      guest_token: guestToken,
    });
    return data;
  },

  async me(): Promise<Customer> {
    const { data } = await http.get<Customer>(`${BASE}/me`);
    return data;
  },

  /** Revokes every outstanding token for the account, on every device. */
  async logout(): Promise<MessageResponse> {
    const { data } = await http.post<MessageResponse>(`${BASE}/logout`);
    return data;
  },

  async forgotPassword(email: string): Promise<MessageResponse> {
    const { data } = await http.post<MessageResponse>(
      `${BASE}/forgot-password`,
      { email },
      { skipAuth: true },
    );
    return data;
  },
};
