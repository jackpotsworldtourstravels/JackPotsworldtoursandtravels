# Admin Portal Assessment — 3. Functionality Verification & Gap Analysis

**Date:** 2026-11-13 · Read-only, static code evidence (registered router + service + model + action endpoints). **Not** runtime/UX tested and **not** verified against a live DB — "Complete" here means *implemented in code*, not *proven working in production* (see doc 5).

## Status key
**Complete** = screen has a registered router, a service, model/table, and the actions its UI implies. **Partial** = reads work but expected actions are missing, or it's code-complete but undeployed. **Missing** = no backend. **By-design** = intentionally limited.

## B2B — per screen
| Screen | Status | Evidence / gap |
|---|---|---|
| Dashboard | Complete | dashboard_service aggregates; KPI tiles |
| Merchants | Complete | full merchant+staff lifecycle (merchants/merchant_team/super_admin) |
| Active Users | Complete | session_service over system_logs; presence/online |
| Booking Enquiries | Complete | enquiry/ticket approve/reject/issue |
| Approval Queue | Complete | merchant & manager approvals, change requests |
| Booking Operations | Complete | lifecycle, documents, notes |
| Service Request Mgmt | Complete | cancellation/date-change/refund sub-requests via change_requests |
| Providers | Complete | provider + provider-user CRUD |
| Manual Booking | Complete | ticket.manual on-behalf-of flow |
| Payment Management | Complete | payment_admin verify/manage |
| Wallet Desk | Complete | top-up verification + reconciliation |
| Reports Export | Complete | reports + export_service (csv/xlsx/pdf) |
| Analytics | Complete | analytics_service |
| Audit Logs | Complete | read-only trigger table, redacted-on-read |
| System Logs | Complete | activity + system-info |
| Support (B2B) | Complete | support tickets / messages |
| Notifications | Complete | broadcast, my-notifications, delivery failures |
| Profile | Complete | profile + change password |

**B2B gaps:** none structural at code level. (Runtime/UX correctness and the pre-existing `test_admin_supplier_reservation_http` failures are flagged in doc 5.)

## B2C — per screen
| Screen | Status | Evidence / gap |
|---|---|---|
| Customers | **Partial** | list + sensitive detail read present & audited; **no block/unblock/status/reset-password endpoint** (admin can view but not act on a customer) |
| Bookings | Complete | list/detail + status change, audited |
| Cancellations & Refunds | Complete | maker-checker refund (Approach C), manual refund, resolve-failed, reconcile; audited |
| Reviews & Ratings | Complete | moderate approve/reject/reply, audited |
| Live Chat / WiFi calling | Complete | queue/claim/reply/transfer/close/calls/attachments; WS + ticket; audited |
| Communication | **Partial** | notifications/tickets/overview are **read-only**; no admin send/broadcast-to-customer endpoint in this router |
| Customer Payments | Complete | list + sensitive payment detail read, audited |
| Reconciliation | Complete | verify payment + supplier reservation, audited |
| User Activity | Complete | activity log + sessions (read) |
| Catalogue — Flights | **By-design** | status/config only; B2C flights are live-supplier search (Duffel), no stored inventory to manage |
| Catalogue — Hotels | Complete | hotel + room CRUD, audited |
| Catalogue — Packages | Complete | package + itinerary + departures CRUD, audited |
| Catalogue — Destinations | Complete | destination + location CRUD + reorder, audited |
| B2C Reports | Complete | preview + export, audited |
| B2C Analytics | Complete | analytics |
| B2C Admin Audit trail | **Partial** | read API + writers code-complete & tested, but the `customer_admin_audit_logs` **table is not created on any DB** (migration 0095 not executed) — so in a running system no admin-audit row is written/readable until deployed |
| Gaming (hidden) | **Disabled (by design)** | fail-closed everywhere; nav hidden; API 404; data preserved |

## The 8 requested domains
| Domain | B2B | B2C | Notes |
|---|---|---|---|
| **Monitoring** | Complete (Active Users, System Logs, Dashboard) | Complete (User Activity) | B2B presence/sessions mature |
| **Screening** | Partial — no dedicated fraud/sanction screening module found; payment-provider verification + supplier guard act as controls | Partial — same; `supplier_guard` prevents live payment without a supplier | No KYC/AML/sanctions screening module exists (candidate future work) |
| **Audit logs** | Complete (trigger `audit_logs`, redacted) | **Partial** — code-complete `customer_admin_audit_logs`, **undeployed** | B2C audit is the Stage-2 deliverable; needs DB execution |
| **Reports** | Complete (reports + export) | Complete (preview + export) | both csv/xlsx/pdf |
| **Payments** | Complete (payment_admin, wallet) | Complete (customer_payments, reconciliation, provider events) | HDFC + TrustBrick live paths |
| **Refunds** | via service-request refund sub-type | Complete (maker-checker Approach C, manual, reconcile) | B2C refund flow is the most hardened area |
| **Bookings** | Complete (enquiries, booking-ops, manual) | Complete (bookings list/detail/status) | B2C booking *mutation* limited to status |
| **Support** | Complete (tickets, notifications) | Complete chat/calls; **Partial** communication (read-only) | WiFi calling present on B2C |

## Consolidated gap list (actionable)
1. **B2C customer management is view-only** — no block/unblock/status/reset-password endpoint on `customer_admin` (doc 2). *Impact: ops can see a customer but cannot act.*
2. **B2C communication is read-only** — no admin→customer send/broadcast in `admin_communication`. *Impact: no outbound comms from this screen.*
3. **B2C admin audit is undeployed** — migration 0095 + DBA grants not executed; the audit table does not exist on any DB. *Impact: the Stage-2 feature is inert until deployed.*
4. **No dedicated screening/KYC/AML module** for either side (only provider/supplier payment guards). *Impact: compliance screening is not a portal feature.*
5. **Cosmetic gaming web residuals** (`packages.html` footer, `booking-card.js` search tab) point at the redirecting, noindexed gaming page. *Impact: cosmetic only; functionally disabled.*
6. **Catalogue flights is status-only by design** — confirm this matches the business intent (no stored flight inventory).
