import {
  emptyTravellerForm,
  hotelGuestFromTraveller,
  packageFieldsFromTraveller,
  passportHint,
  toTravellerInput,
  travellerFormFrom,
  travellerName,
  travellerSchema,
} from '@/features/account/travellerForm';
import { addDays, todayISO } from '@/utils/dates';

import { savedTraveller } from '../fixtures/account';

const parse = (over: Record<string, string> = {}) =>
  travellerSchema.safeParse({ ...emptyTravellerForm(), first_name: 'Meera', last_name: 'Nair', ...over });

const messages = (result: ReturnType<typeof parse>) => result.error?.issues.map((i) => i.message) ?? [];

describe('a saved traveller', () => {
  it('needs only a first and last name', () => {
    expect(parse().success).toBe(true);
  });

  it.each([
    ['no first name', { first_name: '  ' }, 'First name is required.'],
    ['no last name', { last_name: '' }, 'Last name is required.'],
    ['a name over 100 characters', { first_name: 'M'.repeat(101) }, 'First name is too long.'],
    ['a date of birth in the future', { date_of_birth: addDays(todayISO(), 1) }, 'That date of birth is in the future.'],
    ['a date of birth in words', { date_of_birth: 'long ago' }, /YYYY-MM-DD/],
    ['a passport number over 40 characters', { passport_number: 'A'.repeat(41), passport_expiry: '2034-01-01' }, 'That passport number is too long.'],
  ])('rejects %s', (_label, patch, message) => {
    const result = parse(patch);
    expect(result.success).toBe(false);
    expect(messages(result).some((m) => (message instanceof RegExp ? message.test(m) : m === message))).toBe(true);
  });

  it('keeps a passport number and its expiry together: one without the other is no use to a booking', () => {
    expect(messages(parse({ passport_number: 'N1234567' }))).toContain('Add the passport’s expiry date.');
    expect(messages(parse({ passport_expiry: '2034-01-01' }))).toContain('Add the passport number.');
    expect(parse({ passport_number: 'N1234567', passport_expiry: '2034-01-01' }).success).toBe(true);
  });

  it('stores a passport number without spaces, in capitals', () => {
    const result = parse({ passport_number: ' n 1234 567 ', passport_expiry: '2034-01-01' });
    expect(result.data?.passport_number).toBe('N1234567');
  });

  it('turns blank optional fields into null for the server', () => {
    const input = toTravellerInput(parse().data!);
    expect(input).toEqual({
      traveller_type: 'adult',
      first_name: 'Meera',
      last_name: 'Nair',
      date_of_birth: null,
      nationality: null,
      passport_number: null,
      passport_expiry: null,
      issuing_country: null,
    });
  });
});

describe('showing a saved traveller', () => {
  it('shows only the last three characters of the passport, enough to tell two people apart', () => {
    expect(passportHint(savedTraveller())).toBe('Passport ending 567');
    expect(passportHint(savedTraveller({ passport_number: null }))).toBeNull();
    expect(passportHint(savedTraveller({ passport_number: '  ' }))).toBeNull();
  });

  it('names them first name then last name', () => {
    expect(travellerName(savedTraveller())).toBe('Meera Nair');
  });

  it('round-trips through the edit form', () => {
    const form = travellerFormFrom(savedTraveller());
    expect(form).toMatchObject({ first_name: 'Meera', passport_number: 'N1234567', passport_expiry: '2034-09-01', traveller_type: 'adult' });
    expect(toTravellerInput(travellerSchema.parse(form))).toMatchObject({ first_name: 'Meera', passport_number: 'N1234567' });
  });

  it('reads a traveller type it does not know as an adult rather than breaking', () => {
    expect(travellerFormFrom(savedTraveller({ traveller_type: 'senior' as never })).traveller_type).toBe('adult');
  });
});

describe('filling a booking form from a saved traveller', () => {
  it('gives a package traveller their name and passport, with empty strings for what is missing', () => {
    expect(packageFieldsFromTraveller(savedTraveller())).toEqual({
      traveller_type: 'adult',
      first_name: 'Meera',
      last_name: 'Nair',
      passport_number: 'N1234567',
      passport_expiry: '2034-09-01',
    });
    expect(packageFieldsFromTraveller(savedTraveller({ passport_number: null, passport_expiry: null }))).toMatchObject({
      passport_number: '',
      passport_expiry: '',
    });
  });

  it('gives a hotel guest only a name: a hotel does not ask for a passport', () => {
    expect(hotelGuestFromTraveller(savedTraveller())).toEqual({ first_name: 'Meera', last_name: 'Nair' });
  });
});
