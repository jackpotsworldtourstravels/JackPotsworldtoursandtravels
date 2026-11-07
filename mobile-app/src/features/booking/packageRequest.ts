import { z } from 'zod';

import { cleanMobile } from '@/features/auth/schemas';
import { isISODate, parseISODate, todayISO, type ISODate } from '@/utils/dates';
import type { DepartureOption, PackageBookingRequest, PackageTravellerInput, TripInput } from '@/types/booking';

import { normaliseCoupon } from './hotelRequest';

export const MAX_TRAVELLERS = 12;

const tidy = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');
const name = (label: string) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().min(1, `${label} is required.`).max(100, `${label} is too long.`));

const MOBILE_RE = /^\+?\d{8,15}$/;

/**
 * Whole months from the departure to the passport's expiry. The server's own
 * arithmetic (customer_traveller_service.passport_months_remaining), ported
 * line for line so the app and the server can never disagree about a boundary
 * date. The server requires at least 6.
 */
export function passportMonthsRemaining(expiry: ISODate, departure: ISODate): number {
  const e = parseISODate(expiry);
  const d = parseISODate(departure);
  let months = (e.getFullYear() - d.getFullYear()) * 12 + (e.getMonth() - d.getMonth());
  if (e.getDate() < d.getDate()) months -= 1;
  return months;
}

export const MIN_PASSPORT_MONTHS = 6;

export type TravellerType = 'adult' | 'child' | 'infant';

export interface TravellerFormValues {
  traveller_type: TravellerType;
  first_name: string;
  last_name: string;
  passport_number: string;
  /** YYYY-MM-DD, typed. */
  passport_expiry: string;
}

export interface PackageFormValues {
  travellers: TravellerFormValues[];
  email: string;
  mobile: string;
}

/**
 * The server's rules for a package booking's travellers: a name for each,
 * at least one adult, and, for an international package, a passport number and
 * an expiry at least six months after departure. Whether the departure still
 * has seats, and the price, are the server's to say.
 */
export function packageFormSchema(options: { international: boolean; departure: ISODate; count: number }) {
  const { international, departure, count } = options;
  const traveller = z
    .object({
      traveller_type: z.enum(['adult', 'child', 'infant']),
      first_name: name('First name'),
      last_name: name('Last name'),
      passport_number: z.string().trim().max(40, 'That passport number is too long.'),
      passport_expiry: z.string().trim(),
    })
    .superRefine((t, ctx) => {
      if (!international) return;
      if (!t.passport_number) {
        ctx.addIssue({ code: 'custom', path: ['passport_number'], message: 'Passport number is required for this destination.' });
      }
      if (!t.passport_expiry) {
        ctx.addIssue({ code: 'custom', path: ['passport_expiry'], message: 'Passport expiry is required for this destination.' });
      } else if (!isISODate(t.passport_expiry)) {
        ctx.addIssue({ code: 'custom', path: ['passport_expiry'], message: 'Enter the expiry as YYYY-MM-DD, for example 2032-05-30.' });
      } else if (passportMonthsRemaining(t.passport_expiry, departure) < MIN_PASSPORT_MONTHS) {
        ctx.addIssue({
          code: 'custom',
          path: ['passport_expiry'],
          message: 'The passport must be valid for at least 6 months after the departure date.',
        });
      }
    });

  return z.object({
    travellers: z
      .array(traveller)
      .length(count)
      .refine((list) => list.some((t) => t.traveller_type === 'adult'), { message: 'At least one adult must travel.' }),
    email: z.string().trim().pipe(z.email('Enter a valid email address.')),
    mobile: z
      .string()
      .transform(cleanMobile)
      .pipe(z.string().regex(MOBILE_RE, 'Enter a valid mobile number: 8 to 15 digits, optionally starting with +.')),
  });
}

export function emptyPackageForm(
  count: number,
  prefill?: { firstName?: string; lastName?: string; email?: string; mobile?: string },
): PackageFormValues {
  return {
    travellers: Array.from({ length: count }, (_, i) => ({
      traveller_type: 'adult' as const,
      first_name: i === 0 ? (prefill?.firstName ?? '') : '',
      last_name: i === 0 ? (prefill?.lastName ?? '') : '',
      passport_number: '',
      passport_expiry: '',
    })),
    email: prefill?.email ?? '',
    mobile: prefill?.mobile ?? '',
  };
}

/** Departures a customer can still book: not before today, with seats left. Soonest first. */
export function bookableDepartures(departures: readonly DepartureOption[], today: ISODate = todayISO()): DepartureOption[] {
  return departures
    .filter((d) => isISODate(d.date) && d.date >= today && d.seats_left > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** How many travellers a departure can take. */
export function maxTravellers(departure: Pick<DepartureOption, 'seats_left'>): number {
  return Math.max(0, Math.min(MAX_TRAVELLERS, departure.seats_left));
}

export function buildTrip(input: { packageId: number; departureId: number; pax: number }): TripInput {
  return { package_id: input.packageId, departure_id: input.departureId, pax_count: input.pax };
}

export function buildPackageBooking(input: {
  trip: TripInput;
  values: z.output<ReturnType<typeof packageFormSchema>>;
  international: boolean;
  coupon?: string | null;
}): Omit<PackageBookingRequest, 'idempotency_key'> {
  const { trip, values, international } = input;
  const travellers: PackageTravellerInput[] = values.travellers.map((t, i) => {
    const isContact = i === 0;
    return {
      traveller_type: t.traveller_type,
      first_name: t.first_name,
      last_name: t.last_name,
      is_contact: isContact,
      ...(international ? { passport_number: t.passport_number, passport_expiry: t.passport_expiry } : {}),
      ...(isContact ? { email: values.email, mobile: values.mobile } : {}),
    };
  });
  return { trip, travellers, addons: [], coupon_code: normaliseCoupon(input.coupon) ?? null };
}
