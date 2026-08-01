# CR-5 — Booking Enquiry: quotation, form and portal refinements

**Status: ⏳ Built and verified, awaiting approval (2026-08-01).**
Raised by the business on 2026-08-01 as a set of handwritten notes covering the Merchant Portal
and the Admin enquiry response. An out-of-band **change request, not a numbered milestone** —
roadmap M5 is Notifications, so this is not M5.

---

## 1. What changes

Two things, and it is worth keeping them apart because only one of them is behavioural.

**A. The admin's answer to an enquiry becomes a binding quotation.** "Mark Available" was a
one-click yes that told the merchant nothing about cost. It becomes **Send Quotation**, carrying a
**total fare** the desk types and the **remarks** that explain it, and the fare is what the
resulting booking is worth.

**B. A pass over the merchant portal's wording, forms and dashboard.** A rename, a legend, a
dropdown, a typeable passenger count, 24-hour time, one relabelled filter, three tiles and a panel
removed, one button removed. No workflow moves.

**C. A pass over the Admin Booking Operations popup** (second pass, same day): two forms removed,
and the booking and passenger data the merchant submitted brought up to — and past — what the
Manager portal shows. No workflow moves, no endpoint touched.

---

## 2. Which approved behaviour this alters

| Approved thing | How CR-5 alters it | Approval |
| --- | --- | --- |
| **Phase 2** — `POST /api/admin/enquiries/{id}/respond` takes `{available, reason?, response?}` | `total_fare` added and **required** on `available: true`; `reason` becomes required on both answers | Business decision, 2026-08-01 |
| **Phase 1** — enquiry-led booking is created at `total_amount = 0` | Created at the quoted fare | Business decision, 2026-08-01 |
| **CR-4b (FROZEN)** — "the fare is captured at **ticket issuance**" | The fare now normally arrives at the **quotation**, so the issuance capture stops firing for new bookings. **No CR-4b code was edited.** | Explicitly chosen by the business over the non-binding alternative, which was offered and declined |
| **Phase 1** — Number of Passengers is read-only, derived from the breakdown | Typeable, reconciled two-way against the breakdown | Business decision; this reverses Phase 1's recorded "deliberate spec deviation", which asked to be flagged if revisited |
| **Phase 1** — `travel_class` is a free-text box | Four-option dropdown in the UI. **The API is unchanged and still free text.** | Business decision |

### The CR-4b freeze, and why it holds

CR-4b is locked, and §0 of the roadmap says a later gate may not modify it. **Nothing in
`ticket_service.py`, `finance_service.py` or `wallet_service.py` was touched by CR-5.** The
binding fare works entirely through behaviour those functions already had:

- `ticket_service._capture_fare_for_wallet_billing` returns early when `total_amount > 0`. A
  quoted booking therefore never reaches the "enter the fare paid to the airline" refusal, and a
  booking that is still at zero — every enquiry-led booking raised before CR-5 — still does.
- Both `assert_credit_available` call sites already pass
  `total_amount if q(total_amount) > 0 else None`. With a real amount present from the draft
  onwards, the gate upgrades itself from *"is there any headroom at all"* to the full
  *"does this specific amount fit"* check, at **submission and at approval**, with no edit.

That is the whole integration. It was verified rather than assumed — see §5.

---

## 3. Scope, item by item

Numbering follows the business's notes.

### Merchant Portal

| # | Asked for | Delivered |
| --- | --- | --- |
| Dashboard | Remove the *Enquire Ticket* button | Removed |
| Dashboard | Remove *Ticketed*, *Awaiting Verification*, *Unread Notices*, *Account* | Three tiles and the Account panel removed; strip is 10 → 6 |
| Rename | Ticket Enquiry → **Booking Enquiry** | Merchant portal only, by decision — Admin keeps *Ticket Enquiries* |
| Form 1 | *Route* → **Departure & Arrival** | Legend renamed |
| Form 2 | Number of Passengers "not working"; allow manual entry | Now typeable, two-way synced |
| Form 3 | Class free text → dropdown | `Economy / Premium Economy / Business / First Class` |
| Booking Request 1 | Remove Documents Upload | **Already done by CR-1** — verified, not rebuilt |
| Booking Request 2 | Save as Draft stays optional | **Already true since CR-1** — verified |
| Booking Request 3 | Submit for Approval is primary | **Already true** — verified |
| Listing 1–2 | Remove *Find*, keep *Search* | Label renamed on Booking Enquiry **and** My Requests; filtering kept |
| Listing 3 | Remove the *Ticket Upload* action | **Nothing to remove** — see §4 |
| Listing 4 | 24-hour time | Selector, stored times and listing timestamps |

