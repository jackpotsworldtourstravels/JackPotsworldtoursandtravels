import {
  bookingHelpSubject,
  contactPayload,
  messageSchema,
  SUPPORT_ADDRESS,
  SUPPORT_HOURS,
  SUPPORT_VISITS,
  findRecentDuplicateTicket,
  hasRecentReply,
  isTicketClosed,
  replySchema,
  SUPPORT_EMAIL,
  SUPPORT_PHONE,
  ticketInput,
  ticketSchema,
  ticketStatusLabel,
} from '@/features/account/support';
import { createTicketSafely, replySafely } from '@/features/account/supportActions';

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { accountApi, resetAccountApi } from '../helpers/accountMock';
import { ticket } from '../fixtures/account';

jest.mock('@/api/endpoints/account', () => require('../helpers/accountMock').accountApiModule);

const NOW = new Date('2026-10-20T09:05:00Z').getTime();
const input = { subject: 'Help with booking JPH000123', description: 'Can I change the check-in date?', priority: 'normal' as const };

beforeEach(resetAccountApi);

describe('the request form', () => {
  it('needs a subject and a description', () => {
    const empty = ticketSchema.safeParse({ subject: '  ', description: ' ' });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining(['Tell us what this is about.', 'Tell us what happened or what you need.']),
    );
  });

  it('keeps to the server’s limits: 200 characters of subject, 4,000 of description', () => {
    expect(ticketSchema.safeParse({ subject: 'x'.repeat(201), description: 'ok' }).success).toBe(false);
    expect(ticketSchema.safeParse({ subject: 'ok', description: 'x'.repeat(4001) }).success).toBe(false);
    expect(ticketSchema.safeParse({ subject: 'x'.repeat(200), description: 'x'.repeat(4000) }).success).toBe(true);
  });

  it('always raises a ticket at normal priority: priority is not the customer’s call', () => {
    const values = ticketSchema.parse({ subject: '  Hello   there ', description: ' Please help ' });
    expect(ticketInput(values)).toEqual({ subject: 'Hello there', description: 'Please help', priority: 'normal' });
  });

  it('puts the booking reference in the subject, so the desk can find it at once', () => {
    expect(bookingHelpSubject({ booking_ref: 'JPP000045' })).toBe('Help with booking JPP000045');
  });

  it('needs a non-empty reply within 4,000 characters', () => {
    expect(replySchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(replySchema.safeParse({ message: 'x'.repeat(4001) }).success).toBe(false);
    expect(replySchema.parse({ message: ' hello ' }).message).toBe('hello');
  });
});

describe('ticket status', () => {
  it('reads in the customer’s words', () => {
    expect(ticketStatusLabel('open')).toBe('Open');
    expect(ticketStatusLabel('in_progress')).toBe('In progress');
    expect(ticketStatusLabel('resolved')).toBe('Resolved');
    expect(ticketStatusLabel('closed')).toBe('Closed');
  });

  it('turns a status it does not know into readable words rather than hiding it', () => {
    expect(ticketStatusLabel('waiting_on_customer')).toBe('Waiting on customer');
    expect(ticketStatusLabel('')).toBe('Open');
  });

  it('treats only "closed" as finished: replying to a resolved ticket reopens it on the server', () => {
    expect(isTicketClosed('closed')).toBe(true);
    expect(isTicketClosed('resolved')).toBe(false);
    expect(isTicketClosed('open')).toBe(false);
  });
});

