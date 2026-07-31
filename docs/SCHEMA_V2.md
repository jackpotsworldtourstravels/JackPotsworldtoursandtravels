# Schema v2 — the nine-table design

Applied by migration `0023_nine_table_redesign`. Replaces the legacy schema
(39 business tables, 4 history/bookkeeping tables, 5 views, 36 stored
procedures, 17 enums) with nine tables.

- DDL: `backend/db/schema_v2/01_drop_legacy_schema.sql`, `02_nine_table_schema.sql`
- ORM: `backend/app/models_v2.py`
- Migration: `backend/alembic/versions/0023_nine_table_redesign.py`

## The nine tables

| # | Table | Why it exists |
|---|---|---|
| 1 | `users` | One identity table for every human — super admin, admin, merchant staff, retail customer. Role, permission set, and in-flight OTP live here. |
| 2 | `merchants` | The B2B partner company. Owns its wallet, credit limit, and its own booking-reference series. |
| 3 | `service_requests` | Catalog inventory, bookings, and every request raised against a booking. Discriminated by `request_type`, linked by `parent_request_id`. |
| 4 | `payments` | Money movement, plus the coupon/discount that applied and any refund. |
| 5 | `passenger_data` | Travellers on a request, with ancillary selections. |
| 6 | `communication_settings` | Per-merchant channel preferences. One row per merchant. |
| 7 | `msg_logs` | Every message in or out, on any channel. |
| 8 | `system_logs` | Sessions, activity, login history, report generation. |
| 9 | `audit_logs` | Row-level before/after history, written by trigger. |

## Entity relationships

```
users ────────────< service_requests >──────── merchants
  │                      │    │                    │
  │                      │    └──< passenger_data  │
  │                      │                         │
  │                      ├──< payments             │
  │                      │                         │
  │                      └──< msg_logs             │
  │                                                │
  ├──< system_logs                                 │
  ├──< audit_logs                                  │
  └────────────────────────────────────────────────┘
       users.merchant_id ──> merchants
       merchants.created_by ──> users   (added by ALTER; breaks the cycle)

service_requests.parent_request_id ──> service_requests   (self-referencing)
merchants ──1:1──> communication_settings
```

The self-reference on `service_requests` is what makes the seven-table merge
work. It is not optional:

| Row | `parent_request_id` points at |
|---|---|
| `booking` | the `catalog_item` being purchased |
| `cancellation` / `refund` / `date_change` / `passenger_modification` | the `booking` being modified |
| `review` / `wishlist` | the `catalog_item` |

A `CHECK` constraint enforces that the four modification types always name a
parent, so an orphaned refund cannot be inserted.

## Mapping: legacy → v2

| Legacy table | Lands in | How |
|---|---|---|
| `users` | `users` | direct |
| `roles` | `users.role` | enum column |
| `permissions` | `users.permissions` | JSONB array of codes |
| `role_permissions` | `users.permissions` | flattened per user |
| `partner_users` | `users` | `role='merchant_admin'/'merchant_user'`, `merchant_id` set |
| `partner_otp_requests` | `users.otp_*` + `msg_logs` | current OTP on the user, delivery history to `msg_logs` |
| `partners` | `merchants` | direct |
| `booking_reference_counters` | `merchants.reference_prefix` + `.booking_sequence` | per-merchant counter |
| `flights` / `hotels` / `cruises` / `tour_packages` | `service_requests` | `request_type='catalog_item'`, attributes in `travel_details` |
| `seasonal_prices` | `service_requests.pricing` | JSONB snapshot |
| `ancillary_service_catalog` | `passenger_data.special_services` | JSONB array |
| `bookings` | `service_requests` | `request_type='booking'` |
| `partner_bookings` | `service_requests` | same, `merchant_id` set |
| `service_requests` | `service_requests` | direct |
| `cancellation_requests` | `service_requests` | `request_type='cancellation'` |
| `refund_requests` | `service_requests` | `request_type='refund'` |
| `date_change_requests` | `service_requests` | `request_type='date_change'`, old/new dates in `travel_details` |
| `passenger_modification_requests` | `service_requests` | `request_type='passenger_modification'` |
| `support_tickets` | `service_requests` | `request_type='support_ticket'` |
| `reviews` | `service_requests` | `request_type='review'`, `rating` column |
| `wishlist` | `service_requests` | `request_type='wishlist'` |
| `partner_booking_status_history` | `service_requests.status_history` | JSONB array |
| `service_request_status_history` | `service_requests.status_history` | JSONB array |
| `partner_booking_passengers` | `passenger_data` | direct |
| `cancellation_request_passengers` | `passenger_data.is_cancelled` | flag, not a table |
| `passenger_special_services` | `passenger_data.special_services` | JSONB array |
| `payments` | `payments` | direct |
| `partner_payments` | `payments` | `merchant_id` set |
| `coupons` | `payments.coupon_code` + `.discount_amount` | recorded on the consuming payment |
| `discount_campaigns` | `payments.discount_meta` | JSONB snapshot |
| `notifications` | `msg_logs` | `message_type='notification'` |
| `partner_notifications` | `msg_logs` | same, `merchant_id` set |
| `newsletter` | `msg_logs` | `message_type='newsletter'` |
| `contact_us` | `msg_logs` | `message_type='contact_us'`, `direction='inbound'` |
| `activity_logs` | `system_logs` | direct |
| `user_sessions` | `system_logs.session_token` + `.session_expires_at` | a login row *is* the session |
| `report_generation_log` | `system_logs` | `module='reports'` |
| `partner_audit_logs` | `audit_logs` | direct |
| `countries` | `merchants.country`/`country_code`, `passenger_data.nationality` | denormalised to text |

