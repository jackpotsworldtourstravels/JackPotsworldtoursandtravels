"""Rebuild the B2C Admin Portal DEMO on the disposable ``jackpots_hrdemo`` DB.

ONE repeatable, IDEMPOTENT seeder that combines three earlier throwaway scripts
(grant B2C scopes, seed demo B2C data, seed demo suppliers) into a single step so
the demo can be rebuilt with one command before a walkthrough.

    # from the repo root, with the demo DB in DATABASE_URL (overrides .env):
    DATABASE_URL='postgresql+psycopg2://postgres:...@127.0.0.1:5432/jackpots_hrdemo' \
        backend/venv/Scripts/python.exe backend/scripts/seed_hrdemo_demo.py

PREREQUISITES (this script does NOT run them):
  * ``alembic upgrade head`` has been run on jackpots_hrdemo (needs 0095 for the
    B2C audit trail), and
  * a super-admin exists (the app's ``ensure_default_admin`` start-up hook, or
    migration 0003, seeds one). The demo ``admin`` login is created here if it is
    missing, attributed to that super-admin exactly as ``seed_account.py`` does.

SAFETY — this script is deliberately narrow:
  * It ABORTS unless the connected database is named EXACTLY ``jackpots_hrdemo``.
    ``jackpots_v2`` (or anything else) is refused before a session is opened, so
    it cannot touch production or the permanent dev DB.
  * It is IDEMPOTENT. A second run creates no duplicate customers, bookings,
    payments, reviews, tickets, notifications or suppliers, and grants no
    permission the demo admin does not already hold.
  * It writes ONLY rows (via the ORM). It never sends an email, SMS, push,
    notification, payment or supplier request; it never enables Gaming; it never
    edits ``.env``, application source, migrations or other seed scripts; and it
    never commits/pushes/deploys anything.
  * The only permission change is granting the demo admin the existing B2C scope
    set (``rbac.B2C_SCOPES``) — nothing beyond the established demo setup.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

#: backend/scripts/seed_hrdemo_demo.py -> scripts -> backend
BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.config import settings  # noqa: E402

# --------------------------------------------------------------------------- #
# STRICT SAFETY GATE — runs before any database session is opened.
# --------------------------------------------------------------------------- #
REQUIRED_DB_NAME = "jackpots_hrdemo"
FORBIDDEN_SUBSTRINGS = ("jackpots_v2",)

DEMO_ADMIN_EMAIL = "demo.admin@jackpotsworldtours.com"
DEMO_ADMIN_NAME = "Demo Admin"
#: Only applied when the admin is CREATED (i.e. missing). An existing admin's
#: password is never touched. Override with JPW_SEED_PASSWORD if you prefer.
DEMO_ADMIN_PASSWORD = os.environ.get("JPW_SEED_PASSWORD") or "DemoAdmin#2026"


def _abort(msg: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"REFUSING: {msg}", file=sys.stderr)
    raise SystemExit(2)


def _safety_check() -> None:
    """Abort unless the connected DB is exactly ``jackpots_hrdemo``."""
    raw = settings.database_url
    try:
        db_name = make_url(raw).database
    except Exception as exc:  # pragma: no cover - defensive
        _abort(f"could not parse DATABASE_URL ({exc}).")
    for bad in FORBIDDEN_SUBSTRINGS:
        if bad in raw:
            _abort(f"DATABASE_URL names {bad!r}; this script only targets {REQUIRED_DB_NAME!r}.")
    if db_name != REQUIRED_DB_NAME:
        host = raw.split("@")[-1] if "@" in raw else raw
        _abort(
            f"connected database is {db_name!r} (…@{host}); "
            f"this script only runs against {REQUIRED_DB_NAME!r}."
        )


_safety_check()

# Imports that touch the DB engine come AFTER the gate has passed.
from app.database.session import SessionLocal  # noqa: E402
import app.models_customer as m  # noqa: E402
import app.models_v2 as mv  # noqa: E402
from app.auth.rbac import B2C_SCOPES  # noqa: E402
from app.services import account_service  # noqa: E402

NOW = dt.datetime.now(dt.timezone.utc)


def _dec(x) -> Decimal:
    return Decimal(str(x))


def _status_member(enum_cls, *names):
    for n in names:
        if hasattr(enum_cls, n):
            return getattr(enum_cls, n)
    return list(enum_cls)[0]


# --------------------------------------------------------------------------- #
# 1) Demo admin login + B2C scope grant (idempotent).
# --------------------------------------------------------------------------- #
def ensure_admin_and_grant(db) -> None:
    user = db.execute(
        select(mv.User).where(mv.User.email == DEMO_ADMIN_EMAIL)
    ).scalar_one_or_none()

    if user is None:
        actor = db.execute(
            select(mv.User).where(mv.User.role == mv.UserRole.SUPER_ADMIN)
        ).scalars().first()
        if actor is None:
            print(
                "  admin: SKIPPED — no super-admin to attribute creation to. "
                "Start the app once (seeds one) or run seed_account.py, then re-run.",
                file=sys.stderr,
            )
            return
        user, _issued = account_service.create_admin(
            db, actor, full_name=DEMO_ADMIN_NAME, email=DEMO_ADMIN_EMAIL,
            phone=None, password=DEMO_ADMIN_PASSWORD, role=mv.UserRole.ADMIN,
        )
        print(f"  admin: created {DEMO_ADMIN_EMAIL} (password: the one supplied/default)")

    existing = set(user.permissions or [])
    merged = sorted(existing | set(B2C_SCOPES))
    if merged != sorted(existing):
        user.permissions = merged
        db.add(user)
        db.commit()
        print(f"  admin: granted B2C scopes; row now holds {len(merged)} explicit codes")
    else:
        print(f"  admin: B2C scopes already present ({len(existing)} codes) - no change")


# --------------------------------------------------------------------------- #
# 2) Demo B2C data (customers, flight bookings, payments, reviews, tickets,
#    notifications). Guarded: if any @hrdemo.test customer exists, skip wholly.
# --------------------------------------------------------------------------- #
CUSTOMERS = [
    ("Aarav Sharma", "+919812300001", "Mumbai", "Maharashtra", ("ACTIVE",)),
    ("Priya Nair", "+919812300002", "Kochi", "Kerala", ("ACTIVE",)),
    ("Rohan Mehta", "+919812300003", "Ahmedabad", "Gujarat", ("ACTIVE",)),
    ("Fatima Khan", "+919812300004", "Hyderabad", "Telangana", ("ACTIVE",)),
    ("Vikram Reddy", "+919812300005", "Bengaluru", "Karnataka", ("BLOCKED", "SUSPENDED", "INACTIVE")),
    ("Ananya Das", "+919812300006", "Kolkata", "West Bengal", ("ACTIVE",)),
]

# (airline, flno, o_code, o_city, d_code, d_city, intl, status, days_from_now, base, tax, paid)
FLIGHTS = [
    ("IndiGo", "6E-234", "BOM", "Mumbai", "GOI", "Goa", False, "confirmed", 14, 4200, 900, True),
    ("Air India", "AI-101", "DEL", "Delhi", "BOM", "Mumbai", False, "completed", -21, 6800, 1200, True),
    ("Vistara", "UK-995", "BLR", "Bengaluru", "DXB", "Dubai", True, "confirmed", 30, 18500, 3400, True),
    ("SpiceJet", "SG-8721", "HYD", "Hyderabad", "MAA", "Chennai", False, "pending", 9, 3100, 650, False),
    ("IndiGo", "6E-5012", "CCU", "Kolkata", "GOI", "Goa", False, "cancelled", 5, 5200, 1100, False),
    ("Emirates", "EK-507", "COK", "Kochi", "DXB", "Dubai", True, "confirmed", 45, 22000, 4100, True),
]


#: A sign-in-capable demo customer for the Live Chat walkthrough. The bulk
#: demo customers use ``@hrdemo.test`` (clearly synthetic), but EmailStr rejects
#: the reserved ``.test`` TLD, so those accounts cannot finish customer-site
#: sign-in. ``example.com`` is the IANA-reserved documentation domain: valid to
#: EmailStr, guaranteed non-deliverable, and unmistakably synthetic.
CHAT_DEMO_EMAIL = "demo.chat@example.com"


def ensure_chat_demo_customer(db) -> None:
    c = db.execute(
        select(m.Customer).where(m.Customer.email == CHAT_DEMO_EMAIL)
    ).scalar_one_or_none()
    if c is not None:
        print("  chat customer: already present - skipped (idempotent)")
        return
    c = m.Customer(
        customer_code="HRDCHAT01", full_name="Demo Chat User", email=CHAT_DEMO_EMAIL,
        mobile="+919812300099", status=_status_member(m.CustomerStatus, "ACTIVE"),
        email_verified=True, mobile_verified=True, created_at=NOW - dt.timedelta(days=5),
    )
    c.profile = m.CustomerProfile(city="Hyderabad", state="Telangana", country="India")
    db.add(c)
    db.commit()
    print(f"  chat customer: created {CHAT_DEMO_EMAIL} (Live Chat demo sign-in)")


def seed_demo_data(db) -> None:
    existing = db.execute(
        select(func.count()).select_from(m.Customer).where(m.Customer.email.like("%@hrdemo.test"))
    ).scalar_one()
    if existing:
        print(f"  data:  demo customers already present ({existing}) - skipped (idempotent)")
        return

    active = _status_member(m.CustomerStatus, "ACTIVE")  # noqa: F841 (kept for parity/clarity)
    customers = []
    for i, (name, mobile, city, state, status_names) in enumerate(CUSTOMERS, start=1):
        first = name.split()[0].lower()
        st = _status_member(m.CustomerStatus, *status_names)
        c = m.Customer(
            customer_code=f"HRD{i:05d}",
            full_name=name,
            email=f"{first}.{i}@hrdemo.test",
            mobile=mobile,
            status=st,
            email_verified=True,
            mobile_verified=True,
            created_at=NOW - dt.timedelta(days=40 - i * 3),
        )
        c.profile = m.CustomerProfile(city=city, state=state, country="India")
        db.add(c)
        customers.append(c)
    db.flush()

    for j, (airline, flno, oc, ocity, dc, dcity, intl, bstatus, days, base, tax, paid) in enumerate(FLIGHTS):
        cust = customers[j % len(customers)]
        base_d, tax_d = _dec(base), _dec(tax)
        total = base_d + tax_d
        tdate = (NOW + dt.timedelta(days=days)).date()
        b = m.CustomerBooking(
            booking_ref=f"HRDBK{1000 + j}",
            customer_id=cust.customer_id,
            product_type="flight",
            status=bstatus,
            airline=airline, flight_number=flno,
            origin_code=oc, origin_city=ocity,
            destination_code=dc, destination_city=dcity,
            travel_date=tdate, departure_time="09:30", arrival_time="11:05",
            duration_label="1h 35m", stops=0, cabin_class="Economy",
            is_international=intl,
            base_fare=base_d, taxes=tax_d, total_amount=total, currency="INR",
            created_at=NOW - dt.timedelta(days=max(1, 20 - j * 2)),
            cancelled_at=(NOW - dt.timedelta(days=2)) if bstatus == "cancelled" else None,
        )
        b.passengers.append(m.CustomerBookingPassenger(
            passenger_index=0, traveller_type="adult",
            title="Mr" if cust.full_name.split()[0] in {"Aarav", "Rohan", "Vikram"} else "Ms",
            first_name=cust.full_name.split()[0], last_name=cust.full_name.split()[-1],
            is_contact=True, mobile=cust.mobile, email=cust.email,
        ))
        if paid:
            b.payments.append(m.CustomerBookingPayment(
                method="upi", status="captured", amount=total, currency="INR",
                provider="demo", provider_reference=f"DEMOPAY-{1000 + j}",
                provider_status="captured",
                paid_at=NOW - dt.timedelta(days=max(1, 19 - j * 2)),
            ))
        db.add(b)

        ntype = {"confirmed": "booking_confirmed", "cancelled": "booking_cancelled",
                 "pending": "booking_created", "completed": "booking_confirmed"}.get(bstatus, "general")
        db.add(m.CustomerNotification(
            customer_id=cust.customer_id, notification_type=ntype,
            title=f"Booking {b.booking_ref} {bstatus}",
            message=f"Your {airline} flight {ocity} to {dcity} is {bstatus}.",
            related_ref=b.booking_ref, is_read=(bstatus == "completed"),
            created_at=b.created_at,
        ))
    db.flush()

    pkg_id = db.execute(select(m.CustomerPackage.customer_package_id).limit(1)).scalar_one_or_none()
    if pkg_id is not None:
        review_specs = [
            (customers[0], 5, "Fantastic Goa package, very well organised!", "approved"),
            (customers[1], 4, "Good value, hotel was clean and central.", "approved"),
            (customers[2], 2, "Itinerary felt rushed on day two.", "pending"),
            (customers[3], 5, "Loved every bit of it. Will book again.", "pending"),
        ]
        for cust, rating, comment, rstatus in review_specs:
            db.add(m.CustomerReview(
                customer_id=cust.customer_id, item_type="package", item_id=int(pkg_id),
                rating=rating, comment=comment, status=rstatus,
                moderated_at=NOW if rstatus == "approved" else None,
                admin_reply=("Thank you for travelling with us!" if rstatus == "approved" and rating >= 5 else None),
                replied_at=NOW if rstatus == "approved" and rating >= 5 else None,
                created_at=NOW - dt.timedelta(days=7),
            ))

    ticket_specs = [
        (customers[0], "Reschedule my Goa flight", "I need to move my booking HRDBK1000 to a later date.",
         "high", "open", [("", False, "I need to move my booking HRDBK1000 to a later date.")]),
        (customers[3], "Invoice for Dubai trip", "Could you email me a GST invoice for HRDBK1005?",
         "normal", "in_progress", [
             ("", False, "Could you email me a GST invoice for HRDBK1005?"),
             ("Demo Admin", True, "Sure, we're preparing it and will share shortly."),
         ]),
        (customers[1], "Hotel room preference", "Please note a sea-view room preference for my stay.",
         "low", "resolved", [
             ("", False, "Please note a sea-view room preference for my stay."),
             ("Demo Admin", True, "Noted and passed to the hotel. Marking this resolved."),
         ]),
    ]
    for cust, subject, desc, prio, tstatus, msgs in ticket_specs:
        t = m.CustomerSupportTicket(
            customer_id=cust.customer_id, subject=subject, description=desc,
            priority=prio, status=tstatus, created_at=NOW - dt.timedelta(days=3),
        )
        for author, is_staff, text in msgs:
            t.messages.append(m.CustomerSupportMessage(
                author_name=(author or None), is_staff=is_staff, message=text,
            ))
        db.add(t)

    db.commit()
    print("  data:  seeded 6 customers, 6 flight bookings, payments, reviews, tickets, notifications")


# --------------------------------------------------------------------------- #
# 2b) Demo HOTEL bookings. Idempotent (guard on booking_ref prefix HRDHOT).
#     References existing seeded hotels/rooms; never invents catalogue.
# --------------------------------------------------------------------------- #
def _q(x) -> Decimal:
    return Decimal(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _demo_customers(db) -> list:
    return db.execute(
        select(m.Customer).where(m.Customer.email.like("%@hrdemo.test"))
        .order_by(m.Customer.customer_id)
    ).scalars().all()


def _notif_type(status: str) -> str:
    return {"confirmed": "booking_confirmed", "cancelled": "booking_cancelled",
            "pending": "booking_created", "completed": "booking_confirmed"}.get(status, "general")


def seed_hotel_bookings(db) -> None:
    if db.execute(
        select(func.count()).select_from(m.CustomerHotelBooking)
        .where(m.CustomerHotelBooking.booking_ref.like("HRDHOT%"))
    ).scalar_one():
        print("  hotel bookings: already present - skipped (idempotent)")
        return
    customers = _demo_customers(db)
    hotels = db.execute(
        select(m.CustomerHotel).where(m.CustomerHotel.is_active.is_(True))
        .order_by(m.CustomerHotel.customer_hotel_id)
    ).scalars().all()
    if not customers or not hotels:
        print("  hotel bookings: prerequisites missing (customers/hotels) - skipped")
        return

    # (hotel_index, status, nights, check-in offset days, paid)
    specs = [
        (0, "confirmed", 3, 21, True),
        (1, "completed", 2, -26, True),
        (2, "pending", 4, 12, False),
        (3, "cancelled", 2, 9, False),
    ]
    made = 0
    for j, (hi, status, nights, off, paid) in enumerate(specs):
        hotel = hotels[hi % len(hotels)]
        rooms = [r for r in hotel.rooms if r.is_active] or list(hotel.rooms)
        if not rooms:
            continue
        room = min(rooms, key=lambda r: r.base_price_per_night)
        cust = customers[j % len(customers)]
        first, last = cust.full_name.split()[0], cust.full_name.split()[-1]
        checkin = (NOW + dt.timedelta(days=off)).date()
        checkout = checkin + dt.timedelta(days=nights)
        ppn = Decimal(room.base_price_per_night)
        subtotal = _q(ppn * nights)
        taxes = _q(subtotal * Decimal("0.12"))
        total = _q(subtotal + taxes)
        ref = f"HRDHOT{2000 + j}"
        b = m.CustomerHotelBooking(
            booking_ref=ref, customer_id=cust.customer_id, status=status,
            hotel_id=hotel.customer_hotel_id, hotel_name=hotel.name, hotel_location=hotel.location,
            room_id=room.customer_hotel_room_id, room_name=room.name, meal_plan=room.meal_plan,
            check_in_date=checkin, check_out_date=checkout, nights=nights,
            rooms_count=1, adults=2, children=0,
            room_subtotal=subtotal, taxes=taxes, total_amount=total, currency="INR",
            created_at=NOW - dt.timedelta(days=max(1, 18 - j * 2)),
            cancelled_at=(NOW - dt.timedelta(days=2)) if status == "cancelled" else None,
        )
        b.rooms.append(m.CustomerHotelBookingRoom(
            room_index=0, room_id=room.customer_hotel_room_id, room_name=room.name,
            meal_plan=room.meal_plan, price_per_night=ppn,
        ))
        b.guests.append(m.CustomerHotelBookingGuest(
            guest_index=0, room_index=0, guest_type="adult",
            title="Mr" if first in {"Aarav", "Rohan", "Vikram"} else "Ms",
            first_name=first, last_name=last, is_contact=True, mobile=cust.mobile, email=cust.email,
        ))
        b.guests.append(m.CustomerHotelBookingGuest(
            guest_index=1, room_index=0, guest_type="adult",
            title="Mrs", first_name="Demo", last_name=last, is_contact=False,
        ))
        if paid:
            b.payments.append(m.CustomerHotelBookingPayment(
                method="card", status="captured", amount=total, currency="INR",
                provider="demo", provider_reference=f"DEMOHOTEL-{2000 + j}", provider_status="captured",
                paid_at=NOW - dt.timedelta(days=max(1, 17 - j * 2)),
            ))
        db.add(b)
        db.add(m.CustomerNotification(
            customer_id=cust.customer_id, notification_type=_notif_type(status),
            title=f"Hotel booking {ref} {status}",
            message=f"Your stay at {hotel.name} is {status}.",
            related_ref=ref, is_read=(status == "completed"), created_at=b.created_at,
        ))
        made += 1
    db.commit()
    print(f"  hotel bookings: seeded {made} (with rooms, guests, payments, notifications)")


# --------------------------------------------------------------------------- #
# 2c) Demo TOUR PACKAGE bookings. Idempotent (guard on booking_ref HRDPKG).
#     References existing seeded packages + their EXISTING active departures;
#     never invents a departure or an unsupported status.
# --------------------------------------------------------------------------- #
def seed_package_bookings(db) -> None:
    if db.execute(
        select(func.count()).select_from(m.CustomerPackageBooking)
        .where(m.CustomerPackageBooking.booking_ref.like("HRDPKG%"))
    ).scalar_one():
        print("  package bookings: already present - skipped (idempotent)")
        return
    customers = _demo_customers(db)
    rows = db.execute(
        select(m.CustomerPackage, m.CustomerPackageDeparture)
        .join(m.CustomerPackageDeparture,
              m.CustomerPackageDeparture.package_id == m.CustomerPackage.customer_package_id)
        .where(m.CustomerPackageDeparture.is_active.is_(True))
        .where(m.CustomerPackageDeparture.departure_date >= NOW.date())
        .order_by(m.CustomerPackage.customer_package_id, m.CustomerPackageDeparture.departure_date)
    ).all()
    if not customers or not rows:
        print("  package bookings: prerequisites missing (customers/active departures) - skipped")
        return
    # First upcoming active departure per package, then take up to 4 packages.
    chosen: dict[int, tuple] = {}
    for pkg, dep in rows:
        chosen.setdefault(pkg.customer_package_id, (pkg, dep))
    picks = list(chosen.values())[:4]

    # (status, pax, paid) — only statuses valid for an upcoming departure.
    specs = [("confirmed", 2, True), ("confirmed", 4, True),
             ("pending", 2, False), ("cancelled", 3, False)]
    made = 0
    for j, ((pkg, dep), (status, pax, paid)) in enumerate(zip(picks, specs)):
        cust = customers[j % len(customers)]
        first, last = cust.full_name.split()[0], cust.full_name.split()[-1]
        price = Decimal(dep.price_per_person)
        base = _q(price * pax)
        taxes = _q(base * Decimal("0.05"))
        total = _q(base + taxes)
        ref = f"HRDPKG{3000 + j}"
        b = m.CustomerPackageBooking(
            booking_ref=ref, customer_id=cust.customer_id, status=status,
            package_id=pkg.customer_package_id, package_name=pkg.name,
            package_days=pkg.days, is_international=pkg.is_international,
            departure_id=dep.customer_package_departure_id, departure_date=dep.departure_date,
            pax_count=pax, base_total=base, taxes=taxes, total_amount=total, currency="INR",
            created_at=NOW - dt.timedelta(days=max(1, 16 - j * 2)),
            cancelled_at=(NOW - dt.timedelta(days=1)) if status == "cancelled" else None,
        )
        for t in range(pax):
            b.travellers.append(m.CustomerPackageBookingTraveller(
                traveller_index=t, traveller_type="adult",
                title="Mr" if (t == 0 and first in {"Aarav", "Rohan", "Vikram"}) else "Ms",
                first_name=first if t == 0 else f"Guest{t + 1}", last_name=last,
                is_contact=(t == 0), mobile=cust.mobile if t == 0 else None,
                email=cust.email if t == 0 else None,
            ))
        if paid:
            b.payments.append(m.CustomerPackageBookingPayment(
                method="upi", status="captured", amount=total, currency="INR",
                provider="demo", provider_reference=f"DEMOPKG-{3000 + j}", provider_status="captured",
                paid_at=NOW - dt.timedelta(days=max(1, 15 - j * 2)),
            ))
        db.add(b)
        db.add(m.CustomerNotification(
            customer_id=cust.customer_id, notification_type=_notif_type(status),
            title=f"Package booking {ref} {status}",
            message=f"Your {pkg.name} tour ({pax} pax) is {status}.",
            related_ref=ref, is_read=False, created_at=b.created_at,
        ))
        made += 1
    db.commit()
    print(f"  package bookings: seeded {made} (with travellers, payments, notifications)")


# --------------------------------------------------------------------------- #
# 3) Demo suppliers (providers). Idempotent per provider_code.
# --------------------------------------------------------------------------- #
PROVIDERS = [
    ("TBOAIR01", "TBO / TekTravels"),
    ("AKBAR01", "Akbar Travels of India"),
    ("RIYA01", "Riya Travel & Tours"),
]


def seed_providers(db) -> None:
    st = _status_member(mv.ProviderStatus, "ACTIVE", "active")
    added = 0
    for code, name in PROVIDERS:
        exists = db.execute(
            select(mv.Provider).where(mv.Provider.provider_code == code)
        ).scalar_one_or_none()
        if exists:
            continue
        db.add(mv.Provider(provider_code=code, provider_name=name, status=st))
        added += 1
    if added:
        db.commit()
    print(f"  suppliers: added {added}; {len(PROVIDERS)} demo suppliers present")


# --------------------------------------------------------------------------- #
def _report(db) -> None:
    print("\nverification - row counts now on jackpots_hrdemo:")
    checks = [
        (m.Customer, "customers", m.Customer.email.like("%@hrdemo.test")),
        (m.CustomerBooking, "flight bookings", m.CustomerBooking.booking_ref.like("HRDBK%")),
        (m.CustomerHotelBooking, "hotel bookings", m.CustomerHotelBooking.booking_ref.like("HRDHOT%")),
        (m.CustomerPackageBooking, "package bookings", m.CustomerPackageBooking.booking_ref.like("HRDPKG%")),
        (m.CustomerBookingPayment, "flight payments", None),
        (m.CustomerReview, "reviews", None),
        (m.CustomerSupportTicket, "support tickets", None),
        (m.CustomerNotification, "notifications", None),
        (mv.Provider, "suppliers", None),
    ]
    for model, label, where in checks:
        stmt = select(func.count()).select_from(model)
        if where is not None:
            stmt = stmt.where(where)
        n = db.execute(stmt).scalar_one()
        print(f"  {label:18} {n}")


def main() -> int:
    print(f"seed_hrdemo_demo: target DB = {REQUIRED_DB_NAME} (safety gate passed)")
    db = SessionLocal()
    try:
        ensure_admin_and_grant(db)
        ensure_chat_demo_customer(db)
        seed_demo_data(db)
        seed_hotel_bookings(db)
        seed_package_bookings(db)
        seed_providers(db)
        _report(db)
        print("\ndone.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
