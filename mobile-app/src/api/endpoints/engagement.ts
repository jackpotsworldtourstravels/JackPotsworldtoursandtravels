import type { ContactPayload } from '@/features/account/support';

import { http } from '../client';

/** Public, no-session endpoints that are not part of the customer account API. */
export const engagementApi = {
  /**
   * `POST /api/newsletter` -> 204. The backend relays the address to the business
   * inbox by email, so a 503 means the mail could not be sent, not that the address
   * was bad. Limited to 10 a minute per client. Nothing is stored for the customer.
   */
  async subscribeNewsletter(email: string): Promise<void> {
    await http.post('/api/newsletter', { email }, { skipAuth: true });
  },

  /**
   * `POST /api/contact` -> 204: the website's contact form. The backend emails the message to the business inbox and
   * stores nothing, so there is no reference to show and no way to check a lost answer. A 503 means the mail could not
   * be sent. Limited to 5 a minute per client.
   */
  async sendContactMessage(payload: ContactPayload): Promise<void> {
    await http.post('/api/contact', payload, { skipAuth: true });
  },
};
