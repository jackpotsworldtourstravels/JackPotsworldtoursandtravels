# CR-4 — Merchant wallet & transaction ledger

Raised 2026-08-01 by the business. §0 of `docs/BOOKING_OPS_MILESTONES.md` requires written
sign-off before approved behaviour moves, and this change request moves several pieces of it.

| Gate | Status |
| --- | --- |
| **CR-4a — ledger foundation** | ✅ **Approved and locked** (2026-08-01). Architecture: `docs/WALLET_ARCHITECTURE.md` |
| **CR-4b — the money moves** | ✅ **Approved, completed, verified and FROZEN** (2026-08-01) |
| **CR-4c — merchant surfaces** | ⏳ **Built and verified, awaiting approval** (2026-08-01) |
| CR-4d — admin surfaces | ⬜ Not started |

---

## 1. What changes

Today a booking is billed per-booking: it walks to **Payment Pending**, the merchant pays that
booking's amount, an admin verifies, the booking becomes **Paid**. CR-2 disabled that path for
enquiry-led (Classic Tours) bookings entirely.

CR-4 replaces per-booking settlement with a **running merchant account**:

```
CURRENT:  approve ──▶ Payment Pending ──▶ merchant pays THIS booking ──▶ verify ──▶ Paid

CR-4:     approve ──▶ ticket issued ──▶ wallet auto-debited ──▶ booking settled
                                              │
          merchant tops the wallet up out of band, any amount, any time
          (bank / UPI / QR) ──▶ UTR + screenshot ──▶ admin verifies ──▶ wallet credited
```

The wallet may go **negative**. A negative wallet is the merchant's outstanding balance, and the
merchant keeps booking until it crosses its credit limit.

## 2. Which approved behaviour this alters

| Approved item | How CR-4 alters it |
| --- | --- |
| **M4** — wallet non-negative, enforced in the DB and in `adjust_wallet()` | Constraint dropped; negative is the normal operating state |
| **M4** — wallet movements recorded as `payments` rows with `discount_meta.wallet_direction` | Replaced by a first-class `wallet_transactions` ledger |
| **M4** — `assert_within_credit_limit` runs at admin approval / re-price | Also runs at booking submission, and its arithmetic changes (§5.4) |
| **M4** — `merchant_position` returns `outstanding` from billable bookings | A wallet-settled booking owes nothing; exposure moves to the wallet (§5.3) |
| **CR-2** — Classic Tours bookings are outside the payment workflow | Still true for *per-booking* payment; they are now wallet-billed instead |
| **M4** — merchant Payments screen, admin per-merchant finance panel | Both gain wallet sections; neither is rebuilt |

Everything else in §1 of the roadmap is untouched.

## 3. What the code already gives us

Do not rebuild these:

- `merchants.wallet_balance`, `merchants.credit_limit` — columns exist and are populated.
- `finance_service.adjust_wallet()` — already refuses to move a wallet without writing a ledger
  row. That principle survives; only its storage changes.
- The **submit → verify → credit** state machine, in `GET /api/admin/payments/pending` +
  `POST /api/admin/payments/{id}/verify` under `P.PAYMENT_VERIFY`. A recharge is the same shape as
  a booking payment and reuses this desk rather than getting a second one.
- `finance_service.statement()` — a dated ledger with a **server-computed** running balance, and a
  merchant screen already rendering it (`classic-payments.js`).
- `settle_refund()` / `refundable_against()` — M3's cancellation refunds already land in the ledger
  oldest-payment-first.

## 4. Five blockers found in the code

1. **`ck_merchants_wallet_non_negative`** (`models_v2.py:343`) forbids a negative balance, and
   `adjust_wallet()` raises a 400 before the constraint is reached. The core of this design is
   illegal under both. → migration + guard rewrite.
2. **The wallet ledger is improvised inside `payments`.** Wallet rows carry `request_id IS NULL`,
   direction in `discount_meta["wallet_direction"]`, after-balance as a JSON *string*. The audit
   trail this CR asks for (type, debit, credit, balance before, balance after, actor, reason,
   booking ref, payment ref) cannot be stored there honestly.
3. **`request_documents.request_id` is `NOT NULL`.** A recharge screenshot belongs to no booking,
   so the Phase 3 upload table cannot hold it without altering approved schema.
4. **Admin payment accounts do not exist** — no table, no endpoint, no screen, nothing. QR image
   storage does not exist either. (`schemas/accounts.py` is *user* accounts, unrelated.)
5. **`adjust_wallet()` does not lock the merchant row.** Two concurrent moves lose one. Latent
   today; a live defect the moment bookings auto-debit.

## 5. Design decisions

### 5.1 A real ledger table, not more JSONB

New table `wallet_transactions`, the wallet's single source of truth:

| Column | Purpose |
| --- | --- |
| `txn_id`, `txn_number` | sequence-backed reference, `WTX-YYYYMMDD-NNNN` |
| `merchant_id` | scope |
| `txn_type` | `booking_debit`, `wallet_recharge`, `refund_credit`, `manual_adjustment`, `credit_note`, `cancellation_charge` |
| `debit`, `credit` | `Numeric(14,2)`, exactly one non-zero |
| `balance_before`, `balance_after` | audit, per your §4 |
| `request_id`, `payment_id` | nullable links to the booking / recharge that caused it |
| `created_by`, `created_at`, `reason` | who and why |

