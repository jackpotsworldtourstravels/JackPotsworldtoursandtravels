# JackPots World — Project Overview

**Status: descriptive, not authoritative.** This document explains what the system *is* and how its
parts fit together, for someone arriving at the codebase. Where it disagrees with
`docs/BOOKING_OPS_MILESTONES.md` (the roadmap), `docs/WALLET_ARCHITECTURE.md` (money) or
`docs/API_CONTRACT.md` (endpoints), **those files win** — they are the authoritative ones.

Written 2026-08-25 against branch `b2c` at `acf4763`.

---

## 1. What this is

A **B2B travel operations platform**. Registered partner companies — gaming companies, corporate
travel desks, travel agencies — raise travel enquiries and bookings against their own account; a
platform operations desk prices, approves, issues and settles them; and the money runs through a
per-merchant ledger rather than a card payment at checkout.

It began as a consumer (B2C) booking site and was rebuilt around the B2B workflow. The consumer
surface still exists as a public landing page and a set of service pages, but **the catalog it was
built on was dropped by the v2 schema redesign** — the B2B side is where the product now lives.

The defining shape of the system: **one request row travels a state machine**, and everything else
— documents, approvals, notifications, invoices, wallet entries, audit trail — hangs off that row.

### At a glance

| | |
|---|---|
| Backend | FastAPI · SQLAlchemy 2.0 · PostgreSQL 14+ · Alembic · JWT (python-jose) |
| Frontend | Plain HTML / CSS / JS. **No build step, no npm.** Axios from CDN |
| Database | 32 tables · 53 migrations · single chain · head `0043_passport_details` |
| API | 224 endpoints across 30 routers, no version prefix |
| Code | ~44k lines backend Python · ~51k lines frontend JS · ~14k lines CSS |
| Verification | 34 end-to-end scripts driving the live API over HTTP |
| Deployment | One Docker image serving API **and** frontend on a single origin, port 8000 |
| Production | AWS — EC2 + RDS Postgres + S3 documents + Caddy TLS |

---

## 2. Who uses it, and where they sign in

Six audiences, six front doors. **Only two are named on the public site.**

| Audience | Entry point | What they do |
|---|---|---|
| Public visitor | `index.html` | Landing page, service pages (flights, hotels, cruises, packages, visa, activities) |
| Customer (B2C) | `index.html` → **Login**, `customer/` | V1 portal: sign up, profile, bookings |
| Merchant (B2B) | `partner-login.html` → `merchant-classic/` | **The live partner portal.** Enquiry → booking → wallet → support |
| Platform Manager | `manager/` — unlisted | Signs off submitted Booking Requests before the ops desk sees them |
| Admin | `admin/` — unlisted | 17 sections: ops desk, enquiries, payments, wallet desk, providers, reports, audit |
| Super Admin | `super-admin/` — unlisted | Admin management, roles & permissions, global reports, audit logs |

Two more frontends exist and are not front doors:

- **`merchant/`** — the retired *Premium* merchant portal. It now only redirects to `merchant-classic/`.
- **`operations/`** — a role-adaptive operations framework with **no login of its own**; auth is the
  landing page's modal, and merchants are routed there by `MERCHANT_PORTAL_URL`.

Login is a **two-step OTP flow** for platform and merchant accounts: email + password, then a
one-time code. One endpoint set serves all four portals, discriminated by a `portal` field
(`super_admin | admin | manager | merchant`) rather than four login routes. Customers have their own
parallel set under `/api/customer/auth`, and the token scopes are mutually exclusive — a customer
token is refused by every B2B router, and a merchant or admin token is refused by the customer ones.

---

## 3. Architecture

### Single origin

In production **one container serves both halves**. The FastAPI app serves the `frontend/` directory
as static files and answers `/api/*` itself, so the browser talks to one host. That is why
`API_BASE` falls back to the empty string in the shared frontend helpers — no CORS setup, no
separate static host.

In local development the two are split: `uvicorn` on `:8000` and `python -m http.server` on `:5500`,
with `CORS_ORIGINS` allowing the second. **Browse on `127.0.0.1`, never `localhost`** — the two are
different origins to the browser and the session does not follow you between them.

### Backend layout

