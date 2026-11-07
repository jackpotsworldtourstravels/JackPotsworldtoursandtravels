# Releasing the app

How to run the app in development, build it for testing, build it for the stores, and ship it. **Nothing in this
document has been run as a real release.** No build has been made on Expo's servers, nothing is signed, and nothing has
been submitted to either store: those steps need your accounts and your explicit go-ahead. Where a statement comes
from Expo's, Apple's or Google's documentation it says so; where it is this project's own fact, it was checked in
the repository (the Expo web preview, a throwaway native config generation, and exported Android and iOS bundles).

Related documents: [`PAYMENTS.md`](PAYMENTS.md) (the first-real-payment test plan), [`QA.md`](QA.md) (what was
tested, and the device checklist), [`STORE_LISTING.md`](STORE_LISTING.md) (listing text and privacy answers).

## 1. Decisions and blockers (read this first)

These are the things that stop a store submission today. Some need you, some need a backend change.

| # | Blocker | Why it matters | Who |
|---|---|---|---|
| 1 | **Real account deletion does not exist; an interim request flow does.** The backend has no delete endpoint. The app has a *Delete my account* screen that sends a support **request** (nothing is deleted by it). The public web page for it is **drafted, not published**. | Apple: "If your app supports account creation, you must also offer account deletion within the app" (Guideline 5.1.1(v)); a request-based flow is Apple's judgement at review. Google Play requires an in-app path **and** a web page for deletion requests, declared in the Data safety form. | You: review and publish the page, name the staff owner, confirm the runbook. **The proper backend endpoint stays on this list** (see §9) |
| 2 | **Review credentials.** Sign-in is by emailed code, so an Apple or Google reviewer cannot sign in to an account. | Apple Guideline 2.1(a): include demo account info if the app has a login, or an Apple-approved demo mode. | You decide; options in §9 |
| 3 | **Bundle identifier is a placeholder:** `com.jackpotsworldtours.app` (iOS bundle id and Android package). | It cannot be changed after the first upload. | You confirm or change it in `app.json` |
| 4 | **Apple Developer Program and Google Play Console accounts** | Needed to sign, upload and publish. | You |
| 5 | **The real HDFC payment page has never been exercised** by this app. | A broken payment flow in a store build is a refund and review problem. | Follow [`PAYMENTS.md`](PAYMENTS.md) first |
| 6 | **No real-device testing yet.** | See the checklist at the end of [`QA.md`](QA.md). | Needs a person with a phone |
| 7 | **The privacy policy does not mention the app.** (It is the website's policy, `privacy-policy.html`.) Both stores need a public policy URL that covers the app's data. | Store rejection risk. | You or counsel update it |
| 8 | **A staging backend** (and HDFC UAT credentials) for preview builds | Testers must not use the live site for payments. | You / your backend operator |
| 9 | **Store assets**: screenshots, feature graphic, a better icon master (the icon is the 606 px website logo, upscaled to 1024 px, so it is soft) | Listing quality; see [`STORE_LISTING.md`](STORE_LISTING.md). | You / a designer |
| 10 | **Version number.** `app.json` says `0.1.0`. | Set the user-facing version (for example `1.0.0`) when you release. | You |

## 2. What you need

- An **Expo account** (free to start), and the EAS CLI: `npx eas-cli@latest <command>` (version 25.3.0 was current when this
  was written; `eas.json` requires `>= 25.0.0`).
- An **Apple Developer Program** membership (to build, sign and distribute on iOS) and an **App Store Connect** app record.
- A **Google Play Console** developer account and an app record.
- **Node 22** and `npm` on the machine that runs commands (the project was built with Node 22 and npm 10).
- Nothing else is needed on your computer to build in the cloud: no Xcode, no Android Studio. They are only needed for
  emulators and simulators (Xcode needs a Mac).

## 3. How the configuration fits together

| File | What it controls |
|---|---|
| `app.json` | Name, slug, scheme (`jackpotsworld`), bundle id / package, icons, splash, plugins, iOS App Transport Security (plain HTTP forbidden), Android blocked permissions (only `INTERNET` remains) |
| `eas.json` | Build profiles (`preview`, `production`), versioning, the Google Play submission defaults |
| `.env.example` / `.env.local` | Development only: the API address while you run the app locally |
| Build profile `env` in `eas.json` | The API address and environment name baked into a cloud build |

**Everything `EXPO_PUBLIC_*` is public.** Expo copies it into the app's JavaScript, and anyone can read it out of an
installed app. The app holds no secrets: it talks only to the website's backend, which holds the payment and supplier
credentials. Never add a secret to `eas.json`, `app.json` or `.env.local`. A test (`tests/config/eas-config.test.ts`)
fails if a secret-looking key is added to a build profile.

### The two build profiles

| Profile | For | Output | API address |
|---|---|---|---|
| `preview` | Internal testers (installed directly, not through a store) | Android `.apk`; iOS ad-hoc/internal build | **Deliberately unset.** You must give it your staging `https://` address. Until you do, the app refuses to start rather than guess. |
| `production` | The stores | Android `.aab` (app bundle); iOS store build | `https://jackpotsworldtours.com` (verified: `/api/health` answers 200; the `www.` form redirects, so the bare domain is the right one) |

To give `preview` an address, add `"EXPO_PUBLIC_API_BASE_URL": "https://<your-staging-host>"` to
`build.preview.env` in `eas.json`. Never point `preview` at the live site: testers would be making real bookings.

### Versions
`eas.json` sets `"appVersionSource": "remote"` and `"autoIncrement": true` for production. Per Expo's documentation,
EAS then stores and increments the Android `versionCode` and iOS `buildNumber` on its servers, so a build number is
never reused. You set only the user-facing `version` in `app.json` (it is the store's "version name"; the app's
Profile screen shows it). Before the first release run `eas build:version:set` once if you ever shipped a build
elsewhere; for a first release the counters start at 1.

## 4. Running the app while you develop

```bash
cd mobile-app
npm install
cp .env.example .env.local     # Windows: copy .env.example .env.local
npm start                      # then press a (Android), i (iOS), or scan the QR in Expo Go
```

Start the backend first (see the main `README.md`). The address to use depends on where the app runs:
Android emulator `http://10.0.2.2:8000`, iOS simulator `http://127.0.0.1:8000`, a phone on your Wi-Fi
`http://<your PC's LAN IP>:8000` with the backend started on `--host 0.0.0.0`. Plain `http://` is accepted only in
development builds, and iOS permits it only for local-network addresses (App Transport Security).

Everything the app uses is part of the Expo SDK, so **Expo Go works** for development; no custom development build is
required today. If you later add a library with native code Expo Go does not include, you will need a development
build (Expo documents this); the `development` profile is intentionally not in `eas.json` because it needs
`expo-dev-client`, which is not installed.

Before you hand anything over, run the checks:

```bash
npm test            # 710 tests in 49 suites
npm run typecheck
npm run lint
npm run doctor      # expo-doctor, 20/20
```

## 5. Building for internal testing (preview)

After giving `preview` a staging address (§3):

```bash
npx eas-cli@latest login
npx eas-cli@latest build --profile preview --platform android   # .apk you can install directly
npx eas-cli@latest build --profile preview --platform ios       # needs an Apple Developer account and device registration
```

Android: download the `.apk` from the build page and install it (allow installs from the source). iOS internal
builds are signed ad-hoc for specific registered devices; EAS walks you through registering a device
(`eas device:create`). For wider iOS testing use TestFlight with a production build (§7).

## 6. Signing

**Android.** A release is signed with a keystore. With EAS the simplest route is to let EAS create and store it the
first time you build. Use **Play App Signing** (Google holds the app signing key; you hold an *upload* key). Per
Expo's documentation: keep the keystore private, never commit it (the repository already ignores `*.jks`,
`*.keystore` and `credentials.json`), and back up a copy with `eas credentials` (Android, download credentials).
If an upload key is lost it cannot be recovered; you must ask Google Play support to reset it, and the new key takes
effect after about 72 hours.

