# JackpotsWorld mobile app redesign: handoff for a new Claude session

Written 24 Nov 2026 at the end of a long Claude Code session, for a Claude session on a **different Claude account**.
That account cannot open anything from the old one: not its chats, not its private claude.ai artifacts (including
the Design canvas with the mockups). Everything you need is therefore in this repository. Read this file first,
then open the mockups.

---

## 1. Start here (checklist for the new session)

1. **Do not discard or reset anything.** All of the redesign work is **uncommitted** on branch
   `feature/mobile-ui-overhaul`: about 77 modified files and 26 new files or folders. Nothing has been committed or
   pushed. `git stash`, `git checkout -- .` or `git reset --hard` would destroy days of work. Commit only when the
   user asks.
2. **Look at the mockups.** They are exported to [`mockups/`](mockups/): the gallery is
   [`mockups/index.html`](mockups/index.html) and each screen is a standalone page in `mockups/screens/`. You can
   read the HTML directly, or serve the folder:
   - In the Claude desktop app, `.claude/launch.json` has a **`mockups`** preview (python http.server on
     port 8440). Start it, then open `http://localhost:8440/`.
   - Without the preview tool: `python -m http.server 8440 --directory mobile-app/docs/redesign/mockups`, run from
     the repo root.
3. **Check the user's memory files**, if this machine still has them, under
   `C:\Users\suraj\.claude\projects\F--Jackpotsworldtours-JackPotsworldtoursandtravels\memory\` (`MEMORY.md` is the
   index). Everything important from them is repeated below in case they are gone.
4. Before saying any change is done, run the checks in section 8 and, for anything visual, look at it on the phone
   (section 7).

---

## 2. What this project is

- **Product:** JackpotsWorld Tours & Travels, a travel agency in Hyderabad, India. Customers browse and book hotels
  and holiday packages, pay online, and ask for flight quotes.
- **Repo** (`F:\Jackpotsworldtours\JackPotsworldtoursandtravels`):
  - `backend/`: FastAPI with PostgreSQL. Customer APIs live under `/api/customer/...`.
  - `frontend/`: the website, static pages.
  - `mobile-app/`: the customer app, which this work is about.
- **Mobile stack:**
  - Expo SDK 58 (`expo ~58.0.17`), React Native 0.88, TypeScript.
  - Expo Router with typed routes; screens live in `mobile-app/src/app/`.
  - TanStack react-query for data, react-hook-form with zod for forms.
  - Montserrat font.
- `mobile-app/AGENTS.md` has Expo rules. Follow them: use `npx expo install` for packages, and never hand-edit
  `ios/` or `android/`.
- **No new native modules were added** during the redesign, on purpose. Every animation uses React Native's own
  `Animated` (no Reanimated, no SVG library), so the installed development build keeps working without a rebuild.
  Keep it that way unless the user agrees to a rebuild.

---

## 3. What the user asked for (their decisions, in order)

The user is the business owner, not a developer. They judge the work by how it looks and feels on their Android
phone. They want it **"immaculate"** and **from a customer's perspective**. They give short, direct feedback,
like "the take-off of the flight loader is not same as the mockup, fix that". Explain things plainly, show
screenshots from the phone, and match the mockups exactly when asked.

Decisions they made:

1. **First launch is log in or register.** A large Jackpots World Tours & Travels logo sits on navy above the form,
   on a white sheet. A small "Explore first, log in later" link lets someone browse as a guest.
2. **Home has no "JACKPOTS WORLD" wordmark** in the header; the user disliked it and asked for it to be removed.
   The header has:
   - **top left:** a menu button with three horizontal lines;
   - **top right:** a **bell** for notifications, next to the **profile** button.
3. **The ☰ menu** holds My bookings/trips, Wishlist, Profile, and the rest: Offers and coupons, Saved travellers,
   Payments and refunds, Help, About and Terms. It also has Log out, or Log in for guests.
4. **The bottom tab bar** reads Home · Trips · **Assistant** · Wishlist · Profile. The Assistant opens the chatbot
   and sits in the centre as a big raised gold button; the bar's top border arcs up over it.
5. **Offers** appear both in the menu ("Offers and coupons") and as a strip on Home ("Yes, add both").
6. **Look:**
   - deep navy (`#07111F` / `#0B1D35`) with gold accents (`#D4AF5A`);
   - navy primary buttons;
   - the app keeps Montserrat; the mockups use Plus Jakarta Sans.
