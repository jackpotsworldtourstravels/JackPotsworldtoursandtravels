import type {
  CancellationRequest,
  CancellationRequestInput,
  CustomerSession,
  ProfileUpdate,
  SavedTraveller,
  SupportMessage,
  SupportTicket,
  SupportTicketInput,
  TravellerInput,
  WishlistItem,
  WishlistItemType,
} from '@/types/account';
import type { Customer } from '@/types/api';

import { http } from '../client';

const BASE = '/api/customer';
const seg = encodeURIComponent;

/** The signed-in customer's own details. Every route is scoped to the session; none carries a customer id. */
export const profileApi = {
  /** Partial update: the caller sends only what changed. Email is not editable (it is the login identifier). */
  async update(changes: ProfileUpdate): Promise<Customer> {
    const { data } = await http.patch<Customer>(`${BASE}/profile`, changes);
    return data;
  },

  async sessions(): Promise<CustomerSession[]> {
    const { data } = await http.get<CustomerSession[]>(`${BASE}/profile/sessions`);
    return data;
  },
};

export const wishlistApi = {
  async list(): Promise<WishlistItem[]> {
    const { data } = await http.get<WishlistItem[]>(`${BASE}/wishlist`);
    return data;
  },

  /** Saving what is already saved returns the existing row, so a double tap cannot duplicate it. */
  async add(itemType: WishlistItemType, itemId: number): Promise<WishlistItem> {
    const { data } = await http.post<WishlistItem>(`${BASE}/wishlist`, { item_type: itemType, item_id: itemId });
    return data;
  },

  async remove(id: number): Promise<void> {
    await http.delete(`${BASE}/wishlist/${seg(String(id))}`);
  },
};

export const travellerApi = {
  async list(): Promise<SavedTraveller[]> {
    const { data } = await http.get<SavedTraveller[]>(`${BASE}/travellers`);
    return data;
  },

  /** A passport number already on the list updates that entry instead of adding a copy. */
  async create(input: TravellerInput): Promise<SavedTraveller> {
    const { data } = await http.post<SavedTraveller>(`${BASE}/travellers`, input);
    return data;
  },

  async update(id: number, input: TravellerInput): Promise<SavedTraveller> {
    const { data } = await http.patch<SavedTraveller>(`${BASE}/travellers/${seg(String(id))}`, input);
    return data;
  },

  async remove(id: number): Promise<void> {
    await http.delete(`${BASE}/travellers/${seg(String(id))}`);
  },
};

export const supportApi = {
  async list(): Promise<SupportTicket[]> {
    const { data } = await http.get<SupportTicket[]>(`${BASE}/support-tickets`);
    return data;
  },

  async get(id: number): Promise<SupportTicket> {
    const { data } = await http.get<SupportTicket>(`${BASE}/support-tickets/${seg(String(id))}`);
    return data;
  },

  /** Not idempotent on the server: a lost answer must be checked against the list before sending again. */
  async create(input: SupportTicketInput): Promise<SupportTicket> {
    const { data } = await http.post<SupportTicket>(`${BASE}/support-tickets`, input);
    return data;
  },

  async reply(id: number, message: string): Promise<SupportMessage> {
    const { data } = await http.post<SupportMessage>(`${BASE}/support-tickets/${seg(String(id))}/messages`, { message });
    return data;
  },
};

export const cancellationApi = {
  /**
   * Asks the desk to review cancelling a booking. It does NOT cancel it and moves no money: a person decides.
   * The server refuses a booking that is not the caller's, one already cancelled or completed, and a second open request.
   */
  async request(input: CancellationRequestInput): Promise<CancellationRequest> {
    const { data } = await http.post<CancellationRequest>(`${BASE}/cancellation-requests`, input);
    return data;
  },
};
