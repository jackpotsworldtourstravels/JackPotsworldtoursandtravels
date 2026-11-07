# Quality assurance (Phase 8)

What was checked, how, what it found, and what still needs a person with a phone. Every line says whether it
was **automated**, **run by hand** (in the Expo web preview at phone width against a local backend with the mock
payment provider), or **not run**. Nothing was tested on a real Android or iOS device.

## Summary

| Area | Result |
|---|---|
| Automated tests | 49 suites, 710 tests pass (three full runs in a row, 2026-10-22); `tsc` and ESLint clean; `expo-doctor` 20/20. An earlier full run had one intermittent timeout in `book-saved-travellers.test.tsx` (see below). |
| Native builds | Production Android and iOS bundles export and compile (Hermes bytecode). Not installed on a device. |
| Security review | No secrets in the bundles; tokens only in Keychain/Keystore; no logging; fixed or https-only URLs. 1 iOS and 2 Android config issues found and fixed. |
| API contract | All 50 endpoint calls exist in the backend's OpenAPI with matching methods |
| Customer data isolation | 20 cross-customer checks against the local backend: all pass |
| Responsiveness | No horizontal overflow on 10 screens at 320 px; layouts capped and centred on tablets |
| Real devices, real HDFC page | **Not run** |

## Findings and what was done

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | iOS generated config allowed arbitrary plain-HTTP loads (`NSAllowsArbitraryLoads: true`), undermining the app's https-only rule | High (iOS release) | **Fixed** in `app.json`; guarded by a test |
| 2 | Android requested unused permissions: external-storage read/write, overlay, vibrate | Medium (store review) | **Fixed** (`blockedPermissions`); only `INTERNET` remains |
| 3 | `userInterfaceStyle: light` was ignored on Android (needed `expo-system-ui`) | Low | **Fixed** (dependency added) |
| 4 | Nine Expo packages a patch release behind (`expo-doctor`) | Low | **Fixed** (`expo install --fix`) |
| 5 | An unsent booking form (names, passport numbers) stayed in memory after sign-out | Medium (shared phone) | **Fixed**, with a test |
| 6 | iOS tokens were migratable to other devices by backup | Medium | **Fixed** (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), with a test |
| 7 | Text fields responded only to taps on the inner text, not their padding | Low (usability) | **Fixed**, with tests |
| 8 | A full parallel test run could time out on a slow first render | Test reliability | **Fixed** (20 s ceiling) |
| 9 | `GET /payments/history` reads only flight payments | n/a to the app | Worked around in Phase 7; **backend change proposed** |
| 10 | `POST /wishlist` returns **500** for a huge `item_id` and accepts a negative one | Low (backend) | **Not changed (backend); needs your approval.** The app cannot send such ids |
| 11 | On iOS the Keychain can survive an uninstall and reinstall, so a session can outlive the app until its refresh token expires (7 days) or the customer signs out | Low | **Documented**; fixing needs a first-run marker outside the Keychain (a new dependency) |
| 12 | 51 `npm audit` advisories | See below | **Assessed**: build tooling, not shipped |