`merchants.wallet_balance` stays as the cached balance, written only under
`SELECT … FOR UPDATE`. Verification asserts `wallet_balance == SUM(credit) - SUM(debit)` after
every scenario — a cached total that can drift from its ledger is the bug M4 exists to prevent.

`payments` keeps its job: the *instrument* (what the merchant sent, UTR, method, screenshot,
verification state). A verified recharge creates exactly one `wallet_transactions` credit.

### 5.2 Recharge submission — new table, not a stretched one

New table `wallet_topups`: merchant, amount, method (`bank` / `upi` / `qr`), UTR, proof file path
(via `services/storage.py`, the path `document_service` already uses), status
(`submitted` / `verified` / `rejected`), reviewer, remarks. Cleaner than making
`request_documents.request_id` nullable, which would loosen an approved constraint for one
unrelated case.

### 5.3 The debit fires once, at Ticket Issued, and settles the booking

On entry to `ticket_issued` (§8, decision 1), in the same transaction as the lifecycle transition:

1. lock the merchant row,
2. write a `booking_debit` wallet transaction for `total_amount`,
3. write a `payments` row (`method='wallet'`, `SUCCESS`) against the booking.

Step 3 is what stops one debt being two numbers. Without it the booking stays in
`BILLABLE_STATUSES` with a non-zero `balance_due` *and* the wallet is negative by the same amount,
and `merchant_position` reports the exposure twice. A **unique partial index on
`(request_id) WHERE txn_type = 'booking_debit'`** makes the debit idempotent — a retried transition
cannot bill twice.

### 5.4 Credit limit becomes the booking gate

Arithmetic changes from "outstanding + this booking − wallet > limit" to:

```
projected_debt = max(0, −(wallet_balance − booking_amount))
refuse when projected_debt > credit_limit
```

A **hard block** (§8, decision 3): the request is refused server-side, and the message names the
available credit remaining and the amount required. No per-booking override exists.

Enforced in **two** places: at merchant submission (fail fast, with the shortfall named) and at
approval (authoritative — the amount can change between the two). Enforcing only at submit is a
gate that a re-price walks straight through.

**`credit_limit = 0` keeps meaning "no limit configured"**, per the M4 decision recorded in
`finance_service.has_credit_limit`. Every merchant currently carries the 0 default; reading it
literally would block every booking on the platform the day this ships.

### 5.5 Payment accounts

New table `payment_accounts`: type (`bank` / `upi` / `qr`), label, JSONB detail fields, QR image
path, active flag, display order. Admin CRUD under Account Management; merchants get a read-only
active list on the Add Money screen. Inactive accounts stay visible on historical top-ups so an old
recharge still shows where the money went.

### 5.6 No new permission codes

`P.PAYMENT_PAY` covers submitting a recharge, `P.PAYMENT_VERIFY` covers approving one,
`P.PAYMENT_MANAGE` covers payment accounts and manual adjustments, `P.PAYMENT_VIEW` covers reading
the ledger. §0's rule is that new behaviour reuses an existing code unless it is a genuinely new
capability, and none of this is.

## 6. Build plan — four gated milestones

Per §0 these are **never chained**. Each is implemented, verified in-browser and by script, then
stopped for approval.

**CR-4a — ledger foundation.** Migrations (drop the non-negative constraint; `wallet_transactions`
+ its sequence; `wallet_topups`; `payment_accounts`), `wallet_service.py`, `adjust_wallet()`
rewritten onto the ledger with row locking, `merchant_position` extended with the wallet fields.
Existing `discount_meta` wallet rows backfilled into the new table so no history is lost.

**CR-4b — the money moves.** Auto-debit on the trigger status, idempotency index, credit-limit gate
at submit and approve, refund/cancellation-charge transaction types, low-balance warning data.

**CR-4c — merchant surfaces.** Wallet screen in Classic (balance, outstanding, available credit,
total paid, total booked, last payment, transaction history), Add Money flow showing the admin's
payment accounts, UTR + screenshot upload, submission status. Dashboard tile honest about credit
used vs limit.

**CR-4d — admin surfaces.** Recharge verification queue on the existing payments desk, per-merchant
wallet ledger inside Merchant Management, Payment Accounts CRUD under Account Management, manual
adjustment and credit note.

Frontend work carries the mandatory `?v=` cache-bust bump on every changed asset.

## 6a. CR-4a — what was delivered (2026-08-01)

Approved scope was the five items the business listed: migrations, the `wallet_transactions`
ledger, a wallet service with row-level locking, removal of the non-negative constraint, and the
backfill. **No UI changed and no booking or payment behaviour moved**, with the one unavoidable
exception recorded below.

