# JackPots World Tours & Travels

A full-stack tours & travel booking platform: static HTML/CSS/JS frontends (public site, admin
console) backed by a FastAPI + PostgreSQL REST API.

Visitors can search and book flights, hotels, cruises, and tour packages; maintain a wishlist;
leave reviews; and track bookings/payments/notifications from an in-page Account Center. Admins
get a separate console (`admin.html`) for managing catalog content, users, bookings, payments,
pricing/coupons, support tickets, and revenue reports.

The frontend has **no build step** — plain HTML files with inline CSS/JS, talking to the API via
Axios. The backend is FastAPI + SQLAlchemy 2.0 + PostgreSQL, with Alembic-managed migrations and
JWT authentication.

## Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Detailed Setup](#detailed-setup)
- [Environment Variables](#environment-variables)
- [Database Migrations](#database-migrations)
- [Default Admin Login](#default-admin-login)
- [API Reference](#api-reference)
- [Features](#features)
- [Deployment](#deployment)
- [Future Enhancements](#future-enhancements)

## Quick Start

You need **two terminals** running at the same time: one for the backend API, one for the static
frontend.

```bash
# 1. Clone and enter the project
git clone <repository-url>
cd "TOURS AND TRAVEL"

# 2. Set up the backend
cd backend
python -m venv venv
venv\Scripts\activate            # Windows — use `source venv/bin/activate` on macOS/Linux
pip install -r requirements.txt

# 3. Configure environment
copy .env.example .env           # Windows — use `cp .env.example .env` on macOS/Linux
#    -> edit backend/.env: set DATABASE_URL and JWT_SECRET_KEY at minimum (see below)

# 4. Create the database (adjust credentials/name to match your DATABASE_URL)
createdb -U postgres jackpotsworldtours

# 5. Run migrations (creates tables + seeds sample data + one admin account)
python -m alembic upgrade head

# 6. Start the backend  (Terminal 1 — stays in backend/)
python -m uvicorn app.main:app --reload --port 8000
```

```bash
# 7. Start the frontend (Terminal 2 — from the project root, NOT backend/)
cd "TOURS AND TRAVEL"
python -m http.server 5500
```

Then open **http://127.0.0.1:5500/index.html** in your browser. Sign up, log in, search, and
book — or log in with the [seeded admin account](#default-admin-login) and open
`admin.html` to manage the platform.

> The frontend must be served over HTTP (step 7), never opened as a `file://` path, or the
> browser will block API calls. The backend's default `CORS_ORIGINS` already allows
> `http://127.0.0.1:5500` / `http://localhost:5500`.

## Project Structure

```
TOURS AND TRAVEL/
├── index.html              Public site + logged-in Account Center (search, booking, wishlist,
│                            reviews, notifications, profile) — the main customer-facing app
├── admin.html               Admin console — CRUD, reports, pricing/coupons, support tickets
├── login.html / register.html / forgot-password.html / reset-password.html
│                            Standalone auth pages (reset-password.html is the live link sent
│                            in password-reset emails)
├── assets/                  Logo, favicon, hero videos
├── deploy/                  AWS EC2 deployment scripts + guide (see Deployment section)
└── backend/
    ├── requirements.txt
    ├── .env.example
    ├── alembic/versions/    Migration history (see Database Migrations)
    └── app/
        ├── main.py          FastAPI app instance, CORS, router registration, startup checks
        ├── config.py        Environment configuration (pydantic-settings)
        ├── auth/            Password hashing, JWT encode/decode, rate limiting
        ├── database/        SQLAlchemy engine/session setup
        ├── models/          SQLAlchemy ORM models
        ├── schemas/         Pydantic request/response schemas
        ├── routers/         FastAPI routers, one per resource group
        └── services/        Business logic called by routers
```

## Detailed Setup

**Prerequisites**
- Python 3.11+
- PostgreSQL 14+ (local install, or a hosted instance such as Neon or Railway)
- A modern browser

**Install backend dependencies**

```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
```

**Create the database**

On Windows, `createdb`/`psql` live inside the PostgreSQL install folder and usually aren't on
`PATH`, so use the full path (adjust the version number):

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres jackpotsworldtours
```

On macOS/Linux, `createdb` is normally already on `PATH`:

```bash
createdb -U postgres jackpotsworldtours
```

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in your own values.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string, e.g. `postgresql+psycopg2://postgres:PASSWORD@127.0.0.1:5432/jackpotsworldtours`. URL-encode special characters in the password (`@` → `%40`). |
| `JWT_SECRET_KEY` | Yes | Long random secret used to sign JWTs. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`. Never reuse the example value. |
| `JWT_ALGORITHM` | No (default `HS256`) | JWT signing algorithm. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No (default `30`) | Access token lifetime. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | No (default `7`) | Refresh token lifetime. |
| `RESET_TOKEN_EXPIRE_MINUTES` | No (default `60`) | Password-reset token lifetime. |
| `CORS_ORIGINS` | No (has a dev default) | Comma-separated list of frontend origins allowed to call the API. Must include whatever origin you serve the frontend from. |
| `FRONTEND_BASE_URL` | No | Base URL used to build the absolute link inside password-reset emails, e.g. `https://yourdomain.com`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_USE_TLS` / `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME` | No | SMTP settings for sending real password-reset emails. Leave `SMTP_HOST` unset to skip sending (a warning is logged instead) — fine for local dev. |
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

</details>

## Default Admin Login

The `0003_seed_admin` migration creates one admin account:

- **Email**: `admin@jackpotsworldtours.com`, or whatever you set via `ADMIN_SEED_EMAIL`
- **Password**: whatever you set via `ADMIN_SEED_PASSWORD`, or — if left unset — a cryptographically
  random password generated and printed **once** to the migration's console output

**Change the seeded admin's password after your first login.** No password is ever hardcoded in
source control.

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

## Features

**Public site & Account Center (`index.html`)**
- Search flights, hotels, cruises, and tour packages with type-specific filters
- Item detail view, wishlist toggle, reviews per item
- Signup / login / forgot-password / reset-password
- In-page Account Center: booking history + receipts, cancel-with-refund, wishlist, notifications,
  reviews, support tickets, profile & password management
- Contact form and newsletter signup

**Admin console (`admin.html`)**
- Dashboard KPIs, revenue/booking charts, CSV report export
- CRUD for flights, hotels, cruises, tour packages, and pricing/coupons
- Paginated management of users, bookings, payments, contact messages, reviews, wishlist,
  support tickets, and activity logs
- Send notifications to one user or broadcast to all users

**Cross-cutting**
- JWT access/refresh authentication with role-based access control (user vs. admin)
- Rate limiting on authentication endpoints
- Real password-reset emails via SMTP (falls back to a logged link if unconfigured)
- Server-side price recalculation and inventory validation on every booking
- XSS-safe rendering of all user-generated content

## Deployment

The frontend is fully static — deploy the HTML files as-is to any static host (Netlify, Vercel,
GitHub Pages, S3 + CloudFront). The backend needs a Python host with PostgreSQL.

For a complete guide to deploying both on a single AWS EC2 instance (nginx + gunicorn/uvicorn +
PostgreSQL, systemd service, HTTPS via certbot), see [deploy/README.md](deploy/README.md).

Minimum steps for any host:
1. Provision PostgreSQL and set `DATABASE_URL`, `JWT_SECRET_KEY`, and `CORS_ORIGINS` (pointing at
   your deployed frontend's origin) on your hosting platform.
2. `pip install -r requirements.txt` then `alembic upgrade head` as part of your deploy step.
3. Run with a production ASGI server, e.g. `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
4. Update `API_BASE` at the top of each HTML file's `<script>` block to your deployed backend URL.
5. Confirm `/api/health` returns `{"status": "ok"}`.

## Future Enhancements

- A real payment gateway integration in place of the current mock payment flow
- Round-trip flight modeling and per-date hotel/cruise inventory (current availability checks are
  per-listing, not per-date)
- Automated test suite (unit + integration) and CI pipeline
