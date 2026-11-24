import { z } from 'zod';

import type { TravellerFormValues } from '@/features/booking/packageRequest';
import type { SavedTraveller, TravellerInput, TravellerKind } from '@/types/account';
import { isISODate, todayISO } from '@/utils/dates';

const tidy = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');

const name = (label: string) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().min(1, `${label} is required.`).max(100, `${label} is too long.`));

/** Optional, kept apart from the first name (the server never splits one out of the other). Blank means none. */
const middleName = () =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().max(100, 'Middle name is too long.'))
    .transform((v) => (v === '' ? null : v));

/** The server's limit on the given name it prints: first and middle together, with the space between. */
const GIVEN_NAME_MAX = 100;
const givenNameTooLong = (first: string, middle: string | null) => [first, middle].filter(Boolean).join(' ').length > GIVEN_NAME_MAX;

const optionalText = (label: string, max: number) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().max(max, `${label} is too long.`))
    .transform((v) => (v === '' ? null : v));

const optionalDate = (label: string, rule: (v: string) => string | null) =>
  z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      if (v === '') return;
      if (!isISODate(v)) ctx.addIssue({ code: 'custom', message: `Enter ${label} as YYYY-MM-DD, for example 1990-04-23.` });
      else {
        const problem = rule(v);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }
    })
    .transform((v) => (v === '' ? null : v));

export const TRAVELLER_KINDS: readonly { value: TravellerKind; label: string; ages: string }[] = [
  { value: 'adult', label: 'Adult', ages: '12+ years' },
  { value: 'child', label: 'Child', ages: '2–11 years' },
  { value: 'infant', label: 'Infant', ages: 'Under 2' },
];

/** The titles airlines print on a ticket. Optional: a traveller can be saved without one. */
export const TRAVELLER_TITLES = ['Mr', 'Ms', 'Mrs', 'Miss', 'Dr'] as const;

/**
 * A saved traveller, as the backend accepts it (`TravellerCreate`). A passport
 * number and its expiry go together: one without the other is no use to a
 * booking, and the booking form would only ask again.
 */
export const travellerSchema = z
  .object({
    traveller_type: z.enum(['adult', 'child', 'infant']),
    title: optionalText('Title', 10),
    first_name: name('First name'),
    middle_name: middleName(),
    last_name: name('Last name'),
    date_of_birth: optionalDate('the date of birth', (v) => (v > todayISO() ? 'That date of birth is in the future.' : null)),
    nationality: optionalText('Nationality', 100),
    passport_number: z
      .string()
      .transform((v) => v.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().max(40, 'That passport number is too long.'))
      .transform((v) => (v === '' ? null : v)),
    passport_expiry: optionalDate('the expiry', () => null),
    issuing_country: optionalText('Issuing country', 100),
    frequent_flyer_airline: optionalText('Airline', 100),
    frequent_flyer_number: z
      .string()
      .transform((v) => v.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().max(60, 'That frequent flyer number is too long.'))
      .transform((v) => (v === '' ? null : v)),
  })
  .superRefine((t, ctx) => {
    if (givenNameTooLong(t.first_name, t.middle_name)) {
      ctx.addIssue({ code: 'custom', path: ['middle_name'], message: 'First and middle name together can be at most 100 characters.' });
    }
    if (t.passport_number && !t.passport_expiry) {
      ctx.addIssue({ code: 'custom', path: ['passport_expiry'], message: 'Add the passport’s expiry date.' });
    }
    if (t.passport_expiry && !t.passport_number) {
      ctx.addIssue({ code: 'custom', path: ['passport_number'], message: 'Add the passport number.' });
    }
    if (t.frequent_flyer_number && !t.frequent_flyer_airline) {
      ctx.addIssue({ code: 'custom', path: ['frequent_flyer_airline'], message: 'Add the airline this number is with.' });
    }
  });

export type TravellerFormInput = z.input<typeof travellerSchema>;
export type TravellerFormOutput = z.output<typeof travellerSchema>;

export function emptyTravellerForm(): TravellerFormInput {
  return {
    traveller_type: 'adult',
    title: '',
    first_name: '',
    middle_name: '',
    last_name: '',
    date_of_birth: '',
    nationality: '',
    passport_number: '',
    passport_expiry: '',
    issuing_country: '',
    frequent_flyer_airline: '',
    frequent_flyer_number: '',
  };
}

const KINDS: readonly string[] = ['adult', 'child', 'infant'];
const kindOf = (value: string): TravellerKind => (KINDS.includes(value) ? (value as TravellerKind) : 'adult');

export function travellerFormFrom(t: SavedTraveller): TravellerFormInput {
  return {
    traveller_type: kindOf(t.traveller_type),
    title: t.title ?? '',
    first_name: t.first_name,
    middle_name: t.middle_name ?? '',
    last_name: t.last_name,
    date_of_birth: t.date_of_birth ?? '',
    nationality: t.nationality ?? '',
    passport_number: t.passport_number ?? '',
    passport_expiry: t.passport_expiry ?? '',
    issuing_country: t.issuing_country ?? '',
    frequent_flyer_airline: t.frequent_flyer_airline ?? '',
    frequent_flyer_number: t.frequent_flyer_number ?? '',
  };
}

export function toTravellerInput(values: TravellerFormOutput): TravellerInput {
  return { ...values };
}

/** "Passport ending 567": enough to tell two people apart, not enough to copy a passport off a screen. */
export function passportHint(t: Pick<SavedTraveller, 'passport_number'>): string | null {
  const n = t.passport_number?.trim();
  if (!n) return null;
  return `Passport ending ${n.slice(-3)}`;
}

export function travellerName(t: Pick<SavedTraveller, 'first_name' | 'last_name'> & { title?: string | null; middle_name?: string | null }): string {
  return [t.title, t.first_name, t.middle_name, t.last_name].filter(Boolean).join(' ').trim();
}

/** A saved traveller as the package booking form's fields. The form still applies its own passport rules. */
export function packageFieldsFromTraveller(t: SavedTraveller): TravellerFormValues {
  return {
    traveller_type: kindOf(t.traveller_type),
    first_name: t.first_name,
    middle_name: t.middle_name ?? '',
    last_name: t.last_name,
    passport_number: t.passport_number ?? '',
    passport_expiry: t.passport_expiry ?? '',
  };
}

/** A saved traveller as a hotel guest's name fields (the room's guest type is set by their position, not by this). */
export function hotelGuestFromTraveller(t: SavedTraveller): { first_name: string; middle_name: string; last_name: string } {
  return { first_name: t.first_name, middle_name: t.middle_name ?? '', last_name: t.last_name };
}
