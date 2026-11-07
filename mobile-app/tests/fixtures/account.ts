import type { SavedTraveller, SupportTicket, WishlistItem } from '@/types/account';

export const savedTraveller = (over: Partial<SavedTraveller> = {}): SavedTraveller => ({
  customer_traveller_id: 31,
  traveller_type: 'adult',
  first_name: 'Meera',
  last_name: 'Nair',
  date_of_birth: '1988-02-14',
  nationality: 'Indian',
  passport_number: 'N1234567',
  passport_expiry: '2034-09-01',
  issuing_country: 'India',
  ...over,
});

export const wishlistItem = (over: Partial<WishlistItem> = {}): WishlistItem => ({
  id: 501,
  item_type: 'hotel',
  item_id: 1,
  created_at: '2026-10-20T09:00:00Z',
  ...over,
});

export const ticket = (over: Partial<SupportTicket> = {}): SupportTicket => ({
  id: 88,
  subject: 'Help with booking JPH000123',
  description: 'Can I change the check-in date?',
  priority: 'normal',
  status: 'open',
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T10:30:00Z',
  messages: [
    { id: 1, author_name: 'Asha Rao', is_staff: false, message: 'Can I change the check-in date?', created_at: '2026-10-20T09:00:00Z' },
    { id: 2, author_name: 'Support', is_staff: true, message: 'Yes, which date would you like?', created_at: '2026-10-20T10:30:00Z' },
  ],
  ...over,
});
