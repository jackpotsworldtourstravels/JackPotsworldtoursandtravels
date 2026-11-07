import { profileChanges, profileFormFrom, profileProblem, profileSchema } from '@/features/account/profileForm';
import type { Customer } from '@/types/api';
import { addDays, todayISO } from '@/utils/dates';

const customer = (over: Partial<Customer> = {}): Customer => ({
  id: 1,
  customer_code: 'CUS-000001',
  full_name: 'Asha Rao',
  email: 'asha@example.com',
  mobile: '+919876543210',
  date_of_birth: '1990-04-23',
  status: 'active',
  email_verified: true,
  mobile_verified: true,
  gender: 'Female',
  address_line1: '12 MG Road',
  address_line2: null,
  city: 'Hyderabad',
  state: 'Telangana',
  country: 'India',
  postal_code: '500001',
  profile_photo: null,
  last_login: null,
  created_at: null,
  is_guest: false,
  ...over,
});

const parse = (over: Record<string, string> = {}, c = customer()) => profileSchema.safeParse({ ...profileFormFrom(c), ...over });

describe('the profile form', () => {
  it('accepts the details the customer already has, unchanged', () => {
    expect(parse().success).toBe(true);
  });

  it.each([
    ['a one-letter name', { full_name: 'A' }, 'Enter your full name.'],
    ['a name over 150 characters', { full_name: 'A'.repeat(151) }, 'That name is too long.'],
    ['a mobile number that is too short', { mobile: '12345' }, /valid mobile number/],
    ['a date of birth in words', { date_of_birth: 'long ago' }, /YYYY-MM-DD/],
    ['a date of birth in the future', { date_of_birth: addDays(todayISO(), 1) }, /doesn’t look right/],
    ['a date of birth before 1900', { date_of_birth: '1899-12-31' }, /doesn’t look right/],
    ['a postal code over 20 characters', { postal_code: '1'.repeat(21) }, 'Postal code is too long.'],
    ['an address line over 255 characters', { address_line1: 'x'.repeat(256) }, 'Address line 1 is too long.'],
  ])('rejects %s', (_label, patch, message) => {
    const result = parse(patch);
    expect(result.success).toBe(false);
    const issues = result.error?.issues.map((i) => i.message) ?? [];
    expect(issues.some((m) => (message instanceof RegExp ? message.test(m) : m === message))).toBe(true);
  });

  it('reads blank optional fields as "nothing here" (null), and tidies spacing', () => {
    const result = parse({ address_line2: '   ', city: '  New   Delhi ', mobile: '', date_of_birth: '' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ address_line2: null, city: 'New Delhi', mobile: null, date_of_birth: null });
  });

  it('takes a mobile number typed with spaces or dashes', () => {
    expect(parse({ mobile: '+91 98765-43210' }).data?.mobile).toBe('+919876543210');
  });
});

describe('what is sent when the customer saves', () => {
  const next = (over: Record<string, string> = {}, c = customer()) => {
    const result = parse(over, c);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  };

  it('is nothing at all when nothing changed, so the server is not asked', () => {
    expect(profileChanges(customer(), next())).toEqual({});
  });

  it('is only the fields that changed', () => {
    expect(profileChanges(customer(), next({ city: 'Mumbai', postal_code: '400001' }))).toEqual({ city: 'Mumbai', postal_code: '400001' });
  });

  it('is null for a field the customer cleared (the server reads null as "clear", and a missing key as "leave")', () => {
    expect(profileChanges(customer(), next({ gender: '', state: '' }))).toEqual({ gender: null, state: null });
  });

  it('does not re-send a mobile number that only differs in spacing, which would mark it unverified', () => {
    const c = customer({ mobile: '+91 98765 43210' });
    expect(profileChanges(c, next({ city: 'Pune' }, c))).toEqual({ city: 'Pune' });
  });

  it('does send a mobile number that really changed', () => {
    expect(profileChanges(customer(), next({ mobile: '+919000000002' }))).toEqual({ mobile: '+919000000002' });
  });

  it('treats a field the customer never had and left blank as unchanged', () => {
    const c = customer({ address_line2: null });
    expect(profileChanges(c, next({}, c))).toEqual({});
  });
});

describe('a change the server would accept but that would lock the customer out', () => {
  it('refuses removing the mobile number from an account that has no email, since it is how they sign in', () => {
    const c = customer({ email: null });
    expect(profileProblem(c, { mobile: null })).toMatch(/how you sign in/);
  });

  it('allows removing a mobile number when there is an email to sign in with', () => {
    expect(profileProblem(customer(), { mobile: null })).toBeNull();
  });

  it('says nothing about other changes', () => {
    expect(profileProblem(customer({ email: null }), { city: 'Pune' })).toBeNull();
  });
});
