# JackPots World Tours & Travels

A full-stack tours & travel booking platform: three static HTML/CSS/JS frontends (public site,
user dashboard, admin console) backed by a FastAPI + PostgreSQL REST API.

## Table of Contents

- [Project Overview](#project-overview)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [Folder Structure](#folder-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [PostgreSQL Setup](#postgresql-setup)
- [Environment Variables](#environment-variables)
- [Alembic Migrations](#alembic-migrations)
- [Running the Backend](#running-the-backend)
- [Running the Frontend](#running-the-frontend)
- [Default Admin Setup](#default-admin-setup)
- [API Documentation](#api-documentation)
- [Screenshots](#screenshots)
- [Deployment](#deployment)
- [Future Enhancements](#future-enhancements)

## Project Overview

JackPots World Tours & Travels lets visitors search and book flights, hotels, cruises, and tour
packages; maintain a wishlist; leave reviews; and track bookings/payments/notifications from a
personal dashboard. Admins get a separate console for managing catalog content, users, bookings,
payments, contact messages, reviews, wishlist entries, notifications, activity logs, and revenue
reports (with CSV export and charts).

The frontend is intentionally build-step-free — three self-contained HTML files, each with inline
CSS/JS, talking to the API via `axios`. The backend is a FastAPI application on SQLAlchemy 2.0 +
PostgreSQL, with Alembic-managed schema migrations and JWT-based authentication.

## Features

**Public site (`index.html`)**
- Search flights, hotels, cruises, and tour packages with type-specific filters (cabin class,
  passengers, rooms, duration, month, etc.)
- Item detail view, wishlist toggle, and reviews per item
- Signup / login / forgot-password / reset-password
- Contact form (persisted to the database and visible in the admin console)
- Newsletter signup

**Account Center (`index.html`, logged-in customers)**
- No separate dashboard page — logged-in customers get a profile chip in the header (MakeMyTrip-style)
  whose dropdown opens an Account Center modal over the homepage
- Booking history with a status timeline and a receipt/confirmation modal showing payment details
- Cancel a booking (triggers an automatic mock refund)
- Wishlist management
- Notifications inbox (mark read / delete)
- My Reviews (create / edit / delete)
- Support tickets (raise / view)
- Profile update (including mobile, gender, DOB, address) and password change

**Admin console (`admin.html`)**
- Dashboard KPIs, monthly revenue/bookings charts (Chart.js), and a full reports/CSV export tool
- Generic CRUD for flights, hotels, cruises, and tour packages
- Paginated management tables for users, bookings, payments, contact messages, reviews, wishlist
  entries, and activity logs
- Send notifications to a single user or broadcast to all users
- Read-only activity log with search/filter by action

**Cross-cutting**
- JWT access/refresh authentication with role-based access control (user vs. admin)
- Server-side price recalculation and inventory validation on every booking (the client's
  submitted price is never trusted)
- Pagination on every admin list endpoint
- XSS-safe rendering of all user-generated content on the frontend

## Technology Stack

| Layer | Technology |
|---|---|
| Backend framework | FastAPI (Python 3.11+) |
| ORM | SQLAlchemy 2.0 (`Mapped`/`mapped_column` style) |
| Database | PostgreSQL |
| Migrations | Alembic |
| Validation | Pydantic v2 |
| Auth | JWT (`python-jose`) + bcrypt password hashing (`passlib`) |
| Frontend | Static HTML5 / CSS3 / vanilla JavaScript (no build step) |
| HTTP client | Axios (CDN) |
| Charts | Chart.js (CDN) |
| Dev server | `uvicorn` (backend), Python `http.server` (frontend) |

## Folder Structure

```
TOURS AND TRAVEL/
├── index.html                  Public site + logged-in Account Center — search, details, auth,
│                                contact, wishlist, reviews, bookings, payments, notifications, profile
├── admin.html                  Admin console — CRUD, reports, charts, moderation, pagination
├── README.md
└── backend/
    ├── requirements.txt
    ├── .env.example
    ├── alembic.ini
    ├── alembic/
    │   ├── env.py
    │   └── versions/           Migration history (0001 → 0007, see below)
    └── app/
        ├── main.py             FastAPI app instance, CORS, router registration
        ├── config.py           Pydantic-settings environment configuration
        ├── auth/
        │   ├── security.py     Password hashing, JWT encode/decode, reset tokens
        │   └── deps.py         get_current_user / get_current_admin dependencies
        ├── database/
        │   └── session.py      SQLAlchemy engine/session setup
        ├── models/              SQLAlchemy ORM models (user, travel, booking, misc)
        ├── schemas/             Pydantic request/response schemas, incl. generic Page[T]
        ├── routers/             FastAPI routers, one per resource group
        └── services/            Business logic, called by routers
```

## Prerequisites

- Python 3.11+
- PostgreSQL 14+ (local install, or a cloud instance such as Neon or Railway)
- A modern browser

## Installation

```bash
git clone <repository-url>
cd "TOURS AND TRAVEL"
cd backend
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
```

## PostgreSQL Setup

Create the database (adjust the version number in the path to whatever you installed; on Windows,
`createdb`/`psql` live inside the PostgreSQL install folder and aren't on `PATH` by default):

```powershell
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres jackpotsworldtours
```

On macOS/Linux, `createdb` is usually already on `PATH`:

```bash
createdb -U postgres jackpotsworldtours
```

You'll be prompted for the `postgres` user's password.

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in your own values:

```bash
cd backend
copy .env.example .env          # Windows
# cp .env.example .env          # macOS/Linux
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string, e.g. `postgresql+psycopg2://postgres:PASSWORD@127.0.0.1:5432/jackpotsworldtours`. URL-encode special characters in the password (`@` → `%40`). |
| `JWT_SECRET_KEY` | Yes | Long random secret used to sign JWTs. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`. Never reuse the example value. |
| `JWT_ALGORITHM` | No (default `HS256`) | JWT signing algorithm. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No (default `30`) | Access token lifetime. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | No (default `7`) | Refresh token lifetime. |
| `CORS_ORIGINS` | No (has a dev default) | Comma-separated list of frontend origins allowed to call the API. Must include whatever origin you serve the frontend from. |
| `ADMIN_SEED_EMAIL` | No | Email for the admin account created by the seed migration. Defaults to `admin@jackpotsworldtours.com`. |
| `ADMIN_SEED_PASSWORD` | No | Password for the seeded admin account. If unset, a random password is generated and printed once to the migration's console output — capture it there, since it isn't stored anywhere else in plaintext. |

## Alembic Migrations

The schema is fully managed by Alembic — never modify the database by hand. Migration history:

| Revision | Purpose |
|---|---|
| `0001_initial_schema` | Base schema: roles, users, flights, hotels, cruises, packages, bookings, payments, contact/newsletter/reviews/wishlist/notifications/activity_logs |
| `0002_seed_content` | Seed sample flights, hotels, cruises, and tour packages |
| `0003_seed_admin` | Seed the admin role and admin account (see [Default Admin Setup](#default-admin-setup)) |
| `0004_package_month_and_booking_quantity` | Adds `tour_packages.available_month` and `bookings.quantity` |
| `0005_user_delete_fk_behavior` | Sets explicit `ondelete` behavior per foreign key (CASCADE for owned data, SET NULL for audit trails, RESTRICT for financial records) |
| `0006_add_performance_indexes` | Adds indexes on frequently filtered/joined columns (booking/payment/review/notification/activity-log lookups) |
| `0007_wishlist_review_unique_constraints` | Adds `UNIQUE(user_id, item_type, item_id)` on wishlist and reviews to prevent duplicates under concurrent requests |

Apply all migrations:

```bash
venv\Scripts\python.exe -m alembic upgrade head
```

This creates every table and seeds two roles, sample catalog content, and one admin account.

To generate a new migration after changing a model:

```bash
venv\Scripts\python.exe -m alembic revision --autogenerate -m "describe your change"
venv\Scripts\python.exe -m alembic upgrade head
```

## Running the Backend

```bash
cd backend
venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

The API is now running at `http://127.0.0.1:8000`. Interactive Swagger docs are at
`http://127.0.0.1:8000/docs`, and ReDoc at `http://127.0.0.1:8000/redoc`.

## Running the Frontend

The frontend is static HTML — it must be served over HTTP (not opened as a `file://` path), so
the browser will allow API calls to the backend. From the project root, in a separate terminal:

```bash
python -m http.server 5500
```

Then open `http://127.0.0.1:5500/index.html`.

> The backend's `CORS_ORIGINS` already allows `http://127.0.0.1:5500` and `http://localhost:5500`
> by default. If you serve the frontend on a different port, add it to `CORS_ORIGINS` in
> `backend/.env` and restart the backend.

**Running both together** — you need two terminals open at the same time:

| Terminal | Command | Runs on |
|---|---|---|
| 1 — Backend | `cd backend && venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000` | http://127.0.0.1:8000 |
| 2 — Frontend | `python -m http.server 5500` (from project root) | http://127.0.0.1:5500 |
Then visit `http://127.0.0.1:5500/index.html` — sign up, log in, search, book, and (as the seeded
admin) manage everything from `admin.html`.

## Default Admin Setup

The `0003_seed_admin` migration creates one admin account:

- **Email**: `admin@jackpotsworldtours.com`, or whatever you set via `ADMIN_SEED_EMAIL`
- **Password**: whatever you set via `ADMIN_SEED_PASSWORD`, or — if left unset — a cryptographically
  random password that is generated and printed **once** to the migration's console output

**Change the seeded admin's password after your first login**, from the profile/change-password
flow. No password is ever hardcoded in source control.

## API Documentation

Every endpoint is documented with a summary, description, request/response models, and status
codes, browsable via the interactive Swagger UI at `/docs` once the backend is running. Key
resource groups:

| Prefix | Purpose |
|---|---|
| `/api/auth` | Signup, login, refresh, logout, forgot/reset password, current-user profile |
| `/api/flights`, `/api/hotels`, `/api/cruises`, `/api/packages` | Public catalog browsing + search filters; admin-only create/update/delete |
| `/api/bookings`, `/api/payments` | Create/cancel bookings, view booking & payment history |
| `/api/wishlist` | Add/remove/list wishlist entries |
| `/api/reviews` | Create/edit/delete reviews, list reviews per item |
| `/api/notifications` | List/mark-read/delete the current user's notifications |
| `/api/users/me`, `/api/users/change-password` | Self-service profile management |
| `/api/contact`, `/api/newsletter` | Public contact form and newsletter signup |
| `/api/admin/*` | Admin-only: paginated management of users, bookings, payments, contact messages, reviews, wishlist, notifications, activity logs, plus reports and CSV export |

## Screenshots

> Add screenshots here before sharing/demoing the project.

| Page | Screenshot |
|---|---|
| Public homepage | `docs/screenshots/homepage.png` |
| Search results | `docs/screenshots/search-results.png` |
| Booking confirmation | `docs/screenshots/booking-confirmation.png` |
| User dashboard | `docs/screenshots/user-dashboard.png` |
| Admin dashboard | `docs/screenshots/admin-dashboard.png` |
| Admin reports/charts | `docs/screenshots/admin-reports.png` |

## Deployment

### Backend

1. Provision a PostgreSQL database (e.g. Neon, Railway, Render, or a managed instance).
2. Set the environment variables from the [table above](#environment-variables) on your hosting
   platform — at minimum `DATABASE_URL`, `JWT_SECRET_KEY`, and `CORS_ORIGINS` (pointing at your
   deployed frontend's origin).
3. Install dependencies (`pip install -r requirements.txt`) and run migrations
   (`alembic upgrade head`) as part of your deploy step.
4. Run the app with a production ASGI server, e.g.:
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port $PORT
   ```
   For a platform that expects a Procfile/start command (Render, Railway, Fly.io, etc.), use the
   same command with your platform's assigned port variable.
5. Confirm `/api/health` returns `{"status": "ok"}` once deployed.

### Frontend

The three HTML files are fully static — no build step. Deploy them as-is to any static host
(Netlify, Vercel, GitHub Pages, S3 + CloudFront, etc.).

1. Update `API_BASE` at the top of each HTML file's `<script>` block to your deployed backend URL.
2. Add the deployed frontend's origin to the backend's `CORS_ORIGINS`.
3. Upload/deploy `index.html`, `login.html`, `register.html`, `forgot-password.html`,
   `reset-password.html`, and `admin.html` (and any `assets/` referenced by them) to your static host.

## Future Enhancements

- Real email delivery for password-reset links (currently returned directly in the API response,
  since no email provider is wired up)
- A real payment gateway integration in place of the current mock payment flow
- Round-trip flight modeling and per-date hotel/cruise inventory (current availability checks are
  per-listing, not per-date)
- Rate limiting on authentication endpoints
- Automated test suite (unit + integration) and CI pipeline
