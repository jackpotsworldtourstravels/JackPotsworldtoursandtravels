import { http } from '../client';

/** `GamingTourEnquiryCreate`: what the website's Gaming Tour enquiry form posts. */
export interface GamingEnquiryRequest {
  name: string;
  email: string;
  mobile: string;
  from_airport: string;
  to_airport: string;
  /** ISO with an offset, as the site sends it ("2026-11-20T10:00:00+05:30"). */
  travel_datetime: string;
  number_of_nights: number;
  casino_type: string;
}

export const enquiriesApi = {
  /**
   * `POST /api/customer/gaming-tour-enquiries` -> 201 `{enquiry_reference}`. Public: no session is needed, so none is sent.
   * It stores an ENQUIRY (a person calls the customer back with a quote), not a booking, and has no idempotency key,
   * so a lost answer cannot be checked and the screen says so instead of silently sending again. 5 a minute per client.
   */
  async submitGaming(input: GamingEnquiryRequest): Promise<{ enquiry_reference: string }> {
    const { data } = await http.post<{ enquiry_reference: string }>('/api/customer/gaming-tour-enquiries', input, { skipAuth: true });
    return data;
  },
};