### The one intermittent test failure (2026-10-22)
One full run failed once: `tests/screens/book-saved-travellers.test.tsx` waited more than 5 s (`asyncUtilTimeout` in
`tests/setup.ts`) for "Priced by our server". That run overlapped with `tsc` and ESLint on the same machine. It has not
recurred in 3 full runs, 2 more full runs with 16 workers (more than the machine's cores), and 8 solo runs of the
suite. **Status: not reproduced; cause probably CPU contention on the first render, not confirmed.** No test was
changed, skipped or deleted. If it recurs, raise that suite's wait deliberately or find what makes the first render slow.

### The `npm audit` advisories
They concern Node build tooling (`braces`, `micromatch`, `node-forge`, `metro`, `js-yaml`, `sprintf-js`, `uuid`,
`xcode`, Jest's dependencies). The exported Android and iOS bundles contain 58 packages; none of those is among
them. The one `@expo/metro` file that ships is a development hot-reload client (`HMRClient.js`). The suggested
"fixes" (for example downgrading to `expo@44`) are not real options. `npm audit fix --force` would break the SDK
pin and is not used. Re-check at release time and whenever the Expo SDK is upgraded.

## Security review (code and configuration)

| Check | Result | How |
|---|---|---|
| Secrets in the shipped bundles (private keys, cloud keys, live payment keys, passwords) | None found | Searched both Hermes bundles |
| Where tokens live | Keychain / Keystore via SecureStore; in memory only on web | Code review |
| Android backup | SecureStore is excluded from Auto Backup (generated `secure_store_backup_rules`) | Generated manifest |
| Android cleartext HTTP | Enabled only in the debug manifest | Generated manifest |
| iOS cleartext HTTP | Now forbidden, local-network development allowed | Generated Info.plist |
| Logging | The app has no `console.*` calls at all | Search |
| Web storage | No `localStorage`/`AsyncStorage` | Search |
| URLs the app opens | A fixed list of website pages, `tel:`/`mailto:` for the company's contacts, and the https payment page | Code review |
| Deep links | Only the `jackpotsworld://` scheme; every route validates its parameters; nothing is created or paid by opening a link | Code review and tests |
| Booking and payment tampering | Requests carry no price; the server re-prices; "paid" is only the backend's word | Tests (Phases 5 and 7) |
| One customer reading or changing another's data | Refused (404) for bookings, checkout, reconcile, cancel, cancellation requests, tickets, replies, travellers, wishlist; 401 with no or a garbage token | 20 live checks, `scratchpad` script (2026-10-22) |
| Malformed input | 16 hostile or invalid payloads: 14 got a 4xx, one was accepted (a negative wishlist id) and one got a 500 (a huge wishlist id); both are finding 10 | Live probe |
| Certificate pinning | **Not implemented** (standard TLS only) | Noted |
| Hiding the screen in the app switcher, screenshots | **Not implemented** (booking and passport screens are visible in the task switcher) | Noted |
| Rooted/jailbroken device detection | Not implemented | Noted |

## API integration
- **Endpoint contract:** every one of the 50 calls in `src/api/endpoints/` exists in the backend's OpenAPI with the
  same HTTP method (checked against the OpenAPI exported from the local backend).
- **Response shapes:** exercised against the real local backend during manual runs (bookings, payments, tickets,
  travellers, wishlist, profile, sessions, cancellation requests). No field-level schema diff was automated.

## Responsiveness and layout
- **Run by hand, measured with a script:** Home, Explore, hotel and package lists and pages, the booking form,
  sign-up, Help and support, Profile and Packages at **320 px**: no horizontal overflow on any. Tablet (768 px) and
  landscape tablet (1024 px): content capped at 840 px and centred; no overflow.
- **Tap targets:** every interactive element has an accessibility role and a name (scan of all 30 `Pressable`s).
  Back and show-password buttons are under 44 px wide on web but carry 8 px of hit-slop on native.
- **Not run:** Dynamic Type / font scaling on a device (text has a scale cap in code), the keyboard on small
  screens, landscape on a phone, the notch and gesture areas (safe-area code exists and is unit-tested only).

## Regression
- No website or backend file was changed (the 49 modified files hash identically; HEAD unchanged). The only change
  outside `mobile-app/` since Phase 3 is one `.dockerignore` line.
- The full automated suite, including the Phase 4–7 behaviour tests and their deliberate-breakage checks, still passes.

## Manual test plan for real devices (not yet done)

Run on one recent iPhone, one small and one large Android phone (including one on Android 12 or older), against a
**staging** backend with HDFC UAT.

1. Install, open, browse offline (airplane mode): friendly errors, nothing blank.
2. Sign up, code, sign out, sign in. Kill the app mid-session and reopen: still signed in.
3. Guest, then create an account: wishlist, traveller and request carry over.
4. Book a hotel and a package; pay with a UAT success card; failure card; abandon; kill the app mid-payment.
   (Follow [`PAYMENTS.md`](PAYMENTS.md).) **Android specifically:** the app must not poll while the bank page shows.
5. Rotate to landscape on every main screen; set the largest system font; use TalkBack and VoiceOver on the
   booking form and payment screen; open the keyboard on the smallest phone and confirm the Confirm button is reachable.
6. Switch the phone to dark mode: the app stays light (Android now honours this).
7. Uninstall and reinstall on iOS: confirm what happens to a signed-in session (finding 11).
8. Background the app on the payment screen for several minutes, then return.
9. Open `jackpotsworld://booking/JPH000001` from another app while signed out and signed in.
10. Tap the call and email buttons on a device with and without a SIM and mail app.
