# Payment module — end-to-end test checklist

**For the business's own acceptance testing.** The module is approved and frozen (2026-08-01);
this is how to satisfy yourself of that independently of the automated suite.

Everything below is already asserted by `verify_cr4a/b/c/d.py` (320 checks). That is exactly why
it is worth testing by hand: an automated check proves the code does what its author expected, and
you are here to find where the author expected the wrong thing.

## Accounts you need

| Role | Portal | Can |
| --- | --- | --- |
| Merchant Admin | `/merchant-classic/` | submit top-ups, book, see own wallet |
| Admin | `/admin/` | verify top-ups, manage payment accounts, issue tickets |
| A **second** merchant | `/merchant-classic/` | prove isolation — §10 is meaningless without one |

**Note the balance before you start.** Merchant portal → **Wallet**. Every expected result below is
relative to it.

---

## 1. Wallet top-up (merchant)

| # | Do | Expect |
| --- | --- | --- |
| 1.1 | Wallet → **Add Money** | Active Bank / UPI / QR accounts listed. **If empty, do §2 first** — a merchant cannot pay into nothing |
| 1.2 | Open a QR account | Image renders (served authenticated, not a public URL) |
| 1.3 | Submit ₹10,000, bank transfer, UTR `TEST-A-001`, attach a JPEG/PNG screenshot | `PAY-…` reference returned, status **Awaiting verification** |
| 1.4 | **Re-read the wallet balance** | ⚠️ **UNCHANGED.** The single most important check on this page — a claim is not a credit |
| 1.5 | Check the pending figure | Rises by ₹10,000, shown **beside** the balance, never added into it |
| 1.6 | Submit again with the same UTR `TEST-A-001` | **Refused.** Message must **not** reveal who holds it |
| 1.7 | Submit with a `.txt` or `.exe` as proof | Refused (415) |
| 1.8 | Rename a `.txt` to `.jpg` and submit | Refused (400) — content is sniffed, not trusted |
| 1.9 | Submit a file over 10 MB | Refused (413) |
| 1.10 | Submit amount `0` or negative | Refused |

## 2. Payment accounts (admin)

| # | Do | Expect |
| --- | --- | --- |
| 2.1 | Wallet & Top-ups → Payment Accounts → **Add account** | Bank / UPI / QR selectable |
| 2.2 | Create a **bank** account with no account number | Refused, naming what is missing |
| 2.3 | Create a valid bank account | Created, **Active**; appears on the merchant's Add Money screen |
| 2.4 | Create a **QR** account and tick Active without an image | Refused — an active account nobody can pay into is worse than none |
| 2.5 | Upload a PDF as the QR image | Refused — it renders in an `<img>` |
| 2.6 | Upload a real PNG, then activate | Succeeds; merchant sees it |
| 2.7 | Edit a live bank account and clear its account number | Refused — checked against the **resulting** state |
| 2.8 | **Retire** an account | Disappears from the merchant's screen; **still visible to staff**; past top-ups keep its name |

## 3. Admin verification & wallet credit

| # | Do | Expect |
| --- | --- | --- |
| 3.1 | Wallet & Top-ups → the pending claim → **Review** | Amount, method, UTR, account paid into, and the balance **before** the decision |
| 3.2 | Download the proof | Downloads as an attachment; opens correctly |
| 3.3 | **Verify** | Success names a `WTX-…` reference and the balance either side |
| 3.4 | Merchant portal → Wallet | Balance **+₹10,000**; pending falls by ₹10,000 |
| 3.5 | Ledger | One `wallet_recharge` row, correct amount, running balance correct |
| 3.6 | Verify the **same** claim again | **409.** No second credit |
| 3.7 | Two admins verify one claim simultaneously | One succeeds, other gets 409. **Never two credits, never a 500** |
| 3.8 | Reject a different claim with **no** reason | Refused — remarks mandatory |
| 3.9 | Reject with a reason | Wallet **unchanged**; merchant told why |
| 3.10 | Resubmit the rejected UTR | **Allowed** — a rejected reference is free again |

## 4. Booking auto-debit

| # | Do | Expect |
| --- | --- | --- |
| 4.1 | Raise an enquiry → admin quotes → merchant submits → manager approves | No money moves at any of these steps |
| 4.2 | Admin: attach ticket documents, **Mark Ticket Issued** | Succeeds |
| 4.3 | Wallet | **Debited by the booking amount**; one `booking_debit` row |
| 4.4 | Booking's payment position | Reads **settled** — the debt is on the wallet, **not counted twice** |
| 4.5 | Merchant notification | Names the amount, the `WTX-…` reference and the new balance |
| 4.6 | Re-issue the same booking | Refused; **no second debit** |
| 4.7 | A **catalog-led** booking through pay → verify → issue | Wallet **not** touched — it has its own payment path |
| 4.8 | An enquiry-led booking with **no** amount | Issuance refused, asking for the fare, and **no ticket number is burned** |

## 5. Credit limit