**iOS.** EAS can create and manage the distribution certificate and provisioning profile for you when you sign in
with your Apple Developer account during `eas build`. Per Expo's documentation the distribution certificate is
account-wide (limit of two) and the provisioning profile is per app and expires after 12 months, so a build after
expiry needs a fresh profile (EAS offers to regenerate it).

**Never share** your Apple ID password, an App Store Connect API key (`*.p8`), or a Google Play service account key
with anyone, and do not put them in this repository (they are ignored by `.gitignore`, but ignoring is a safety
net, not a plan). Use `eas credentials` and EAS's secret storage.

## 7. Building for the stores (production)

Only after the blockers in §1 are resolved and the checklist in §10 is complete.

```bash
npx eas-cli@latest build --profile production --platform android    # produces an .aab
npx eas-cli@latest build --profile production --platform ios        # produces a store build
```

**Submitting.** `eas.json` is set up so that a Google Play submission lands as a **draft on the internal testing
track**: it cannot reach customers by itself.

```bash
npx eas-cli@latest submit --platform android --profile production   # uses a Play service account key
npx eas-cli@latest submit --platform ios --profile production       # uploads to App Store Connect / TestFlight
```

The first upload to each store is partly manual (creating the app record, the listing, the content rating, the
privacy questionnaires: see [`STORE_LISTING.md`](STORE_LISTING.md)). EAS Submit then automates later uploads.

