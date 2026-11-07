import { z } from 'zod';

import { cleanMobile } from '@/features/auth/schemas';
import { groupBookings } from '@/features/booking/groups';
import type { BookingRow } from '@/features/booking/hooks';
import type { SupportTicket, SupportTicketInput } from '@/types/account';
import type { Customer } from '@/types/api';
import { todayISO, type ISODate } from '@/utils/dates';

import type { ContactPayload } from './support';

/**
 * AN ACCOUNT-DELETION *REQUEST*, NOT A DELETION.
 *
 * The backend has no endpoint that deletes or closes an account, so the app does the one thing it can do
 * honestly: it sends the team a request, BY EMAIL through the website's contact channel (the website's support
 * is no longer a ticket queue, and its staff tools do not answer tickets), which a person completes under the website's privacy
 * policy (erase what is no longer needed; keep what the law requires; answer within 30 days of a verified
 * request). Nothing here deletes anything, and nothing here verifies anyone's identity: the request says
 * whether it came from a signed-in session or a guest session and the desk still verifies, as the policy says it will.
 *
 * The proper fix is a backend endpoint. This is the interim.
 */
export const DELETION_SUBJECT = 'Account deletion request';

/** The policy's promise: a response within 30 days of a verified request. */
export const RESPONSE_DAYS = 30;

const MOBILE_RE = /^\+?\d{8,15}$/;

/** What the customer is told will be removed, and what must be kept, in the policy's own terms (sections 8 and 10). */
export const WILL_BE_DELETED = [
  'Your profile: name, contact details, date of birth, gender and address.',
  'Saved travellers, including passport details, once no trip or claim needs them.',
  'Your wishlist and saved preferences.',
  'Your sign-in on every device.',
] as const;

export const MUST_BE_KEPT = [
  'Booking records, invoices and payment references: kept for as long as tax, accounting and company law require, which in India is generally at least eight financial years.',
  'Travel documents for a trip that has not happened yet, or has an open refund, claim or dispute: kept until it is closed, then deleted.',
  'Your support requests, including this one: kept for up to three years from the last contact.',
] as const;

/** Bookings that are unpaid and still payable, or paid with the trip still ahead: the ones that affect when a request can be completed. */
export function openBookingRefs(rows: readonly BookingRow[], today: ISODate = todayISO()): string[] {
  return groupBookings(rows, today)
    .filter((s) => s.group === 'awaiting' || s.group === 'upcoming')
    .flatMap((s) => s.rows.map((r) => r.booking.booking_ref));
}

/** An unanswered deletion request already on the account, so the customer is not asked to send a second. */
export function findOpenDeletionRequest(tickets: readonly SupportTicket[]): SupportTicket | null {
  return (
    tickets.find(
      (t) => t.subject.trim().toLowerCase() === DELETION_SUBJECT.toLowerCase() && t.status !== 'closed' && t.status !== 'resolved',
    ) ?? null
  );
}

/** An email address or a mobile number, tidied; null if it is neither. */
export function parseContact(value: string): { kind: 'email' | 'mobile'; value: string } | null {
  const v = value.trim();
  if (z.email().safeParse(v).success) return { kind: 'email', value: v };
  const m = cleanMobile(v);
  return MOBILE_RE.test(m) ? { kind: 'mobile', value: m } : null;
}

/**
 * The form. The team replies by EMAIL, so an email address is REQUIRED when there is none on the account: for a
 * guest, or an account with no email. A registered customer's email is already on the account, and may add another
 * email or a mobile number.
 */
export function deletionSchema(needsEmail: boolean) {
  return z
    .object({
      reason: z.string().trim().max(500, 'Please keep this under 500 characters.'),
      contact: z.string().trim().max(200, 'That is too long.'),
      confirmed: z.boolean(),
    })
    .superRefine((v, ctx) => {
      if (!v.confirmed) {
        ctx.addIssue({ code: 'custom', path: ['confirmed'], message: 'Tick the box to confirm you understand.' });
      }
      if (needsEmail) {
        if (parseContact(v.contact)?.kind !== 'email') {
          ctx.addIssue({ code: 'custom', path: ['contact'], message: 'Give an email address we can reply to.' });
        }
      } else if (v.contact && !parseContact(v.contact)) {
        ctx.addIssue({ code: 'custom', path: ['contact'], message: 'Enter a valid email address or mobile number, or leave this blank.' });
      }
    });
}
export type DeletionFormInput = z.input<ReturnType<typeof deletionSchema>>;
export type DeletionFormOutput = z.output<ReturnType<typeof deletionSchema>>;

const MAX_LISTED = 20;

/** The support request the desk receives. A fixed subject, normal priority, and everything the desk needs to act without writing back. */
export function buildDeletionRequest(input: {
  customer: Customer;
  guest: boolean;
  openRefs: readonly string[];
  reason: string;
  contact: string;
  now?: Date;
}): SupportTicketInput {
  const { customer, guest, openRefs, now = new Date() } = input;
  const contact = parseContact(input.contact);
  const listed = openRefs.slice(0, MAX_LISTED).join(', ');
  const lines = [
    'Account deletion request (sent from the mobile app).',
    '',
    'Please delete my account and personal data in line with your privacy policy, keeping only the records you are required by law to retain.',
    '',
    `Account: ${customer.customer_code} (${guest ? 'guest session, no registered account' : 'registered account'})`,
    ...(guest ? [] : [`Email on file: ${customer.email ?? 'none'}`, `Mobile on file: ${customer.mobile ?? 'none'}`]),
    ...(contact ? [`${guest ? 'Contact for this request' : 'Other contact given'}: ${contact.value} (${contact.kind})`] : []),
    `Open bookings: ${openRefs.length === 0 ? 'none' : `${listed}${openRefs.length > MAX_LISTED ? ` and ${openRefs.length - MAX_LISTED} more` : ''}`}`,
    ...(input.reason.trim() ? ['', `Reason: ${input.reason.trim()}`] : []),
    '',
    'I understand that sending this does not delete my account straight away, that records you must keep by law (such as bookings and payments) will be retained, and that your team will verify my identity and respond within 30 days.',
    '',
    `Sent ${now.toISOString()} from ${guest ? 'a guest session' : 'a signed-in session'} in the app. Identity has NOT been verified by the app: please verify as your policy describes.`,
  ];
  return { subject: DELETION_SUBJECT, description: lines.join('\n').slice(0, 4000), priority: 'normal' };
}

/**
 * The same request as an email to the team: the website's contact form (name, email, subject, message). The reply goes
 * to `email`: the account's own address for a registered customer, otherwise the address they gave.
 */
export function deletionMessage(input: {
  customer: Customer;
  guest: boolean;
  openRefs: readonly string[];
  reason: string;
  contact: string;
  now?: Date;
}): ContactPayload {
  const { customer, guest } = input;
  const contact = parseContact(input.contact);
  const email = (!guest && customer.email) || (contact?.kind === 'email' ? contact.value : '');
  const request = buildDeletionRequest(input);
  return {
    name: guest ? 'Guest' : customer.full_name || 'Customer',
    email,
    subject: request.subject,
    message: request.description,
  };
}
