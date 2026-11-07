# Store listing and privacy answers (drafts)

Drafts for the Google Play and Apple App Store listings, and the answers to their privacy questionnaires. **These are
drafts for you to review, not legal advice.** Character limits and screenshot sizes below are the ones I know; the
consoles change them, so confirm each in the console when you paste. Nothing here has been entered anywhere.

## Rules for the text
Say only what the app does today:
- It sells **hotels and tour packages** (and takes enquiries for packages with no open dates).
- It does **not** sell flights. Do not mention flights, flight fares or "fly free".
- Prices on pages are indicative; the server confirms the price at booking. Do not promise "best price".
- Support is by phone and email (the website lists the phone as answering every day, around the clock) and by in-app requests.
  There is no live chat.
- Do not claim ratings, awards, partner counts or "2,000+ properties" the catalogue cannot back up.

## Basics

| Field | Draft |
|---|---|
| App name | JackpotsWorld Tours & Travels (29 characters; Play and Apple both limit the name to 30) |
| Short name on the phone | JackpotsWorld |
| Category | Travel (Apple: Travel; Google Play: Travel & Local) |
| Price | Free |
| Contact email | support@jackpotsworldtours.com |
| Contact phone | +91 91778 47799 |
| Website | https://jackpotsworldtours.com |
| Privacy policy URL | https://jackpotsworldtours.com/privacy-policy.html (**must be updated to cover the app first**) |
| Support URL | https://jackpotsworldtours.com/customer-support.html |
| Terms | https://jackpotsworldtours.com/terms-and-conditions.html |
| Account deletion URL (Google Play) | **Drafted, not published.** Text in `ACCOUNT_DELETION_PAGE.md`, HTML draft in `account-deletion.draft.html`; suggested address `https://jackpotsworldtours.com/account-deletion.html` (your decision). Enter it only once the page is live. See `RELEASE.md` §9. |

## Text

**Google Play short description (limit 80):**
> Book hotels and holiday packages. Prices confirmed by our team's system.

(Alternative: "Hotels and tour packages from a Hyderabad travel agency, in your pocket.")

**Apple subtitle (limit 30):** `Hotels & holiday packages`

**Apple promotional text (limit 170):**
> Find hotels and tour packages, see the price our system confirms for your dates, pay securely, and keep every booking in one place.

**Full description (limit 4,000; the same text can serve both stores):**
> JackpotsWorld Tours & Travels is a Hyderabad travel agency. This app lets you find and book hotels and tour packages, and
> manage your trips, with real people to call when you need them.
>
> FIND
> • Browse destinations, hotels and tour packages.
> • See photographs, amenities, room options, itineraries, inclusions and cancellation policies.
> • Save hotels and packages to a wishlist.
>
> BOOK WITH A CONFIRMED PRICE
> • Choose your dates and guests, and our system quotes the exact price, taxes and any coupon discount before you book.
> • Guest names are required for a hotel stay; international packages ask for passport details.
> • Save the people you travel with and pick them next time.
>
> PAY SECURELY
> • Payment happens on our payment partner's secure page. The app never sees your card details.
> • A booking shows as paid only when our system has confirmed the payment.
>
> YOUR TRIPS, IN ONE PLACE
> • See awaiting-payment, upcoming, past and cancelled bookings, and your payments and refunds.
> • Cancel an unpaid booking, or ask our team to review cancelling a paid one.
>
> HELP
> • Call or email us, or send a request from the app and read our reply there.
>
> You can browse without an account, continue as a guest, or sign in with a one-time code sent to your email or phone.

**Apple keywords (limit 100, comma-separated, no spaces after commas):**
`hotels,holiday packages,tour packages,travel,India,Hyderabad,bookings,trip,vacation`

**What's new (first release):** `First release: browse and book hotels and tour packages, with prices confirmed by our system.`

## Screenshots and graphics (to be made)
Suggested screens, in order, taken from a real device with real catalogue data:
1. Home (search card, destinations)  2. Hotel page with rooms  3. Booking review ("Priced by our server")
4. Tour package page with itinerary  5. A confirmed booking  6. Wishlist  7. Help and support.

Sizes (confirm in the consoles): Apple requires screenshots for the largest iPhone size class (and iPad if the app
supports tablets, which `app.json` currently declares: `supportsTablet: true`); Google Play needs at least two phone
screenshots, a 512×512 icon and a 1024×500 feature graphic. The current icon is the website logo upscaled; commission a
proper 1024×1024 master before launch.

## Age rating
No user-generated content visible to others (support requests are private), no gambling, no mature content, no
ads. Expect the lowest rating in both stores, but answer the questionnaires yourself. **Check one thing:** the website
has a "Gaming Tour Packages" section (the app does not show it); if gaming or casino travel is ever added to the app,
the rating answers change.

