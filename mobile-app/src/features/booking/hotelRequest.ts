import { z } from 'zod';

import { cleanMobile } from '@/features/auth/schemas';
import type { Party } from '@/features/search/party';
import type { StayDates } from '@/features/search/stay';
import type { HotelBookingRequest, HotelGuestInput, HotelQuoteRequest, StayInput } from '@/types/booking';

/** `JPW`-style tidy: trim and collapse inner whitespace, as the server's own validators do. */
const tidy = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');

const name = (label: string) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().min(1, `${label} is required.`).max(100, `${label} is too long.`));

const MOBILE_RE = /^\+?\d{8,15}$/;

/** What the guest form collects. The first adult is the booking contact. */
export interface HotelFormValues {
  guests: { first_name: string; last_name: string }[];
  email: string;
  mobile: string;
  notes: string;
}

/**
 * The server's rules for a hotel booking's people, so mistakes are caught
 * before a request: a name for everyone staying, exactly one contact (the first
 * adult) with an email and a mobile, notes within 500 characters. It cannot
 * check availability or price; only the server can.
 */
export function hotelFormSchema(guestCount: number) {
  return z.object({
    guests: z
      .array(z.object({ first_name: name('First name'), last_name: name('Last name') }))
      .length(guestCount),
    email: z.string().trim().pipe(z.email('Enter a valid email address.')),
    mobile: z
      .string()
      .transform(cleanMobile)
      .pipe(z.string().regex(MOBILE_RE, 'Enter a valid mobile number: 8 to 15 digits, optionally starting with +.')),
    notes: z.string().trim().max(500, 'Keep notes under 500 characters.'),
  });
}

export function emptyHotelForm(party: Party, prefill?: Partial<Pick<HotelFormValues, 'email' | 'mobile'>> & { firstName?: string; lastName?: string }): HotelFormValues {
  const count = party.adults + party.children;
  return {
    guests: Array.from({ length: count }, (_, i) => ({
      first_name: i === 0 ? (prefill?.firstName ?? '') : '',
      last_name: i === 0 ? (prefill?.lastName ?? '') : '',
    })),
    email: prefill?.email ?? '',
    mobile: prefill?.mobile ?? '',
    notes: '',
  };
}

/** Normalise a coupon code the way the backend compares it: trimmed, upper case. */
export function normaliseCoupon(code: string | null | undefined): string | undefined {
  const c = (code ?? '').trim().toUpperCase();
  return c ? c.slice(0, 40) : undefined;
}

export function buildStay(input: { hotelId: number; roomId: number; stay: StayDates; party: Party }): StayInput {
  return {
    hotel_id: input.hotelId,
    room_id: input.roomId,
    check_in: input.stay.checkIn,
    check_out: input.stay.checkOut,
    rooms_count: input.party.rooms,
    adults: input.party.adults,
    children: input.party.children,
  };
}

export function buildHotelQuoteRequest(stay: StayInput, coupon?: string | null): HotelQuoteRequest {
  return { stay, addons: [], coupon_code: normaliseCoupon(coupon) ?? null };
}

/**
 * The booking body, minus the idempotency key (added at send time from the
 * request's own fingerprint). Adults first, then children; the first adult is the
 * contact. There is no price, total, tax or currency anywhere in it.
 */
export function buildHotelBooking(input: {
  stay: StayInput;
  values: z.output<ReturnType<typeof hotelFormSchema>>;
  coupon?: string | null;
}): Omit<HotelBookingRequest, 'idempotency_key'> {
  const { stay, values } = input;
  const guests: HotelGuestInput[] = values.guests.map((g, i) => {
    const isContact = i === 0;
    return {
      guest_type: i < stay.adults ? 'adult' : 'child',
      first_name: g.first_name,
      last_name: g.last_name,
      is_contact: isContact,
      ...(isContact ? { email: values.email, mobile: values.mobile } : {}),
    };
  });

  return {
    stay,
    guests,
    addons: [],
    special_requests: [],
    notes: values.notes ? values.notes : null,
    coupon_code: normaliseCoupon(input.coupon) ?? null,
  };
}

/** Whether a room can sleep the party across the rooms asked for. A hint, not a server rule. */
export function roomFits(maxGuests: number, party: Party): boolean {
  return maxGuests * party.rooms >= party.adults + party.children;
}
