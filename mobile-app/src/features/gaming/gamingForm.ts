import type { GamingEnquiryRequest } from '@/api/endpoints/enquiries';
import { isISODate, type ISODate } from '@/utils/dates';

/**
 * THE WEBSITE'S GAMING TOUR ENQUIRY, AS DATA AND RULES.
 *
 * Wording is from `frontend/gaming-packages.html` (headings, labels, "Enquiry received", "What happens next")
 * and the messages and limits are `validate()` in `gaming-enquiry.js`, which mirror `GamingTourEnquiryCreate`.
 * `tests/features/gaming.parity.test.ts` reads those files and fails on drift. It is an ENQUIRY: a person
 * calls the customer back with a quote, and nothing is charged.
 */
export const GAMING_COPY = {
  title: 'Plan your gaming tour',
  lede: 'Casino trips are arranged one traveller at a time — tell us where and when you want to go, and our desk will call you back with a tailored quote.',
  customer: { title: 'Customer Information', sub: 'So our team can reach you about this enquiry.' },
  travel: { title: 'Travel Details', sub: 'Where you’re travelling from and to, and for how long.' },
  preference: { title: 'Gaming Preference', sub: 'Tell us what you’re after — as much detail as you like.' },
  submit: 'Submit Enquiry',
  received: { title: 'Enquiry received', body: 'Please wait, our team will contact you soon.' },
  next: {
    title: 'What happens next',
    items: [
      'A member of our gaming desk calls you back, usually within one business day.',
      'We put together a quote covering flights, stay and your gaming preferences.',
      'Nothing is charged until you confirm the trip with us.',
    ],
  },
  talk: 'Prefer to talk now?',
  contact: 'Contact us',
  talkTail: 'directly and mention Gaming Tours.',
} as const;

export interface GamingForm {
  name: string;
  email: string;
  mobile: string;
  from: string;
  to: string;
  date: ISODate | null;
  /** 24-hour "HH:MM". */
  time: string;
  nights: string;
  casino: string;
}

export const EMPTY_GAMING_FORM: GamingForm = { name: '', email: '', mobile: '', from: '', to: '', date: null, time: '10:00', nights: '', casino: '' };

export type GamingField = 'name' | 'email' | 'mobile' | 'from' | 'to' | 'datetime' | 'nights' | 'casino';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Every field's message, in the site's words, in the site's order. An empty object means the form is valid. */
export function gamingErrors(form: GamingForm): Partial<Record<GamingField, string>> {
  const errors: Partial<Record<GamingField, string>> = {};
  if (!form.name.trim()) errors.name = 'Please enter your full name.';

  const email = form.email.trim();
  if (!email) errors.email = 'Please enter your email address.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Please enter a valid email address.';

  const mobile = form.mobile.trim();
  const digits = mobile.replace(/[^\d]/g, '');
  if (!mobile) errors.mobile = 'Please enter your mobile number.';
  else if (digits.length < 7 || digits.length > 15) errors.mobile = 'Please enter a valid mobile number.';

  if (!form.from.trim()) errors.from = 'Please enter a departure airport.';
  if (!form.to.trim()) errors.to = 'Please enter an arrival airport.';

  if (!form.date || !isISODate(form.date) || !TIME_RE.test(form.time.trim())) errors.datetime = 'Please choose a travel date and time.';

  const nights = Number(form.nights);
  if (!(nights > 0 && nights <= 90)) errors.nights = 'Please enter the number of nights (1 or more).';

  if (!form.casino.trim()) errors.casino = 'Please tell us your casino preference.';
  return errors;
}

/** The request the site's form sends. The site appends +05:30 to the local time it asked for. */
export function gamingRequest(form: GamingForm): GamingEnquiryRequest {
  return {
    name: form.name.trim(),
    email: form.email.trim(),
    mobile: form.mobile.trim(),
    from_airport: form.from.trim(),
    to_airport: form.to.trim(),
    travel_datetime: `${form.date}T${form.time.trim()}:00+05:30`,
    number_of_nights: Number(form.nights),
    casino_type: form.casino.trim(),
  };
}
