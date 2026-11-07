/**
 * THE HOME PAGE'S WORDS, FROM THE WEBSITE.
 *
 * Every string here is copied from `frontend/index.html` (hero, destinations, the
 * "promise" and the closing scene) or `frontend/assets/js/booking-card.js` (the
 * trust strip under the search card), so the app says what the site says.
 * `tests/features/home-copy.parity.test.ts` reads those files and fails if the two
 * drift, the way the support contact details are already guarded.
 *
 * TWO LINES DIFFER ON PURPOSE, and are listed in `DEVIATIONS` with the website's
 * original, so nothing is changed silently:
 *   - the site's "24x7 Customer Support" promises "chat and call"; the app has no
 *     live chat yet (the phone and in-app requests are what exists), and
 *   - the site's "Travel Made Simple" says "Flights, hotels and tours"; Flights are
 *     not in the app (the backend reports a sample supplier).
 * Each reverts to the website's wording when the feature it describes ships.
 */

export const HERO = {
  line1: 'The World',
  accent: 'Awaits',
  line2: 'You.',
} as const;

/** `booking-card.js` TRUST: the three reassurances under the search card. */
export const TRUST = [
  { icon: 'lock-closed-outline', title: 'Secure Payments', sub: 'SSL secured' },
  { icon: 'headset-outline', title: '24/7 Support', sub: 'Always here for you' },
  { icon: 'checkmark-circle-outline', title: 'Fast Confirmation', sub: 'Quick booking updates' },
] as const;

export const DESTINATIONS = {
  kicker: 'Where we can take you',
  title1: 'Destinations,',
  title2: 'chosen with care.',
  lede: 'Explore destinations and discover new places — from the old city of Hyderabad to the atolls of the Indian Ocean.',
} as const;

export interface Benefit {
  /** An Ionicons name standing in for the site's jp-icons glyph named in `siteIcon`. */
  icon: string;
  siteIcon: string;
  title: string;
  body: string;
}

export const PROMISE = {
  kicker: 'The JackPots World promise',
  statement: ['Travel', 'without', 'limits.'],
  sub: 'Eight reasons travellers stop comparing tabs and just book here.',
  items: [
    { icon: 'flash-outline', siteIcon: 'zap', title: 'Fast Booking', body: 'Quick, clear booking updates.' },
    { icon: 'checkmark-circle-outline', siteIcon: 'circleCheck', title: 'Fair, Transparent Pricing', body: 'Clear pricing, shown upfront.' },
    { icon: 'lock-closed-outline', siteIcon: 'lock', title: 'Secure Payments', body: 'Bank-grade encryption on every transaction, every time.' },
    { icon: 'bed-outline', siteIcon: 'bedDouble', title: 'Curated Hotels', body: 'Carefully selected properties.' },
    { icon: 'time-outline', siteIcon: 'clock3', title: '24×7 Customer Support', body: 'Real humans on the phone, any hour, any day.' },
    { icon: 'close-circle-outline', siteIcon: 'circleX', title: 'Flexible Options', body: 'Cancellation options vary by booking.' },
    { icon: 'refresh-outline', siteIcon: 'rotateCcw', title: 'Straightforward Refunds', body: 'Processed according to booking policy.' },
    { icon: 'people-outline', siteIcon: 'usersRound', title: 'Travel Made Simple', body: 'Hotels and tours in one place.' },
  ] as readonly Benefit[],
} as const;

/** Where the app's wording departs from the website's, and what the website says. */
export const DEVIATIONS: Record<string, { website: string; reason: string }> = {
  '24×7 Customer Support': {
    website: 'Real humans on chat and call, any hour, any day.',
    reason: 'The app has no live chat or in-app calling yet.',
  },
  'Travel Made Simple': {
    website: 'Flights, hotels and tours in one place.',
    reason: 'Flights are not in the app yet.',
  },
};

export const FINALE = {
  kicker: 'Your next chapter',
  title1: 'Ready',
  accent: 'to go?',
  lede: 'Tell us where, when and who with. A travel expert plans the rest — usually within a few hours.',
  cta: 'Plan your journey',
  newsletter: {
    heading: 'Never miss amazing travel deals',
    text: 'One email a week. Fares, flash sales, and visa updates — nothing else.',
    placeholder: 'you@example.com',
    label: 'Email address',
    button: 'Subscribe',
    success: "You're subscribed! Watch your inbox for deals.",
    error: 'Something went wrong — please try again.',
  },
} as const;
