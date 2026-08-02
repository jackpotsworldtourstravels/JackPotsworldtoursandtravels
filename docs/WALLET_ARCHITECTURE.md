# Wallet architecture

**Status: AUTHORITATIVE for money movement. THE MODULE IS FROZEN.** Established by CR-4a and
extended by CR-4b, CR-4c and CR-4d — all four approved and locked 2026-08-01. **Nothing described
in this document may change except to fix a bug the business has verified and reported.** The six
rules in §2 and the invariants in §7 are the properties a bug fix must not erode. Every milestone that moves, displays or reports a merchant's
balance follows this document. If a plan, a screen or another document disagrees with this file,
this file wins.

Companion documents: `docs/BOOKING_OPS_MILESTONES.md` (the roadmap and the delivery rule),
`docs/CR-4_MERCHANT_WALLET.md` (the change request and its four gates), `docs/API_CONTRACT.md`
(endpoints).

---

## 1. The model in one paragraph

A merchant holds a **running account**, not a prepaid balance. Bookings debit it, top-ups credit
it, and it is allowed to go **negative** — a negative wallet *is* the merchant's outstanding
balance. What bounds the exposure is `merchants.credit_limit`, a per-merchant business limit an
admin sets, not a floor at zero identical for everyone. The balance is
`SUM(credit) - SUM(debit)` over `wallet_transactions`, and nothing else.

## 2. The six rules

Break one of these and the feature is not production-ready, however well it works.

1. **`wallet_service.post()` is the only way the wallet moves.** It is the only code in the
   repository permitted to assign `merchants.wallet_balance`. This is the wallet's equivalent of
   `lifecycle.transition` owning `service_requests.status`.
2. **No balance change without a ledger row.** `post()` writes both or neither, in one
   transaction. A wallet that moves without an entry is a balance nobody can reconcile.
3. **Take the lock before reading the balance.** `wallet_service.lock()` — `SELECT … FOR UPDATE`
   **with `populate_existing=True`** (see §6). Every read-modify-write on a balance goes through
   it.
4. **`Decimal` from the column to the response.** No `float()` in the money path, server or
   client. Money crosses the wire as a decimal **string**; the browser formats it with
   `moneyStr()` from `shared/formatters.js` and never parses it.
5. **Quote `txn_number`, never `txn_id`.** Every transaction carries a unique human reference —
   `WTX-20260801-000042` — issued from `seq_wallet_txn_number`. That is what appears in the UI, in
   reports, in activity and audit entries, in notifications and in support conversations. Internal
   ids are never shown to a user and never quoted in a message. Same rule as `request_number`,
   `topup_number` (`PAY-…`) and the ENQ-/SRQ-/TKT-/INV- series.
6. **Two guards, not one — the concurrency guarantee (CR-4b).** Every money path is protected at
   *both* layers, and neither substitutes for the other:
   - **The database owns correctness.** A uniqueness rule that must hold is a constraint or a
     unique index (`uq_wallet_transactions_booking_debit`), never a check-then-act in Python. This
     is what keeps the money right when the application races itself.
   - **The lock owns the response.** The endpoint takes `SELECT … FOR UPDATE` on its subject row
     before it reads anything it is about to change, so simultaneous callers serialise and the
     losers get an ordinary refusal instead of a raw `IntegrityError`.

   Measured, not assumed: with the index but no lock, six simultaneous issues of one booking wrote
   exactly one debit and moved the wallet exactly once — **and returned two 200s and three 500s**.
   The money was never wrong; the responses were. **Lock order is `ServiceRequest` → `Merchant`,
   always.** Any new money endpoint states its concurrency test in its verification script; a
   sequential "do it twice" does not reach the race.

## 3. The tables

### `wallet_transactions` — the ledger, append-only

| Column | Notes |
| --- | --- |
| `txn_id` | PK. **The chain order** — see §6. Never displayed. |
| `txn_number` | `WTX-YYYYMMDD-NNNNNN`, unique. The reference everything quotes. |
| `merchant_id` | `ON DELETE RESTRICT` — a ledger must outlive a tidy-up. |
| `txn_type` | See §4. Direction is *not* implied by it. |
| `debit`, `credit` | Exactly one is non-zero, enforced by `ck_wallet_transactions_one_direction`. |
| `balance_before`, `balance_after` | Stored, not derived, so a line is readable on its own. `ck_wallet_transactions_balance_math` checks the arithmetic on every insert. |
| `request_id`, `payment_id`, `topup_id` | What caused it. All nullable, all `SET NULL`. |
| `reason`, `created_by`, `created_at` | Who and why. `created_at` is set post-lock (§6). |

**There is no update path and no `updated_at`.** A wrong entry is corrected by posting the
opposite entry, the way ledgers have always worked. Editing history makes every balance before the
edit unexplainable.

**`uq_wallet_transactions_booking_debit`** — a partial unique index on `request_id` for
`booking_debit` rows. One booking can be billed once, and that is guaranteed by the schema rather
than by a service's good intentions.