## Privacy answers (Google Play Data safety / Apple App Privacy)

Derived from what the app actually sends to the backend. Confirm each with whoever owns your privacy obligations.

**Facts about the app:** no advertising, no analytics SDK, no crash-reporting SDK, no social login, no tracking across
other companies' apps or sites, no location, no contacts, no photos, no microphone, no camera. Data travels over
https. The only third-party code in the app is Expo's open-source libraries and bundled fonts (the production bundle contains 58 packages; see `QA.md`). Card and bank details are typed on the payment provider's own page,
not in the app.

| Data | Collected? | Why | Optional? | Linked to the person? |
|---|---|---|---|---|
| Name, email address, phone number | Yes | Account, booking contact, support | Required to book | Yes |
| Date of birth, gender, postal address | Yes | Profile (optional fields) | Optional | Yes |
| **Passport number, expiry, nationality** (saved travellers; international packages) | Yes | Booking international trips; saved for next time | Optional unless the package is international | Yes. Sensitive: treat as government-ID data in the questionnaires |
| Booking history, quotes, wishlist, saved travellers | Yes | The app's function | n/a | Yes |
| Payment records (amount, status, method, provider reference) | Yes | Showing and confirming payment, refunds | n/a | Yes. **Card numbers are not collected by the app or the backend** |
| Support requests and replies | Yes | Support | Optional | Yes |
| Search terms (destination, dates, guests) | Sent to the server to return results, with no sign-in (the endpoints are public); the server's own request logs may hold them | App function | n/a | Not linked to an account by the app |
| Device and session information (device name, browser string, IP address, sign-in times) | Yes (the backend records sessions) | Security, "where you're signed in" | n/a | Yes |
| Location, contacts, photos, files, audio, health, browsing history | **No** | n/a | n/a | n/a |

**Purposes to declare:** App functionality; Account management; Fraud prevention and security. **Not** advertising,
**not** analytics, **not** personalisation, **not** sold.

**Shared with others:** the payment provider (for payment, through its own page), and the hotel or tour operator that
must fulfil a booking, as your privacy policy describes. Confirm the wording of "sharing" against each store's
definition (service providers acting on your behalf are treated differently from third-party sharing).

**Security practices:** data encrypted in transit (yes).

**Data deletion questions (honest answers today):**
- *Can users request that data be deleted?* Yes, **by request**: in the app (Profile → Delete my account, which sends a
  support request) or by emailing/calling support. A person verifies and completes it; it is **not** instant and **not**
  automatic.
- *Is there an in-app way?* An in-app way **to ask**. There is **no** in-app way that deletes the account by itself.
  Google Play's form distinguishes these; answer accordingly. Apple may judge that a request-based flow does not meet
  Guideline 5.1.1(v); that is a risk to accept knowingly (`RELEASE.md` §1 and §9).
- *Web link for requesting deletion (Google Play)?* The page in `ACCOUNT_DELETION_PAGE.md`, **once you have published it**.
  Leave this blank rather than enter an address that does not load.
- *What is kept after deletion?* Booking, invoice and payment records (generally at least eight financial years),
  travel documents while a trip or claim is open, and support correspondence (up to three years), as the Privacy
  Policy says.
- Do not say deletion is instant, automatic or verified by the app.

**Apple "Data used to track you":** none. No App Tracking Transparency prompt is needed.
**Export compliance:** `app.json` declares `ITSAppUsesNonExemptEncryption: false` (the app uses only the operating
system's standard HTTPS). Confirm that this is still true when you answer Apple's export questions.

## Review notes (template)
> JackpotsWorld is a travel agency's app for booking hotels and tour packages. No account is required to review it:
> tap **Continue as guest** on the sign-in screen. You can browse, select a room, review the server-confirmed price, and
> create a booking; payment is made on our payment partner's hosted page. [Describe how a reviewer sees the payment
> screen without paying: for example a staging address, or a pre-created booking reference.] To sign in with an
> account, the app sends a one-time code to the email address entered. [Add a reviewer test account here only if you
> create one; see RELEASE.md §9.] Account deletion: Profile → Delete my account sends a deletion request to our team, who
> verify the customer and complete it within 30 days (it does not delete the account instantly). [Add the public
> deletion-page address once published.] Support: +91 91778 47799,
> support@jackpotsworldtours.com.

Apple guideline 3.1.3(e) permits payment methods other than in-app purchase for services consumed outside the app
(travel). That is the basis for the hosted card/UPI payment; mention it in the notes if asked.