```
backend/app/
├── main.py              router registration, security headers, request-metadata
│                        middleware, startup admin seed, background completion sweep
├── config.py            every setting, env-driven (pydantic-settings)
├── models_v2.py         the 25 B2B tables + every enum — THE ORM source of truth
├── models_customer.py   the 7 customer_* tables, its own DeclarativeBase
├── auth/                rbac.py (permission codes + role matrix), deps, security, rate limit
├── routers/             30 routers, each owning its own full path prefix
├── services/            ~60 service modules — all business logic lives here
└── schemas/             pydantic request/response models
```

Routers are thin. **Every rule of consequence lives in `services/`** — the lifecycle state machine,
the wallet, approvals, delivery, OCR, exports.

### Frontend layout

```
frontend/
├── index.html + service pages       public site
├── assets/css/jp-ds.css             THE cross-portal design system (tokens, §14–§17)
├── assets/js/                       admin, super-admin, partner, booking, jp-icons, assistant
├── shared/                          formatters.js (money!), merchant-api.js, ops-api.js, countries
├── components/                      toast, spinner, confirm-dialog, focus-trap
├── merchant-classic/                the live merchant portal — 21 JS modules on one shell
├── admin/ manager/ super-admin/     one index.html each, sections driven by data-section
├── operations/ customer/            the two newer frameworks
└── merchant/                        retired, redirects
```

There is no bundler. Scripts are `<script src>` tags with a **`?v=` cache-bust query** — editing a
JS file without bumping its `?v=` ships nothing to a returning browser.

### Design system

`assets/css/jp-ds.css` is the one cross-portal lever. The brand accent is **violet `#6D5DF6`**, with
`#A78BFA` as the readable weight on dark — a deliberate two-weight accent, because the original
bright accent failed AA contrast under white text. Card radius 18px, Montserrat, JetBrains Mono for
identifiers. §15 standardises every Admin dialog; §14 is the shared UI layer.

---

## 4. The data model

Migration `0023` replaced a 42-table legacy schema with **nine tables**. The schema has grown back
to 32, but the nine-table spine is still the shape of the system.

### The spine: `service_requests`

Almost everything a merchant does becomes a row here. One table carries enquiries, bookings,
cancellations, date changes, refunds, ancillaries, documents, support tickets and chat threads,
discriminated by `request_type` and shaped by two JSONB columns (`travel_details`, `pricing`).

Key columns:

- `request_number` — the human reference (`ENQ-` / `SRQ-` / `TKT-` / `INV-` series). **Never quote
  the integer id to a user.**
- `parent_request_id` — self-referencing. A cancellation points at the booking it cancels;
  passengers hang off the parent, not the child.
- `status` — the state machine's only home (see §5).
- `total_amount` — what the platform bills. `client_fare` — what the *merchant* quoted its own end
  customer, never a price this platform charges. `saved_amount` is derived and **floored at zero**.
  `client_fare` NULL means "not recorded", which is not the same as zero.

Around it: `merchants`, `users`, `payments`, `passenger_data`, `request_documents`, `request_notes`,
`msg_logs`, `system_logs`, `audit_logs`, `communication_settings`.

### The satellites

| Group | Tables | Note |
|---|---|---|
| Wallet | `wallet_transactions`, `wallet_topups`, `payment_accounts` | The ledger. See §6 |
| Hotels | `hotel_enquiries`, `hotel_enquiry_rooms`, `hotel_room_children`, `hotel_booking_guests` | Own tables, own router, **same `ticket.*` permissions** as flights |
| Providers | `providers`, `provider_users` | External suppliers the desk buys FROM. Not app users; no delete path |
| Group booking | `group_booking_imports` | Passenger manifest upload (xlsx/xls) |
| Passport OCR | `passport_ocr_extractions`, `passport_ocr_field_edits` | CR-8, provider-agnostic |
| Service access | `merchant_service_access` | Which products a merchant may touch at all |
| Customer portal | 7 `customer_*` tables | **A separate island** — own Base, shares no row with the above |

### Migrations

53 files, **one chain, no branches** — a property `verify_m9.py` asserts on every run, because the
chain has forked twice in this project's history and a fork breaks `alembic upgrade head` on every
container start. Numbering is not chronological: `0044_customer_portal` is parented on
`0052_soft_delete_email_reuse`, deliberately, because a branch re-parented mid-chain gets overtaken
and forks again.

---

## 5. The booking lifecycle

`services/lifecycle.py` owns `service_requests.status`. Nothing else assigns it. There are **two
tracks**, and which one a request is on is a property of the request, not of the caller.

**Standard track** (catalog-led bookings, Operations):

