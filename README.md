# JackPots World Tours & Travels

A full-stack tours & travel booking platform.

- **Frontend** — plain HTML/CSS/JS (no build step, no npm), talking to the API via Axios
- **Backend** — FastAPI + SQLAlchemy 2.0 + PostgreSQL, JWT auth, Alembic migrations

Visitors can search and book flights, hotels, cruises, and tour packages; keep a wishlist; leave
reviews; and manage bookings/payments from an Account Center. Admins get a separate console
(`admin/index.html`) for catalog, users, bookings, payments, pricing/coupons, support tickets, and
reports. Registered B2B partner companies (gaming companies, corporate travel desks, agencies) get
their own portal (`merchant-classic/index.html`) to raise and track ticket requests and service
requests against their own bookings only. `merchant/index.html` is the retired Premium portal and
now only redirects there.

**Where each audience signs in (2026-08-03).** The public site's **Login** is the CUSTOMER (B2C)
door; **My Partner** opens `partner-login.html`, the merchant (B2B) login. Admin, Manager and Super
Admin are reachable only at `admin/`, `manager/` and `super-admin/` and are named nowhere on the
public site — `portal-login.html`, which used to list all four, now redirects to the partner login.
The customer login is UI ahead of its backend: there is no customer endpoint (the `Portal` literal
accepts `super_admin|admin|manager|merchant` only), so the form is gated behind
`CUSTOMER_AUTH.enabled` in `assets/js/app.js` and declines clearly until one ships.

## Contents

