# UI overhaul — Phase 0 diagnosis

Branch: `feature/mobile-ui-overhaul`. Expo SDK 58, React Native 0.88, Expo Router, TypeScript.

## Inputs

- **MakeMyTrip reference screenshots: not available.** `./design-reference/makemytrip/` does not exist and no
  reference ZIP was found on the machine. Layout decisions follow the written patterns in the brief and the
  approved mockups in [`../mockups/ui-overhaul/`](../mockups/ui-overhaul/) (28 screens, signed off before work began).
- **Logo:** `mobile-app/assets/images/logo.png` (the official file). Not redrawn.
- **Owner adjustment (after mockup sign-off):** the Home header carries **no logo and no
  "JackPots World Tours & Travels" wordmark**. Only the greeting and the notification bell.

## Why the app looks like the website

The app was built as a faithful port of jackpotsworldtours.com, and the code says so on purpose. Tests named
`*.parity.test.ts` fail the build if the app drifts from the website's HTML/CSS. The causes the brief lists are
all present:

| Cause | Where it is |
|---|---|
| Large serif display headings | `theme/typography.ts`: `display`, `h1`, `h2`, `h3` are Playfair Display (40/32/26/21 px). Every screen title, section title and empty state uses them. |
| Oversized hero banners and landing-page copy | `(tabs)/index.tsx` opens with a 480 px Dubai photograph and a 55 px uppercase serif headline; `EditorialHero` (Explore, Bookings, Wishlist, Flights, Hotels, Packages) and `PageShell` (Support) open every page with a breadcrumb, kicker, two-line serif title and lede. |
| Website sections stacked in one ScrollView | Home = hero → search dock → numbered destination grid → `PromiseSection` (8 marketing promises) → `Finale` (closing scene + newsletter) → `SiteFooter`. |
| A website footer on app screens | `SiteFooter` (company/travel/legal columns, contact block, copyright bar) is appended to Home, Explore, Bookings, Wishlist, Flights, Hotels, Packages, destination, hotel and package detail, and every `PageShell` page. |
| Hamburger-first navigation | `HeaderActions` puts the website's header in the app: wishlist heart, LOGIN / CREATE pill and a burger that opens the website's full-screen numbered drawer, duplicating the tab bar. |
| Logo repeated on every screen | `BrandHeader` draws the logo on every header, inner screens included. |
| Trust strip | `TrustStrip` ("Best fares / Secure booking / 24×7 …") inside the search card. |
| Inline web-style forms | `SearchCard` is the website's dock: a dark tab strip joined to a form, all inline on Home; there are no full-screen pickers. |
| `maxWidth` reading columns | `CONTENT_MAX_WIDTH = 640` and `Pad` wrappers everywhere (harmless on phones, but a web pattern). |
| Tokens are good; usage is not | `theme/tokens.ts` is clean and already matches the brand. Screens mostly use tokens, but the typography scale is web-sized (body 15, button 16, display 40-55) and several components hard-code website measurements (`fontSize: 55.4`, `borderRadius: 18/20`, `paddingHorizontal: 15`). |
| No sticky action bars | Prices and primary actions live inside `DetailHero` at the top of the page and scroll away. No sort/filter bar, no sticky footers, no skeletons (spinners on blank areas). |

What is already right and is kept: the API layer, hooks, auth, payment, idempotency and booking logic, the
honest data rules (indicative rates, server quotes, "destination photo, not this hotel", flights fail closed),
`BottomSheet`, `Calendar`, `Stepper`, `FieldButton` and the money/date utilities.

## Screen inventory

| Route file | What it shows | Data hooks | Visual problems |
|---|---|---|---|
| `(tabs)/index.tsx` | Home | `useDestinations` | Website hero, serif headline, inline search dock + trust strip, promises, newsletter, footer, burger drawer. |
| `(tabs)/explore.tsx` | Destination grid + search | `useDestinations` | `EditorialHero` banner, footer. |
| `(tabs)/bookings.tsx` | My bookings (grouped) | `useMyBookings` | `EditorialHero` ("My journeys."), footer. |
| `(tabs)/wishlist.tsx` | Saved hotels/packages | `useWishlist` | `EditorialHero`, footer. |
| `(tabs)/profile.tsx` | Account hub | `useAuth` | Logo header, serif headings. |
| `(auth)/sign-in.tsx`, `verify.tsx`, `sign-up.tsx` | OTP sign-in, sign-up | `useAuth` | `AuthFrame` web layout; OTP is a single text field. |
| `flights/index.tsx` | Flight search + unavailable state | `useFlightCapability` | `EditorialHero`, footer. |
| `hotels/index.tsx` | Hotel results | `useHotels`, `useDestinationHotelsInfinite`, `useDestinations` | `EditorialHero` summary, no sort/filter bar, footer. |
| `hotels/[id].tsx` | Hotel detail + rooms | `useHotelDetail` | `DetailHero` with price/CTA at top, no sticky tabs/footer, footer. |
| `packages/index.tsx` | Package results | `usePackages` | `EditorialHero`, footer. |
| `packages/[id].tsx` | Package detail + departures | `usePackageDetail` | `DetailHero`, footer. |
| `packages/enquire.tsx` | Date enquiry form | `useAuth` | Serif headings. |
| `destination/[id].tsx` | One destination | `useDestination*`, `usePackages` | `DetailHero`, footer. |
| `book/hotel.tsx`, `book/package.tsx` | Review → travellers → pay | `useHotelQuote`, `usePackageQuote`, `useTravellers` | No step indicator, no sticky pay bar. |
| `booking/[ref].tsx` | Booking detail, pay, cancel | `useBooking` | Long single column. |
| `payments/index.tsx` | Payment history | `useMyBookings` | Logo header. |
| `travellers/index.tsx`, `edit.tsx` | Saved travellers | `useTravellers`, `useSaveTraveller`, `useDeleteTraveller` | Logo header. |
| `support/index.tsx`, `new.tsx`, `[id].tsx` | Support hub, new ticket, conversation | `useSupportTickets`, `useSupportTicket` | `PageShell` (breadcrumb hero + footer). |
| `account/edit.tsx`, `sessions.tsx`, `delete.tsx` | Profile edit, sessions, deletion request | `useUpdateProfile`, `useSessions`, … | Logo header. |
| `gaming/index.tsx` | Disabled stub | none | Stays disabled; not linked anywhere. |
| `+not-found.tsx` | 404 | none | Logo header. |

## Data gaps found while designing (affect what screens can show)

- **No package has an itinerary, hotel list or exclusions** (`itinerary: []`, `hotels: []`, `exclusions: []` for all
  11). The Itinerary / Exclusions / Hotels tabs render an honest empty state.
- **No verified photo exists for any Hyderabad hotel**; the app's resolver shows the city photo labelled
  "Destination photo · not this hotel". Only Novotel Bengaluru has its own photo. One photo per hotel means no
  carousel dots.
- **Flights:** the backend reports `provider: "demo"`, so results show `UnavailableState`.
- **Offers:** `/coupons` returns only a flights coupon whatever product is asked for, so Home has no offers rail.
- **Cancellation progress:** no customer read API, so booking detail shows the policy and the request reference only.