7. **Loaders:**
   - **Option B, the take-off**, for big waits: a gold side-view airliner rolls down a runway, lifts its nose and
     climbs away.
   - **Option A, a plain circle loader**, inside buttons and small spots.
   - The user later insisted the take-off match the mockup exactly; it now does (section 5).
8. **Passenger name fields:** **First name**, **Middle name (optional)** and **Last name** as three separate
   fields, full width, stacked one under another in that order, on every form that takes a person's name.
9. **Flights stay UI-only** until a flight supplier is connected ("Yes, build them UI-only"). They run on sample
   data that is clearly labelled, and the last step sends an enquiry to the team instead of taking payment.

---

## 4. The mockups (36 screens, 8 rows)

They are exported from the Claude Design canvas *JackpotsWorld App Redesign*. The original canvas,
`https://claude.ai/artifact/GRYTPGgdDT9EEs1doQWCWF`, is private to the old account. The user can share it to the
new account from the canvas page's Share menu if they want the live canvas; otherwise the export here is complete.

**Format:** each screen is a 390 × 844 phone frame. Links between screens work inside `mockups/screens/`. The
images (logo, destination photos) are in `mockups/assets/`.

**Status key:**
- **Built** means the app has it.
- **Built (sample data)** means UI-only, behind a development-build entry point.

