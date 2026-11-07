import { z } from 'zod';

import type { SupportTicket, SupportTicketInput, TicketStatus } from '@/types/account';
import type { AnyBooking } from '@/types/booking';

const tidyLine = (v: string) => v.split(/\s+/).filter(Boolean).join(' ');

/** The company's own contact details, as published on its website (frontend/contact-us.html). */
export const SUPPORT_PHONE = '+919177847799';
export const SUPPORT_PHONE_DISPLAY = '+91 91778 47799';
export const SUPPORT_EMAIL = 'support@jackpotsworldtours.com';
/** From the same page: when the phone is answered, where the agency is, and how to visit. */
export const SUPPORT_HOURS = '24 hours a day, 7 days a week';
export const SUPPORT_ADDRESS = 'Hyderabad, Telangana, India';
export const SUPPORT_VISITS = 'Visits are by appointment, so please call before travelling to see us.';

/**
 * A message to the team, sent the way the website's own contact form sends one:
 * `POST /api/contact`, which relays it to the business inbox by email (name, email,
 * optional subject, message; ContactFormRequest). Tickets are no longer how the
 * website takes support requests, and its staff tools do not answer them, so new
 * messages do not go there. The team replies BY EMAIL, to the address given here.
 */
export const messageSchema = z.object({
  name: z.string().transform(tidyLine).pipe(z.string().min(1, 'Tell us your name.').max(120, 'That is too long.')),
  email: z.string().trim().pipe(z.email('Enter an email address we can reply to.')),
  subject: z.string().transform(tidyLine).pipe(z.string().max(200, 'Please keep the subject under 200 characters.')),
  message: z.string().trim().pipe(z.string().min(1, 'Tell us what you need.').max(5000, 'Please keep this under 5,000 characters.')),
});
export type MessageFormInput = z.input<typeof messageSchema>;
export type MessageFormOutput = z.output<typeof messageSchema>;

export interface ContactPayload {
  name: string;
  email: string;
  subject?: string;
  message: string;
}

/** An empty subject is left out rather than sent blank, as the website's form does. */
export function contactPayload(values: MessageFormOutput): ContactPayload {
  return { name: values.name, email: values.email, ...(values.subject ? { subject: values.subject } : {}), message: values.message };
}

/** What to tell someone whose message may or may not have arrived. Nothing here claims it did. */
export const MESSAGE_UNSURE =
  'We couldn’t confirm that your message reached us. It may already have, so check your email for our reply before sending it again. You can also call or email us.';

/** The server's limits for a ticket (`SupportTicketCreate`) and a reply (`SupportMessageCreate`). */
export const ticketSchema = z.object({
  subject: z
    .string()
    .transform(tidyLine)
    .pipe(z.string().min(1, 'Tell us what this is about.').max(200, 'Please keep the subject under 200 characters.')),
  description: z
    .string()
    .trim()
    .pipe(z.string().min(1, 'Tell us what happened or what you need.').max(4000, 'Please keep this under 4,000 characters.')),
});
export type TicketFormInput = z.input<typeof ticketSchema>;
export type TicketFormOutput = z.output<typeof ticketSchema>;

export const replySchema = z.object({
  message: z.string().trim().pipe(z.string().min(1, 'Write a message first.').max(4000, 'Please keep this under 4,000 characters.')),
});

/** Priority is not a customer's call (anyone could mark everything urgent), so every ticket is `normal`. */
export function ticketInput(values: TicketFormOutput): SupportTicketInput {
  return { subject: values.subject, description: values.description, priority: 'normal' };
}

/** A ticket opened from a booking starts with the reference in the subject, so the desk can find it at once. */
export function bookingHelpSubject(booking: Pick<AnyBooking, 'booking_ref'>): string {
  return `Help with booking ${booking.booking_ref}`;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  pending: 'Waiting for us',
  resolved: 'Resolved',
  closed: 'Closed',
};

export function ticketStatusLabel(status: TicketStatus): string {
  if (STATUS_LABEL[status]) return STATUS_LABEL[status];
  const text = status.replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Open';
}

/** Resolved and closed tickets are done; a reply to a resolved one reopens it on the server. */
export function isTicketClosed(status: TicketStatus): boolean {
  return status === 'closed';
}

const WINDOW_MS = 10 * 60_000;

const same = (a: string, b: string) => tidyLine(a).toLowerCase() === tidyLine(b).toLowerCase();

/**
 * Ticket creation has no idempotency key. If an answer is lost (timeout, dropped
 * connection) the ticket may exist; before sending the same words again, look
 * for one the customer just created and treat it as the answer.
 */
export function findRecentDuplicateTicket(tickets: readonly SupportTicket[], input: Pick<SupportTicketInput, 'subject' | 'description'>, now: number): SupportTicket | null {
  return (
    tickets.find(
      (t) => now - new Date(t.created_at).getTime() < WINDOW_MS && same(t.subject, input.subject) && same(t.description, input.description),
    ) ?? null
  );
}

/** The same check for a reply: the customer's own identical message, sent moments ago. */
export function hasRecentReply(ticket: SupportTicket, message: string, now: number): boolean {
  return (ticket.messages ?? []).some(
    (m) => !m.is_staff && now - new Date(m.created_at).getTime() < WINDOW_MS && same(m.message, message),
  );
}