| # | Do | Expect |
| --- | --- | --- |
| 5.1 | Admin → Merchant Management → set credit limit ₹50,000 | Saved |
| 5.2 | Drive the wallet to exactly −₹50,000 | Allowed — exactly at the limit is fine |
| 5.3 | Merchant submits another booking | **Refused server-side.** Message names balance, limit, credit available and the two ways out |
| 5.4 | Merchant adds money and it is verified | Same booking now submits |
| 5.5 | Push back to the limit **after** submitting, then approve | **Refused at approval too** — the gate is re-checked, not assumed |
| 5.6 | With the merchant over its limit, issue a ticket for a booking already approved | **Succeeds.** A ticket already bought must be recorded; refusing would lose the debt |
| 5.7 | Set credit limit to `0` | Means **no limit**, not a limit of zero — booking is unblocked |

## 6. Refunds

| # | Do | Expect |
| --- | --- | --- |
| 6.1 | Cancel a wallet-billed booking; admin approves with a ₹3,500 charge | Approved |
| 6.2 | Wallet | **Credited the net refund** (fare − charge) |
| 6.3 | Ledger | A `refund_credit` row with its own `WTX-…` |
| 6.4 | Net position | Merchant is out **exactly the charge** |
| 6.5 | Cancel a booking that was never wallet-billed | Wallet untouched |

## 7. Credit notes & manual adjustments

| # | Do | Expect |
| --- | --- | --- |
| 7.1 | Admin → merchant wallet → post a **credit note** with a reason | Wallet credited; ledger row typed `credit_note`, **not** `manual_adjustment` |
| 7.2 | Response | Returns a `WTX-…` **reference**, never an internal id |
| 7.3 | Post an untyped credit | Defaults to `wallet_recharge` — unchanged from before |
| 7.4 | Try to post a `booking_debit` by hand | **Refused (422)** — only ticket issuance writes that type |
| 7.5 | Post an adjustment with no reason | Refused |

## 8. Ledger reconciliation

| # | Do | Expect |
| --- | --- | --- |
| 8.1 | Admin → Wallet & Top-ups → **Wallet Reconciliation** | Every merchant listed |
| 8.2 | **`drift` column** | ⚠️ **`0.00` for every merchant.** Anything else is an incident, not a report — stop and escalate |
| 8.3 | Wallet balance vs ledger balance | Identical on every row |
| 8.4 | Pending top-ups | Shown **beside** balances, never inside them |
| 8.5 | After doing §3–§7, re-open reconciliation | Still all zero |
| 8.6 | Open a merchant's **Ledger** | Running balance adds up line by line, top to bottom |
| 8.7 | Compare with what the merchant sees in its own portal | **Identical rows and totals** |
| 8.8 | An amount with paise (e.g. ₹13,750.50) | Paise survive everywhere — never rounded to ₹13,751 |

## 9. Notifications

| # | Do | Expect |
| --- | --- | --- |
| 9.1 | Merchant submits a top-up | Admins notified that a claim awaits verification |
| 9.2 | Admin verifies | Merchant notified, naming amount, `WTX-…` and new balance |
| 9.3 | Admin rejects | Merchant notified **with the reason** and told the wallet is unchanged |
| 9.4 | Ticket issued | Merchant told the amount debited and the new balance |
| 9.5 | Admin → Notifications → **Delivery Failures** | With SMTP unconfigured, every email shows `failed` with "SMTP is not configured…". **This is correct**, not an outage |

## 10. Permission boundaries

**The section most worth your time.** These are cross-tenant and privilege checks; a pass here is
worth more than any feature test.

| # | Do | Expect |
| --- | --- | --- |
| 10.1 | As a **merchant**, open the admin wallet desk URLs directly | Refused (401/403/404) |
| 10.2 | As a merchant, call `/api/admin/wallet/reconciliation` | Refused — **it once leaked every merchant's balances** |
| 10.3 | As a merchant, call `/api/admin/merchants/{other}/wallet/transactions` | Refused |
| 10.4 | As a merchant, verify your **own** top-up | Refused — you may claim, never confirm |
| 10.5 | As merchant **B**, download merchant A's proof file | **404**, not 403 — a 403 confirms it exists |
| 10.6 | As merchant B, read merchant A's wallet | Only ever your own |
| 10.7 | As a merchant, create or edit a payment account | Refused |
| 10.8 | Any wallet URL with no login | 401/403 |
| 10.9 | As **Super Admin**, open the wallet desk | Refused — holds no payment codes. **Known and accepted**; use an Admin |

---

## If you find something

1. **Note the exact steps, the expected result and what happened**, plus the `WTX-…` / `PAY-…` /
   booking reference. The references exist so a defect can be traced to a ledger row.
2. **Check reconciliation (§8.2) immediately.** Whether `drift` is still zero separates a display
   bug from a money bug, and they have very different urgency.
3. Report it. Per the freeze, **only the reported bug is fixed** — no other payment behaviour
   changes, and the fix arrives with a regression test in the relevant `verify_cr4*.py`.

## What is deliberate, so you do not report it as a bug

- **A negative wallet balance is normal.** It is the merchant's outstanding balance — the point of
  the whole design.
- **A submitted top-up credits nothing** until an admin verifies it.
- **Every email shows as `failed`** when SMTP is unconfigured. The platform is refusing to claim
  mail went out when it did not.
- **`credit_limit = 0` means no limit**, not a limit of zero.
- **Super Admin cannot verify payments.** Pre-existing, consistent with the older payments desk.
- **`fare_amount` is ignored on an already-quoted booking** — the merchant is billed the quotation
  it accepted. (This comes from CR-5, which is **not yet approved**.)
