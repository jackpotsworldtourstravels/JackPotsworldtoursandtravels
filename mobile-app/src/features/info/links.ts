/**
 * THE WEBSITE'S INFORMATION PAGES, OPENED FROM THE APP.
 *
 * The labels and addresses are the footer's own (`frontend/assets/js/site-footer.js`,
 * `LINKS`), so the app lists what the site lists, in the site's order. The pages are
 * the website's, opened in an in-app browser: one copy of every policy to keep
 * correct, and the website stays the source of truth.
 * `tests/features/info-links.parity.test.ts` reads the footer and fails on drift.
 *
 * Not listed here on purpose: Contact Us (the app's Help and support screen is that
 * page), and Flights / Hotels / Tour Packages / Destinations / Gaming Packages (the
 * services, which are screens in the app).
 */
export interface InfoLink {
  label: string;
  /** A path on the website's origin, which is also the API's origin. */
  path: string;
}

/** `company` in the footer, minus Contact Us. */
export const COMPANY_LINKS: readonly InfoLink[] = [
  { label: 'About Us', path: '/about.html' },
  { label: 'Customer Support', path: '/customer-support.html' },
  { label: 'FAQs', path: '/faqs.html' },
];

/** `legal` in the footer, all seven, in its order. */
export const LEGAL_LINKS: readonly InfoLink[] = [
  { label: 'Privacy Policy', path: '/privacy-policy.html' },
  { label: 'Website Terms & Conditions', path: '/terms-and-conditions.html' },
  { label: 'Cancellation & Refund Policy', path: '/cancellation-refund-policy.html' },
  { label: 'Cookie Policy', path: '/cookie-policy.html' },
  { label: 'Payment Security', path: '/payment-security.html' },
  { label: 'Disclaimer', path: '/disclaimer.html' },
  { label: 'Image Credits', path: '/image-credits.html' },
];