### `wallet_topups` — what the merchant says it sent

A merchant's claim (amount, method, UTR, proof file, which platform account it went to), awaiting
verification. Credit reaches the wallet **only** when a staff member verifies it, at which point
exactly one `wallet_recharge` transaction is posted and linked back through `topup_id`.
`uq_wallet_topups_utr` stops one bank reference being claimed twice.

### `payment_accounts` — where a merchant sends money

Bank / UPI / QR accounts configured by staff and shown read-only to merchants. `qr_image_path` is
a storage key, never a URL — served through an authenticated endpoint, never statically mounted.

## 4. Transaction types

| `txn_type` | Normally | Raised by |
| --- | --- | --- |
| `booking_debit` | debit | a booking reaching Ticket Issued |
| `wallet_recharge` | credit | a verified `wallet_topups` row |
| `refund_credit` | credit | a cancellation or downward re-price settling |
| `cancellation_charge` | debit | the charge retained on a cancellation |
| `credit_note` | credit | a commercial or goodwill credit that is not a refund |
| `manual_adjustment` | either | staff correcting a balance, always with a reason |

**Direction lives in the row, not the type.** A cancellation produces a credit *and* a debit;
reading direction off `txn_type` is how a ledger ends up with two answers.

## 5. Which bookings are wallet-billed

`lifecycle.is_classic_track(request)` is the predicate, and it already carries the backward
compatibility guarantee:

- **Enquiry-led (Classic Tours) bookings** are wallet-billed. They have no payment stage — CR-2
  removed it — so the wallet is their only settlement path.
- **Catalog-led (standard) bookings** keep `POST /api/requests/{id}/pay` and the
  Payment Pending → Paid statuses. They are **not** wallet-billed; billing them would charge them
  twice.
- **A booking that has ever entered a payment status stays on the standard track permanently**,
  which is what stops historical enquiry-led bookings — raised before CR-2 — from being re-billed
  under rules that did not exist when they were made.

`finance_service.assert_wallet_covers` still guards the catalog track's wallet *payments*: that is
a merchant spending funds on account, not the platform extending credit, and letting it overdraw
would make "pay from wallet" a second ungated credit facility.

## 5a. The credit limit, and the one text that refuses

Two gates, both hard blocks with no per-booking override: **submission**
(`ticket_service.submit_request`) and **approval** (`manager_service.approve`). Both call
`finance_service.assert_credit_available`. Never at **issuance** — a ticket the platform has already
bought must be recorded, and refusing the accounting entry would lose the debt rather than prevent
it, so `bill_booking_to_wallet` passes `enforce_limit=False`.

**Every refusal comes from `wallet_service.credit_refusal_message`, and there is only one of it.**
The two gates originally raised their own text and each named a *different* subset of the figures,
so the same block read differently depending on which gate happened to catch it — and neither
carried everything the business asked for. Because the block has no override, this message is the
merchant's entire remedy: if it does not say how bad the position is and what fixes it, the next
action is a phone call. So it names

**wallet balance · outstanding · credit limit · available credit** — and, where the amount is
known, **the amount required and the shortfall**.

On the enquiry-led track at submission the fare is genuinely unknown until the desk books it, so
that last pair is **left out rather than guessed**. `outstanding` and `available credit` are both
floored at zero: a merchant in credit owes nothing, and one past its limit has no credit available
rather than a negative amount of it.

`credit_limit = 0` continues to mean **no limit configured**, not a limit of zero — every merchant
carries the column default, so reading it literally would block the whole platform on day one.

## 6. Four traps, every one found by measurement

None of these was found by reading the code. Each was found by running a concurrency test that
failed, which is the argument for writing them.

**`SELECT … FOR UPDATE` is a no-op without `populate_existing=True`.** The statement takes the row
lock, but SQLAlchemy's identity map returns the instance the session already loaded — with the
balance it held *before* the lock was granted. The lock is then held over a stale read, and it
fails silently: eight concurrent movements each wrote a plausible ledger row and only four reached
the balance. **This applies to every row-locked read-modify-write in this codebase, not only the
wallet.**

**A ledger is ordered by `txn_id`, never by `created_at`.** PostgreSQL's `now()` — the column
default — is fixed at *transaction start*, so two concurrent writes can carry timestamps in the
opposite order to the one in which they took the lock and moved the balance. A statement ordered
that way renders a running balance that appears to jump backwards. `txn_id` is allocated at INSERT,
always after the lock, so it is the only key that matches the chain. `created_at` is set explicitly
post-lock and is used for **display and date filtering only**.

**A unique index protects the money; it does not protect the response.** Six simultaneous issues of
one booking wrote exactly one `booking_debit` and moved the wallet exactly once — the index held —
but three callers got a raw 500 from the `IntegrityError` and two were told they had succeeded. The
database guarantee is the one that matters and it must stay, *and* the path that writes money must
still be serialised so the losers get an ordinary refusal instead of a stack trace. **Any endpoint
that moves the wallet locks its subject row first** (CR-4b, `ticket_service.issue_ticket`).

