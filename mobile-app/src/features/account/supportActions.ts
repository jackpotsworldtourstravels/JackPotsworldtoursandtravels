import { supportApi } from '@/api/endpoints/account';
import type { SupportTicket, SupportTicketInput } from '@/types/account';

import { findOpenDeletionRequest } from './deletion';
import { findRecentDuplicateTicket, hasRecentReply } from './support';

/**
 * Raise a ticket without creating the same one twice.
 *
 * `POST /support-tickets` has no idempotency key. When an earlier attempt ended
 * without an answer (timeout, dropped connection) the ticket may already exist,
 * so `checkFirst` looks for one the customer just made and returns it instead of
 * sending the words again. A first attempt goes straight through.
 */
export async function createTicketSafely(
  input: SupportTicketInput,
  checkFirst: boolean,
  now: number = Date.now(),
): Promise<SupportTicket> {
  if (checkFirst) {
    const existing = findRecentDuplicateTicket(await supportApi.list(), input, now);
    if (existing) return existing;
  }
  return supportApi.create(input);
}

/**
 * Raise the account-deletion request without raising it twice. The words carry a send time, so a retry never
 * matches the first attempt's text; what identifies "already sent" is a deletion request still open on the
 * account (the same rule the screen uses to show "you've already asked").
 */
export async function createDeletionRequestSafely(input: SupportTicketInput, checkFirst: boolean): Promise<SupportTicket> {
  if (checkFirst) {
    const existing = findOpenDeletionRequest(await supportApi.list());
    if (existing) return existing;
  }
  return supportApi.create(input);
}

/** The same for a reply. Returns whether it was sent now or had already arrived. */
export async function replySafely(
  ticketId: number,
  message: string,
  checkFirst: boolean,
  now: number = Date.now(),
): Promise<'sent' | 'already_sent'> {
  if (checkFirst) {
    const ticket = await supportApi.get(ticketId);
    if (hasRecentReply(ticket, message, now)) return 'already_sent';
  }
  await supportApi.reply(ticketId, message);
  return 'sent';
}