| Row | Mockup (file in `mockups/screens/`) | Status in the app | Where in `mobile-app/src/` |
|---|---|---|---|
| 1 · Opening the app | `Main.html` launch | Built as the native splash: the logo on navy (`expo-splash-screen` in `app.json`), held by `SplashScreen` until the session loads | `app.json`, `app/_layout.tsx` |
| | `Login.html` log in | Built. The real login is passwordless (email or mobile, then a one-time code), so there's no password field. | `app/(auth)/sign-in.tsx`, `features/auth/AuthFrame.tsx` |
| | `Verify.html` code entry | Built | `app/(auth)/verify.tsx` |
| | `Register.html` create account | Built | `app/(auth)/sign-up.tsx` |
| 2 · Home and around | `Home.html` | Built | `app/(tabs)/index.tsx` |
| | `Menu.html` ☰ drawer | Built | `features/navigation/SideMenu.tsx` |
| | `Assistant.html` chat | Built (uses the real `/api/customer/assistant/message`) | `app/assistant.tsx`, `features/assistant/`, `api/endpoints/assistant.ts` |
| | `Notifications.html` | Built (real `/api/customer/notifications`) | `app/notifications.tsx` |
| | `Profile.html` | Built | `app/(tabs)/profile.tsx` |
| 3 · Booking | `Hotel.html` choose a room | Built | `app/hotels/[id].tsx` |
| | `HotelReview.html` guests and review | Built | `app/book/hotel.tsx`, `features/booking/components/PeopleFields.tsx` |
| | `FlightSeats.html` seat map | Built (sample data) | `app/flights/book/seats.tsx` |
| | `Payment.html` | Built | `features/booking/components/PaymentPanel.tsx` |
| | `Confirmed.html` | Built | `PaymentPanel.tsx` confirmed state, `app/booking/[ref].tsx` |
| 4 · Flight extras | `AddOns.html`, `Meals.html`, `Baggage.html`, `Assistance.html` | Built (sample data) | `app/flights/book/extras.tsx`, `meals.tsx`, `baggage.tsx`, `assistance.tsx` |
| 5 · Multi-city flights | `MultiCitySearch.html` | Built | `features/flights/FlightSearchForm.tsx`, `app/flights/index.tsx` |
| | `MultiCityResults.html` | Built (sample data) | `app/flights/book/results.tsx` |
| | `FlightTrip.html` trip 1 and trip 2 | Built (sample data) | `app/flights/book/review.tsx` |
| | `FlightTravellers.html` | Built (sample data) | `app/flights/book/travellers.tsx` |
| 6 · After booking | `FlightBooking.html`, `ETicket.html`, `ManageBooking.html`, `CancelFlight.html` | Built (sample data) | `app/flights/booked/trip.tsx`, `ticket.tsx`, `manage.tsx`, `cancel.tsx` |
| 7 · Passengers and offers | `SavedTravellers.html` | Built | `app/travellers/index.tsx` |
| | `AddTraveller.html` add a passenger | Built (First, Middle, Last stacked) | `app/travellers/edit.tsx`, `features/account/travellerForm.ts` |
| | `Offers.html` | Built | `app/offers.tsx`, `features/offers/VoucherCard.tsx` |
| | `ApplyCoupon.html` | Built | `features/booking/components/Quote.tsx` (`CouponField`) |
| 8 · Loading | `LoaderFull.html`, `LoaderSizes.html` (option A, orbit) | Superseded by option B. The circle loader is kept for buttons. | `components/Loader.tsx` (`CircleLoader`) |
| | `LoadingResults.html` results skeleton | Built | `components/states.tsx` (`ListSkeleton` with `label`) |
| | `PaymentProcessing.html` | Built | `PaymentPanel.tsx` (progress with `TakeoffLoader`) |
| | `TakeoffFull.html` searching (chosen) | Built | `components/SearchingScreen.tsx`, used by `app/hotels/index.tsx`, `app/packages/index.tsx` |
| | `TakeoffSizes.html` take-off at every size | Built | `components/Loader.tsx` (`TakeoffLoader`, tones `onDark` and `onLight`) |

**Older drafts:** `mobile-app/docs/mockups/` (`redesign.html`, `ui-overhaul.html`) holds the **first** drafts from
before the Design canvas, plus `mobile-app/docs/ui-overhaul/00-diagnosis.md`. The user rejected the look those
drafts led to ("the look and feel is very poor"). Treat `docs/redesign/mockups/` as the source of truth.

---

## 5. What was built, by area

### Theme and shared components (`src/theme/`, `src/components/`)
- **Theme tokens** (`theme/tokens.ts`):
  - `primary` `#0B1D35`, `navy900` `#0A1120`, `gold` `#D9B26F`, `goldDeep` `#B48A2E`, `navyTrack` `#1E3254`;
  - page background `#F3F5F9`, plus role colours for lines, dividers and skeletons.
  - The website-parity tests still read `gold`, `ivory`, `ink` and `night`, so keep those tokens.
- **`Button`:**
  - navy primary with 14 px corners; a separate `coral` variant;
  - while `loading` it keeps full colour and shows the gold `CircleLoader`; only `disabled` fades it.
- **`Loader.tsx`:**
  - **`TakeoffLoader`** is drawn from the mockup's exact SVG geometry with plain Views, in the mockup's 200 × 100
    units scaled by `width`: tail fin, tailplane, body, swept wing, engine, cockpit window, cabin windows, wheels,
    runway and its streaming centre line, a ground shadow, and on navy six pulsing runway lights.
  - Timing is the mockup's CSS keyframes (2.6 s loop: roll, lift, climb) with per-segment
    `cubic-bezier(.45,0,.55,1)`, sampled into one `Animated` interpolation (`keyframes()`).
  - **`CircleLoader`** is the small gold arc.
  - Both hold still under "reduce motion" and in tests.