```
Created → Pending → Under Review → Approved → Payment Pending → Paid → Ticket Issued ⇢ Completed
Created → Pending → Rejected
```

**Classic Tours track** (CR-2 — a booking raised from an answered Ticket Enquiry):

```
Created → Pending Manager Approval → Under Manager Review → Manager Approved → Ticket Issued ⇢ Completed
Pending Manager Approval / Under Manager Review → Created   ("returned for correction", with remarks)
```

Two differences carry the whole change request. **The approver is the Manager**, not the Admin who
answered the enquiry. And **there is no payment step** — Manager Approved goes straight to Ticket
Issued, because the desk already agreed the sector and this workflow settles outside the platform.

### The one edge nobody walks

`Ticket Issued ⇢ Completed` is **the clock, not a button**. A booking completes when its scheduled
journey has finished — a fact about the travel date, not a decision the desk takes. Issuing a ticket
ends at *Ticket Issued*: the ticket exists, documents are generated, the merchant is notified, and
the wallet has already been debited. A background sweep (`booking_completion_service`, every 15
minutes by default) walks the edge once the travel date is past. Travel dates are IST; the sweep
applies a `+330` minute offset.

A third set, `SETTLEMENT_TRANSITIONS`, is deliberately kept **out** of the published edge list so the
cancellation and refund edges never appear in a generic action menu.

---

## 6. Money

`docs/WALLET_ARCHITECTURE.md` is authoritative and **the module is frozen** — approved and locked
2026-08-01, changeable only to fix a business-verified bug.

**The model in one line:** a merchant holds a *running account*, not a prepaid balance. Bookings
debit it, top-ups credit it, and **it is allowed to go negative** — a negative wallet *is* the
merchant's outstanding balance. What bounds the exposure is `merchants.credit_limit`, a per-merchant
business limit, not a floor at zero. The balance is `SUM(credit) − SUM(debit)` over
`wallet_transactions`, and nothing else.

The six rules, compressed:

1. **`wallet_service.post()` is the only code permitted to assign `merchants.wallet_balance`.**
2. **No balance change without a ledger row** — both or neither, in one transaction.
3. **Take the lock before reading the balance** — `SELECT … FOR UPDATE` with `populate_existing=True`.
4. **`Decimal` from column to response.** No `float()` in the money path, server or client. Money
   crosses the wire as a decimal *string*; the browser formats it with `moneyStr()` and never parses it.
5. **Quote `txn_number`** (`WTX-20260801-000042`), never the internal id.
6. **Two guards, not one.** The database owns correctness (a unique index); the lock owns the
   response. Without the lock, six simultaneous issues of one booking wrote exactly one debit — and
   returned two 200s and three 500s. **Lock order is `ServiceRequest` → `Merchant`, always.**

Transaction types: `booking_debit`, `wallet_recharge`, `refund_credit`, `manual_adjustment`,
`credit_note`, `cancellation_charge`, `reschedule_fee`. Direction is **not** encoded in the type — a
refund credits and a cancellation charge debits, and both arise from the same event.

**A top-up credits nothing on submission.** The wallet moves only when an admin verifies the payment
at the Wallet Desk.

---

## 7. Authorization

Two orthogonal systems, and conflating them is the mistake the codebase repeatedly warns about.

### RBAC — what a user may *do*

`auth/rbac.py` holds every permission code (`ticket.request`, `booking.manager_approve`,
`servicerequest.approve`, `merchant_user.delete`, …) and the fixed role matrix. Endpoints declare
`Depends(require(P.X))`; roles never get bespoke checks.

Platform roles: `super_admin`, `admin`, `manager`, `merchant_admin`, `merchant_user`, `customer`.

Merchant staff carry `merchant_user` plus a **sub-role** — `manager`, `supervisor`, `operator`,
`finance`, `data_operator`. The critical invariant:

> **`_MERCHANT_READ` is the floor every merchant account holds, and sub-roles add actions only.**
> Sub-role sets contain no `*_VIEW` codes, so a sub-role can take away a *button*, never a *page*.
> That is what keeps the merchant portal one interface instead of several.

`operator` and `data_operator` are bound to the *same* frozenset, not copies — they described one
job, and the split only ever surfaced as a 403 at the end of a filled-in booking form.

Two approval desks exist and hold **none** of each other's codes: the *platform Manager* approving
bookings (`booking.manager_*`) and the *merchant's own manager* approving its staff's requests
(`booking.merchant_*`, `servicerequest.approve`).