**Migration `0036_wallet_ledger`** — drops `ck_merchants_wallet_non_negative`; creates
`wallet_transactions`, `wallet_topups` and `payment_accounts` with four enum types and two
sequences; backfills the ledger; audits the two mutable tables. **Exercised down *and* up**, not
just forward. The downgrade restores the non-negative constraint and will *fail* if any merchant is
running a negative balance — deliberately: that is real money owed under the new model, and a
rollback should stop rather than pretend otherwise.

**The invariant is in the database, not in a docstring.**
`ck_wallet_transactions_balance_math` asserts `balance_after = balance_before + credit - debit` on
every insert, and `ck_wallet_transactions_one_direction` refuses a row that is both a debit and a
credit or neither. A ledger whose own arithmetic can be wrong is decoration.

**`wallet_service.py`** — `post()` is now the only code in the repository that assigns
`merchants.wallet_balance` (verified by search: one assignment site). It never moves the balance
without writing the row that explains why, and it takes `SELECT ... FOR UPDATE` on the merchant
first.

**Backfill** — 72 historical wallet movements reconstructed from the `payments` rows carrying
`discount_meta->>'wallet_direction'`, which is the complete history because every movement ever
made went through `finance_service.adjust_wallet`. Balances are reconstructed **backwards from the
current balance** so the ledger cannot disagree with what the platform already shows; a synthetic
opening row covers any difference. In this database the difference was **zero for every merchant** —
the historical movements explain the current balances exactly.

**One transitional dual-write, stated plainly.** `adjust_wallet` still writes its `payments` row
alongside the ledger row, because `finance_service.statement()` builds its wallet lines from
`discount_meta` and CR-4a's scope is explicitly *no change to any read surface*. The two cannot
drift: the `payments` row is derived from the transaction already posted, never computed a second
time, and they are linked in both directions. CR-4c moves `statement()` onto the ledger and the
second write goes away.

### The one behaviour that had to change

Removing the constraint necessarily changes `POST /api/admin/merchants/{id}/wallet`: a debit past
zero used to return 400 and now succeeds. What replaced the floor at zero is the credit limit,
enforced in `wallet_service.assert_within_credit_limit`. `verify_m4.py`'s two assertions of the old
rule were rewritten to assert the new one — the CR-1 lesson, applied deliberately rather than
discovered afterwards.

`finance_service.assert_wallet_covers` is **left in force**: the catalog-led track's
`POST /api/requests/{id}/pay` is a merchant settling an invoice from funds on account, and letting
that overdraw would turn "pay from wallet" into a second, ungated credit facility.

### Two defects found by verification, both fixed

1. **The row lock did nothing.** `SELECT ... FOR UPDATE` took the lock, but SQLAlchemy's identity
   map returned the instance the session already held — with the balance it had loaded *before* the
   lock was granted. Eight concurrent movements each wrote a plausible ledger row and **only four
   reached the balance**. Fixed with `execution_options(populate_existing=True)`. This is the same
   race the pre-CR-4a `adjust_wallet` had; adding the lock without this would have looked like a fix
   and not been one.
2. **`created_at` is not the chain.** It defaults to `now()`, which PostgreSQL fixes at *transaction
   start*, so two concurrent movements can carry timestamps in the opposite order to the one in
   which they moved the balance — and a statement ordered that way renders a running balance that
   jumps backwards. The ledger is now ordered by `txn_id`, allocated at INSERT and therefore always
   after the lock; `created_at` is set explicitly post-lock and is used only for display and date
   filtering. The index changed to `(merchant_id, txn_id)` with a separate one for date filters.

Both were found by running the concurrency section, not by reading the code.

### A stale assertion found in passing

`verify_m4.py`'s "a debit past zero is refused" tried to overdraw by a fixed ₹999,999 — but the
script tops the seeded wallet up by ₹50,000 on every run, so once the balance passed ₹999,999 the
debit no longer crossed zero and the check was asserting a refusal that had nothing to do with the
rule it named. It had already stopped testing anything before CR-4a touched it. The replacement is
computed from the current balance and says the same thing on every run.

### Verification

`tests/verify_cr4a.py` — **51 checks**, serverless (CR-4a adds no endpoint, so driving it over HTTP
would only prove a route that does not exist is absent). Covers schema and constraints, backfill
fidelity and the balance chain, ledger arithmetic including crossing zero in both directions,
database refusal of malformed rows, booking-debit idempotency, the credit limit at its exact
boundary, eight simultaneous movements, and `ON DELETE RESTRICT` protecting a ledger from a
tidy-up. It builds and removes its own fixture merchant rather than writing permanent rows onto a
real ledger.

Full suite: **696 checks, 12/12 scripts, 0 failures.** The invariant
(`wallet_balance == SUM(credit) - SUM(debit)`, chain continuous, every legacy row linked) was
re-checked against all three real merchants *after* the whole suite had run.

### §3 Production Readiness Checklist — CR-4a