### Admin Portal

| Asked for | Delivered |
| --- | --- |
| Replace *Mark Available* with a professional label | **Send Quotation** (business's starred choice). Its pair became **Decline Enquiry** |
| Add *Total Fare* | Free-text amount, typed, never calculated. Required and strictly positive |
| Add *Remarks / Reason* | Required on both answers |
| The merchant receives the fare and the explanation | Detail card, list row, Booking Request screen, timeline note and the notification |

### Admin Portal — Booking Operations popup (added 2026-08-01, second pass)

| Asked for | Delivered |
| --- | --- |
| Remove the **Assignment** section | **Already gone** — CR-2 dropped it; the queue's own assignment filter and column cover it |
| Keep **Airline References** editable | The three inputs and `opsSaveReferences()` are live. Briefly removed in this pass and **restored by decision** — see below |
| Show the **full passenger details entered by the merchant**, matching the Manager portal | Every field the Manager portal shows is now present, and the passenger cards carry **13** fields to the Manager's 7 |

**The six sections, in the order the business specified:**

| # | Section | Editable? |
| --- | --- | --- |
| 1 | Booking information | read-only |
| 2 | Passenger information — as the merchant submitted it | read-only |
| 3 | Quotation — total fare + remarks | read-only |
| 4 | **Airline references** — PNR, ticket number, airline reference | **yes** |
| 5 | Issued ticket documents | upload / remove |
| 6 | Internal notes — staff only | add |

**What was added to Booking information**, closing the gaps against the Manager portal: `Submitted`,
`Route` (International / Domestic), `Alternate phone` — plus three the Manager portal does **not**
show and this desk needs:

- **Preferred departure / return time.** The merchant chooses these on the enquiry form and
  *neither* portal displayed them. Printed unconverted as stored 24-hour `HH:MM` (`opsTime`),
  because the desk reading a different clock from the person who filled the form in is how "09:30"
  becomes an evening flight.
- **Booking amount**, with `settled from the wallet at ticketing` on the Classic track. This modal
  showed **no money at all** — the only figure it ever carried was the fare *input*, which a quoted
  booking no longer renders.
- **The quotation**, promoted to a section of its own (3): fare, the amount the booking was actually
  raised at, and the remarks the merchant received. The desk about to buy the ticket is the last
  person who can notice that the quote and the itinerary disagree. On a booking quoted ₹24,500 that
  was raised at 0, `Booking raised at —` says so on the same screen as the fare box.

> **Why the references form is editable and why it was briefly not.** The first pass of this
> section removed the form, on the reading that the modal should be a read-only work sheet;
> the cost was flagged at the time — a booking would then carry only the PNR
> `ticket_service.issue_ticket` generates for it, and the airline's real reference would never
> reach the merchant's paperwork. **The business restored it: Operations books the ticket
> externally and must key back the PNR, ticket number and airline reference.** These three inputs
> are the **only editable copy of those values anywhere in the product** — every other surface
> that shows a PNR or a ticket number (merchant portal, Operations, partner history) renders it
> read-only, which was confirmed by search before restoring rather than duplicating them. For the
> same reason they are **not** repeated read-only in section 1: a value shown twice in one dialog
> is a value someone edits in one place and reads from the other.

### Payment flow

The notes' final item — *"a new wallet-based payment flow needs to be implemented (the one you've
recently redesigned)"* — **is CR-4, already in flight**: 4a and 4b are approved and frozen, **4c is
built and awaiting approval**, 4d is not started. It is deliberately **not** part of CR-5. Chaining
it would break the delivery rule in §0 of the roadmap.

---

