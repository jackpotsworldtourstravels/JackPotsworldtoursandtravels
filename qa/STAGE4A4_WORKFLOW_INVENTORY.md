# Stage 4A.4 — Cross-Portal Workflow Inventory

Built from the actual application (live probes). Records are created through real
workflows (no mocked cross-portal outcomes), namespaced, in jpw_qa only. Suppliers
dormant; no payments/OTP/notifications (B2C booking is `pending` because "no payment
gateway is integrated"; B2B Classic Tours bypasses payment, CR-2).

| # | Workflow | Records | Create path | Cross-portal read (same id) | State / transition | Authz | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X1 | Customer registration → Admin visibility | `customers` (+`customer_auth`) | `POST /api/customer/auth/signup` + `/verify-otp` (dev-OTP) | Admin `GET /api/admin/customers?search=` + `/{id}` show the **same** customer_id/email/customer_code | n/a | merchant/customer/anon → refused; GET unknown id → 404 | **IMPLEMENTED** |
| X2 | Customer booking → Admin booking visibility | `customer_package_bookings` | `POST /api/customer/package-bookings` → `booking_ref` (e.g. JPP000001), status `pending` | Customer `GET /api/customer/package-bookings` and Admin `GET /api/admin/customer-bookings` show the **same `booking_ref`** | pending | merchant/anon → refused | **IMPLEMENTED** |
| X3 | Admin booking action → Customer-visible status | same booking | Admin `PATCH /api/admin/customer-bookings/{ref}/status` | Customer My Trips re-read reflects the new status | `pending→confirmed` (valid set: pending/confirmed/cancelled/completed) | invalid status → 400; merchant PATCH → refused | **IMPLEMENTED** |
| X4 | Merchant request → Admin visibility | `service_requests` (enquiry-led) | `tests/flows.make_booking` (merchant raises, admin answers) → `request_number` (REQ-…), id | Merchant `GET /api/requests`, Admin & Operations(admin) `GET /api/requests/{id}` show the **same request_number/status** | draft | rival merchant → refused; customer/anon → refused; unknown id → 404 | **IMPLEMENTED** |
| X5 | Operations request handling → Admin/merchant consistency | same request | (Operations authority = reused admin) | Admin and Operations(admin session) read the identical request id/state the merchant sees | draft | anon refused | **IMPLEMENTED (API-level; ops browser :8000-limited)** |
| X6 | Invoice / e-ticket visibility | `service_requests` + document/eticket | requires staff ticket **issuance** (M2 upload) + document pipeline | — | issued/ticketed | — | **DEFERRED** — needs the ticket-issuance/document flow (multi-step staff ops); not exercisable as a simple cross-portal read without that pipeline. No real payment/supplier path. |

Notes:
- **Same-identifier verification** is the core assertion: X1 customer_code/id, X2/X3 `booking_ref`, X4/X5 `request_number` — asserted equal across the participating portals.
- **Operations & Merchant-Classic browser limitation (documented, not a defect):** both SPAs hardcode `API_BASE=http://127.0.0.1:8000` on localhost, so their in-browser DATA calls can't reach :8099. X4/X5 verify Operations at the **API level** (reused admin session), not in-browser. Full browser coverage is NOT claimed for them.
- **X6 deferred:** e-ticket/invoice visibility depends on ticket issuance (staff upload) + the document service; building it would require the M2 issuance flow, out of scope for a payment/supplier-free cross-portal read. Recorded as a known gap.