### Service access — which *products* a company may touch

`merchant_service_access` gates `flights`, `hotels`, `visa` and `holidays` **per merchant company**,
independent of who is asking. New merchants get Flights on and the rest opt-in. Entitlements ship
ahead of products — `holidays` currently gates a "coming soon" page.

### Cross-tenant safety

A merchant only ever sees its own rows, and cross-merchant access returns **404, never 403**, so a
response cannot confirm another company's record exists.

---

## 8. The API surface

224 endpoints, 30 routers. **No version prefix** — each router owns its full path.

| Prefix | Covers |
|---|---|
| `/api/auth` | Two-step OTP login for all four platform portals |
| `/api/customer/auth`, `/api/customer/profile` | The B2C island |
| `/api` | Tickets, enquiries, requests, documents, wallet, finance, dashboard, group bookings |
| `/api/hotel`, `/api/admin/hotel-enquiries` | The hotel product line |
| `/api/admin`, `/api/admin/merchants`, `/api/admin/bookings`, `/api/admin/messages` | The ops desk |
| `/api/manager`, `/api/merchant/approvals`, `/api/merchant/team` | The two approval desks + team admin |
| `/api/super-admin` | Admin management, role matrix, system info, audit |
| `/api/analytics`, `/api/reports` | Aggregates (SQL-computed) vs row exports |
| `/api/assistant` | Partner Assistant — classifies intent only, returns no business data |
| `/api/support`, `/api/notifications`, `/api/profile` | Support desk, bell, own account |

Conventions worth knowing: every list returns `Page[T]` (`items/total/page/page_size/total_pages`);
errors are plain `{"detail": "..."}`; money is `Decimal`, 2dp; resource ids are integers but the
human-facing identifier is always a separate string field.

### The Partner Assistant

Two routes, and **neither returns business data**. `interpret` turns a merchant's sentence into an
intent name; the *browser* then calls the ordinary merchant endpoints under the merchant's own token
and renders from those responses. This is why it needs no permission code of its own — it reads
nothing, so there is no capability to gate, and a merchant whose role cannot see the wallet gets the
same 403 through the assistant as through the menu.

---

## 9. Notable subsystems

| Subsystem | What it does | Note |
|---|---|---|
| **Passport OCR (CR-8)** | Extracts passport fields from a photograph | Provider-agnostic; `OCR_PROVIDER=none` by default, Azure by env only. **No platform role holds `document.upload`** |
| **Booking documents** | Passport/visa scans on enquiry-led bookings | Served **only** through an authenticated, merchant-scoped download route — never a static mount |
| **Group booking import** | Passenger manifest from xlsx/xls | `xlrd` pinned to 2.x on purpose so the two Excel libraries cannot disagree about who parses what |
| **Storage** | Local disk or S3 | The same image runs either way; boto3 imported lazily |
| **Lifecycle email** | ~30 notification templates | **Off by default** — one flag in `deliver()`. Login OTP and password reset are structurally out of its reach |
| **jp-icons** | 80 self-hosted animated SVGs replacing emoji | Async renders must re-arm with `JPIcon.mount(scope)` |
| **Support Center** | Merchant ↔ platform chat | `direction` on a message is the *platform's* point of view |
| **Request metadata** | IP / browser / device on every log row | A ContextVar middleware, so ~60 existing `log_activity` calls record it with no signature change |

---

## 10. Verification

`tests/` is a real, committed suite — **34 end-to-end scripts** that drive the live API over HTTP.
They are not unit tests and they do not mock: they sign in through the real two-step OTP flow, create
real rows, and assert on real responses.

```bash
python tests/run_all.py
```

Run it with the **backend venv's Python**, against a live backend and a real PostgreSQL database. A
green run is the release gate, not a formality.

Three properties worth knowing before you touch it:

- **`verify_m9.py` fails if any `verify_*.py` on disk is missing from `run_all.py`.** Three
  milestones once sat green and unrun because their scripts were never registered.
- **`verify_m8.py` runs last and deliberately exhausts the auth rate limit.** Anything after it fails
  on login rather than on its own subject. Do not reorder it.
- **Never pipe the run to `tail`** — you get tail's exit code, not the suite's. And never run a single
  `verify_*` script while `run_all.py` is running; they share fixtures.