## 4. What the notes asked for that does not exist

**"Remove the Ticket Upload button/action (not needed on this screen)."** There is no ticket-upload
control anywhere in the merchant portal — searched across `frontend/merchant-classic/`,
`frontend/operations/` and the retired Premium screens. The only ticket upload in the product is on
the **Admin** Booking Operations desk (`admin-booking-ops.js`, M2/CR-2), where staff attach the
airline's e-ticket after payment; a merchant may only attach to its own draft, and CR-1 removed even
that from this workflow.

Nothing was removed for this item. If the button is visible in a specific screenshot, it is not in
this codebase and needs pointing at.

---

## 5. Design decisions

### 5.1 The quotation is stored on the enquiry, as a string

`travel_details.quoted_fare` holds the amount as a **string** — JSONB cannot hold a `Decimal`, and
storing a float would put the money path through the one type
`docs/WALLET_ARCHITECTURE.md` exists to keep it out of. It is rebuilt as a `Decimal` in
`EnquiryResponse.of`, so it reaches the wire as a decimal string like every other money field.

Alongside it: `quotation_remarks`, and the attribution `quoted_by` / `quoted_by_name` /
`quoted_at`. **The attribution never leaves the enquiry** — `EnquiryResponse` does not expose it,
and `to_booking_request` strips it rather than copying it onto the booking; see §6.3b for why that
matters more than it looks. No migration — `travel_details` is the JSONB column every enquiry field
already lives in, which is also why this is revertible without one.

### 5.2 Remarks are required, not optional

The business's example is a total that is *deliberately* not the ticket price:

```
Total Fare: ₹15,000
Reason:     ₹3,000 ticket fare
            ₹12,000 baggage charges
```

The remarks are the entire reason the number is acceptable. A quotation without them is a bill with
no explanation, and the merchant's next action is to telephone the desk — which is what this change
is meant to prevent. So the schema refuses one.

### 5.3 The passenger count reconciles; it does not float free

The server requires `passenger_count == adults + children + infants` and 422s otherwise. Simply
removing `readonly` would have produced a form that looks filled in and cannot be submitted. So a
typed total is reconciled: **adults absorb the difference**, because children and infants are only
ever set deliberately and an infant conjured by arithmetic would travel on a lap nobody booked.
The floor is one adult, and never fewer adults than infants; a total that cannot be met by moving
adults alone is clamped back and says so.

### 5.4 The class dropdown narrows the UI, not the API

`travel_class` stays free text on the wire. Making it an enum would break every enquiry already
stored with a fare-family name and would be a contract change for a label. The dropdown is a strict
**subset** of what the server accepts — the UI offering less than the server allows, which is the
safe direction.

### 5.5 24-hour time is scoped to the merchant portal

`fmtDateTime` in `shared/formatters.js` is loaded by the Admin, Manager and Super Admin portals as
well, and renders 12-hour under `en-IN`. Changing it would have moved four portals. `clDateTime24`
is a local override in `classic-enquiry.js`; the form's control is a plain 24-hour `<select>`, and
`cl24h()` / `clMeridiemToggle()` — the AM/PM conversion helpers — were deleted along with the
`.cl-mer` CSS, since this screen was their only caller.

The half-hour granularity is new: the old hour-only list forced "around 09:30" to 09:00 or 10:00.

### 5.6 Two portals, two words for one row

The merchant says **Booking Enquiry**; staff say **Ticket Enquiry**. `request_type` is
`ticket_enquiry` either way. Renaming the type would mean a migration and a contract break for a
label, and the two audiences genuinely mean different things — the merchant is starting a booking,
the desk is working a queue.

---

## 6. What verification found

### 6.0 Assertions that encoded the pre-CR-5 world

Beyond the three *callers* in §6.1, four *assertions* encoded the old behaviour and had to be
rewritten rather than "made to pass":