- **`SearchingScreen.tsx`:** the full-screen navy take-off: title, search summary, pulsing dots, "Cancel search" and
  the logo. `useFirstSearch(pending)` shows it only for a search's first load, keeps it up at least 1.2 s, and
  never shows it when results are already cached.
- **`states.tsx`:**
  - `LoadingState` is the take-off with a message;
  - `ListSkeleton` pulses only its grey shapes (fading a whole card with a shadow drew a box inside it on Android),
    and takes an optional navy "Finding stays…" pill.
- **Other new components:** `CalendarScreen`, `DetailScroll`, `ImageCarousel`, `OptionSheet`, `SearchListScreen`,
  `Toast` and `ui.tsx`. `ui.tsx` holds `StatusPill`, `StickyFooter`, `PriceTag`, `SortFilterBar` and others.

### Navigation and auth
- `app/_layout.tsx` uses `Stack.Protected guard={status !== 'signedOut'} redirectTo="/sign-in"`, so a signed-out
  user lands on log in.
- `(auth)` screens show as a full-screen card when signed out, and as a modal for a guest.
- `app/(tabs)/_layout.tsx` uses `Tabs` from `expo-router/js-tabs` with a custom bar:
  `features/navigation/BrandTabBar.tsx`. Tabs: index, bookings, wishlist, profile, explore. The Assistant button
  pushes `/assistant`.
- `features/navigation/SideMenu.tsx` is a Modal drawer from the left. In development builds only, it adds a
  **"Developer previews"** item that opens `/dev/gallery` (hidden in release builds and under test).

### Accounts, travellers, offers
- **Traveller fields:** `title`, **`middle_name`**, `frequent_flyer_airline` and `frequent_flyer_number`.
  - The backend already stored `middle_name`; the app side was added in this session.
  - The backend rule: first plus middle name together are at most 100 characters. The forms check this and show
    the message under Middle name.
  - Hotel and package bookings send `middle_name` only when it's filled in.
- **Saved travellers:** a list showing passport status (valid / expiring within 183 days / expired / none), and an
  editor with traveller-type cards, title chips, a passport card and a collapsible frequent-flyer section.
- **Notifications:** `notificationsApi` with hooks `useNotifications`, `useUnreadCount` and `useMarkAllRead`.
- **Offers:** `/offers` uses `discoveryApi.coupons(product)`. Checkout's coupon field shows live coupon chips.

### Booking and payment
- `PaymentPanel`: confirmed card, take-off progress steps, hold banner, navy amount card, Pay button and security
  note. **Payment is only ever confirmed by the backend.**
- `book/hotel.tsx` steps are Room · Guests · Payment; `book/package.tsx` steps are Departure · Travellers ·
  Payment.
- `booking/[ref].tsx` is the booking detail page.

### Flights (UI-only, sample data)
There is **no flight supplier**, so nothing about flights is real. What exists:
- **Real search, no fares:** the search form (one-way, round trip, multi-city) is real. With no supplier the
  Flights page says so and offers a **quote request** by email: `QuoteForm` in
  `features/flights/FlightsUnavailable.tsx`, built by `features/flights/flightQuote.ts`.
- **Sample-data booking flow:** in `app/flights/book/` (results → review → travellers → seats → extras → meals,
  baggage, assistance → send).
  - Each screen shows a "sample flights and prices" notice.
  - The last step sends the whole trip to the team as an enquiry. **Nothing is booked or charged.**
  - Data and state: `features/flights/preview/`: `sample.ts` (fake airlines and deterministic flights), `draft.ts`
    (trip draft store), `extras.ts` (meals, baggage, seat prices, totals), `flow.ts` and `ui.tsx`.
- **Sample-data after-booking screens:** in `app/flights/booked/` (trip, ticket, manage, cancel), using
  `preview/sampleBooking.ts`. Each screen redirects away in release builds.