| Group | Result |
| --- | --- |
| **Security** | No new endpoint, so nothing new is reachable. No new response field, no secret or PII. No f-string SQL — the backfill is a single static statement, and every parameterised query in the new service uses bound parameters. N/A: uploads (none added), rate limits (auth untouched). |
| **RBAC** | No new permission code and no new endpoint. The one endpoint whose behaviour changed keeps its existing `P.PAYMENT_MANAGE` gate; `verify_m4.py` still asserts a merchant cannot reach it (403). |
| **Concurrency** | Every wallet write goes through one row-locked path. Eight-actor race tested for real — and it *failed first*, which is the point. No status changes at all in CR-4a, so `lifecycle.transition` is untouched. Sequence allocated after the lock. |
| **Performance** | Ledger reads are index-covered by `(merchant_id, txn_id)`; date filters by `(merchant_id, created_at)`. `totals()` is one grouped query, not one per tile. `ledger()` takes a hard `limit`. No N+1 — nothing renders yet. |
| **Accessibility** | **N/A — CR-4a renders nothing.** No frontend asset changed, so no `?v=` bump was required either. |
| **Documentation** | `docs/API_CONTRACT.md` **needs no change: CR-4a adds no endpoint.** The migration carries a *why* for each decision; the non-obvious ones (identity-map lock, txn_id ordering, backwards backfill) are commented at the point of the decision. This file and the roadmap updated. Schema docs are milestone-mapping documents and are reconciled in M10. |
| **Regression** | 12/12 scripts, 696 checks. `verify_m4.py`'s two stale assertions rewritten to the new contract and called out above rather than quietly changed. |

---

## 6b. CR-4b — what was delivered (2026-08-01)

Scope as approved: auto-debit at Ticket Issued, credit-limit enforcement, wallet transactions for
issued bookings, refund and credit-note support, verification, regression.

### The blocker found before any code was written

**Enquiry-led bookings carry no fare, and no live path ever sets one.** `enquiry_service` creates
them with `total_amount = 0` and its comment says the fare "is set on the booking the Admin
approves" — but **CR-2 closed `approve_request` to this track** and **CR-3's merchant approval
takes no amount by design**. The enquiry answer captures no price either. Confirmed against the
live database: **every** enquiry-led booking on the current track is at ₹0 — 178 pending approval,
98 draft, and **88 Manager-Approved bookings sitting on the Booking Ops desk waiting to be
ticketed, all worth nothing**. (The 26 ticketed ones carrying amounts are pre-CR-2 bookings that
went down the old payment path.)

An auto-debit built on `total_amount` would therefore have posted **₹0 on every booking** — the
feature would have looked delivered and billed nobody. That is the same shape as M4's "an endpoint
with no caller is not a feature", one layer down.

**What was done about it:** the fare is captured at ticket issuance, by the desk that just bought
the ticket and is the first actor who knows the number — which is also where the business put it
(*"Admin books ticket externally → uploads ticket documents → the amount is deducted"*).
`POST /api/admin/requests/{id}/issue-ticket` takes an optional `fare_amount`, **required only when
a wallet-billed booking still has no amount**, refused at ≤ 0, and validated *before* the
transition so a rejected attempt burns no ticket or invoice number. A booking that already carries
an amount ignores the field entirely, so the standard track is byte-for-byte unchanged.

### What was built

- **Auto-debit at Ticket Issued** — `finance_service.bill_booking_to_wallet`, called from
  `ticket_service.issue_ticket` in the same transaction as the lifecycle move. Posts a
  `booking_debit` through `wallet_service.post` and writes the settlement `payments` row so the
  booking reads as settled: without it the debt would appear **twice**, once as the booking's
  `balance_due` and once as the negative wallet.
- **Idempotent** — guarded by `uq_wallet_transactions_booking_debit` (CR-4a) plus a lookup that
  returns the original entry rather than surfacing an IntegrityError to a desk that did nothing
  wrong.
- **Scoped by `is_classic_track`**, which carries the backward-compatibility guarantee for free: a
  catalog-led booking is never wallet-billed (it would pay twice), and a booking that ever entered
  a payment status stays on the standard track permanently, so historical enquiry-led bookings are
  never re-billed under rules that did not exist when they were made.
- **Credit limit, hard block** — `finance_service.assert_credit_available`, at **submission**
  (`ticket_service.submit_request`) and again at **approval** (`manager_service.approve`), because
  a balance can move between the two and a gate only at submit is one a re-price walks through.
  Where the fare is not yet known the check is "is there any headroom at all", which is the only
  honest question available. **Never** applied at ticket issuance: refusing to record a ticket the
  platform has already paid for would lose the debt, not prevent it.
- **Refunds** — `finance_service.refund_booking_to_wallet`, called from `change_request_service`
  after `settle_refund`. Settling only the booking's payments leaves the merchant down the full
  fare on a booking it no longer has; the money goes back where it came from. The retained
  cancellation charge stays debited, which is the correct net position.
- **Credit notes and typed adjustments** — the existing admin wallet endpoint takes an optional
  `txn_type`, so a credit note is recorded as a credit note rather than filed as an adjustment.
  `booking_debit` is deliberately **not** accepted there: that type is written only by ticket
  issuance, and posting it by hand would route around the one-debit-per-booking index.

### The refusal message did not say what it was asked to say

Found on the completion pass against the approved scope, not by a failing test — which is the
point worth recording.