### Google Play, in order
1. Create the app in Play Console; complete **App content**: privacy policy URL, Ads (none), App access
   (reviewer instructions, see §9), Content rating, Target audience, **Data safety** (answers in `STORE_LISTING.md`),
   **Data deletion** (§9), Government/financial declarations as the form requires.
2. Upload the `.aab` to **Internal testing**; test on real devices (the checklist in `QA.md`).
3. Promote to **Closed testing**, then **Production**, using a **staged rollout** (start small, for example 5–10%).
   Google may require a period of closed testing before production for new personal accounts; check the console.

### Apple, in order
1. Create the app in App Store Connect with the confirmed bundle id.
2. Upload the build; test it through **TestFlight** on real devices.
3. Complete the **App Privacy** questionnaire (answers in `STORE_LISTING.md`), age rating, pricing (free), review notes
   with demo access (§9), screenshots, and the privacy policy URL.
4. Submit for review. Choose **manual release** so you control the date.

## 8. After release

- **Updates are store releases.** The app does not include `expo-updates`, so JavaScript fixes cannot be sent over the
  air. Every fix means a new build and a new store review. (Adding EAS Update later is an option; it is a decision with
  its own review and rollback rules, not a default.)
- **Backend compatibility.** Old app versions stay installed for months. Do not remove or rename API fields or routes the
  app uses without a compatibility window; `docs/QA.md` lists the 50 endpoints the app calls.
- **Crash reporting and analytics are not installed.** You will not see crashes unless you add a service, or from
  the stores' own crash reports (Play Console Android vitals, Xcode Organizer / App Store Connect). Adding a service
  changes the privacy answers in `STORE_LISTING.md`.
- **Rollback.** A store release cannot be recalled from phones that installed it. You can halt a staged rollout
  (Google Play) or remove a version from sale (Apple), and ship a fix. The backend can also refuse unsafe actions
  server-side, which is why prices and payment status are never decided in the app.
- **Support.** The app shows the company's phone and email; make sure the team knows customers may now arrive from the app,
  quote a booking reference, and may have **requests** waiting in the support queue.

## 9. The account-deletion and review-access decisions

### Account deletion (blocker 1)
**Status: the interim (option 1) is built; option 2, the proper fix, is still outstanding and stays on the release-readiness list.**

The backend cannot delete an account today, and what to delete is a legal question (bookings, payments and tax
records have statutory retention periods; the website's privacy policy says booking and payment records are kept for
the period the law requires, and other data is deleted on request). The stores accept an in-app *path*; the
backend and policy decide what is removed. Options, in increasing effort:

1. **Interim, no backend change:** an in-app "Delete my account" screen that explains what will and will not be
   deleted (matching the policy) and sends a support request with a fixed subject; your team completes it within a
   stated time. Plus a public web page describing the same process, for the Google Play link. Whether Apple accepts
   a request-based flow is Apple's judgement at review; it is lower risk than none.
2. **Proper:** a backend endpoint that closes the account, removes or anonymises personal data, keeps what the
   law requires, and revokes sessions; the app then calls it after a confirmation.