- **How to reach them (development builds only):**
  - On the Flights page, after a search: **Preview the new flight booking** or **Preview a booked flight**. These
    buttons are hidden under test via `SHOW_PREVIEWS`.
  - Or from ☰ → Developer previews → the gallery's flight section.

### Honesty rules the code follows (keep them)
- Hotel rates are "indicative until your stay is quoted". The quote and payment come from the backend.
- Sample flight data is always labelled as sample.
- A destination photo used for a hotel is captioned "Destination photo, not this hotel".

---

## 6. Local environment (this Windows machine)

| Thing | Detail |
|---|---|
| Repo | `F:\Jackpotsworldtours\JackPotsworldtoursandtravels` |
| PostgreSQL 18 | Port **5433** (not the README's 5432); service `postgresql-x64-18`; binaries in `C:\Program Files\PostgreSQL\18\bin` (not on PATH); role `postgres`, password auth. **The service is sometimes Stopped, and starting it needs an Administrator shell** (`Start-Service postgresql-x64-18`). Claude can't do that; ask the user. |
| Backend | `.claude/launch.json` → **`backend`** (venv `backend/venv`, port 8000). It crashes at startup with "connection refused :5433" when Postgres is stopped. |
| `backend/.env` | Gitignored. `OTP_DEV_ECHO=true` is set **locally** so sign-in codes come back in the API response and the app shows them on the Verify screen ("Development server code: …"). **Never set this anywhere deployed**; deployed hosts ignore it anyway (`settings.deployed`). |
| Test customer | `test.customer@example.com` (mobile `+919000000001`), on the local database only. Sign-in is passwordless: email, then the 6-digit code shown on screen. The verify API field is `code`. |
| Drive C | Nearly full (under 1 GB free). Put temp files on F: (`F:\Jackpotsworldtours\.tmp`). |
| PowerShell | Its `Get-Content`/`Set-Content` corrupt UTF-8 files. Do bulk edits with the Edit tool, Python or sed, never PowerShell. |
| Android SDK | `F:\Android\Sdk`; adb is `F:\Android\Sdk\platform-tools\adb.exe` (not on PATH in Git Bash). |

---

## 7. Running the app on the user's phone

- **Phone:** an Android, model CPH2467, connected by USB.
- **App:** the installed **development build** is `com.jackpotsworldtours.app.dev`. It has `applicationIdSuffix
  ".dev"` so it sits beside the store app, which was left installed.
- **Native rebuilds:** the native build was made from a copy at `F:\jw\m`, because Windows path length limits broke
  the build in the repo path. That copy uses CMake 3.31.6 via `cmake.dir` in `local.properties`. A rebuild is only
  needed if native modules change.

Steps:

1. Make sure Postgres is running, then start **`backend`** and **`mobile-android`** from `.claude/launch.json`.
   - `mobile-android` runs `F:\Jackpotsworldtours\.tmp\android.cmd`. That script sets TEMP to F:, sets
     `EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:8000`, runs `adb reverse` for 8081 and 8000, then
     `npx expo start --dev-client --port 8081`.
2. Wait until Metro answers `http://127.0.0.1:8081/status`. Opening the app too early shows a "problem loading the
   project" error. If that happens, just reopen the app.
3. Run `adb reverse tcp:8081 tcp:8081` and `adb reverse tcp:8000 tcp:8000`. Repeat this after every reconnect.
4. Open the app pointed at Metro:
   `adb shell am start -a android.intent.action.VIEW -d "exp+jackpotsworld-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081" com.jackpotsworldtours.app.dev`
5. Deep links use the scheme `jackpotsworld://`, for example `jackpotsworld://hotels` or
   `jackpotsworld://dev/gallery`.
6. Screenshots: `adb shell screencap -p /sdcard/x.png`, then `adb pull`. Edits reload on the phone automatically
   while Metro runs.

On the phone, the grey floating gear marked "Tools" is the Expo developer menu. It only exists in development
builds.

**iPhone:** not set up. It needs an Apple Developer Program membership (US$99/yr), and either EAS cloud builds or a
Mac with Xcode. The phone must be registered and have Developer Mode on. `app.json` already has the iOS bundle id
`com.jackpotsworldtours.app`; `eas.json` would need iOS settings in its `development` profile.

---

## 8. Checks to run before calling anything done (from `mobile-app/`)

- **Type-check:** `npx tsc --noEmit -p .` must exit 0.
  - Typed routes come from `.expo/types/router.d.ts`, which Metro generates.
  - A new route errors until Metro regenerates that file.
  - A new folder's `index.tsx` was once typed as `/x/index` instead of `/x`; naming the screen (for example
    `booked/trip.tsx`) avoided it.