Scope item 2 listed **five** figures a credit block must show: wallet balance, outstanding, credit
limit, remaining available credit, and the amount required. The two gates each raised their own
text and between them named **three of five at one gate and two of five at the other**, so the same
hard block read differently depending on which gate caught the merchant, and neither was complete.

The test did not catch it because the assertion was
`"credit limit" in text and "wallet" in text` — a substring check loose enough that the incomplete
message passed it. **An assertion that a well-formed message would fail is the only kind worth
writing**; that one would have passed almost any string containing two common words.

Both gates now raise one shared `wallet_service.credit_refusal_message`. Each figure is asserted by
**name and by value**, because a correct label beside a wrong number is worse than no label. The
amount required is still omitted on the enquiry-led track at submission — the fare genuinely is not
known until the desk books it, and the honest gap is better than a guess. Two related fixes fell
out of writing it: `outstanding` and `available credit` are floored at zero (a merchant in credit
does not owe a negative amount), and the message says "this transaction" rather than "this booking"
when the same guard refuses a manual admin debit, which is not a booking.

Recorded in `docs/WALLET_ARCHITECTURE.md` §5a so later gates inherit the one-text rule.

### `issue_ticket` was never row-locked, and CR-4b made that expensive

The approved scope asked for one verification this suite did not contain: *"verify concurrent
requests cannot create duplicate debits."* `verify_cr4b.py` had **no concurrency section at all** —
"billing happens once" issued the same booking twice **sequentially**, which the lifecycle refuses
on status alone and which therefore never reaches the race.

Six simultaneous issues of one booking gave:

```
[500, 200, 500, 200, 500, 400]
```

**Two desks were told they had issued the same ticket, and three got a raw 500.** The 500s were
`uq_wallet_transactions_booking_debit` raising `IntegrityError` with nothing to catch it.

What did *not* go wrong is the part worth keeping: **exactly one `booking_debit` was written and
the wallet moved exactly once, in every run.** The money was safe because the guarantee is a unique
index in the database rather than a check in the application — CR-4a's design doing its job under
precisely the conditions it was built for.

The cause is older than CR-4b. `issue_ticket` read the booking with an unlocked
`get_request()`, so every step after it — the status check, the ticket and invoice number
allocation, and now the debit — was a check-then-act on a status six requests can all read as
`approved`. `reprice` in the same file and `manager_service` both already lock for exactly this
reason; issuance simply never did. CR-4b is what made it matter, by putting money on the path.

Fixed by locking the booking row (`SELECT … FOR UPDATE`, with `populate_existing=True` per
`WALLET_ARCHITECTURE.md` §6 — without it the lock returns the stale instance and the status
re-check reads the pre-lock value, defeating the entire point). Losers now block, re-read the
committed status and get an ordinary "already issued" refusal. Verified over three consecutive
runs, with **zero unhandled exceptions in the server log**.

Two things follow that are worth stating rather than leaving implied. The double-200 also meant two
callers could each allocate a **ticket and invoice number** for one booking — the lock closes that
too. And the lock order is **ServiceRequest → Merchant**, matching `change_request_service`, which
is what keeps the two money paths from deadlocking against each other.

### On the recommendation about references

Already the design, from CR-4a: every transaction carries `txn_number` (`WTX-20260801-000042`) from
`seq_wallet_txn_number`, and top-ups carry `PAY-…`. CR-4b makes sure it is *used* rather than merely
stored — the activity log, the merchant notification, the cancellation's stored pricing and the
wallet endpoint's response all quote the reference and never an internal id. The rule is now written
down as **`docs/WALLET_ARCHITECTURE.md` §2.5** so later gates inherit it.

### The one UI change, and why it is not scope creep

CR-4b was to touch no UI. But requiring the fare makes the Booking Ops desk **unable to issue a
Classic ticket at all** without a field to type it into — the milestone would have shipped an
inoperable workflow, which is the exact failure CR-2's completion pass was pulled up for. So one
number input was added to the existing Mark Ticket Issued action in `admin-booking-ops.js`, shown
only when the server would require it. No new screen, no new endpoint, `?v=` bumped on both changed
assets. Everything else stays with CR-4c/CR-4d.

### Tests that asserted the old contract

Two, both rewritten and both called out rather than quietly changed:

- `tests/flows.py::make_booking` gained a `fare` parameter. Before CR-4b this builder produced a
  *ticketed booking worth ₹0* — every suite asserting against it was asserting against a booking
  with no money in it.
- `tests/verify_cr2.py`'s "with the tickets attached, Ticket Issued -> 200" issued without a fare.

### Verification

`tests/verify_cr4b.py` — **60 checks**, end to end through the real endpoints: the debit and its
amount, direction, reference, chain and link; one debt not two; billing exactly once; a catalog-led
booking never billed; a fare-less booking refused without burning a ticket number; the credit block
at submit and at approve, recovery by paying, and a ticket already bought billed past the limit;
the cancellation refund and its retained charge; credit notes; cross-tenant. CR-4a's four
invariants are re-asserted after **every** scenario.

