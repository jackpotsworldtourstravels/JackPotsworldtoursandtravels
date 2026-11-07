import {
  buildDeletionRequest,
  DELETION_SUBJECT,
  deletionMessage,
  deletionSchema,
  findOpenDeletionRequest,
  MUST_BE_KEPT,
  openBookingRefs,
  parseContact,
  RESPONSE_DAYS,
  WILL_BE_DELETED,
} from '@/features/account/deletion';
import type { Customer } from '@/types/api';
import { todayISO } from '@/utils/dates';

import { ticket } from '../fixtures/account';
import { hotelBooking, packageBooking, payment } from '../fixtures/booking';

const customer: Customer = {
  id: 1,
  customer_code: 'CUS-000001',
  full_name: 'Asha Rao',
  email: 'asha@example.com',
  mobile: '+919876543210',
  date_of_birth: null,
  status: 'active',
  email_verified: true,
  mobile_verified: false,
  gender: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  country: null,
  postal_code: null,
  profile_photo: null,
  last_login: null,
  created_at: null,
  is_guest: false,
};
const guest: Customer = { ...customer, customer_code: 'CUS-000009', full_name: 'Guest', email: null, mobile: null, is_guest: true };
const NOW = new Date('2026-10-22T10:00:00Z');
const base = { customer, guest: false, openRefs: [] as string[], reason: '', contact: '', now: NOW };

describe('what the customer is told', () => {
  it('promises the policy’s 30 days and nothing faster', () => {
    expect(RESPONSE_DAYS).toBe(30);
  });

  it('says what can be deleted and what must be kept, in the policy’s own categories', () => {
    expect(WILL_BE_DELETED.join(' ')).toMatch(/profile/i);
    expect(WILL_BE_DELETED.join(' ')).toMatch(/passport/i);
    expect(MUST_BE_KEPT.join(' ')).toMatch(/eight financial years/);
    expect(MUST_BE_KEPT.join(' ')).toMatch(/three years/);
    expect(MUST_BE_KEPT.join(' ')).toMatch(/trip that has not happened yet/);
  });
});

describe('open bookings', () => {
  it('lists unpaid bookings and paid ones with the trip ahead, and ignores cancelled ones', () => {
    const rows = [
      { kind: 'hotel' as const, booking: hotelBooking({ booking_ref: 'JPH000001' }) }, // awaiting payment
      { kind: 'hotel' as const, booking: hotelBooking({ booking_ref: 'JPH000002', status: 'confirmed', payments: [payment('captured')] }) }, // upcoming
      { kind: 'hotel' as const, booking: hotelBooking({ booking_ref: 'JPH000003', status: 'cancelled' }) },
      { kind: 'package' as const, booking: packageBooking({ booking_ref: 'JPP000006' }) },
    ];
    const refs = openBookingRefs(rows, todayISO());
    expect(refs).toEqual(expect.arrayContaining(['JPH000001', 'JPH000002']));
    expect(refs).not.toContain('JPH000003');
  });

  it('is empty when there are no bookings', () => {
    expect(openBookingRefs([])).toEqual([]);
  });
});

describe('an open request already on the account', () => {
  const asked = (over = {}) => ticket({ subject: DELETION_SUBJECT, ...over });

  it('is found while it is open or in progress, however the subject is cased', () => {
    expect(findOpenDeletionRequest([ticket(), asked()])).not.toBeNull();
    expect(findOpenDeletionRequest([asked({ subject: ' ACCOUNT deletion REQUEST ', status: 'in_progress' })])).not.toBeNull();
  });

  it('is not found once resolved or closed (a new one may be sent), or for another subject', () => {
    expect(findOpenDeletionRequest([asked({ status: 'resolved' }), asked({ status: 'closed' })])).toBeNull();
    expect(findOpenDeletionRequest([ticket()])).toBeNull();
    expect(findOpenDeletionRequest([])).toBeNull();
  });
});

describe('contact details', () => {
  it('accepts an email or a mobile number, tidied', () => {
    expect(parseContact(' a@b.co ')).toEqual({ kind: 'email', value: 'a@b.co' });
    expect(parseContact('+91 98765-43210')).toEqual({ kind: 'mobile', value: '+919876543210' });
  });

  it.each(['', 'asha', '12345', 'a@b', '+91 abc'])('rejects %p', (v) => {
    expect(parseContact(v)).toBeNull();
  });
});

