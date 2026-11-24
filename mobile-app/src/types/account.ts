/**
 * Shapes for the customer's own account: profile, saved travellers, wishlist,
 * support tickets and cancellation requests. Mirrors the backend's schemas in
 * `app/schemas/customer*.py`; nothing here is invented.
 */

/** `PATCH /profile`: send ONLY what changed. `null` clears a field; a missing key leaves it alone. */
export interface ProfileUpdate {
  full_name?: string;
  mobile?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
}

/** A place the customer is signed in. The IP address is deliberately not modelled: the app never shows it. */
export interface CustomerSession {
  id: number;
  browser: string | null;
  device: string | null;
  login_at: string;
  last_seen_at: string;
}

export type TravellerKind = 'adult' | 'child' | 'infant';

export interface TravellerInput {
  traveller_type: TravellerKind;
  /** Mr, Ms, Mrs, Miss, Dr, … as airlines print it. */
  title: string | null;
  first_name: string;
  /** Optional, separate from the first name. */
  middle_name: string | null;
  last_name: string;
  date_of_birth: string | null;
  nationality: string | null;
  passport_number: string | null;
  passport_expiry: string | null;
  issuing_country: string | null;
  frequent_flyer_airline: string | null;
  frequent_flyer_number: string | null;
}

/** What the server returns for a saved traveller: the input plus its id (other fields are not used by the app). */
export interface SavedTraveller extends TravellerInput {
  customer_traveller_id: number;
}

export type WishlistItemType = 'flight' | 'hotel' | 'cruise' | 'package';

/** One in-app notification (`GET /api/customer/notifications`), newest first. */
export interface AppNotification {
  id: number;
  /** booking, payment, refund, support, general, … : picks the icon. */
  notification_type: string;
  title: string;
  message: string;
  /** A booking or ticket reference it is about, when there is one. */
  related_ref: string | null;
  is_read: boolean;
  created_at: string;
}

export interface WishlistItem {
  id: number;
  item_type: WishlistItemType;
  item_id: number;
  created_at: string;
}

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed' | string;

export interface SupportMessage {
  id: number;
  author_name: string | null;
  is_staff: boolean;
  message: string;
  created_at: string;
}

export interface SupportTicket {
  id: number;
  subject: string;
  description: string;
  priority: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  /** Present on the detail response; the list may omit it. */
  messages?: SupportMessage[];
}

export interface SupportTicketInput {
  subject: string;
  description: string;
  priority: 'normal';
}

/** "Ask the desk to review cancelling this booking." It cancels nothing by itself. */
export interface CancellationRequestInput {
  booking_ref: string;
  reason: string | null;
}

export interface CancellationRequest {
  cancellation_id: string;
  booking_id: string;
  service_type: string;
  reason: string | null;
  requested_date: string;
  status: string;
}