Full suite: **773 checks, 13/13 scripts, 0 failures** (`verify_cr4b.py` 60 → **77** across the
completion pass). Every other script's count is **identical to the pre-CR-4b baseline** — cr4a 52,
m4 126, cr2 118, m3 128 — which is the evidence that the issuance lock changed no existing
behaviour rather than an assumption that it didn't. Ledger re-checked afterwards across all
merchants: cached balance equals ledger, chain unbroken, **zero bookings billed more than once**.

**Browser-verified** on the Admin Booking Ops desk at 1280 / 768 / 375, console clean: the field
appears only on a ₹0 Classic booking and not on a priced standard one; an empty fare is refused
client-side with focus returned and **no request sent**; and a real end-to-end issue of
**₹13,750.50** moved the wallet by exactly that — paise intact — with the statement and the
position agreeing.

### §3 Production Readiness Checklist — CR-4b

| Group | Result |
| --- | --- |
| **Security** | One changed endpoint, already authenticated and unchanged in its gating. `fare_amount` is a Pydantic `Decimal` with `gt=0`. No new response field carries a secret; the wallet endpoint now returns a *reference*, deliberately not an id. Cross-tenant asserted: a merchant can neither post to another's wallet nor issue any ticket. No f-string SQL. |
| **RBAC** | No new permission code. Issuance stays `P.TICKET_ISSUE`, the wallet stays `P.PAYMENT_MANAGE`. The UI offers nothing the server refuses — the fare field renders under exactly the condition the server enforces. |
| **Concurrency** | Every wallet write still goes through CR-4a's single row-locked path; CR-4b adds no second one. Double-billing is prevented by a unique index, not by a check-then-act. **Issuance is now serialised too** — six simultaneous issues gave two 200s and three 500s before the fix, and one 200 with 400s after it, over three consecutive runs with zero unhandled exceptions. The row said the right thing throughout; only the responses were wrong. Lock order ServiceRequest → Merchant. Status changes remain `lifecycle.transition` only. |
| **Performance** | No new list query. The debit adds one indexed lookup and two inserts inside a transaction that was already open. |
| **Accessibility** | The one new control has a `for`/`id` label, `aria-describedby` help text, a `:focus-visible` ring, and focus returns to it on a validation error. Error text is not colour-only. No horizontal overflow at 1280 / 768 / 375 — measured with a real viewport resize. |
| **Documentation** | `docs/API_CONTRACT.md` updated for the one changed endpoint and the wallet payload. `docs/WALLET_ARCHITECTURE.md` is the authoritative reference and is linked from the roadmap's conventions. Non-obvious decisions commented at the point of the decision. |
| **Regression** | 13/13 scripts, 756 checks. `?v=` bumped on both changed assets. Two tests that asserted the pre-CR-4b contract rewritten and named above. |

**N/A with reason:** *Uploads* — CR-4b adds no upload path. *Migrations* — CR-4b adds none; the
schema it needs was delivered and locked in CR-4a.

**On CR-4a's "do not modify `wallet_service.py`" instruction:** it was invoked **once**, for the
credit-refusal message, which did not meet CR-4b's own approved scope — a defect, which is the
stated exception. `credit_refusal_message` and `outstanding` were added; **the ledger schema,
`post()`, `lock()` and the arithmetic were not touched, and migration 0036 was not reopened.**

---

## 6c. CR-4c — what was delivered (2026-08-01)

Scope as approved: the merchant Wallet screen, balance and transaction history, the Add Money flow,
display of the admin payment accounts, UTR and screenshot upload, verification, regression.

### What was there already, and what was not

CR-4a created `wallet_topups` and `payment_accounts` — fully designed, indexed and constrained —
and then **nothing in the backend referenced either table**. No service, no router, no schema; the
only mentions in the entire codebase were the model classes. This gate is what gave them a caller.

### What was built

- **`routers/wallet.py`** — seven routes, all implicitly scoped to the caller's own merchant.
  There is no `merchant_id` in any path, so there is no id to tamper with; the two that take an id
  (a top-up, its proof) re-check ownership and 404.
- **`services/topup_service.py`** — a **new file, not an extension of `wallet_service`**, because
  that module is frozen by CR-4a's and CR-4b's approvals and nothing here is a bug in it. It calls
  `wallet_service` and never re-implements any of it.
- **`document_service.store_upload()`** — extracted so the content-type allowlist, the magic-byte
  sniff, the streaming size cap and the "a rejected upload never reaches storage" rule exist in
  **one** place. A payment screenshot is a file a stranger uploads; it gets what a passport scan
  gets. Copying those sixty lines would have meant two copies of the security checks, and the copy
  that gets forgotten in the next change is the one with the hole in it. `upload()` now calls it and
  behaves identically — `verify_api.py` (92 checks) and `verify_storage.py` (32) are what prove that.
- **`frontend/merchant-classic/js/classic-wallet.js`** — balance, outstanding, credit headroom,
  lifetime totals, a paginated ledger with the **server's** running balance, the top-up list with
  status and proof download, and the Add Money modal showing each payment account's details and QR.

### The rule the whole gate rests on