- **Lint:** `npx expo lint` must show 0 problems. The React Compiler lint rules are on:
  - no refs read during render;
  - no `setState` inside effects; set state during render under a condition instead;
  - don't keep a manual `useMemo` it can't preserve.
- **Tests:** `npx jest --runInBand`, with `TEMP` and `TMP` set to `F:\Jackpotsworldtours\.tmp`. The machine has
  little RAM and a full C: drive, so never run jest in parallel workers.
  - In Git Bash: `export TEMP='F:\Jackpotsworldtours\.tmp' TMP='F:\Jackpotsworldtours\.tmp'`.
  - **Expected result: 858 passed, 4 failed.** The 4 failures are old website-parity tests (footer labels, the two
    info-links tests, gaming wording). **The user said to leave them.** Any other failure is new.
- **Test setup:**
  - `tests/setup.ts` mocks `@expo/vector-icons`, including `MaterialCommunityIcons`.
  - Animations don't run in tests: `NODE_ENV === 'test'` turns them off.
  - The searching screen's minimum time is 0 in tests.

---

## 9. What's left

1. **Let the user try everything on the phone** and fix whatever they point out. That has been the working loop.
2. **Commit and open a PR**, when the user asks. Everything is uncommitted on `feature/mobile-ui-overhaul`; `main`
   is the PR base. End commit messages with the attribution line the harness gives you.
3. **Tests for the flight preview screens** (`app/flights/book/*`, `app/flights/booked/*`). They pass type-check and
   lint but have no tests yet.
4. **Real flight booking** needs a flight supplier on the backend. When one exists, its results replace the
   UI-only preview behind `useFlightCapability()`.
5. **iPhone build:** section 7.
6. **Watch the machine:** Postgres stopping, and the C: drive filling up.

---

## 10. Files touched in this redesign (for orientation)

`git status` shows the full list. The main areas:

- **New:**
  - `src/app/assistant.tsx`, `notifications.tsx`, `offers.tsx`, `src/app/dev/`, `src/app/flights/book/`,
    `src/app/flights/booked/`, `src/app/search/`;
  - `src/components/Loader.tsx`, `SearchingScreen.tsx`, `CalendarScreen.tsx`, `DetailScroll.tsx`,
    `ImageCarousel.tsx`, `OptionSheet.tsx`, `SearchListScreen.tsx`, `Toast.tsx`, `ui.tsx`;
  - `src/features/assistant/`, `flights/preview/`, `navigation/`, `offers/`, `search/SearchLanding.tsx`;
  - `src/api/endpoints/assistant.ts`;
  - `docs/redesign/` (this file and the mockups).
- **Changed:** nearly every screen in `src/app/`, most components in `src/components/`, `src/theme/tokens.ts`,
  `features/account/*`, `features/booking/*` and `features/flights/*`, plus tests and fixtures under `tests/`.
- **Config:** `.claude/launch.json` (adds the `mobile-android` and `mockups` previews) and
  `mobile-app/package.json`.
- **Also untracked:** `package-lock.json` at the repo root, which showed up during the work. Check with the user
  before committing it.
