/**
 * Response and request shapes for the backend's customer API.
 *
 * Hand-written from the backend's own Pydantic schemas
 * (backend/app/schemas/customer.py) and checked against the OpenAPI document
 * the production API publishes. Add types here as each phase starts using an
 * endpoint; do not mirror endpoints nothing calls yet.
 *
 * Money crosses the wire as a decimal STRING ("12500.00"). Keep it a string
 * until display; never parse it into a float to do arithmetic. The backend is
 * the only thing that prices anything.
 */

/** `GET /api/customer/auth/me` and the `customer` inside a token response. */
export interface Customer {
  id: number;
  customer_code: string;
  full_name: string;
  /** Null for a guest. */
  email: string | null;
  mobile: string | null;
  date_of_birth: string | null;
  status: string;
  email_verified: boolean;
  mobile_verified: boolean;
  gender: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  profile_photo: string | null;
  last_login: string | null;
  created_at: string | null;
  is_guest: boolean;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** Present on sign-in / sign-up / guest; absent on a refresh. */
  customer: Customer | null;
}

/** Step one of sign-in and sign-up: a short-lived challenge to spend with the code. */
export interface LoginChallenge {
  otp_required: boolean;
  challenge_token: string;
  /** "email" when the code was mailed. Anything else is a development host. */
  delivery: string;
  message: string;
  /**
   * Only ever set by a non-deployed backend (OTP_DEV_ECHO). The verify screen
   * shows it in development builds only; it is never stored or logged.
   */
  dev_otp: string | null;
}

export interface MessageResponse {
  message: string;
  reset_link?: string | null;
}

export interface GuestClaimResponse {
  claimed: boolean;
  moved?: Record<string, number>;
}

export interface SignUpRequest {
  full_name: string;
  email: string;
  mobile: string;
  password: string;
  confirm_password: string;
  date_of_birth?: string | null;
}

/** `GET /api/customer/flights/search` with no parameters. */
export interface FlightSearchEnvelope {
  provider: string;
  currency: string | null;
  results: unknown[];
  note?: string;
}