**Submitting a top-up credits nothing.** `topup_service` contains no call to `wallet_service.post`,
and that absence is the feature: if submission moved the wallet, a merchant could raise its own
spending power by typing a number into a form, and the credit limit — the platform's only bound on
its exposure — would mean nothing. `pending_topups` is therefore reported *beside* the balance and
never inside it. Asserted against the cached balance, the ledger **and** the transaction count.

### The defect verification found

**A repeated UTR returned a 500.** `uq_wallet_topups_utr` is a platform-wide partial unique index
(excluding rejected claims) created by CR-4a with a clear rationale: a bank reference identifies one
real transfer, so two live claims on it are two claims on one payment. The index did its job — and
the `IntegrityError` reached the merchant as an unhandled 500. **This is CR-4b's lesson repeating
one gate later**, which is exactly why it is now written down as `WALLET_ARCHITECTURE.md` §2.6: the
database owns correctness, the application still owes the caller an answer.

Fixed with both guards — a pre-check for the ordinary duplicate (a double-click, or re-entering a
transfer already reported), placed *before* the file is stored so no orphaned upload is left behind,
and a caught `IntegrityError` for the race the pre-check cannot close. The refusal names the
reference and what to do about it, and deliberately **never says who holds the existing claim**:
the index spans every merchant, and confirming a clash would let anyone probe for other companies'
bank references.

### Two more found by driving the screen

1. **The success confirmation erased itself.** The submission wrote its "we have recorded this"
   message into the same element `clLoadWalletSummary` uses for the credit-limit banner — and that
   function clears it on every load when nothing is wrong. The reload that follows a successful
   submission therefore wiped the confirmation the merchant had just earned. Split into two slots.
2. **A lakh did not fit in half a phone.** `.cl-kpis` drops to two fixed columns under 640px,
   leaving ~123px inside each tile, while a figure like ₹60,43,002.00 needs ~189px at the tile type.
   It overflowed and pushed the whole page 31px wider than the viewport. Fixed by giving the
   wallet's tiles the full width below 640px — **scoped to `#cl-wallet`**, because `.cl-kpis` is
   shared with the M4 Payments screen, which has the same latent problem (measured worse, at 429px)
   and is locked. Reported rather than quietly altered; see "Known and not fixed" below.

### The extraction broke document upload, and the suite caught it

Pulling `store_upload` out of `document_service.upload` left one reference behind: the activity-log
entry still read the local `size`, which now lives inside the extracted function. **Every booking
document upload returned 500** — `NameError` is a runtime fault, so it compiled cleanly and the new
top-up path (which does not log that field) worked perfectly throughout.

Caught by `verify_cr2.py`'s "staff attach ticket 1 of 3 -> 201", which is exactly the argument for
running the whole suite after a refactor rather than only the tests for the thing being built. The
extraction was still the right call — two copies of the magic-byte check is the worse outcome — but
"behaviour-preserving" is a claim to be tested, not asserted. Fixed to read `document.size_bytes`;
re-verified end to end, including the stored size, checksum, path and the download.

### A latent bug in the test harness

`minihttp.request` built a body only when `files` or `json` was passed. A call with `data=` alone
sent **no body at all**, so every form field came back "Field required" — a harness fault that
reads exactly like an endpoint fault, and it cost a debugging round trip on the first form-only
endpoint the suite has ever had. Fixed to send `application/x-www-form-urlencoded`. Nothing relied
on the old behaviour: every pre-existing `data=` caller passes `files=` alongside it.

Also: `verify_cr4c.py` namespaces its UTRs per run (`uuid`). A fixed literal would have passed once
and failed on every run afterwards — the same shape as the `verify_m4.py` magic-number defect CR-4a
found. Confirmed by running the script twice: 88/88 both times.

### Known and not fixed, deliberately

- **No payment accounts exist in the database.** `payment_accounts` is empty and its CRUD is
  **CR-4d**. The merchant screen handles this honestly — it says no details have been published and
  invites the merchant to ask, rather than rendering an empty box — and a top-up can still be
  recorded without one (`payment_account_id` is nullable). Two clearly-labelled `(DEMO)` accounts
  were created in the development database so the flow could be driven end to end; **production
  needs CR-4d before this screen is useful.**
- **The `adjust_wallet` dual-write stays.** CR-4a's plan said CR-4c would move `statement()` onto
  the ledger and delete it. That is the *Payments* screen — locked M4 surface — and rewriting its
  data source is a change to approved functionality needing its own approval. It was not in this
  gate's scope and nothing here required it. `WALLET_ARCHITECTURE.md` §9 records the correction.
- **The portal-wide 375px overflow.** Pre-existing and not introduced here; the wallet screen is now
  clean at 375, Payments is not.

### Verification

`tests/verify_cr4c.py` — **88 checks**, end to end through the real endpoints: the summary against
SQL, money as decimal strings, pagination that does not repeat a page, active-vs-retired payment
accounts, the submission that moves nothing, every form rule, the duplicate UTR, the upload
allowlist / magic bytes / empty file / 10 MB cap, the proof served as an attachment, the merchant's
own list, six simultaneous submissions, and cross-tenant. CR-4a's invariants are re-asserted after
every scenario.

### §3 Production Readiness Checklist — CR-4c

