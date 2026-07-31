# Phase 1 — PostgreSQL Database Setup (JackPots World Tours & Travels)

**Status: Historical record.** This document captures the original,
hand-built PostgreSQL schema created directly in `psql`/pgAdmin before the
FastAPI backend, SQLAlchemy models, or Alembic migrations existed. It is the
starting point that later informed the approved
[9-table redesign](DATABASE_REDESIGN_9TABLE.md) — kept here for reference,
not as a description of the current live schema (see
[`backend/db/README.md`](../backend/db/README.md) for what's actually
applied today).

---

## Table of Contents

1. [Database Verification](#1-database-verification)
2. [Table Creation](#2-table-creation)
3. [Sample Data](#3-sample-data)
4. [Verification Queries](#4-verification-queries)
5. [Indexes](#5-indexes)
6. [Views](#6-views)
7. [Triggers](#7-triggers)
8. [Stored Functions](#8-stored-functions)
9. [Common Update Statements](#9-common-update-statements)
10. [Final Database Objects Summary](#10-final-database-objects-summary)
11. [Next Phase — FastAPI Backend](#11-next-phase--fastapi-backend)

---

## 1. Database Verification

**Confirm the target database:**

```sql
SELECT current_database();
```

**Confirm no tables exist yet (clean slate):**

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public';
```

---

## 2. Table Creation

Nine core tables were created, in dependency order:

| # | Table | Purpose |
|---|-------|---------|
| 1 | `users` | Super Admin, Admin, and Merchant user accounts; login credentials |
| 2 | `merchants` | Merchant profile, wallet balance, company information |
| 3 | `service_requests` | Bookings, ticket enquiries, cancellations, refunds, date changes, passenger modifications |
| 4 | `payments` | Payments, refunds, wallet transactions, transaction history |
| 5 | `passenger_data` | Passenger details, passport, nationality, meal/seat preferences |
| 6 | `communication_settings` | Email, SMS, WhatsApp, OTP, push notification preferences |
| 7 | `msg_logs` | Email/SMS/OTP logs, live chat, WhatsApp message logs |
| 8 | `system_logs` | Login logs, API logs, report logs, browser/device/IP metadata |
| 9 | `audit_logs` | Database change history (INSERT/UPDATE/DELETE) |

**Foreign key relationship:**

```
users.merchant_id  →  merchants.merchant_id
```

---

## 3. Sample Data

Seed records were created for each table to validate the schema end-to-end:

- Merchant
- Super Admin
- Booking
- Payment
- Passenger
- Communication settings
- Message log
- System log
- Audit log

---

## 4. Verification Queries

**List all tables:**

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public';
```

**Count all tables:**

```sql
SELECT COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'public';
```

**Inspect table contents:**

```sql
SELECT * FROM users;
SELECT * FROM merchants;
SELECT * FROM service_requests;
SELECT * FROM payments;
SELECT * FROM passenger_data;
SELECT * FROM communication_settings;
SELECT * FROM msg_logs;
SELECT * FROM system_logs;
SELECT * FROM audit_logs;
```

---

## 5. Indexes

| Table | Indexed Columns |
|-------|------------------|
| `users` | Email, Role, Merchant |
| `merchants` | Merchant Name, Status |
| `service_requests` | Merchant, User, Booking Reference, Status, Request Type |
| `payments` | Merchant, Request, Transaction ID, Status |
| `passenger_data` | Passport, Request, Passenger Name |
| `msg_logs` | User, Request, Status, Message Type |
| `system_logs` | User, Module, Action |
| `audit_logs` | Table Name, Record ID, Operation |

25+ indexes total.

---

## 6. Views

| View | Purpose |
|------|---------|
| `vw_merchant_dashboard` | Merchant Dashboard |
| `vw_booking_summary` | Booking Summary |
| `vw_payment_report` | Payment Report |
| `vw_passenger_report` | Passenger Report |
| `vw_message_report` | Message Report |

**Verify views:**

```sql
SELECT table_name
FROM information_schema.views
WHERE table_schema = 'public';
```

---

## 7. Triggers

### `update_updated_at_column()`

Automatically refreshes the `updated_at` column whenever a row changes.
Applied to:

- `users`
- `merchants`
- `service_requests`
- `payments`
- `passenger_data`
- `communication_settings`

### `log_audit_update()`

Generic audit trigger for logging row changes.

> ⚠️ **Needs redesign.** The generic, one-size-fits-all trigger ran into
> issues and was flagged to be rewritten on a per-table basis rather than as
> a single shared function.

---

## 8. Stored Functions

| Function | Purpose |
|----------|---------|
| `get_merchant_balance()` | Return a merchant's current wallet balance |
| `get_total_requests()` | Total service request count |
| `get_total_revenue()` | Total revenue across payments |
| `get_total_passengers()` | Total passenger count |
| `create_booking_request()` | Create a new booking/service request |
| `approve_booking()` | Approve a pending booking |
| `cancel_booking()` | Cancel a booking |
| `process_refund()` | Process a refund against a payment |
| `add_passenger()` | Attach a passenger record to a request |
| `record_payment()` | Record a payment transaction |
| `merchant_dashboard()` | Aggregate merchant dashboard statistics |

---

## 9. Common Update Statements

**Update a payment:**

```sql
UPDATE payments
SET
    amount = 30000.00,
    payment_method = 'UPI',
    payment_status = 'SUCCESS',
    transaction_id = 'TXN123456789',
    payment_date = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE payment_id = 1;
```

**Update booking status:**

```sql
UPDATE service_requests
SET status = 'APPROVED'
WHERE request_id = 1;
```

**Update merchant details:**

```sql
UPDATE merchants
SET city = 'Bengaluru'
WHERE merchant_id = 1;
```

---

## 10. Final Database Objects Summary

| Object | Count |
|---|---:|
| Tables | 9 |
| Views | 5 |
| Trigger functions | 1 |
| Audit function | 1 (flagged for redesign) |
| Stored functions | 11 |
| Indexes | 25+ |

---

## 11. Next Phase — FastAPI Backend

With the PostgreSQL schema in place, the planned roadmap moved to the
application layer:

1. SQLAlchemy models
2. Alembic migrations
3. Pydantic schemas
4. CRUD layer
5. FastAPI APIs
6. JWT authentication
7. Merchant Dashboard APIs
8. Admin Dashboard APIs
9. Super Admin Dashboard APIs

This took the project from a bare database layer to a working FastAPI
backend — see [`backend/db/README.md`](../backend/db/README.md) and
[`docs/DATABASE_REDESIGN_9TABLE.md`](DATABASE_REDESIGN_9TABLE.md) for how the
schema has evolved since this initial setup.