**Lock order is `ServiceRequest` → `Merchant`, always.** `issue_ticket` and
`change_request_service` both take the booking first and the merchant second, inside
`wallet_service.post`. Reversing that order anywhere is a deadlock between the two money paths.

## 7. What still has to be true, every time

The verification script for any milestone touching money asserts all four:

1. `merchants.wallet_balance == SUM(credit) - SUM(debit)` for every merchant.
2. The chain is continuous: each row's `balance_before` equals the previous row's `balance_after`,
   per merchant, ordered by `txn_id`.
3. Every legacy wallet `payments` row still has its ledger row.
4. The above still hold **after** a concurrency scenario, not merely before one.

`tests/verify_cr4a.py` implements them; later scripts reuse it rather than rewriting it.

## 8. Adding money: a claim, then a credit (CR-4c — approved and frozen 2026-08-01)

**Submitting a top-up moves no money.** A merchant filling in an amount, a UTR and a screenshot is
making a *claim*; the wallet is credited only when an admin verifies it (CR-4d), at which point
exactly one `wallet_transactions` row is written and linked back through `topup_id`.

`services/topup_service.py` therefore contains **no call to `wallet_service.post`**, and that
absence is the feature — `verify_cr4c.py` asserts a submission leaves the cached balance, the
ledger and the transaction count all byte-identical. If submission credited the wallet, a merchant
could raise its own spending power by typing a number and the credit limit would bound nothing.

Consequences that every later surface must respect:

- **`pending_topups` is reported beside the balance and never inside it.** They are two numbers.
  Any screen that adds them together is claiming money the platform has not seen.
- **A UTR may be claimed once** (`uq_wallet_topups_utr`, platform-wide, excluding rejected claims).
  A bank reference identifies one real transfer, so two live claims on it are two claims on one
  payment. Per §2.6 this is guarded twice: a friendly pre-check for the ordinary duplicate, and a
  caught `IntegrityError` for the race — because the index alone would have answered **500**.
- **The refusal never says who holds the existing claim.** The index spans every merchant;
  confirming a clash would let anyone probe for other companies' bank references.
- **Proof files use `document_service.store_upload`**, extracted in CR-4c so the allowlist, the
  magic-byte sniff and the streaming size cap exist in exactly one place. A payment screenshot gets
  what a passport scan gets. They cannot live in `request_documents` — its `request_id` is NOT NULL
  and a top-up belongs to no booking.

## 8a. Crediting the claim, and the boundary that protects it (CR-4d — approved and frozen 2026-08-01)

`services/payment_admin_service.verify_topup` is **the only code that credits a
wallet from a top-up**, and it does it by calling `wallet_service.post` — no
second arithmetic, no second balance write. Rejection moves nothing and frees
the UTR (`uq_wallet_topups_utr` excludes rejected rows), so a mistyped reference
can be corrected rather than locking a merchant out of its own transfer.

**Both guards from §2.6 are present, and one of them is new:**
`uq_wallet_transactions_topup` (migration 0037) makes a second credit for one
claim impossible in the database; the row lock on the top-up plus a status
re-check makes the loser of a race receive a 409 instead of an `IntegrityError`.
Six simultaneous verifications were run: one 200, five 409s, one credit, no 500.
**Lock order is top-up → merchant**, the same subject-row-first rule as
`ServiceRequest → Merchant`.

### The permission boundary — `payment.verify`, never `payment.view`

**`payment.view` is held by every merchant role.** It is what lets a merchant
read *its own* wallet in `wallet.py`, where the safety comes from the fact that
**no route carries a merchant id**. Every staff route is platform-wide or takes
somebody else's merchant id, so it must be gated on `payment.verify` or
`payment.manage`, which only `_ADMIN` holds.

This was got wrong first: the CR-4d router shipped its reads on `payment.view`,
and `verify_cr4d.py` proved that any merchant could then read every other
merchant's balance, credit limit, outstanding position and complete ledger.
**Adding a staff endpoint to this module means asking which existing code the
caller must hold that a merchant does not.** The test asserts it from a real
merchant token, not by reading the decorator.

## 9. Transitional, and when it ends

`finance_service.adjust_wallet` writes **two** rows: the authoritative `wallet_transactions` entry
and a `payments` row, because `finance_service.statement()` still builds its wallet lines from
`discount_meta['wallet_direction']`. They cannot drift — the `payments` row is derived from the
transaction already posted, never computed a second time — and they are linked in both directions.

**This was planned for CR-4c and deliberately not done there.** CR-4c's approved scope is the
merchant's wallet screen and the Add Money flow; `statement()` is the *Payments* screen, which is
part of the locked M4 surface, and rewriting its data source is a change to approved functionality
that needs its own approval. The new wallet screen reads the ledger directly and does not touch
`statement()` at all, so nothing was gained by bundling it.

Until it is retired: **do not add a third reader of `discount_meta`.**