| Group | Result |
| --- | --- |
| **Security** | Uploads: allowlist + magic-byte sniff + 10 MB cap enforced **while streaming** (not from a client-supplied Content-Length), rejected uploads never reach storage, served as `attachment` with `no-store`, stored paths never exposed in any response. QR images stream from an authenticated route, never a public URL. No f-string SQL. Cross-tenant asserted on the proof, the list and the summary; a staff account gets a 400, not someone else's wallet. The duplicate-UTR refusal deliberately leaks nothing about who holds the claim. |
| **RBAC** | **No new permission codes**, as CR-4 §5.6 planned: `payment.view` reads, `payment.pay` submits. That split already exists for paying a booking and is the right one — Supervisor and Operator can read the wallet but not commit the company to a payment claim. |
| **Concurrency** | Six simultaneous submissions: all succeed, each with a unique `PAY-` reference from the sequence, **none moves the wallet**. The duplicate UTR is guarded by a unique index *and* a caught `IntegrityError`, per §2.6 — not by a check-then-act alone. No new wallet write path; `wallet_service.post` remains the only one. |
| **Performance** | The ledger page resolves its booking numbers in **one** query for the whole page, not one per row. `totals()` and `pending_summary()` are each a single grouped query. Every list takes a hard `page_size` cap (≤100). |
| **Accessibility** | Every input has a `for`/`id` label; the amount and UTR carry `aria-describedby` help text; validation returns focus to the offending field and the error is text, not colour. Tables scroll inside `overflow-x:auto` wrappers. No horizontal page overflow at 1280 / 768 / 375 — measured with real viewport resizes. |
| **Documentation** | `API_CONTRACT.md` gains the seven routes and the rules that matter; `WALLET_ARCHITECTURE.md` gains §8 (claim-then-credit) and a corrected §9; this file and the roadmap updated. |
| **Regression** | `?v=` bumped on every changed asset (`classic.css`, `classic-shell.js`, `merchant-api.js`, and the new `classic-wallet.js`). Full suite green. |

**N/A with reason:** *Migrations* — CR-4c adds none; CR-4a's schema was sufficient and was not
reopened. *Wallet arithmetic* — untouched; this gate reads the ledger and writes claims.

---

## 7. Verification requirements

`tests/verify_cr4.py`, plus the full suite green at every gate:

- Ledger arithmetic against hand-computed fixtures: `wallet_balance == SUM(credit) − SUM(debit)`
  after recharge, debit, refund, adjustment and credit note.
- The worked example end to end: wallet 0 → book ₹15,000 → −₹15,000 → recharge ₹20,000 → +₹5,000.
- Idempotency: a replayed transition bills exactly once.
- Credit limit: refused at −(limit + ₹1) server-side, at submit **and** at approve; a merchant
  already over its limit can still have a booking *reduced* (the M4 defect fixed in CR-2 — the
  regression goes in this script so it cannot come back).
- Concurrency: two simultaneous debits on one merchant, and two simultaneous verifications of one
  recharge. Exactly one winner, never a 500, balance correct.
- Cross-tenant: merchant A gets **404** on B's wallet, ledger, top-up and proof file.
- No float anywhere in the path; money crosses the wire as a decimal string.
- Uploads: size-capped, magic-byte checked, served as attachments, never statically mounted.
- Browser sweep at 1280 / 768 / 375, console clean.

## 8. Decisions taken by the business — 2026-08-01

Recorded here because §0 requires the scope to be written down, not assumed. All three were
answered directly; none was inferred.

**1. The debit fires at `ticket_issued`.** The moment the Admin uploads the issued ticket documents
and the booking reaches Ticket Issued, in one transaction: write the `booking_debit` wallet
transaction, move the balance (negative if the funds are not there), record it in the ledger. The
merchant settles later by adding money. **Explicitly not** at Manager/merchant approval, and
**explicitly not** at Completed.

**2. The wallet is the only settlement mechanism for new enquiry-led bookings.** Per-booking
payment is retired for enquiry-led bookings created from CR-4 onwards. Wallet balance is the single
source of truth for what a merchant owes.

*Scope boundary, stated because the instruction was "new enquiry-led bookings only":*

- Bookings **already in flight or historical finish on the path they were created on.** Nothing is
  retro-billed and no in-flight booking becomes unmovable — the same principle as CR-2's
  `is_classic_track`, which keeps a booking that has entered a payment status on the standard track
  permanently.
- The **catalog-led (standard) track keeps `POST /api/requests/{id}/pay`** and its
  Payment Pending → Paid statuses. It was not part of this instruction, so it is not being altered.
  Retiring it is one decision away if the business wants it; it is not assumed here.

**3. The credit limit is a hard block.** A booking that would take the merchant's outstanding
balance past its configured limit is **refused server-side**. The refusal names the remaining
available credit and the amount required, and offers the two real routes forward: add money to the
wallet, or ask an administrator to raise the limit. There is no per-booking override. Raising the
limit is a deliberate, audited admin act.

`credit_limit = 0` still means *no limit configured* (§5.4) — reading it literally would block every
merchant on the platform on day one.
