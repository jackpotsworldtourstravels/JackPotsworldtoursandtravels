import { z } from 'zod';

import { cleanMobile } from '@/features/auth/schemas';
import type { ProfileUpdate } from '@/types/account';
import type { Customer } from '@/types/api';
import { isISODate, todayISO } from '@/utils/dates';

const tidy = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');
const MOBILE_RE = /^\+?\d{8,15}$/;

export const GENDER_OPTIONS = ['Female', 'Male', 'Other'] as const;
const EARLIEST_BIRTH = '1900-01-01';

/** Blank means "nothing here", which the server stores as null. */
const optionalText = (label: string, max: number) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().max(max, `${label} is too long.`))
    .transform((v) => (v === '' ? null : v));

/**
 * The server's limits for the profile (`CustomerProfileUpdateRequest`), so a
 * mistake is caught before a request. Email is absent on purpose: it is the
 * login identifier, and the backend does not let a profile edit change it.
 */
export const profileSchema = z.object({
  full_name: z
    .string()
    .transform(tidy)
    .pipe(z.string().min(2, 'Enter your full name.').max(150, 'That name is too long.')),
  mobile: z
    .string()
    .transform(cleanMobile)
    .pipe(z.string().refine((v) => v === '' || MOBILE_RE.test(v), 'Enter a valid mobile number: 8 to 15 digits, optionally starting with +.'))
    .transform((v) => (v === '' ? null : v)),
  date_of_birth: z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      if (v === '') return;
      if (!isISODate(v)) {
        ctx.addIssue({ code: 'custom', message: 'Enter your date of birth as YYYY-MM-DD, for example 1990-04-23.' });
      } else if (v > todayISO() || v < EARLIEST_BIRTH) {
        ctx.addIssue({ code: 'custom', message: 'That date of birth doesn’t look right.' });
      }
    })
    .transform((v) => (v === '' ? null : v)),
  gender: optionalText('Gender', 20),
  address_line1: optionalText('Address line 1', 255),
  address_line2: optionalText('Address line 2', 255),
  city: optionalText('City', 100),
  state: optionalText('State', 100),
  country: optionalText('Country', 100),
  postal_code: optionalText('Postal code', 20),
});

export type ProfileFormInput = z.input<typeof profileSchema>;
export type ProfileFormOutput = z.output<typeof profileSchema>;

export function profileFormFrom(customer: Customer): ProfileFormInput {
  return {
    full_name: customer.full_name,
    mobile: customer.mobile ?? '',
    date_of_birth: customer.date_of_birth ?? '',
    gender: customer.gender ?? '',
    address_line1: customer.address_line1 ?? '',
    address_line2: customer.address_line2 ?? '',
    city: customer.city ?? '',
    state: customer.state ?? '',
    country: customer.country ?? '',
    postal_code: customer.postal_code ?? '',
  };
}

const KEYS = [
  'full_name',
  'mobile',
  'date_of_birth',
  'gender',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'country',
  'postal_code',
] as const;

/**
 * Only what the customer actually changed. The server treats a missing key as
 * "leave alone" and `null` as "clear", so sending the whole form would be wrong
 * in a way that matters: re-sending a mobile number that merely differs in
 * spacing would mark it unverified. A number counts as unchanged if it is the
 * same after the same tidying the form applies.
 */
export function profileChanges(original: Customer, next: ProfileFormOutput): ProfileUpdate {
  const changes: Record<string, string | null> = {};
  for (const key of KEYS) {
    const before = original[key] ?? null;
    const after = next[key];
    const same = key === 'mobile' ? (before === null ? '' : cleanMobile(before)) === (after ?? '') : before === after;
    if (!same) changes[key] = after;
  }
  return changes as ProfileUpdate;
}

/** A change the server would accept but that would lock the customer out. Returns a sentence, or null. */
export function profileProblem(original: Customer, changes: ProfileUpdate): string | null {
  if ('mobile' in changes && changes.mobile === null && !original.email) {
    return 'Your mobile number is how you sign in, so it can’t be removed.';
  }
  return null;
}
