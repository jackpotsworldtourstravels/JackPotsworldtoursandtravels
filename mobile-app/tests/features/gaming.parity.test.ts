import { readFileSync } from 'fs';
import { resolve } from 'path';

import { GAMING_COPY } from '@/features/gaming/gamingForm';

/**
 * The gaming enquiry is the website's. These tests read `gaming-packages.html` and `gaming-enquiry.js`
 * and fail if the app's wording or messages drift from them.
 */
const FRONTEND = resolve(__dirname, '../../../frontend');
const html = readFileSync(resolve(FRONTEND, 'gaming-packages.html'), 'utf8');
const js = readFileSync(resolve(FRONTEND, 'assets/js/gaming-enquiry.js'), 'utf8');

// The page's text uses plain apostrophes; the app uses typographic ones.
const plain = (s: string) => s.replace(/’/g, "'");

describe('wording matches frontend/gaming-packages.html', () => {
  it('heading and section titles', () => {
    expect(html).toContain(`<h1>${GAMING_COPY.title}</h1>`);
    for (const s of [GAMING_COPY.customer, GAMING_COPY.travel, GAMING_COPY.preference]) {
      expect(html).toContain(`>${s.title}</h2>`);
      expect(html).toContain(`>${plain(s.sub)}</p>`);
    }
  });

  it('lede, submit button and the confirmation', () => {
    expect(html).toContain(GAMING_COPY.lede.slice(0, 40));
    expect(html).toContain(`>${GAMING_COPY.submit}</button>`);
    expect(html).toContain(`<h2>${GAMING_COPY.received.title}</h2>`);
    expect(html).toContain(`<p>${GAMING_COPY.received.body}</p>`);
  });

  it('what happens next, and the side note', () => {
    expect(html).toContain(`<h3>${GAMING_COPY.next.title}</h3>`);
    for (const item of GAMING_COPY.next.items) expect(html).toContain(`<span>${item}</span>`);
    expect(html).toContain(`${GAMING_COPY.talk} <a href="contact-us.html">${GAMING_COPY.contact}</a> ${GAMING_COPY.talkTail}`);
  });
});

describe('validation matches frontend/assets/js/gaming-enquiry.js', () => {
  it.each([
    'Please enter your full name.',
    'Please enter your email address.',
    'Please enter a valid email address.',
    'Please enter your mobile number.',
    'Please enter a valid mobile number.',
    'Please enter a departure airport.',
    'Please enter an arrival airport.',
    'Please choose a travel date and time.',
    'Please enter the number of nights (1 or more).',
    'Please tell us your casino preference.',
  ])('the site says "%s"', (message) => {
    expect(js).toContain(message);
  });

  it('the same limits: 7 to 15 digits in a mobile, 1 to 90 nights, the same offset', () => {
    expect(js).toContain('mobileDigits.length < 7 || mobileDigits.length > 15');
    expect(js).toContain('nights > 0 && nights <= 90');
    expect(js).toContain('+05:30');
  });

  it('posts to the same endpoint with the same fields', () => {
    expect(js).toContain('/api/customer/gaming-tour-enquiries');
    for (const field of ['name', 'email', 'mobile', 'from_airport', 'to_airport', 'travel_datetime', 'number_of_nights', 'casino_type']) expect(js).toContain(`${field}:`);
  });
});