- [How to Run](#how-to-run)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Database Migrations](#database-migrations)
- [Default Admin Login](#default-admin-login)
- [API Reference](#api-reference)
- [Features](#features)
- [Deployment](#deployment)

## How to Run

**Prerequisites:** Python 3.11+, PostgreSQL 14+ (local, or a hosted instance like Neon/Railway), a
modern browser.

You need **two terminals** running at the same time — one for the API, one for the static site.

### Terminal 1 — Backend API

```bash
cd backend

# 1. Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate            # Windows
# source venv/bin/activate       # macOS/Linux

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
copy .env.example .env           # Windows — `cp .env.example .env` on macOS/Linux
# Edit backend/.env — set DATABASE_URL and JWT_SECRET_KEY at minimum (see Environment Variables)

# 4. Create the database (name must match DATABASE_URL)
createdb -U postgres jackpotsworldtours

# 5. Run migrations — creates all tables and seeds sample data + one admin account
python -m alembic upgrade head

# 6. Start the API
python -m uvicorn app.main:app --reload --port 8000
```

Leave this running. The API is now live at http://127.0.0.1:8000 (interactive docs at
[/docs](http://127.0.0.1:8000/docs)).

### Terminal 2 — Frontend

```bash
# From frontend/ (NOT the project root, NOT backend/)
cd frontend
python -m http.server 5500
```

Open **http://127.0.0.1:5500/index.html** in your browser. Sign up, log in, search, and book — or
log in with the [seeded admin account](#default-admin-login) and open `admin/index.html` (relative
to `frontend/`, i.e. http://127.0.0.1:5500/admin/) to manage the platform.

> ⚠️ The frontend must be served over HTTP (`python -m http.server`), never opened directly as a
> `file://` path, or the browser will block API calls. The backend's default `CORS_ORIGINS`
> already allows `http://127.0.0.1:5500` / `http://localhost:5500`.

<details>
<summary>Windows: <code>createdb</code> not found?</summary>

`createdb`/`psql` live inside the PostgreSQL install folder and usually aren't on `PATH`. Use the
full path (adjust the version number to match your install):

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres jackpotsworldtours
```

</details>

## Project Structure

```
TOURS AND TRAVEL/
├── frontend/                 Everything static-served (see Terminal 2 above)
│   ├── index.html            Public site + logged-in Account Center — the main customer-facing app
│   ├── login.html / register.html / forgot-password.html / reset-password.html
│   │                         Standalone auth pages (index.html also has its own login/signup
│   │                         modals — both exist; admin.html's "reset customer password" action
│   │                         links to reset-password.html specifically)
│   ├── admin/index.html      Admin console — CRUD, reports, pricing/coupons, support tickets,
│   │                         Merchant Management (all as sections within this one file)
│   ├── merchant/index.html   Merchant Portal — dashboard, ticket enquiry/request, request
│   │                         history, service requests, reports, profile (served at /merchant/)
│   ├── super-admin/index.html
│   │                         Super Admin Portal — dashboard, admin management, roles &
│   │                         permissions, system config, global reports, audit logs, profile
│   ├── assets/
│   │   ├── images/ (logo, favicons)   videos/ (hero clips)
│   │   ├── css/    main.css, admin.css (extracted from what used to be inline <style> blocks),
│   │   │           partner-portal.css, super-admin.css
│   │   └── js/     app.js, admin.js (extracted from inline <script> blocks), auth.js, api.js
│   │               (reusable JWT-session and API-call layers, shared by all four portals),
│   │               partner-*.js (one file per Partner Portal concern), super-admin-*.js
│   ├── shared/formatters.js  escapeHtml/money/fmtDate/fmtDateTime/fmtTime — one canonical copy,
│   │                         used by every portal (previously duplicated per-file)
│   └── components/           toast.js, spinner.js, confirm-dialog.js — reusable UI helpers
│                              (see components/README.md for what's real vs. new, and why
│                              navbar/sidebar/footer stay portal-specific)
├── backend/                  FastAPI app (see Terminal 1 above) — layout unchanged by the
│   │                         frontend reorganization above
│   ├── requirements.txt
│   ├── .env.example
│   ├── alembic/versions/    Migration history (see Database Migrations)
│   ├── db/partner_portal/   Reviewed, applied-as-migrations SQL: schema, stored procedures,
│   │                        triggers, views, seed data (see Partner Portal Database below)
│   └── app/
│       ├── main.py          FastAPI app instance, CORS, router registration, startup checks
│       ├── config.py        Environment configuration (pydantic-settings)
│       ├── auth/            Password hashing, JWT encode/decode, rate limiting
│       │                    (partner_deps.py: separate JWT scope for Partner Portal sessions)
│       ├── database/        SQLAlchemy engine/session setup
│       ├── models/          SQLAlchemy ORM models (partner*.py, reference.py for the Partner Portal)
│       ├── schemas/         Pydantic request/response schemas (partner_*.py)
│       ├── routers/         FastAPI routers, one per resource group (partner_*.py)
│       └── services/        Business logic called by routers — Partner Portal services are
│                            thin wrappers that call PostgreSQL stored procedures rather than
│                            implementing logic in Python (see Partner Portal Database below)
├── database/                 Proposed (not applied) domain-separated PostgreSQL redesign — see
│                              database/README.md and docs/DATABASE_STRUCTURE.md
├── docs/                      DATABASE_STRUCTURE.md, FIELD_MAPPING.md
├── deploy/                    AWS EC2 deployment scripts + guide (see Deployment)
├── scripts/, tests/, uploads/ Reserved for future use — see each folder's README.md for why
│                              they're currently empty
└── README.md                  This file
```

`backend/app/auth/` is this project's security layer (password hashing,
JWT, rate limiting) — kept under that name rather than renamed to
`security/`, since the rename would touch every `from app.auth...` import
across ~30 backend files for no functional benefit. `database/`,
`alembic/`, and everything under `backend/app/{models,schemas,services,
routers}/` are unchanged by the reorganization above.

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in your own values.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string, e.g. `postgresql+psycopg2://postgres:PASSWORD@127.0.0.1:5432/jackpotsworldtours`. URL-encode special characters in the password (`@` → `%40`). |
| `JWT_SECRET_KEY` | **Yes** | Long random secret used to sign JWTs. Generate with `python -c "import secrets; print(secrets.token_hex(32))"`. Never reuse the example value. |
| `JWT_ALGORITHM` | No — default `HS256` | JWT signing algorithm. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No — default `30` | Access token lifetime. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | No — default `7` | Refresh token lifetime. |
| `RESET_TOKEN_EXPIRE_MINUTES` | No — default `60` | Password-reset token lifetime. |
| `CORS_ORIGINS` | No — has a dev default | Comma-separated frontend origins allowed to call the API. Must include whatever origin you serve the frontend from. |
| `FRONTEND_BASE_URL` | No | Base URL used to build the absolute link inside password-reset emails, e.g. `https://yourdomain.com`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_USE_TLS` / `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME` | Partner Portal: **Yes** · main-site reset: No | Generic SMTP settings — works with Gmail (`smtp.gmail.com:587` + a 16-char App Password), Outlook (`smtp.office365.com:587`), SendGrid (`smtp.sendgrid.net:587`, username `apikey`), or Amazon SES (`email-smtp.<region>.amazonaws.com:587`, SES SMTP credentials). The main site's password-reset email silently skips sending (logs a warning) if `SMTP_HOST` is unset — fine for local dev. The **Partner Portal's OTP emails do not** have a log/skip fallback: an OTP request fails with `503` if SMTP isn't configured, since the code is never printed anywhere. |
| `ADMIN_SEED_EMAIL` | No | Email for the admin account created by the seed migration. Defaults to `admin@jackpotsworldtours.com`. |
| `ADMIN_SEED_PASSWORD` | No | Password for the seeded admin account. If unset, a random password is generated and printed once to the migration's console output — capture it there. |

## Database Migrations

The schema is fully managed by Alembic — never modify the database by hand.

```bash
cd backend
python -m alembic upgrade head
```

This creates every table and seeds two roles, sample catalog content, and one admin account.

To generate a new migration after changing a model:

```bash
python -m alembic revision --autogenerate -m "describe your change"
python -m alembic upgrade head
```

<details>
<summary>Migration history</summary>

| Revision | Purpose |
|---|---|
| `0001_initial_schema` | Base schema: roles, users, flights, hotels, cruises, packages, bookings, payments, contact/newsletter/reviews/wishlist/notifications/activity_logs |
| `0002_seed_content` | Seed sample flights, hotels, cruises, and tour packages |
| `0003_seed_admin` | Seed the admin role and admin account |
| `0004_package_month_and_booking_quantity` | Adds `tour_packages.available_month` and `bookings.quantity` |
| `0005_user_delete_fk_behavior` | Explicit `ondelete` behavior per foreign key |
| `0006_add_performance_indexes` | Indexes on frequently filtered/joined columns |
| `0007_wishlist_review_unique_constraints` | Prevents duplicate wishlist/review rows under concurrent requests |
| `0008_extended_profile_and_support_tickets` | Extended user profile fields + support ticket tables |
| `0009_activity_monitoring` | Activity log expansion |
| `0010_customer_management` | Admin customer-management fields |
| `0011_support_ticket_resolved_at` | Adds `resolved_at` to support tickets |
| `0012_inventory_management` | Inventory tracking tables |
| `0013_booking_management` | Admin booking-management fields |
| `0014_pricing_coupons` | Pricing rules and coupon tables |
| `0015_partner_portal` | Partner Portal: 19 tables, 3 views, 9 triggers, 19 stored procedures — applies `backend/db/partner_portal/*.sql` |
| `0016_partner_portal_gap_completion` | Partner Portal follow-up: status-history tables, 4 more stored procedures, 2 more views, sample partner seed data — applies `backend/db/partner_portal/gap_completion/*.sql` |
| `0017_partner_portal_back_office` | Partner Portal Back Office: 2 stored procedures backing the new admin/index.html Partner Requests screen — applies `backend/db/partner_portal/back_office/*.sql` |

</details>

### Partner Portal database

Unlike the rest of the schema, the Partner Portal's business logic lives mostly in
**PostgreSQL stored procedures**, not in the FastAPI service layer — the Python services in
`app/services/partner_*.py` are thin wrappers that call `SELECT sp_xxx(...)`. The actual DDL/PLpgSQL
is hand-written and reviewed in `backend/db/partner_portal/` (numbered `01_types.sql` ...
`14_seed_reference_data.sql`) and `backend/db/partner_portal/gap_completion/` (`01_schema.sql` ...
`08_seed_data.sql`) — each folder has its own `README.md` explaining every table/procedure/trigger/view
and a `00_run_all.sql` you can run directly against a scratch database to review the DDL outside of
Alembic. Migrations `0015`/`0016` apply this same SQL through the normal `alembic upgrade head` path;
don't hand-edit the schema.

**Onboarding a new partner company.** The portal is invitation-only — there's no public sign-up.
Back Office creates a partner and its first login with:

```sql
SELECT sp_register_partner(
    'Company Name', 'COMPANYCODE01', 'CC',              -- company_name, company_code, reference_prefix
    'contact@realcompanydomain.com', '+91-90000-00000',  -- partner email (must be a real, deliverable address — OTP/reset emails go here), phone
    'Admin Full Name', 'admin@realcompanydomain.com',    -- first partner_user's name + a real, deliverable email
    '<bcrypt hash — see below>',
    'partner_admin'                                       -- or 'partner_staff'
);
```

Use real, deliverable email addresses — the Partner Portal's OTP and password-reset flows send actual
emails via SMTP, so a fake or reserved-TLD address (`.example`, `.test`, etc.) means that partner can
never receive their OTP and can never log in.

Generate the bcrypt hash the same way the app does (never hand-write or paste a plaintext password
into SQL):

```bash
cd backend && python -c "from app.auth.security import hash_password; print(hash_password('their-temp-password'))"
```

Two sample partners are already seeded this way — see `backend/db/partner_portal/gap_completion/08_seed_data.sql`.

## Default Admin Login

The `0003_seed_admin` migration creates one admin account:

- **Email** — `admin@jackpotsworldtours.com`, or whatever you set via `ADMIN_SEED_EMAIL`
- **Password** — whatever you set via `ADMIN_SEED_PASSWORD`, or, if left unset, a random password
  printed **once** to the migration's console output

**Change the seeded admin's password after your first login.** No password is ever hardcoded in
source control.

### Partner Portal demo logins

Two sample partner accounts are seeded by `0016_partner_portal_gap_completion`
(`backend/db/partner_portal/gap_completion/08_seed_data.sql`):

| Company | Email | Password |
|---|---|---|
| Aurora Gaming Studios | `jackpotsworldtours.travels@gmail.com` | `Aurora@2026` |
| Blueline Corporate Travel | `jackpotsworldtours.travels+arjun@gmail.com` | `Blueline@2026` |

Both route to the same real inbox via Gmail "+" sub-addressing (mail to `local+tag@gmail.com`
delivers to `local@gmail.com`, while staying a distinct string for the `email` UNIQUE constraint) —
swap in different real addresses per company if you want separate inboxes.

Sign in at `partner-login.html`; the OTP step requires `SMTP_HOST`/`SMTP_FROM_EMAIL` (and the rest
of the SMTP variables) to be set in `backend/.env` — there is no server-side log fallback. If SMTP
isn't configured, OTP requests fail with a `503` rather than ever printing the code anywhere.

## API Reference

Every endpoint is documented and browsable via interactive Swagger UI at `/docs` (or ReDoc at
`/redoc`) once the backend is running — e.g. http://127.0.0.1:8000/docs.

| Prefix | Purpose |
|---|---|
| `/api/auth` | Signup, login, refresh, logout, forgot/reset password |
| `/api/flights`, `/api/hotels`, `/api/cruises`, `/api/packages` | Public catalog browsing + search; admin-only create/update/delete |
| `/api/bookings`, `/api/payments` | Create/cancel bookings, view booking & payment history |
| `/api/wishlist` | Add/remove/list wishlist entries |
| `/api/reviews` | Create/edit/delete reviews per item |
| `/api/notifications` | List/mark-read/delete the current user's notifications |
| `/api/support-tickets` | Raise/view customer support tickets |
| `/api/users`, `/api/users/me` | Self-service profile management |
| `/api/contact`, `/api/newsletter` | Public contact form and newsletter signup |
| `/api/admin/*` | Admin-only: users, customers, bookings, payments, pricing/coupons, activity logs, reports/CSV export |
| `/api/partner-auth` | Partner Portal auth: OTP request/verify, login, refresh, logout, forgot/reset password |
| `/api/partner/*` | Partner Portal (own-data-only via JWT, enforced in the service layer): dashboard, ticket enquiry, bookings, request history, service requests, reports, profile, countries |

## Features

**Public site & Account Center (`index.html`)**
- Search flights, hotels, cruises, and tour packages with type-specific filters
- Item detail view, wishlist toggle, reviews per item
- Signup / login / forgot-password / reset-password
- In-page Account Center: booking history + receipts, cancel-with-refund, wishlist, notifications,
  reviews, support tickets, profile & password management
- Contact form and newsletter signup

**Admin console (`admin/index.html`)**
- Dashboard KPIs, revenue/booking charts, CSV report export
- CRUD for flights, hotels, cruises, tour packages, and pricing/coupons
- Paginated management of users, bookings, payments, contact messages, reviews, wishlist, support
  tickets, and activity logs
- Send notifications to one user or broadcast to all users

**Partner Portal (`merchant-classic/index.html`, sign-in at `partner-login.html`)** — separate B2B
surface, own JWT scope, own login
- 3-step OTP + password sign-in (email → OTP → password), plus forgot-password
- Dashboard KPIs, Ticket Enquiry (searches the same live flight catalog as the public site)
- Request Ticket: flights/hotels/cruises, multi-passenger, draft-then-submit-for-approval workflow
- Request History; Service Requests (cancellation, date change, refund, passenger modification)
- Reports with filters + CSV/print export; profile + password management
- Partners can only ever see and act on their own bookings — enforced server-side, not just hidden
  in the UI (verified: a second partner's token gets `404`, not someone else's data)

**Partner Requests (`admin/index.html`)** — the Back Office side of the workflow above
- Booking Approvals tab: queue of pending partner bookings across every company, with a review
  drawer (full trip + passenger detail) and Approve (with an optional final amount) / Reject
  (with a required reason)
- Service Requests tab: queue of submitted cancellation/date-change/refund/passenger-modification
  requests, with Approve / Reject / Mark Completed
- Uses the same `sp_approve_request`/`sp_reject_request` (Phase 2) that already existed but had no
  caller, plus two new procedures (`sp_admin_list_partner_bookings`, `sp_resolve_service_request`)

**Cross-cutting**
- JWT access/refresh authentication with role-based access control (user vs. admin vs. partner —
  three separate, mutually-exclusive token scopes; a partner token is rejected on `/api/admin/*`
  and an admin token is rejected on `/api/partner/*`)
- Rate limiting on authentication endpoints
- Real password-reset/OTP emails via SMTP (falls back to a logged warning if unconfigured — true
  for both the customer password-reset flow and Partner Portal OTP delivery)
- Server-side price recalculation and inventory validation on every booking
- XSS-safe rendering of all user-generated content

## Deployment

The frontend is fully static — deploy the HTML files as-is to any static host (Netlify, Vercel,
GitHub Pages, S3 + CloudFront). The backend needs a Python host with PostgreSQL.

**The current deployment guide is [docs/AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md)** — one EC2
instance running the Docker image, RDS Postgres, S3 for booking documents, and automatic TLS.

[deploy/README.md](deploy/README.md) describes an earlier approach (nginx + systemd + PostgreSQL
installed on the instance itself). It is kept for reference but is **superseded**: it predates both
the Docker image and the S3 document backend, and it puts the database on the web server, where an
instance rebuild destroys it. Follow one guide or the other, not a mixture.

Minimum steps for any host:
1. Provision PostgreSQL and set `DATABASE_URL`, `JWT_SECRET_KEY`, and `CORS_ORIGINS` (pointing at
   your deployed frontend's origin) on your hosting platform.
2. `pip install -r requirements.txt` then `alembic upgrade head` as part of your deploy step.
3. Run with a production ASGI server, e.g. `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
4. Update `API_BASE` to your deployed backend URL — inline at the top of each HTML file's
   `<script>` block (`index.html`, `admin/index.html`) or, for the Partner Portal, in
   `assets/js/partner-shared.js`.
5. Confirm `/api/health` returns `{"status": "ok"}`.
</content>