## Application modules that must be rewritten

The schema is swapped; the application is not. Nothing below has been
changed yet, and until it is, only `/api/health` works.

| Layer | Path | Work |
|---|---|---|
| Models | `backend/app/models/` | Delete; replaced by `app/models_v2.py` |
| Schemas | `backend/app/schemas/` | Rewrite Pydantic models around `request_type` discrimination |
| Routers | `backend/app/routers/` | `flights`/`hotels`/`cruises`/`packages` collapse into one catalog router filtered by `travel_type`; `bookings`, `reviews`, `wishlist`, `support_tickets` all become `service_requests` queries |
| Partner routers | `backend/app/routers/partner_*.py` | Rewrite: the 36 stored procedures they call no longer exist |
| Services | `backend/app/services/partner_*.py` | These are thin `SELECT sp_xxx(...)` wrappers — the logic must move into Python or be rewritten as new procedures |
| Auth | `backend/app/auth/partner_deps.py` | Partner JWT scope now resolves against `users.role` + `users.merchant_id` rather than a separate `partner_users` table |
| Frontend | `frontend/assets/js/*.js` | Response shapes change wherever a catalog item or booking is rendered |

Stored procedures were dropped with the legacy schema. The Partner Portal's
business logic lived almost entirely inside them, so that portal needs the
most work.

## Trade-offs

Three places where "exactly nine tables" and "properly normalised, avoid
duplicated data" pull against each other. Documenting rather than hiding them:

**1. Catalog inventory as `service_requests` rows.** A flight is not a
request — it is a product that exists whether or not anyone books it. Storing
it as `request_type='catalog_item'` means the catalog and the transaction log
share a table, indexes, and constraint surface. Mitigated with a partial index
(`ix_sr_catalog_live`) and a `CHECK` that catalog rows carry no owner, but a
separate `catalog` table would be the correct design. This is the largest
compromise the nine-table limit forces.

**2. Type-specific fields in JSONB.** A flight has an airline and a cabin
class; a hotel has a star rating and amenities. One table cannot hold typed
columns for all four travel types without ~40 mostly-NULL columns, so they
live in `travel_details`. Cost: no per-field foreign keys, no per-field NOT
NULL, and filtering needs GIN indexes rather than B-tree. Acceptable because
these fields are read as a unit and rarely filtered individually.

**3. Coupons only exist once redeemed.** `coupons` and `discount_campaigns`
were catalogues of *offers*; `payments.coupon_code` records only the offer
that was used. There is nowhere to define a coupon before anyone redeems it,
so validity windows and usage caps have to be enforced in application code
instead of by the database. If coupon management is a demo requirement, this
is the mapping most likely to need revisiting.

Also lossy: `countries` was a 190-row reference table with ISO codes; country
is now free text on `merchants` and `passenger_data`, so nothing prevents
"Inida". A CHECK against a fixed list would help without adding a table.