| Where | Asserted | Now |
| --- | --- | --- |
| `verify_cr2.py` | *"and no amount was invented along the way"* — the booking is still `0` after manager approval | *"the manager's approval changed no amount"* — it is still the quoted fare. CR-2's actual guarantee is that the manager invents nothing, not that the number is zero |
| `verify_cr4b.py` | *"without inventing an amount it cannot know"* — the refusal must **not** name a figure | It **must** name it. The fare is known at submission now, and a refusal silent about it hides the one number the merchant needs. `credit_refusal_message` is unchanged; it simply receives an amount where it used to receive `None` |
| `verify_cr4b.py` | the credit fixture assumed a `0` booking passed both gates | The fixture booking is built at `12000.00`, which is also the fare sent at issuance — they have to be the same number now, or the final assertion measures the wrong one |
| `verify_cr4b.py` | the race fixture sent `fare_amount` at issuance and expected it to apply | The builder quotes `RACE_FARE`, since `fare_amount` is now correctly ignored on a booking that already has an amount |

One further failure was **not** CR-5's doing and is worth separating: `verify_m4.py`'s wallet
payment asserted against whatever balance the shared development wallet happened to hold, which
worked only while the suite put more in than it took out. It now tops itself up first. Same trap
the roadmap records against this file's overdraw test — a fixed expectation against a drifting
fixture — in the other direction. And `verify_cr2.py`'s *"manager credentials on the admin
portal"* posts a **raw** login (it has to; the point is that it fails), so in a full run it can
land on an exhausted rate-limit budget and report a 429 as a defect. It now waits the limit out
the way `config.login` does.

### 6.1 Three suite scripts asserted the old contract

`POST /respond` now refuses `{"available": true}` with no fare, and **three callers in the suite
sent exactly that**: `flows.make_booking` (the shared enquiry-led builder, used by six scripts) and
two calls in `verify_api.py`. All three were rewritten to send a quotation. `flows.make_booking`
gained a `quote` parameter defaulting to its existing `fare`.

This is the same failure family the roadmap already records twice (CR-1 broke `verify_api.py`'s
submit rule; CR-4b rewrote `flows.py` and `verify_cr2.py`). It was found by running the suite, not
by reading it.

### 6.2 A CR-4b test could no longer construct the state it tests

`verify_cr4b.py`'s *"a booking with no fare cannot be ticketed"* built a booking through
`flows.make_booking` and relied on it having `total_amount = 0`. After CR-5 that builder produces a
priced booking, so the section would have been testing the wrong thing — silently, and still green.

Rewritten to zero the row directly, which is a faithful reproduction of the population the rule
actually guards: **pre-CR-5 bookings, which exist as database rows and not as anything an API call
can still create.** A CR-5 assertion was added beside it proving the state is unreachable through
the API (422). Asserting through the now-impossible call would have quietly stopped testing
anything — the exact failure mode the roadmap records against `verify_m4.py`'s magic number.

### 6.3 Two defects in the new verification script, both mine

Worth recording because both were the *script* being wrong, not the product:

- It queried `wallet_transactions.amount`, which does not exist — the ledger stores `debit` and
  `credit` in separate columns precisely so `balance_after = balance_before + credit - debit` can
  be a database check constraint (CR-4a).
- It asserted the credit-refusal figures against `finance_service`'s position. They come from
  `wallet_service`, and the two use **the same word for different quantities** — see §6.4.

### 6.3a Five defects reading the screens found, and the API tests could not

Every one of these is a screen contradicting the quotation. None would have failed a single
assertion in `verify_cr5.py`, because none of them is an endpoint. The first is the one worth
reading — it is on the screen where the platform's money actually moves.

1. **The operations desk stopped being told what it was about to debit.** CR-4b put a fare field
   on the issue-ticket modal and named the figure in its confirmation — *"its wallet is debited
   ₹X"* — sourced from what the operator had just typed. A quoted booking already carries its
   amount, so the field correctly does not render (`needsFare` is `total_amount <= 0`, which needed
   no change) — and the confirmation then fell through to the branch that mentions no money at all.
   The operator triggering a ₹60,000.50 wallet debit was told only that *"the merchant is notified
   and can download the attached ticket documents"*. The amount is now read off the booking when
   the field is absent, gated on `workflow === 'classic_tours'` so a catalog-led booking — which is
   never wallet-billed — still says nothing about a debit. All three branches were driven in the
   browser with `confirmDialog` stubbed to decline, so nothing was issued.