describe('the form', () => {
  const ok = { reason: '', contact: '', confirmed: true };
  const messages = (needsEmail: boolean, v: object) => {
    const r = deletionSchema(needsEmail).safeParse({ ...ok, ...v });
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('needs the box ticked, for everyone', () => {
    expect(messages(false, { confirmed: false })).toContain('Tick the box to confirm you understand.');
    expect(messages(true, { confirmed: false, contact: 'a@b.co' })).toContain('Tick the box to confirm you understand.');
  });

  it('needs NO contact from a registered customer, whose email is on the account', () => {
    expect(messages(false, {})).toEqual([]);
  });

  it('REQUIRES an EMAIL address from a guest, because the team replies by email', () => {
    expect(messages(true, {})[0]).toBe('Give an email address we can reply to.');
    expect(messages(true, { contact: 'nonsense' })[0]).toBe('Give an email address we can reply to.');
    // A mobile number is a way to ring someone, not a way to answer an email.
    expect(messages(true, { contact: '+919876543210' })[0]).toBe('Give an email address we can reply to.');
    expect(messages(true, { contact: 'guest@example.com' })).toEqual([]);
  });

  it('checks an optional contact from a registered customer if they give one', () => {
    expect(messages(false, { contact: 'nonsense' })[0]).toMatch(/valid email address or mobile number/);
    expect(messages(false, { contact: 'other@example.com' })).toEqual([]);
  });

  it('keeps the reason within 500 characters', () => {
    expect(messages(false, { reason: 'x'.repeat(501) })[0]).toMatch(/500/);
  });
});

describe('the request the desk receives', () => {
  it('has a fixed subject and normal priority, and says it is a request that deletes nothing by itself', () => {
    const r = buildDeletionRequest(base);
    expect(r.subject).toBe('Account deletion request');
    expect(r.priority).toBe('normal');
    expect(r.description).toMatch(/does not delete my account straight away/);
    expect(r.description).toMatch(/records you must keep by law/);
    expect(r.description).toMatch(/within 30 days/);
  });

  it('identifies the account and what is on file, and does NOT claim identity was verified', () => {
    const r = buildDeletionRequest(base);
    expect(r.description).toContain('CUS-000001 (registered account)');
    expect(r.description).toContain('Email on file: asha@example.com');
    expect(r.description).toContain('Mobile on file: +919876543210');
    expect(r.description).toMatch(/Identity has NOT been verified by the app/);
    expect(r.description).toContain('2026-10-22T10:00:00.000Z');
    expect(r.description).toContain('from a signed-in session in the app');
    expect(r.description).not.toContain('guest session');
  });

  it('lists open bookings, or says there are none, and truncates a very long list', () => {
    expect(buildDeletionRequest(base).description).toContain('Open bookings: none');
    expect(buildDeletionRequest({ ...base, openRefs: ['JPH000001', 'JPP000002'] }).description).toContain('Open bookings: JPH000001, JPP000002');
    const many = Array.from({ length: 30 }, (_, i) => `JPH${String(i + 1).padStart(6, '0')}`);
    const long = buildDeletionRequest({ ...base, openRefs: many });
    expect(long.description).toContain('and 10 more');
    expect(long.description).not.toContain('JPH000021');
  });

  it('carries the reason, trimmed, only when there is one', () => {
    expect(buildDeletionRequest({ ...base, reason: '  Moving abroad ' }).description).toContain('Reason: Moving abroad');
    expect(buildDeletionRequest({ ...base, reason: '  ' }).description).not.toContain('Reason:');
  });

  it('for a guest, names the guest session and the contact to reply to, and has no "on file" lines', () => {
    const r = buildDeletionRequest({ ...base, customer: guest, guest: true, contact: ' +91 98765 43210 ' });
    expect(r.description).toContain('CUS-000009 (guest session, no registered account)');
    expect(r.description).toContain('Contact for this request: +919876543210 (mobile)');
    expect(r.description).not.toContain('on file');
  });

  it('for a guest, does not say it came from a signed-in session', () => {
    const r = buildDeletionRequest({ ...base, customer: guest, guest: true, contact: 'g@example.com' });
    expect(r.description).toContain('from a guest session in the app');
    expect(r.description).not.toContain('signed-in');
    expect(r.description).toMatch(/Identity has NOT been verified by the app/);
  });

  it('never exceeds the support request limit', () => {
    expect(buildDeletionRequest({ ...base, reason: 'y'.repeat(5000) }).description.length).toBeLessThanOrEqual(4000);
  });
});


describe('the request as an email to the team', () => {
  const base = { customer, guest: false, openRefs: [] as string[], reason: '', contact: '', now: new Date('2026-10-22T10:00:00Z') };

  it('uses the website’s contact fields, the fixed subject, and the account’s own email as the reply address', () => {
    const m = deletionMessage(base);
    expect(m).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', subject: DELETION_SUBJECT });
    expect(m.message).toContain('CUS-000001 (registered account)');
    expect(m.message).toContain('does not delete my account straight away');
    expect(m.message).toContain('Identity has NOT been verified by the app');
    expect(m.message).toContain('from a signed-in session in the app');
  });

  it('keeps the account’s email as the reply address even if the customer adds another contact, and says so in the text', () => {
    const m = deletionMessage({ ...base, contact: 'other@example.com' });
    expect(m.email).toBe('asha@example.com');
    expect(m.message).toContain('Other contact given: other@example.com (email)');
  });

  it('for a guest, replies to the address they gave, and says it came from a guest session', () => {
    const m = deletionMessage({ ...base, customer: { ...customer, full_name: 'Guest', email: null, mobile: null, customer_code: 'CUS-000009', is_guest: true }, guest: true, contact: 'guest@example.com' });
    expect(m.name).toBe('Guest');
    expect(m.email).toBe('guest@example.com');
    expect(m.message).toContain('CUS-000009 (guest session, no registered account)');
    expect(m.message).toContain('from a guest session in the app');
    expect(m.message).not.toContain('signed-in');
  });

  it('for an account with no email, replies to the address they give', () => {
    const m = deletionMessage({ ...base, customer: { ...customer, email: null }, contact: 'new@example.com' });
    expect(m.email).toBe('new@example.com');
  });

  it('never exceeds the contact form’s limit for a message', () => {
    expect(deletionMessage({ ...base, reason: 'y'.repeat(5000) }).message.length).toBeLessThanOrEqual(5000);
  });
});
