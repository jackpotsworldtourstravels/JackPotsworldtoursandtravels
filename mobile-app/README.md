# JackpotsWorld mobile app

The Android and iOS app for JackpotsWorld Tours & Travels. One React Native / Expo / TypeScript codebase
that talks to the **same backend API and database as the website**. It has no database access of its own,
holds no secrets, and leaves every price, availability check and payment decision to the backend.

This folder is a standalone project: its own `package.json`, lockfile, config, tests and docs. Nothing outside
`mobile-app/` imports from it, and it imports nothing from `frontend/` or `backend/`.

> **Status: Phase 9 (release preparation) done; awaiting review.** Everything through quality assurance
> (Phase 8) is built and tested. Phase 9 added the release configuration (`eas.json`) and three documents:
> [`docs/RELEASE.md`](docs/RELEASE.md) (build, sign, submit, roll out), [`docs/STORE_LISTING.md`](docs/STORE_LISTING.md)
> (listing drafts and privacy answers) and the blockers list. **Nothing has been built in the cloud, signed or
> submitted.** Store submission is blocked until account deletion, review access, the bundle identifier, the
> privacy policy, a real-device pass and a real HDFC test are resolved (all listed in `RELEASE.md` §1). Live chat,
> calls, notifications and passport scanning are not built. Flights are deliberately **off** (see
> [Flights](#flights-are-gated-on-the-backend)).
>
> **Account deletion (interim, built, uncommitted).** Profile → *Delete my account* sends the support desk a
> **request**; it does **not** delete anything, verify anyone's identity or track a deadline: a person does all three.
> The public web page is **drafted, not published** ([`docs/ACCOUNT_DELETION_PAGE.md`](docs/ACCOUNT_DELETION_PAGE.md),
> [`docs/account-deletion.draft.html`](docs/account-deletion.draft.html)) and the staff process is in
> [`docs/ACCOUNT_DELETION_RUNBOOK.md`](docs/ACCOUNT_DELETION_RUNBOOK.md). **The proper backend deletion endpoint is
> still outstanding** and stays on the release-readiness list ([`docs/RELEASE.md`](docs/RELEASE.md) §1, §9).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configure the API address](#configure-the-api-address)
- [Run](#run)
- [Test, lint, typecheck](#test-lint-typecheck)
- [Project layout](#project-layout)
- [How it works](#how-it-works)
- [Building Android and iOS](#building-android-and-ios)
- [Known limitations](#known-limitations)

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 22 LTS | `node -v` |
| npm | 10 | the lockfile is `package-lock.json`; use npm, not yarn or pnpm |
| Expo SDK | 58 | installed per project; no global Expo CLI needed (`npx expo`) |
| Android Studio | optional | for the emulator. Java 17 |
| Xcode (macOS) | optional | iOS builds need a Mac or EAS cloud builds |
| Expo Go / dev build | optional | quickest way to try it on a real phone |

**Windows and OneDrive.** This repository lives under OneDrive. `node_modules` holds tens of thousands of
small files, which OneDrive will try to sync and which can lock files while Metro is running. Pause OneDrive
sync while installing and developing, or keep a working copy outside OneDrive. Android's native build also
hits Windows' 260-character path limit in deep folders: either enable long paths
(`LongPathsEnabled`) or use cloud builds (`eas build`), which avoid the problem entirely.

## Install

```bash
cd mobile-app
npm install
```

Always add dependencies with `npx expo install <package>`, never `npm install <package>`: it picks the version
that matches the SDK. `npx expo-doctor` checks the whole project (it passes 20/20 today).

## Configure the API address

Copy the template and edit it:

```bash
cp .env.example .env.local        # Windows: copy .env.example .env.local
```

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Origin of the backend: scheme, host, optional port. No path. |
| `EXPO_PUBLIC_APP_ENV` | `development`, `staging` or `production`. Labels and diagnostics only. |

Rules, enforced at startup by [`src/config/env.ts`](src/config/env.ts) and covered by tests:

- **`https://` is mandatory** for staging and production, and for any release build. `http://` is accepted
  only in a development build with `APP_ENV=development`.
- A release build with no address **refuses to start** rather than guess one.
- Development builds fall back to the emulator addresses when the variable is unset.

| Where the app runs | Use |
|---|---|
| Android emulator | `http://10.0.2.2:8000` (the host machine) |
| iOS simulator | `http://127.0.0.1:8000` |
| Physical phone on your Wi-Fi | `http://<your PC's LAN IP>:8000`, and start the backend with `--host 0.0.0.0` |
| Production | `https://<production domain>` |

> **Nothing in `EXPO_PUBLIC_*` is secret.** Expo inlines these values into the JavaScript bundle, so anyone can
> read them from an installed app. Never put a database URL, a payment key secret, a supplier credential or a
> JWT secret in this app. Real secrets live only in the backend's `backend/.env` on the server.

Environments are separate builds, each with its own address: development reads `.env.local`; staging and
production builds get theirs from the build profile (see [Building](#building-android-and-ios)). Do not commit
`.env.local` (it is git-ignored).

## Run

Start the backend first (from the repo root, with the backend's own virtualenv; see the main README), then:

```bash
cd mobile-app
npm start              # Metro dev server; press a for Android, i for iOS, or scan the QR in Expo Go
npm run android        # open on a running Android emulator / USB device
npm run ios            # macOS only
npm run web            # browser preview for quick layout checks; NOT a shipped platform
```

On a development build the Home tab shows a **Development build** card: which API it points at, whether the
backend answers, what the flight probe decided, and the session state. It does not render in release builds.

**Local sign-in codes.** A backend started with `OTP_DEV_ECHO=true` returns the code in its response, and a
development build of the app shows it on the verification screen. A deployed backend never does: the code
is emailed, and the app has no way to display it.

**Browser preview and CORS.** Native apps are not subject to CORS; the `npm run web` preview is. The backend's
`CORS_ORIGINS` must include the preview's origin (for example `http://127.0.0.1:8420`).

## Test, lint, typecheck

```bash
npm test               # Jest (jest-expo + React Native Testing Library), watch off
npm run test:ci        # same, for CI
npm run typecheck      # tsc --noEmit
npm run lint           # expo lint (ESLint, eslint-config-expo)
npm run doctor         # expo-doctor
```

What the automated suite covers today (710 tests in 49 suites, all in [`tests/`](tests); `tsc` and ESLint are clean):

| Area | Tests |
|---|---|
| HTTP client | Bearer header; one shared token refresh for concurrent 401s; replay after refresh; session ended when the refresh token is refused; session kept when the refresh fails for network reasons; wrong OTP is never treated as an expired session; **writes are never retried** (timeout and 503) |
| Errors | Network, timeout, 401/403/404/422/429, FastAPI validation messages, Retry-After; server error bodies never reach the screen |
| Config | https enforcement, trailing slash, emulator defaults, rejects paths/queries/garbage |
| Auth provider | Launch with no / valid / revoked / offline session; sign-in stores tokens and clears the previous identity's cache; guest-to-account claim; sign-out; session-expiry event |
| Forms | Sign-in, OTP and sign-up validation mirroring the backend's rules |
| Flights gate | Off for `demo`, on only for a named non-demo supplier, **off on any error** |
| Components | Button (loading/disabled ignore presses, 48dp target), TextField, error / empty / loading states |
| Money and dates | Indian grouping and string-exact formatting, exact comparison without floats, ISO dates with no off-by-one, nights, month grids |
| Hotel photos | The website's "never another hotel's photo" rule on the real hotels, **plus a parity test that fails if the port drifts from `frontend/assets/js/hotel-image-map.js`** |
| Discovery data | Both hotel response shapes normalised, sorting and filtering, package price/date logic (stale `priceFrom` vs the next departure), public-only requests, offers always named by product |
| Search | Party limits (1-4 rooms, 1-32 adults, 0-16 children), stay-date rules, route-param validation, calendar, destination search |
| Screens | Hotel and package results against fixtures: destination vs all, empty states, sort, filters, server re-query, error and retry, hostile route params |
| Booking requests | Hotel and package request builders carry **no money field at all**; guest and traveller rules (names, one contact, passport rules mirroring the server's six-months check); route inputs validated before anything is priced |
| Duplicate protection | Idempotency key bound to a SHA-256 of what is being booked: **reused** for an identical retry (timeout, app restart), **new** once anything is edited, forgotten after success; single-flight against double taps; stores no personal data |
| Quote vs catalogue | Indicative rates and the server's quote are labelled apart; a stale or coupon-rejected quote cannot be booked; a total that differs from the quote the customer saw is flagged before payment |
| Payment truth | "Paid" only when the backend reports a captured payment **and** a confirmed booking; the reconcile `captured` flag, a closed browser and a redirect are all ignored; a deterministic checkout key resumes an open order instead of opening a second; only an `https` redirect is opened; demo-mode servers are refused; Pay does not start a stray status check |
| Sign-in detour | Signed-out visitors return to the booking form, with what they typed, after signing in; backing out forgets it; the router's passing screens never cause a second copy of the form |
| Screens (booking) | Hotel page, package page, both review/confirm screens, booking page (Pay, check, cancel, who may see a booking), My bookings, package enquiry |
| Profile | Only changed fields are sent (null clears, a missing key leaves); a mobile that differs only in spacing is not re-sent (it would mark it unverified); mobile cannot be removed from an account with no email; server limits mirrored; guests get *Create account*, not a form |
| Wishlist | Hotel 4 is not package 4; hotels and packages shown, flights and cruises counted; removal through the server; a deleted item says "no longer listed" but a network error does not; signed-out and guest behaviour; **one request however often a button is pressed** |
| Saved travellers | Passport and expiry go together, tidied (no spaces, capitals); only a hint of the passport is shown; an invalid or foreign id is refused before anything is requested; the picker fills booking forms, keeps the contact an adult, and the six-months passport rule still applies |
| Support | Contact details match the website; priority is always normal; a lost answer is checked against the list before resending (ticket and reply); closed tickets take no reply; a booking reference is validated before it reaches a subject line |
| Account deletion request | Says it does NOT delete straight away and never claims automation; separates what can be deleted from what must be kept; ticking the box is required; a guest must give a contact, a registered customer need not; open bookings are warned about and listed but never block sending; one request however often Send is pressed; an open request already on the account is shown instead of a second form; a lost answer looks for the open request before resending; the confirmation survives the list refetch; the desk's text names the account, says identity was NOT verified, and caps its length; the ticked state and the section titles are announced to a screen reader |
| Cancellation request | Offered only for paid, live bookings with the trip ahead; one request however often Send is pressed; "already asked" is reassurance, not an error |
| My bookings groups | Awaiting payment / Upcoming / Past / Cancelled from the backend's own status, payments and dates |
| Guests | "Continue as guest" is not offered to someone who already is one |

**Also checked by hand against a local backend** (mock payment provider, no outbound integrations; Expo web
preview at phone width): quote and coupon, sign-in as a guest and return to the filled form, create a booking,
a signed mock webhook with the **wrong amount** (refused by the backend, booking stays unpaid) then the right
one (booking confirmed after "Check payment status"), cancel an unpaid booking, the My bookings list, and a
package with no bookable dates showing the enquiry option. Those runs also found three bugs, all fixed and
now covered by automated tests: the sign-in return opened a second copy of the booking form; Pay's "can't be
completed in the app" message was wiped by an automatic status check; and a confirmed payment showed two
"payment received" banners. The two payment fixes were verified by tests, **not re-run in the browser**
afterwards; the sign-in return was.

**Not covered, and not yet done:** the real HDFC hosted page and payment return, a package booking end to end
(the local database has only past departures), rendering on real Android and iOS devices, Dynamic Type and
font-scale behaviour, keyboard handling on small screens, landscape layouts, and SecureStore persistence
across an app restart. Those need a device, a provider sandbox or a staging backend and are planned for
Phase 8. Treat them as untested until then.

## Project layout

```
mobile-app/
├── app.json                 name, ids, scheme, plugins (Expo config)
├── .env.example             the two build-time variables, documented
├── eslint.config.js  tsconfig.json  package.json  package-lock.json
├── assets/                  icons and splash (interim; see Known limitations) and the logo
├── src/
│   ├── app/                 Expo Router: every file is a screen
│   │   ├── _layout.tsx      providers, fonts, splash, protected (auth) group
│   │   ├── (tabs)/          Home · Explore · Bookings · Wishlist · Profile
│   │   ├── (auth)/          sign-in · verify · sign-up (modal)
│   │   ├── destination/[id] one destination: places, hotels, packages
│   │   ├── hotels/          hotel results, and [id] the hotel page (rooms, indicative rates)
│   │   ├── packages/        package results, [id] the package page, enquire (when no dates are open)
│   │   ├── book/            hotel and package review: server quote, coupon, guests, confirm
│   │   ├── booking/[ref]    one booking: price, Pay, check status, cancel, help, request a cancellation
│   │   ├── account/         edit (details), sessions (where you're signed in) and delete (a deletion REQUEST)
│   │   ├── travellers/      saved travellers: list, and edit (add or change)
│   │   └── support/         contact, your requests, new request, and a conversation ([id])
│   ├── api/                 client, errors, token store, idempotency keys, query client, endpoints/
│   ├── config/              env parsing and validation
│   ├── providers/           AuthProvider, AppProviders
│   ├── features/            auth (incl. sign-in return), booking (requests, attempts, payment, outcome, groups),
│   │                        account (profile form, wishlist, travellers, support), discovery (hooks, cards,
│   │                        sort/filter), media (photo rules), search, dev diagnostics
│   ├── components/          Button, TextField, Screen, Card, Banner, states, AuthGate, Calendar, pickers, RemoteImage, ...
│   ├── hooks/               useFlightCapability
│   ├── theme/               design tokens, typography, fonts
│   ├── utils/               money and date helpers
│   └── types/               API types
└── tests/                   Jest tests, setup and a fake network transport
```

The route files sit under `src/app/` (Expo Router's default when a `src/` folder exists) rather than a
top-level `app/`, so all code lives under one folder.

## How it works

**Design system.** [`src/theme/tokens.ts`](src/theme/tokens.ts) copies the website's *rendered* tokens from
`frontend/assets/css/jw-system.css` §1 (ivory `#F5F0E8`, navy `#0F1B2E`, gold `#D9B26F`, coral `#C9482F`,
Montserrat for UI and Playfair Display for display type, radii 8/14/20/28/pill). Comments in `main.css` and
`jp-ds.css` describe a teal and a violet palette; neither is what the customer site renders, and the staff
portals' violet is not used here. The primary button is the website's bronze-gold gradient pill. Fonts are
bundled per weight (only the six the website loads).

**Navigation.** Tabs (Home, Explore, Bookings, Wishlist, Profile) replace the website's header menu. Browsing
is public, as on the website; Bookings, Wishlist and Profile ask a signed-out visitor to sign in
(`AuthGate`). The `(auth)` group is a Router *protected route*: it cannot be reached while a session exists.

**Authentication reuses the website's customer accounts.** There is no second account system. The app calls
the same `/api/customer/auth/*` endpoints: passwordless email-or-mobile code (`request-otp` then `verify-otp`),
sign-up, and the guest session (`/guest`, then `/guest/claim` to carry a guest's activity into an account on
sign-in). Tokens are Bearer tokens in the JSON body, kept in **Expo SecureStore** (Keychain / Keystore).

**Sessions.** The access token lasts 30 minutes and the refresh token 7 days. On a 401 the client refreshes
**once** (shared by every request that failed together) and replays the request. If the refresh token is
refused the session ends and the app tells the customer; if the refresh fails because the network did, the
session is kept. Signing out clears the tokens **and the entire query cache**, so the next person on the phone
never sees the previous customer's data.

**Never duplicate a booking or a payment.** Queries (GETs) retry transient failures twice. **Mutations never
retry automatically.** Booking creation and every checkout take an `idempotency_key` (8–64 characters); use
`newIdempotencyKey()` ([`src/api/idempotency.ts`](src/api/idempotency.ts)) once per customer intention and keep it
until that attempt has an answer, so a double-tap, a reload or a retry after a timeout is one booking and one
payment order on the server. Buttons ignore presses while `loading`.

**Money stays a string.** The backend sends amounts as decimal strings (`"12500.00"`). Keep them as strings and
format for display; never do arithmetic on them. The backend prices everything and returns the total.

**Discovery.** Home leads with the search card (Hotels and Tour Packages), then destinations, offers, featured
stays and holiday packages, each loading and failing on its own. Everything comes from the public customer API
(`/destinations`, `/hotels`, `/packages`, `/coupons`) with no session. A few behaviours worth knowing:

- **Photographs are the website's own files**, served from the API's origin (`/assets/...`), not copied into the
  app. The API sends image *keys*, so URLs are derived in
  [`mediaUrl.ts`](src/features/media/mediaUrl.ts), which refuses any key that is not a plain slug. A missing photo
  falls back to a brand panel, never a broken-image icon.
- **A hotel never shows another hotel's photo.** [`hotelPhoto.ts`](src/features/media/hotelPhoto.ts) ports the
  website's resolver: a provider photo of that property, a curated photo verified on name *and* city *and* area,
  or a photo of the city captioned "Destination photo, not this hotel", or a placeholder. The API's `image` key
  is ignored because the seed data pointed it at the wrong buildings.
- **Prices are indicative.** The hotel endpoints return a catalogue rate, not availability for dates, and the
  results screen says so. Dates and guests are collected (within the backend's limits) and carried in the route
  to the quote at booking; they do not filter the list. Only the quote and the booking carry real prices.
- **A package leads with its next departure's price.** `priceFrom` is the lowest price across *all* departures,
  including ones that have left, so it can sit far below anything bookable; the card shows `price_next` and the
  date, or the base price with "No dates listed".
- **Offers are asked for by product** (`hotel`, `package`). The coupon endpoint defaults to flights, so an
  unnamed request would show a flight offer in an app that does not sell flights.
- **Money is never parsed.** [`money.ts`](src/utils/money.ts) groups the digits of the string the backend sent
  and compares amounts without floats.

### Booking and payment

The flow is the website's, step for step, and the app adds no rules of its own about money or availability:

1. **Indicative rate, then a quote.** The hotel and package pages show catalogue prices, labelled *Indicative*.
   Choosing a room or a departure opens a review screen that asks `POST …/quote` for the server's price for
   exactly that stay or trip (and any coupon), shown under **Your quote / Priced by our server**. A quote
   that is still updating, or whose coupon was refused, cannot be booked.
2. **Create.** *Confirm booking* sends `POST /hotel-bookings` or `/package-bookings` with an `idempotency_key` and
   the people. **There is no price in the request**: the server re-prices at create. Nothing is charged, and
   a package booking holds its seats. The booking page flags it if the server's total differs from the quote
   the customer saw.
3. **Checkout.** *Pay* checks `/payments/config`, then `POST …/checkout` (a key and no amount) and opens the
   returned **https** `redirect_url` in the system browser (`expo-web-browser`). A server in demo payment mode,
   or a response with no hosted page, is refused with an honest message; nothing pretends to pay.
4. **Reconcile.** When the customer is back (iOS: the browser closes; Android: the app returns to the foreground,
   because `openBrowserAsync` resolves as soon as the page opens) or on *Check payment status*, the app calls `POST …/reconcile`, which
   makes the **backend** ask the provider and compare the amount. "Paid" is shown only when the backend reports
   a captured payment **and** a confirmed booking. A closed browser, a redirect or the `captured` flag in a
   reconcile answer prove nothing and are ignored.

Duplicate protection has three layers: the booking key is bound to a fingerprint of what is booked (same
booking after a timeout or restart reuses it; an edited form gets a new one, because the server returns the old
booking for an old key without comparing the request); a double tap is dropped by a single-flight guard; and
the checkout key is `pay-<ref>-<n>`, derived from the booking, so Pay pressed twice, or after a restart, resumes
the same order, while `n` goes up only after an attempt has actually failed. A customer who paid and left the
app finds the booking on **My bookings**; opening it checks an open payment once, quietly.

**Signing in mid-booking.** A visitor can fill the form signed out; the app asks them to sign in (or continue
as a guest) only on *Confirm*, then brings them back to the same screen with what they typed. The sign-in
screens are removed from navigation the moment a session exists, and what the router shows afterwards differs
(web lands on Home), so [`returnTo.ts`](src/features/auth/returnTo.ts) records where to return and keeps the
form **in memory only** (never in storage or the URL) for the same route, for at most 15 minutes, and drops it
if the customer backs out of sign-in.

The full payment write-up, what was and was not verified, and the first-real-payment test plan are in
[`docs/PAYMENTS.md`](docs/PAYMENTS.md). The **Payments** screen (Profile) lists the attempts recorded on the customer's
own hotel and package bookings, including refunds; it is built from the bookings because `GET /payments/history` reads
only flight payments.

### Account: profile, wishlist, travellers, support

All of this is the signed-in customer's own, scoped by the session: no route carries a customer id, so there is
nothing to tamper with. The app reuses the website's endpoints and adds no rules of its own.

- **Guests keep what they do.** A guest has a real session and a customer row, so their bookings, wishlist,
  saved travellers and support requests are filed under it, and the backend moves them onto an account when
  they sign in or sign up from the guest session. Phase 6 fixed a gap here: the sign-in screens were guarded
  off for *any* session, so a guest could never reach them and the claim could not run from the app. The guard
  now blocks only someone signed in to an account, and "Continue as guest" is hidden for someone who already
  is one (a second guest session would strand what they had). A guest's Profile offers *Create account* and
  *Sign in* instead of editable details, and ending a guest session asks first.
- **Profile.** Name, mobile, date of birth, gender and address are editable; **email is not** (it is the login
  identifier, and the backend does not allow it). Only the fields that changed are sent: the server reads a
  missing field as "leave it" and `null` as "clear it". A changed mobile number becomes *not verified* (the
  screen says so), and the mobile cannot be removed from an account with no email, since it is how they sign in.
  *Where you're signed in* is read-only: the backend lists live sessions but cannot end one, and signing out
  ends all of them, which the screen says.
- **Wishlist.** The server keeps only "a hotel, id 4"; each row is filled in from the public hotel and package
  pages. The heart reads *Saved* from the server's own list, not from the last tap. Signed out, it asks the
  visitor to sign in (or continue as a guest) and brings them back; it saves nothing on their behalf. Items
  saved on the website that the app cannot open (flights, cruises) are counted, not silently hidden.
- **Saved travellers.** Add, edit and remove; lists show only the last three characters of a passport. In the
  hotel and package booking forms, *Use a saved traveller* copies a person's name (and passport, where the
  trip is international) into the form; the form's own rules, such as the six-months passport check, still apply.
- **Help and support.** The phone number and email are the company's own, from its website (a test fails if the
  two drift). A support *request* is a ticket the desk answers in the app: priority is fixed at normal,
  ticket creation has no idempotency key on the server so a lost answer is checked against the list before
  anything is sent again, a reply to a resolved ticket reopens it, and a closed one takes no replies. **Live
  chat and calling are not in the app**: they need a real-time connection the app does not have yet.
- **Asking the desk to cancel a paid booking.** A *request*, said so on the screen: it cancels nothing and
  moves no money; a person reviews it against the cancellation policy. Offered only for a paid booking whose
  trip has not ended (an unpaid one is simply cancelled by the customer). The server refuses a second open
  request and the app says "you've already asked". There is no endpoint to read a request's progress, so the
  app shows the reference it was given and no status it cannot know.
- **My bookings** is grouped as *Awaiting payment* (unpaid and still payable), *Upcoming*, *Past* (completed,
  or the trip has ended: a hotel's check-out date, or a package's departure plus its days) and *Cancelled*
  (including refunded). Every rule reads what the backend said.
- **No double taps.** Save, remove and delete actions run through a single-flight guard (`useOnce`), because a
  mutation's own "pending" flag reaches the screen a moment after the tap and two quick taps would both go out;
  a second delete would then fail with "not found" for something that had worked.

### Flights are gated on the backend

Production's `GET /api/customer/flights/search` reports `provider: "demo"`: the website's flight results come
from a hard-coded sample list in the browser, which a store app must not present as live fares. The app
therefore shows Flights **only** when the backend names a non-demo supplier, and fails closed otherwise
([`useFlightCapability`](src/hooks/useFlightCapability.ts)).

## Building Android and iOS

Release procedures, signing, store steps and the pre-release checklist are in [`docs/RELEASE.md`](docs/RELEASE.md).
In short: `eas.json` defines a `preview` profile (internal test builds; you give it a staging address) and a
`production` profile (store builds against `https://jackpotsworldtours.com`, remote version numbering, Android app
bundle); a Google Play submission lands as an internal-track **draft**. Nothing is built, signed or submitted until you
run the commands. Each `EXPO_PUBLIC_*` value is public; never put a secret in this app.

## Known limitations

- **Bundle identifiers are placeholders.** `com.jackpotsworldtours.app` (Android `package`, iOS
  `bundleIdentifier`) is a default derived from the domain. **Confirm or change it before the first store
  upload; it cannot be changed after publishing.** The app name `JackpotsWorld` follows your spelling; the
  website itself uses both `JackPots World` and `JackpotsWorld`.
- **Icons are interim.** The only logo in the repo is 606×600 px. The store icon, adaptive-icon foreground and
  splash are generated from it (upscaled, so soft). A 1024×1024 master of the logo is needed for release.
- **Account deletion is a request, not a deletion.** The backend has no delete endpoint, and both stores require
  one for apps that let people create accounts. The app has an interim *Delete my account* screen that sends a
  support request (subject "Account deletion request") for a person to verify and complete under the Privacy Policy;
  it tells the customer it does not delete anything immediately, warns about open bookings without blocking, and
  requires a contact email or mobile number from a guest. Apple may not accept a request-based flow. A backend
  endpoint is still needed before release (not added: backend changes need your approval).
- **Signing out signs out everywhere.** The backend's logout revokes *every* token for the account, so signing
  out on the phone also signs the website out. That is the existing backend behaviour.
- **Flights probe can only turn on when the backend names a supplier on a parameter-less call.** With the Duffel
  adapter active that call is refused with a 400, which the app reads as "off". Enabling flights for a real
  supplier needs a small backend addition (the provider on a cheap status route).
- **Google sign-in is not built.** The backend accepts one Google client id (the website's). Native Android and
  iOS client ids would be rejected until the backend allows a list.
- **No push notifications.** The backend has no device-token storage.
- **Hotel photo rules are duplicated.** The resolver is a port of the website's JavaScript, kept honest by a parity
  test, but a backend field carrying the resolved photo would remove the duplication.
- **Photo cache.** The website cache-busts a replaced photograph with a `?v=` stamp; the app does not, so a
  replaced file reaches an installed app only when its image cache expires.
- **The real hosted payment page has not been exercised.** Payment is tested end to end only against the
  backend's mock provider (no hosted page) and by automated tests. Production reports HDFC in real mode; run
  one real, small payment through a staging or sandbox deployment before release. The payment return is the
  backend's redirect to the website, not a deep link into the app, so after paying the customer closes the
  browser and the app asks the backend; a deep-link return would need a backend change (not made).
- **Not offered in the app yet:** hotel add-ons, child ages and special requests, and amending a paid booking
  (cancelling one is a *request* to the desk; see [Account](#account-profile-wishlist-travellers-support)).
- **Not built in Phase 6, though the backend supports it:** live chat and calls (a real-time connection, and
  whether staff are online to answer cannot be verified from here); the notifications inbox (there is no push:
  the backend has no device-token storage); reviews; scanning a passport photo to fill a traveller (the backend
  has a passport-OCR route, which needs a camera and upload flow and an owner decision on handling passport
  images); changing a password (the app signs in by emailed code; the website's password routes are unused);
  and a profile photo (no upload route).
- **A cancellation request's progress cannot be shown.** The backend lets a customer submit one but has no
  route to read it back, so after sending, the app shows the reference and nothing more. A read route would
  fix that (not made).
- **Sessions cannot be ended one by one.** The list is read-only, because the backend has no route to end a
  single session; signing out ends all of them.
- **Package seats are held until the booking is cancelled.** The backend decrements seats on create and has no
  expiry sweep for an unpaid package booking, so the app offers **Cancel booking** while unpaid; a customer
  who abandons one leaves seats held. A backend expiry sweep would close that (not made).
- **The package page shows departures that have already left**, because the backend returns them; the app
  filters to bookable ones, but a backend filter would be cleaner (not made).
- **Hotel availability is a static count per room type**, as on the website. The server accepts the booking if
  it passes that check, so two customers can still book the last room; that is the backend's existing rule.
- **Catalogue content to review (data, not code).** Production lists a public hotel named "TEST PROPERTY -
  payment verification" at ₹50, and two offers whose wording may over-promise: "Up to 40% off ... Free
  breakfast included at 2,000+ properties" (nothing in the app or API can substantiate that figure) and "Kids
  stay & fly free" (the app sells no flights). The app shows what the API serves and changes nothing; they
  need an owner's decision.
- **Thin catalogue.** Production has 15 destinations but hotels mapped to only two of them (Hyderabad, Bengaluru),
  so most destination pages say "No hotels listed yet" and point to packages. That is the data, not a bug.
- **Landscape on a phone** works (no overflow; the header slims) but leaves little vertical room under the header
  and tab bar.
- **Photo licences.** Most destination and location photos are CC BY or CC BY-SA and need an attribution
  screen like the website's Image Credits page.
- **Mobile numbers.** The sign-up field asks for the country code in text. A country picker is planned.
- **Dependency audit.** `npm audit` reports advisories (braces, node-forge, sprintf-js, uuid) that appear to come
  from Expo's CLI and the Jest toolchain rather than from code the app imports, but that has **not** been
  confirmed against the shipped bundle. `npm audit fix --force` would break the SDK pin and is not used.
  Verify in Phase 8 before a release.
- **Web is a preview target only.** `react-native-web` is installed for browser previews; the product is the
  Android and iOS apps.