2. **Booking Request still promised a zero.** A panel note read *"the payable amount is confirmed
   by our team at approval — an enquiry-led booking carries no fare until then, so this request
   will show a zero amount until it is approved"*, printed directly beneath the quoted fare. It now
   states what submitting commits to, with the pre-CR-5 wording kept for an unquoted enquiry.
3. **My Requests hid the amount.** `clRequestAmount` returned *"Not payable here"* for every
   Classic Tours booking, with the comment *"it has no amount and never will"*. True under CR-2,
   false under CR-5 — so the one screen listing every request was the one screen that would not
   say what any of them cost. It now shows the figure with a *"from wallet"* sub-label when there
   is one, and keeps *"Not payable here"* when there is not, which is exactly the pre-CR-5
   population. `moneyStr`, not `money()` — the latter rounds through a float and would have
   rendered ₹60,000.50 as ₹60,001.
4. **The stepper narrated the old lifecycle.** *"2. Answered / Available to book"* and
   *"4. Approval / Our team confirms the fare"* became *"2. Quoted / ₹60,000.50"* and
   *"4. Approval / Sign-off on this booking"*, with step 5 renamed Ticketing.
5. **A clamp warning outlived the state that caused it.** Typing an impossible passenger total
   clamps and explains itself; clearing the box then reverted the value but left the warning up,
   accusing the merchant of an error they were no longer making. `clClearPaxClampMsg` retracts it
   by prefix, so it cannot swallow the infants-per-adult warning or a submit error.

A sixth, **pre-existing**, was corrected in passing: the submit confirmation promised a move to
*"Payment Pending once it is approved and priced"*, which has been wrong on this track since CR-2
removed the payment stage from it.

### 6.3b An internal id would have reached a merchant response

`to_booking_request` copies the enquiry's `travel_details` onto the booking, and
`travel_details` is returned to the merchant **wholesale** as `details` (`schemas/ticket.py`). The
first cut of the quotation wrote `quoted_by` (a platform staff **user id**), `quoted_by_name` and
`quoted_at` alongside the fare, so all three would have travelled onto a merchant-facing response.

The codebase already had the answer: the same function drops `review_claimed_by` / `_by_name` /
`_at` with the comment *"it belongs to the enquiry's workflow, not this booking's."* The quotation
attribution is dropped on exactly that principle. `quoted_fare` and `quotation_remarks` stay —
they are the merchant's own price and the explanation of it — and `verify_cr5.py` now asserts both
halves: what is carried, and what is not.

### 6.4 `outstanding` and `credit available` mean two different things — flagged, not changed

| Word | `wallet_service` (CR-4) | `finance_service` (M4) |
| --- | --- | --- |
| `outstanding` | `max(0, -wallet_balance)` — the wallet debt | unpaid `balance_due` across billable bookings |
| `credit available` | `max(0, credit_limit + wallet_balance)` | `credit_limit − outstanding` |

On the development database these differ by millions, because the catalog track has accumulated
unpaid test bookings. A merchant blocked by the wallet gate reads "available credit ₹7,396.50" in
the refusal, while the dashboard tile — which reads the M4 position — can show a different figure.

**Not touched by CR-5.** Both computations are frozen (CR-4a/4b and M4), both are correct for what
they describe, and CR-5 neither introduced nor worsened the overlap. It is recorded here because
**CR-4d is where the merchant- and admin-facing wallet surfaces are reconciled**, and that is the
gate that should decide whether one of the two words changes.

---

## 7. Verification

- **`tests/verify_cr5.py` — 81 checks.** Quotation validation at every boundary (missing fare,
  zero, negative, missing remarks, a fare on a decline); the fare reaching the merchant as a
  decimal string with its paise, on the detail *and* the list row *and* the timeline; the booking
  raised at exactly the quoted amount with `pricing.priced_at = enquiry_quotation`; the credit
  limit refusing at submission with **all five figures asserted by name and by value** plus the
  shortfall; issuance needing no `fare_amount`; a zeroed (pre-CR-5) booking still demanding one;
  **six simultaneous quotations** — exactly one 200, no 500s; cross-tenant 404; and the server-side
  rules the new form controls depend on (count reconciliation, all four cabins, `00:00` / `00:30` /
  `12:00` / `23:30`); and what the booking carries off the enquiry — the fare and remarks yes,
  the internal attribution no.
