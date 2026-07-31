# CR-3 — Booking approval moved to the merchant's manager ✅ **Built, awaiting approval**

Raised and built 2026-07-31, at the business's direction. **Not yet approved** — §0 of
`docs/BOOKING_OPS_MILESTONES.md` requires sign-off before this counts as done, and it alters
CR-2, which is locked. Fold this into §1 of that file on approval.

---

## 1. What changed

The account that signs off a submitted Booking Request is now the **merchant's own manager**
(`merchant_role = 'manager'`, created by an Admin under a merchant) rather than the platform
Manager (`UserRole.MANAGER`, created by the Super Admin).

```
CR-2:  submit ──▶ [PLATFORM Manager @ /manager/] ──▶ Admin Booking Operations

CR-3:  submit ──▶ [MERCHANT's approver, in the merchant portal] ──▶ Admin Booking Operations
```

**Decided by the business:** the merchant's manager *replaces* the platform Manager rather than
sitting in front of it. The consequence is recorded here so it is not rediscovered later — **each
merchant signs off its own bookings**, and the only platform-side scrutiny of an enquiry-led
booking is the Admin Booking Operations desk that processes it.

## 2. No migration

The statuses did not change. A booking still goes
`Pending Manager Approval → Under Manager Review → Manager Approved`, and a return still lands in
`Created`. Only *who may walk the approval edge* changed, which is permission data, not schema.
Migrations `0033`–`0035` (the platform Manager role) are untouched.

## 3. Who approves

| Merchant sub-role | Raises bookings | Approves |
|---|---|---|
| `merchant_admin` (role) | yes | **yes** |
| `MANAGER` | yes | **yes** |
| `SUPERVISOR` | yes | no |
| `OPERATOR` / `DATA_OPERATOR` | yes | no |
| `FINANCE` | no | no |

**Merchant Admin holds the codes as well as the manager sub-role**, deliberately: every merchant
has a Merchant Admin by construction, not every merchant has a manager, and a single manager being
away must not stop a merchant submitting work. In production that makes the approvers
`nikhilaseera@gmail.com` (Fintech) and `harsha040903@gmail.com` (Trust Brick), plus each merchant's
Merchant Admins.

**Self-approval is refused.** The manager sub-role holds `ticket.request`, so the same person can
raise and would otherwise sign off the same booking — which makes the step decorative for exactly
the people most likely to use it. The raiser gets a 403 and the screen renders the booking
read-only with the reason.

## 4. What was built

**Permissions** — `P.BOOKING_MERCHANT_APPROVE`, `P.BOOKING_MERCHANT_RETURN`, granted to
`MerchantRole.MANAGER` and `_MERCHANT_ADMIN`. **Not** the CR-2 platform codes: those are gated by
`manager_service._assert_approver_surface`, and a merchant must not be able to *address* the
platform queue at all, not merely be refused by it late.

**Service** — `manager_service` now serves both actor kinds rather than being forked. Duplicating
it would have meant two copies of the claim and the `SELECT ... FOR UPDATE`, which is the code
least safe to fork. A merchant actor is confined to its own merchant in `list_queue`,
`queue_counts`, `get_booking` and every decision path, by `_assert_own_merchant` —
**404, not 403**, because confirming a booking exists would leak another merchant's request
numbers to anyone willing to enumerate them.

**Lifecycle** — `Transition.permission` now accepts a tuple of codes of which the actor needs any
one, and the Classic approval edges list both approvers. Any-of, not all-of: no actor holds both
sets, so requiring both would close the edge to everyone. The table answers "may this actor walk
this edge at all"; it never answers "whose booking is it", which stays in `manager_service`.

**API** — `/api/merchant/approvals` (list, counts, detail, start-review, approve, return). Scope
comes from the token; there is deliberately no `merchant_id` parameter.

**Frontend** — an **Approvals** section in the Classic merchant portal
(`merchant-classic/js/classic-approvals.js`), shown only to accounts holding the code. Same
read-only review as the Manager portal: booking, itinerary, passengers, timeline, then Approve for
ticketing / Return for correction. `can_decide` comes from the server and is never recomputed on
the client, so the buttons cannot invite a decision the server will refuse.

## 5. What is unchanged

- **CR-2's Classic Tours payment bypass** — `CLASSIC_TRANSITIONS`, Payment Pending / Paid having
  no inbound edge on the enquiry-led track, `is_classic_track`, `CLASSIC_STAFF_LATE_STAGES`.
- **M4 Finance**, the Admin Booking Operations queue, and the standard catalog-led track.
- **The platform Manager path still works**, and `tests/verify_cr2.py` still passes unchanged. It
  is dormant rather than removed — in practice its queue stays empty because merchants now approve
  first. PostgreSQL cannot drop an enum value, so removing the role would cost a migration to undo;
  leaving it costs nothing. **Retiring `/manager/` outright is a separate decision.**

## 6. Verification

`tests/verify_cr3.py` — **28 checks, all passing**, wired into `tests/run_all.py`:

- the merchant's manager approves its own company's booking, and it reaches Booking Operations
- **cross-merchant isolation** — a rival merchant's queue excludes it, and detail/approve both 404.
  The single most important assertion here: a permission that is correct but unscoped would let any
  merchant approve every merchant's work, and that failure is invisible from a single-merchant test
- self-approval refused, and a colleague can then approve the same booking
- a Data Operator can neither open the queue nor approve
- return-for-correction requires remarks and lands in Created, not Rejected
- four simultaneous approvals resolve to exactly one winner, losers 4xx and never 500

Full suite green: **11/11 scripts**, including `verify_cr2.py`.

**A bug the suite could not catch, found by driving the real UI:** the approval succeeded (HTTP
200) while the screen reported failure, because Classic does not load `components/toast.js` and
`showToast` was undefined. Classic reports success by closing the modal and refreshing; the screen
now does that. Re-verified in-browser — modal closes, awaiting 160→159, approved 44→46, no console
errors.

## 7. Known gaps

- **Only the Classic merchant portal has the approval UI.** Premium raises bookings too and has no
  approval screen, so an approver working in Premium will not see the queue there. The backend is
  enforced regardless, so this is a coverage gap, not a bypass — but it needs closing before
  Premium users are told the feature exists.
- **`/manager/` is still reachable** and its account still valid. Dormant, not retired.