Two scripts exit 0 while asserting almost nothing unless configured: `verify_passport_ocr.py` needs
*two* env flags, and `verify_responsive.py` needs a static server on `:5500`.

---

## 11. How the work is delivered

`docs/BOOKING_OPS_MILESTONES.md` is the authoritative roadmap and outranks any plan that lives only
in a chat session.

**The delivery rule:** one milestone at a time, never chained —
implement → verify (API script *and* in-browser, against live PostgreSQL) → fix → regression-test
every previously approved phase → write the summary → **stop for explicit approval**.

**Changing approved functionality:** everything locked is locked. The only exception is a *bug* —
approved behaviour that does not do what the roadmap and the API contract say it does. A wanted
behaviour change is a change request, not a milestone task. **Additive is not exempt**: adding a
status, a permission code, a lifecycle edge or a response field changes approved behaviour.

> The practical test: if a reviewer who approved the milestone would be surprised by the diff, it
> needed approval first.

Locked: Phases 1–3, M1–M3, CR-1, CR-2, and all four wallet gates CR-4a–d.
Built but awaiting approval: CR-3, CR-5, CR-6.

---

## 12. Deployment

**Production** is AWS in one region (`ap-south-1` for Indian merchants): EC2 running the Docker
image, RDS Postgres, a private S3 bucket for documents reached via the instance's IAM role, and Caddy
terminating TLS. Only Caddy is public; the container serves API and frontend on 8000, single origin.

`deploy/docker-entrypoint.sh` runs `alembic upgrade head` on **every container start** — which is why
a forked migration chain bricks the deploy rather than just failing a command.

Security headers are set **twice on purpose**: at the edge in `deploy/Caddyfile`, and again in
`main.py`, because an edge is not the only way the app is reached (the nginx alternative set none of
them, and a container can be port-mapped directly during an incident). HSTS is set only at Caddy,
where TLS actually terminates.

A `render.yaml` blueprint also exists for a one-service Render deploy. The database is deliberately
not declared in it.

**Redeploy is a 3-step process, and skipping the image build ships nothing while exiting 0** — see
`docs/AWS_DEPLOYMENT.md` and `deploy/redeploy.sh`.

---

## 13. Current state and known caveats

Recorded so the next reader is not misled.

- **Branch state.** Work is on `b2c`, which is 3 commits ahead of and 8 commits behind `origin/main`.
  A merge is outstanding.
- **Six files in `frontend/customer/` are untracked** — `index.html`, `register.html`,
  `dashboard.html` and three JS modules. The Customer Portal is partly uncommitted.
- **`docs/RUNBOOK.md` is stale.** It says 22 scripts and head `0037_topup_credit_once`; the real
  numbers are 34 and `0043_passport_details`.
- **`README.md` describes the retired B2C catalog** as if it were live. Flights, hotels, cruises and
  tour-package catalog tables were dropped by the v2 redesign, and a number of landing-page API calls
  hit endpoints that no longer exist. Trust `main.py`'s router list over the README.
- **Legacy router and service files over dropped tables remain in the tree as dead code.**
  `models_v2.py` plus the registered routers are the live surface.
- **`catalog_management` is the one module deliberately left unported** — it is not in the approved spec.
- **OCR is off unless configured.** `OCR_PROVIDER=none` ships by default, and the simulated provider
  can never produce an expiring passport. MiniAiLive is referenced in config but **not installed**.
- **The platform `Portal` literal accepts `super_admin | admin | manager | merchant` only** — the
  customer sign-in runs on its own parallel endpoint set, not this one.
- **A sign-out on localhost navigates to the live site** — `auth.js` hardcodes an absolute production
  URL. Assert `location.origin` before acting in a local browser session.

---

## 14. Where to look first

| Question | File |
|---|---|
| What is live right now? | `backend/app/main.py` — the router list and `PORTED_MODULES` |
| What is a request allowed to do next? | `backend/app/services/lifecycle.py` |
| Who may do it? | `backend/app/auth/rbac.py` |
| How does money move? | `docs/WALLET_ARCHITECTURE.md`, then `services/wallet_service.py` |
| What does an endpoint return? | `docs/API_CONTRACT.md` |
| What was approved, and when? | `docs/BOOKING_OPS_MILESTONES.md` |
| How do I deploy or roll back? | `docs/RUNBOOK.md` + `docs/AWS_DEPLOYMENT.md` |
| Does my change break anything? | `python tests/run_all.py` |