- **Full suite — 944 checks, 15/15 scripts, 0 failures**, run alone against the live PostgreSQL
  database. Every prior script's own count is unchanged or higher; nothing was made to pass by
  weakening an assertion.
- **Re-run after the Booking Operations second pass — 944 checks, 15/15, 0 failures**, identical
  to the line above, which is the expected result for a change confined to three frontend files.
  `verify_m1.py` (59) still covers `PUT .../references`, and it covers it for a form that once
  again exists.

- **Browser — driven end to end, both portals, against the live database.** Merchant raised
  `ENQ-20260801-001010` (Hyderabad → Dubai, Emirates EK525, Business, 23:30, 2 pax) through the
  real form; Admin claimed it and sent a quotation of **₹60,000.50** with a three-line breakdown;
  the merchant read it back on the list row, in the detail card and on Booking Request, then
  submitted `REQ-2026-001962`, which carries `total_amount: "60000.50"` **as a string** on the
  merchant's own API response.
  - The passenger stepper was exercised for real: typing 9 moved adults to 9; adding two children
    took the total to 11; typing 4 rebalanced to 2 adults + 2 children; an impossible party of 2
    against 2 children and 2 infants clamped to 6 and said so; empty, `0` and `abc` all reverted.
  - Client-side quotation validation: no remarks, remarks-without-fare, `abc` and `0.00` each
    refused with their own message before any request was sent.
  - The confirmation dialog names the figure and its three consequences before the answer is final.
  - **Merchant portal: `Booking Enquiry` throughout. Admin portal: `Ticket Enquiries`, unchanged.**
  - Dashboard strip is 10 tiles → 6, the Account panel and the Enquire Ticket button are gone.
  - **No horizontal overflow at 1280 / 768 / 375** on the merchant dashboard, Booking Enquiry, My
    Requests or the enquiry form modal, nor on the Admin enquiry list and its response modal (fare
    and remarks 335 px wide inside a 375 px viewport, every button within bounds). **Console clean
    on both portals.**
  - All new inputs carry `for`/`id` labels and are keyboard-reachable.

  **Screenshots were not possible** — the Browser pane is not displayed in this session, so
  `computer{action:"screenshot"}` times out. `javascript_tool` measurements and DOM reads carried
  the whole visual check, as they did for CR-1.

- **Browser — the Booking Operations popup.** Driven on four real bookings covering every branch
  the modal has:

  | Booking | State | What it proves |
  | --- | --- | --- |
  | `REQ-2026-002076` | Ticket issued, quoted ₹12,000 | Six sections in the specified order; amount reads *"₹12,000.00 settled from the wallet at ticketing"*; preferred departure time reads `09:30` |
  | `REQ-2026-002118` | Approved, quoted ₹24,500, priced | No fare box (already priced), `Mark Ticket Issued` offered, quotation fare = raised amount |
  | `REQ-2026-002129` | Approved, quoted ₹24,500, raised at 0 | Fare box **does** render, and the quotation panel reports `Booking raised at —` beside the ₹24,500 quote |
  | `REQ-2026-001347` | Approved, pre-quotation era | Quotation panel explains the absence instead of showing an empty grid |

  Assignment is absent on all four; **Airline references is present and editable on all four**.
  **The save round-trip was exercised for real** — typed `6E-REF-88213` into the airline-reference
  box, clicked *Save references*, and the value came back on `GET /api/requests/3807`. The
  partial-update promise printed above the form was tested too: changing the PNR while leaving the
  ticket-number box **blank** left `TKT-2026-000568` intact. The fixture was restored afterwards.
  **A field-for-field diff against the Manager portal returned an empty missing-list**, with 13
  passenger fields to the Manager's 7. No overflow at 1280 / 768 / 375 — the references grid
  collapses 3 columns → 1 at 375 — and the console is clean.

  **One layout defect was found in the restored section and fixed.** *Airline reference (if
  applicable)* is long enough to wrap to two lines at every width where three columns still fit,
  which dropped its input 16 px below the other two. Corrected with `align-items:end`, **scoped to
  `#opsWorkBody`** rather than added to `.ops-grid-3` itself: the Manager portal reuses that class
  for its profile form, where the email field carries a hint *below* its input — bottom-aligning
  there would have aligned the hint and lifted the input. `#opsWorkBody` exists in no other
  portal's markup, which was checked rather than assumed. All three inputs now share a baseline at
  1280 / 788 / 375.

