# Multi-Segment Flight Booking Architecture (Bugs 2 & 5)

**Date:** 2026-11-20
**Status:** implementation (isolated worktree, disposable data, mocked providers).
**Root cause addressed:** `customer_bookings` stored **one flight per booking**
(a single `flight_number`/origin/destination, one fare, one payment, one
e-ticket). That single fact blocked multi-city (Bug 2) and round-trip (Bug 5):
a journey of more than one flight had nowhere to live, so the UI dead-ended and
round-trip checkout was deliberately blocked rather than take money for an
itinerary the model could not hold.

## Design — additive, backward compatible

A booking becomes an **envelope** that owns **1..N segments**. One flight is
simply the N=1 case, so legacy one-way bookings are unchanged in shape and
behaviour.

### `customer_bookings` (the envelope) — additive change
- **New** `journey_type` — `one_way` | `round_trip` | `multi_city`
  (default `one_way`, so every existing row is a valid one-way booking).
- The existing per-flight columns (`airline`, `flight_number`,
  `origin_*`/`destination_*`, `travel_date`, …) are **kept** and hold a
  **journey summary**: the first segment's airline/flight and departure, the
  first segment's origin, and the **last** segment's destination. Every reader
  that predates segments (admin screens, the confirmation notification,
  existing history) keeps working and shows a sensible origin→final-destination.
- `total_amount` and the fare breakdown remain the **authoritative booking
  total** — now the **sum across all segments**.

### `customer_booking_segments` (new) — one row per flight
- Identity/itinerary per leg (airline, flight number, origin/destination,
  date, times, cabin, international).
- **Per-leg fare breakdown** (`base_fare … total_amount`), so the envelope's
  total is a verifiable sum of its parts.
- `pnr` per leg (NULL until a GDS issues one — never invented locally, same
  rule as the envelope), `status`, and `seats_json`/`addons_json` for per-leg
  extras.
- `UNIQUE(customer_booking_id, segment_index)`.

Passengers stay **per booking** (`customer_booking_passengers`) — the same
party flies every leg of a round-trip/multi-city journey.

### Backfill
Every existing `customer_bookings` row gets exactly one segment (index 0)
copying its flight + fare fields, so one-way history reads through the same
segment path as everything else. No row is rewritten; the envelope columns are
untouched.

## Why payment safety is automatic

`payment_verification_flight_service.confirm_booking` already refuses to confirm
unless the **captured amount equals the booking's own `total_amount` to the
paisa** (no partial payments). Because the envelope's `total_amount` is the
server-computed **sum of every segment**, a multi-segment booking is confirmed
only when the customer has paid the exact total for **all** segments — the
"payment amount equals the server-calculated total across all segments"
requirement is enforced by the existing guard, not by new trusted code. The
client never sends an amount; `create_multi_segment_booking` reprices each
segment through `customer_pricing_service.quote` and sums the results.

## Repricing & coupons
Each segment is priced independently through the same `quote()` the one-way
flow uses (fare × cabin × party, seats, add-ons). A booking-level coupon is
applied to the **first segment only**, so a journey earns one discount, not one
per leg. The envelope's discount/total are the sums.

## Lifecycle (unchanged envelope paths)
- **Create** → envelope `pending`, segments written, total = Σ segments.
- **Pay** → one payment for `booking.total_amount` (the sum).
- **Confirm** → existing `confirm_booking` verifies amount == Σ segments.
- **Ticket** → per-segment `pnr` when a GDS issues one (NULL today, honest).
- **History** → the booking response carries its segments (all legs shown).
- **Cancel/Refund** → envelope-level, exactly as a one-way booking; the
  captured payment is the refundable amount. Segments cascade with the booking.

## Downgrade
Drops the segments table and `journey_type`. One-way bookings are fully intact
(their single segment only mirrored the envelope). A booking with more than one
segment collapses to its first-segment summary (the envelope columns already
hold it) — the extra legs cannot be represented in the single-flight model, so
this is the one lossy case, acceptable for a reversible dev migration and noted
here.
