# Website-to-app parity matrix

The website (`frontend/`) is the source of truth. This file is the working checklist for the whole customer experience:
what each website page is, what the app has, how they compare, and what is verified and how. It is updated at the end of
every batch. **Last updated: 2026-10-23, after batch 3.**

Status codes: **A** complete and matched, **B** implemented but visually or functionally different or incomplete,
**C** missing, **D** broken, **E** blocked by an external integration or a backend/website decision.

How "verified" is meant: **Phone** = seen on the physical Android phone (Metro over USB, development build);
**Web** = seen in the Expo web preview at 390px next to the live website page; **Tests** = jest only. Tests alone never
count as visual parity.

## 1. Shared design system (batch 1 and 2)

| Piece | Website source | App | Status | Verified |
|---|---|---|---|---|
| Colours, fonts | `jw-system.css`, `home-cinema.css` (`--cn-*`) | `src/theme` (+ Playfair 700 added for page titles) | A | Tests (colour parity) |
| Header and menu | `jw-header.js`, drawer in `index.html` | `HeaderActions.tsx` (numbered full-screen drawer, two-bar burger) | A | Phone |
| Footer | `site-footer.js`, footer in `index.html` | `features/home/SiteFooter.tsx`, now on **every converted inner page** too | A | Phone |
| Booking-card field tiles | `home-cinema.css` computed styles | `FieldButton` (`tile`) | A | Phone |
| Service-page form frame (hero + overlapping card, caps labels, coral submit) | `gaming-packages.html` computed styles | `PageShell`, `FormCard`, `FormSection`, `TextField`, `Button variant="coral"`, `FieldButton appearance="field"` | A | Phone |
| Editorial hero (photo, crumb, ruled kicker, serif title, summary with Edit) | `hotels.html`, `packages.html`, `destinations.html`, `flights.html` | `EditorialHero` | A | Phone |
| Detail hero (photo, place pill, name, price, cream CTA) | `package.html` | `DetailHero` | A | Phone |
| Account card on navy | `register.html` | `features/auth/AuthFrame.tsx` | A | Phone |
| Scroll motion (GSAP ScrollTrigger equivalent) | `home-cinema.js` | `features/motion/ScrollMotion.tsx` | A (Home); not used elsewhere | Phone |
| Bottom safe area (nothing under the system bar) | n/a | `Screen` now defaults `bottomInset` on; tab screens opt out | A | Phone (page bottoms) |
| Long header titles | n/a | `BrandHeader` wraps to two lines; service pages use the hero as the title | A | Phone |
| Loading, empty, error, retry states | `spinner.js`, per-page | `components/states.tsx` | B (own style, not the site's) | Tests |

## 2. Pages

| Website page | App route | Status | Notes and evidence |
|---|---|---|---|
| Home (`index.html`) | `(tabs)/index` | **A** | Owner accepted; footer and scroll animation done; Phone |
| Flights (`flights.html`) | `flights` | **B / E** | Hero, search form and its rules match (Phone). No live fares or booking: **E**, no supplier. Quote request by email is the honest ending. The site's results list ("Sample schedule", date strip, sort) is deliberately not reproduced |
| Hotels results (`hotels.html`) | `hotels` | **B** | Hero with date ribbon, cards with their facts, price block, coral "View rooms": **A** (Phone). Not done: the site's full **Filters** panel (8 filters, 8 sorts; the app has star rating, free cancellation and 5 sorts), the stay total and "taxes & fees" line (the site computes them with a display rate of 12%; the app's real quote comes from the server at booking, so it is not printed on the card) |
| Hotel details | `hotels/[id]` | **B** | Detail hero and footer done (Web). Rooms and booking flow are the app's own layout, not restyled to the site's rooms panel |
| Tour packages (`packages.html`) | `packages` | **B** | Hero, three category cards that filter, count, cards: **A** (Phone). The site's Filters panel is not reproduced (sort chips only) |
| Package details (`package.html`) | `packages/[id]` | **B** | Detail hero, price, enquiry/booking choice, footer: **A** (Phone). Sections exist (highlights, included, not included, itinerary, hotels, policy, departures). **C**: "Traveller reviews", "At a glance" panel |
| Destinations (`destinations.html`) | `(tabs)/explore` | **B** | Hero ("Where will you go?", counts) and footer done (Web). The grid is the app's own tiles, not the site's editorial layout |
| Destination (`destination.html`) | `destination/[id]` | **B** | Detail hero and footer (Web). Sections: places to visit, hotels, packages |
| Places to visit (`location.html`) | none | **C** | The app shows attractions as a shelf on the destination page; there is no per-location page (fare details, "good to know", pictures) |
| Gaming Tour Packages (`gaming-packages.html`) | `gaming` | **A** | Phone |
| Contact Us (`contact-us.html`) | `support`, `support/new` | **B** | Hero, card, caps fields, coral submit (Web/Tests). The site's form has a "Tour package" field; the app's message form is the general one (`/api/contact`). Delivery is by email to the business inbox: owner must confirm it is monitored |
| Customer Support (`customer-support.html`) | `support` + website page in the in-app browser | **B / E** | The site's support is live chat; the app has no live chat or calling (needs a real-time connection): **E** |
| About, FAQs, Privacy, Terms, Refund, Cookie, Payment Security, Disclaimer, Image Credits | Profile and footer links, opened in the in-app browser | **B** | Deliberate: one copy of every policy, the website's. Not native screens |
| Sign in / Register (`register.html`, `login`) | `(auth)/sign-in`, `sign-up`, `verify` | **B** | Card, title, caps labels match (Phone). The flow differs on purpose: email or mobile one-time code, not passwords |
| Forgot / reset password | none | **E** | The app has no passwords, so there is nothing to reset |
| My Bookings (`my-bookings.html`) | `(tabs)/bookings`, `booking/[ref]` | **B** | "Your travel / My journeys." hero and footer match the site (Phone). Functional list, detail, cancel request and pay; the booking cards and the detail screen are not restyled to the site's |
| Wishlist, Profile, notifications | `(tabs)/wishlist`, `(tabs)/profile`, `account/*`, `travellers/*` | **B** | Wishlist has the site's hero and footer (Web/Tests); Profile and account screens are functional and inherit the new field and button styles, without heroes. **C**: notifications inbox, My Reviews, change password (the site has them) |
| Booking and payment flows | `book/hotel`, `book/package`, `payments` | **B** | Functional with the app's safeguards; inherit new fields/buttons/insets; not restyled to the site's booking summary |
| Cruises, Activities, Visa | none | **C / n.a.** | Website pages that are not products (earlier audit) |
| Partner and staff portals | menu opens `partner-login.html` in the browser | n.a. | Out of scope for the customer app |

## 3. Functional rules checked against the site

Flight search fields, trip types, passenger limits and validation messages; Gaming enquiry fields, limits and messages;
footer link lists; header menu order; destinations first-nine-then-all rule: each is pinned by a parity test that reads the
website file. See `tests/features/*.parity.test.ts`.

## 4. Unresolved, and what each needs

| Item | What is needed |
|---|---|
| Live flight fares and booking | A real flight supplier (the backend reports a demo provider) |
| Live chat and calling in support | A real-time connection in the app, and the backend's chat service exposed to it |
| Support and deletion emails | The owner confirming the business inbox is monitored; local email is blank, so a real send is untested |
| Hotel "taxes & fees" and stay total on the card | A decision: print the site's 12% display estimate, or keep showing only the nightly rate |
| Native copies of About, FAQs and the policies | A decision: native screens duplicate text that must stay in step with the site |
| Notifications, reviews, change password | Backend endpoints exist on the site; need a go-ahead to build the screens |
| Site Filters panel (hotels, packages) | More build work; no external dependency |
| Website pages without app equivalent (`location.html`) | More build work; no external dependency |