---

## 7a. §3 Production Readiness Checklist — CR-5 sign-off

Roadmap §3 says this is applied to every milestone and that an inapplicable item is marked N/A
**with a reason**, not silently skipped.

| Group | Result |
| --- | --- |
| **Security** | **No new endpoint** — CR-5 adds a field to one existing body and two to one existing response, both already authenticated. No secret or PII added to any response. `total_fare` and the remarks are Pydantic-validated (`Decimal`, `ge=0`, `max_digits=12`, `decimal_places=2`; `max_length=2000`); **no string is interpolated into SQL anywhere in the change**. Cross-tenant reads still 404, asserted in `verify_cr5.py`. Auth paths untouched. |
| **RBAC** | Unchanged and deliberately so. `respond` keeps `require(TICKET_APPROVE, TICKET_REJECT)` with the in-handler re-check that follows the payload — the nuance Phase 2 recorded, and adding a fare does not change which code is needed to send one. **No new permission code**, because quoting is not a new capability, it is what answering an enquiry now means. Verified from admin, merchant and a rival merchant. |
| **Concurrency** | Untouched, and re-proved: `respond` still takes `SELECT … FOR UPDATE` through `_locked()`, and six simultaneous quotations give exactly one 200 with the stored fare being the winner's. Status changes still go only through `lifecycle.transition`. No sequence is allocated before its transition validates. |
| **Performance** | No new query. The quotation is read from `travel_details`, a column every enquiry response already loads — no extra round trip, no N+1, no new index needed. |
| **Accessibility** | Every new control has a `for`/`id` label (verified in the DOM, both portals). The class dropdown and the 24-hour selector are native `<select>`s, so they are keyboard-operable and screen-reader-labelled for free — and replacing the AM/PM toggle **removed** a pair of custom buttons that needed `aria-pressed` to be understandable at all. Colour carries nothing alone: the quotation is a figure and a heading, not a green box. Layout holds at 1280 / 768 / 375. |
| **Documentation** | `docs/API_CONTRACT.md` §6.3z written in the same pass as the change. Non-obvious decisions commented where the decision is. This file and the roadmap updated. **No migration** — `travel_details` is existing JSONB — so the schema docs need no change. |
| **Regression** | Full suite re-run; `?v=` bumped on every changed `frontend/**` asset. Failures reported with their output and each one traced to a cause before being touched. |

**N/A, with reason:** *Uploads* — CR-5 adds no upload path and does not change `document_service`.
*Migrations* — none; the quotation lives in the JSONB column enquiries already use, which is also
why it can be reverted without one. *PDFs* — CR-5 renders none.

**Known and unchanged:** the two meanings of `outstanding` / `credit available` (§6.4), and
`clRequestAmount`'s use of `money()` on the **non**-Classic branches — CR-5 moved only the branch
it touched onto `moneyStr`, since changing the others would alter M3 and catalog-track rendering
that is not in this change request's scope.

---

## 8. Decisions taken by the business — 2026-08-01

Asked before any code was written, because each changes what gets built:

1. **The action label is "Send Quotation"** (chosen from six candidates; its pair became "Decline
   Enquiry").
2. **The fare is binding** — it becomes the booking's amount. The non-binding alternative
   (quotation shown to the merchant, fare still confirmed at issuance) was offered, and its
   consequence for CR-4b's frozen rule was stated, and it was declined.
3. **The rename is merchant-portal only.** Admin keeps "Ticket Enquiries", matching the internal
   operations workflow and the specifications.
4. **"Remove Find" meant rename it to "Search".** The filtering capability is kept.