describe('not sending the same request twice', () => {
  it('finds the ticket the customer just made, ignoring case and spacing', () => {
    const made = ticket({ created_at: '2026-10-20T09:03:00Z', subject: 'HELP with booking  JPH000123' });
    expect(findRecentDuplicateTicket([made], input, NOW)).toBe(made);
  });

  it('does not mistake an old ticket, or a different one, for it', () => {
    const old = ticket({ created_at: '2026-10-20T08:00:00Z' });
    const other = ticket({ created_at: '2026-10-20T09:03:00Z', description: 'Something else entirely' });
    expect(findRecentDuplicateTicket([old, other], input, NOW)).toBeNull();
  });

  it('finds the customer’s own identical reply, but never the team’s words', () => {
    const t = ticket({
      messages: [
        { id: 1, author_name: 'Asha', is_staff: false, message: 'Thanks, 5 Nov please', created_at: '2026-10-20T09:04:00Z' },
        { id: 2, author_name: 'Support', is_staff: true, message: 'Thanks, 5 Nov please', created_at: '2026-10-20T09:04:30Z' },
      ],
    });
    expect(hasRecentReply(t, 'thanks,  5 nov please', NOW)).toBe(true);
    expect(hasRecentReply(t, 'A different message', NOW)).toBe(false);
    expect(hasRecentReply({ ...t, messages: [t.messages![1]] }, 'Thanks, 5 Nov please', NOW)).toBe(false);
  });

  it('sends a first attempt straight away, without looking first', async () => {
    accountApi.supportApi.create.mockResolvedValue(ticket());
    await createTicketSafely(input, false, NOW);
    expect(accountApi.supportApi.list).not.toHaveBeenCalled();
    expect(accountApi.supportApi.create).toHaveBeenCalledTimes(1);
  });

  it('after an attempt that ended without an answer, returns the ticket that already arrived and sends nothing', async () => {
    const arrived = ticket({ created_at: '2026-10-20T09:03:00Z' });
    accountApi.supportApi.list.mockResolvedValue([arrived]);
    await expect(createTicketSafely(input, true, NOW)).resolves.toBe(arrived);
    expect(accountApi.supportApi.create).not.toHaveBeenCalled();
  });

  it('after an attempt that ended without an answer and left nothing behind, sends it', async () => {
    accountApi.supportApi.list.mockResolvedValue([]);
    accountApi.supportApi.create.mockResolvedValue(ticket());
    await createTicketSafely(input, true, NOW);
    expect(accountApi.supportApi.create).toHaveBeenCalledWith(input);
  });

  it('does the same for a reply', async () => {
    accountApi.supportApi.get.mockResolvedValue(
      ticket({ messages: [{ id: 9, author_name: 'Asha', is_staff: false, message: 'Yes please', created_at: '2026-10-20T09:04:00Z' }] }),
    );
    await expect(replySafely(88, 'Yes please', true, NOW)).resolves.toBe('already_sent');
    expect(accountApi.supportApi.reply).not.toHaveBeenCalled();

    accountApi.supportApi.reply.mockResolvedValue({ id: 10 });
    await expect(replySafely(88, 'A new message', true, NOW)).resolves.toBe('sent');
    await expect(replySafely(88, 'First try', false, NOW)).resolves.toBe('sent');
    expect(accountApi.supportApi.get).toHaveBeenCalledTimes(2); // not asked on a first try
  });
});

describe('the company’s contact details', () => {
  // The numbers are the company's own, from its website. This fails if either side changes alone.
  // (Skipped, not failed, if this folder is checked out without the website beside it.)
  const file = resolve(__dirname, '../../../frontend/contact-us.html');
  const present = existsSync(file);
  const site = present ? readFileSync(file, 'utf8') : '';

  (present ? it : it.skip)('match the website’s contact page', () => {
    expect(site).toContain(`tel:${SUPPORT_PHONE}`);
    expect(site).toContain(`mailto:${SUPPORT_EMAIL}`);
  });

  (present ? it : it.skip)('hours, address and visiting note are the website’s words', () => {
    expect(site).toContain(`<dd>${SUPPORT_HOURS}</dd>`);
    expect(site).toContain(`<address>${SUPPORT_ADDRESS}</address>`);
    expect(site).toContain(SUPPORT_VISITS);
  });
});

describe('a message to the team', () => {
  const ok = { name: '  Asha   Rao ', email: ' asha@example.com ', subject: '', message: '  Please help  ' };

  it('is tidied, and an empty subject is left out of what is sent', () => {
    const parsed = messageSchema.parse(ok);
    expect(parsed).toEqual({ name: 'Asha Rao', email: 'asha@example.com', subject: '', message: 'Please help' });
    expect(contactPayload(parsed)).toEqual({ name: 'Asha Rao', email: 'asha@example.com', message: 'Please help' });
    expect(contactPayload(messageSchema.parse({ ...ok, subject: ' About JPH1 ' }))).toMatchObject({ subject: 'About JPH1' });
  });

  it('needs a name, a reply address and a message, in plain words', () => {
    const r = messageSchema.safeParse({ name: ' ', email: 'nope', subject: '', message: ' ' });
    expect(r.success).toBe(false);
    const messages = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining(['Tell us your name.', 'Enter an email address we can reply to.', 'Tell us what you need.']));
  });

  it('keeps to the server’s limits', () => {
    expect(messageSchema.safeParse({ ...ok, message: 'x'.repeat(5001) }).success).toBe(false);
    expect(messageSchema.safeParse({ ...ok, message: 'x'.repeat(5000) }).success).toBe(true);
    expect(messageSchema.safeParse({ ...ok, subject: 's'.repeat(201) }).success).toBe(false);
  });
});