**What exists now (option 1, built; nothing committed or deployed):**
- The app: Profile → **Delete my account** (`src/app/account/delete.tsx`). It says plainly that it sends a *request* and
  does **not** delete the account straight away, lists what can be deleted and what must be kept (from the Privacy
  Policy), warns about open bookings **without blocking** the request, requires a contact email or mobile number from a
  guest (a guest has no email on the account), asks the customer to tick that they understand, and sends one support
  request with the subject "Account deletion request" (never twice: it checks for an open one first and after a lost
  answer). A customer with a request already open is shown that instead of a second form.
- The public page text: [`ACCOUNT_DELETION_PAGE.md`](ACCOUNT_DELETION_PAGE.md), and a separate stand-alone HTML draft,
  [`account-deletion.draft.html`](account-deletion.draft.html). **Neither is published**; neither is in `frontend/`.
- The staff process: [`ACCOUNT_DELETION_RUNBOOK.md`](ACCOUNT_DELETION_RUNBOOK.md).

**What it does not do:** it deletes nothing, verifies nobody's identity and tracks no deadline. A person does all three
(runbook). The backend step of actually removing data is **not verified** and is a decision for whoever operates it.

**What you still need to do:**
1. Review the page text with whoever owns your privacy obligations; resolve the "Please confirm" list in
   `ACCOUNT_DELETION_PAGE.md`.
2. Choose the address, publish the page (a change to the website, which I have not made), and put the address in the
   Google Play Data safety form and in `STORE_LISTING.md`.
3. Update the Privacy Policy to cover the app and in-app requests (blocker 7).
4. Name the person who owns these requests and the 30-day clock; confirm with the backend operator how deletion is
   carried out (runbook §0 and §5).
5. Before any production release, send a test request from a test account and walk it through the runbook.
6. Accept that Apple may still reject a request-based flow, and keep the backend endpoint (option 2) on the list.

**Option 2 (still outstanding):** a backend endpoint that closes the account, removes or anonymises personal data, keeps
what the law requires, and revokes sessions; the app then calls it after the confirmation it already has. That is a
backend change and needs your approval first. I have not built it.

### Review access (blocker 2)
Reviewers need a way in. Options:
1. **Guest mode.** The app already lets anyone "Continue as guest" and browse, book (up to payment), save items and
   send requests, with no account. Explain this in the review notes. Payment on a live backend is real, so give the
   reviewer a way to see the payment screen without paying (a staging backend, or a test booking you pre-create).
2. **A review account with a fixed code**, which needs a backend change (a reserved test account whose sign-in code
   is known). Recommended only if Apple or Google asks, and only on a staging backend.

## 10. Pre-release checklist

Tick every line before the first store submission.

- [ ] Blockers in §1 resolved or consciously accepted. **Includes** the deletion page published and its address entered in
      the stores, a named owner for deletion requests, and a decision on the proper backend endpoint (§9).
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run doctor` all clean on the commit being released.
- [ ] `npx expo export --platform android --platform ios` completes (it proves both bundles compile).
- [ ] The device checklist at the end of [`QA.md`](QA.md) completed on at least one iPhone, one small and one large Android phone.
- [ ] The first-real-payment plan in [`PAYMENTS.md`](PAYMENTS.md) completed on a staging backend with HDFC UAT, then one
      small real payment on production by you, with a refund.
- [ ] `build.production.env.EXPO_PUBLIC_API_BASE_URL` is the live `https://` address; `GET <address>/api/health` answers 200.
- [ ] The backend has what the app needs: customer API routes live, `CORS` is irrelevant for native apps, HDFC is in
      production mode with its readiness checklist clear (`hdfc_readiness`).
- [ ] The legal pages the Profile screen links to load: `/privacy-policy.html`, `/terms-and-conditions.html`,
      `/cancellation-refund-policy.html`, `/image-credits.html`. The image-credits page must cover every photograph
      (most destination photos are CC BY / CC BY-SA and need attribution).
- [ ] Store listing, screenshots, privacy answers and data-deletion answers reviewed by you.
- [ ] A named person owns the first week: watching Play vitals and App Store Connect, answering support, and able to halt the rollout.

## 11. What this project will never do on its own

Build in the cloud, sign anything, create store records, submit, publish, or change a live system. Each of those
happens only when you run the command or tell me to, in that moment.
