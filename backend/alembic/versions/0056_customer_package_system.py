"""Real B2C tour-package system — inventory and bookings, on tables of their own.

Same move as 0055 did for hotels, now for tour packages. ``SAMPLE_PACKAGES``
in ``travel-data.js`` has been the catalogue since the B2C site shipped;
``booking-data.js``'s ``buildDepartures()`` invented six Saturday departure
dates from a package's own id every time the page loaded; a completed
"booking" went to ``localStorage['jpc_bookings']`` with a reference the
browser made up. This gives the flow somewhere real to land:

* ``customer_packages``            the tour — what ``SAMPLE_PACKAGES`` was.
* ``customer_package_departures``  its actual group-departure dates and
                                   per-person price — what ``buildDepartures()``
                                   made up fresh on every page load.
* ``customer_package_bookings``    one row per booking, itinerary snapshotted
                                   exactly the way 0053/0055 snapshot a flight's
                                   or a stay's.
* ``customer_package_booking_travellers``  who is going. Packages carry
                                   passengers who may need a passport (Dubai,
                                   Bali, Maldives, Singapore, Thailand all do;
                                   Kashmir and Goa do not) — the same shape
                                   0053 already uses for a flight passenger,
                                   not a lighter hotel-guest one.
* ``customer_package_booking_addons``      hotel upgrade, private guide,
                                   airport transfer, travel insurance —
                                   actually bought.
* ``customer_package_booking_payments``    an attempt log, not a ledger —
                                   same honesty as 0053's and 0055's.

WHY THIS IS ITS OWN TABLE SET, NOT A COLUMN ON AN EXISTING BOOKING TABLE. A
package has a departure date and a per-person day count; a flight has none of
that and a hotel has check-in/check-out instead. Three domains sharing one
table would mean every row carries the other two domains' NULL columns — the
same reasoning 0055's docstring gives for hotels, now applied to packages.

WHAT IS SHARED, AND WHY. ``customer_booking_status_enum``,
``customer_payment_status_enum``, ``customer_traveller_type_enum`` and
``customer_addon_type_enum`` (all from 0053) are reused — a status vocabulary,
not travel inventory. ``customer_coupons`` already carries two package-flagged
rows (``FAMILYFUN``, ``TOGETHER25``, seeded in 0053) and is read, not written,
here.

THE BOOKING REFERENCE IS ITS OWN SEQUENCE. ``seq_customer_package_booking_ref``
produces ``JPP000123`` — flights are ``JPB``, hotels are ``JPH``, so a
reference alone says which table to look in.

DEPARTURE DATES ARE SEEDED FROM TODAY, NOT INVENTED PER REQUEST. The demo
picked "the next six Saturdays" fresh on every page load, which is why a
package never seemed to sell out — nothing was ever actually decremented.
Seeding real rows, with a real (if arbitrary) `seats_left`, is what lets a
booking actually check availability instead of asking a formula that has no
memory of what already sold.
"""
import datetime as dt
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0056_customer_package_system"
down_revision: Union[str, None] = "0055_customer_hotel_system"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REF_SEQ = "seq_customer_package_booking_ref"

# Reused from 0053 — status/payment/traveller/addon vocabularies, not travel
# inventory. create_type=False because all four types already exist.
_BOOKING_STATUS = postgresql.ENUM(
    "pending", "confirmed", "cancelled", "completed",
    name="customer_booking_status_enum", create_type=False,
)
_PAYMENT_STATUS = postgresql.ENUM(
    "pending", "authorized", "captured", "failed", "refunded",
    name="customer_payment_status_enum", create_type=False,
)
_TRAVELLER_TYPE = postgresql.ENUM(
    "adult", "child", "infant",
    name="customer_traveller_type_enum", create_type=False,
)
_ADDON_TYPE = postgresql.ENUM(
    "baggage", "meal", "service",
    name="customer_addon_type_enum", create_type=False,
)

# Transcribed from SAMPLE_PACKAGES (frontend/assets/js/travel-data.js), plus
# the fields the demo never had: a real description, inclusions and whether
# the destination is one Indian nationals need a passport for.
_PACKAGES = [
    dict(id=1, name="Dubai", days=5, price_from=54900, is_international=True,
         blurb="Desert safari, Burj Khalifa and a dhow dinner cruise.",
         description="Five days across old and new Dubai — an evening desert safari with dune "
                      "bashing and a barbecue dinner, the observation deck of the Burj Khalifa, "
                      "a stroll through the Gold and Spice Souks, and a dhow dinner cruise along "
                      "Dubai Creek.",
         inclusions=["Return flights", "4-night hotel stay", "Daily breakfast",
                     "Desert safari with BBQ dinner", "Burj Khalifa tickets", "Airport transfers"],
         cancellation_policy="Free cancellation up to 15 days before departure. 50% charge within 15 days, no refund within 3 days."),
    dict(id=2, name="Bali", days=6, price_from=61500, is_international=True,
         blurb="Ubud rice terraces, Nusa Penida and a private villa stay.",
         description="Six days in Bali — the Tegallalang rice terraces and Ubud's monkey forest, "
                      "a day trip to Nusa Penida's cliffs and beaches, and three nights in a "
                      "private pool villa.",
         inclusions=["Return flights", "5-night villa stay", "Daily breakfast",
                     "Nusa Penida day trip", "Ubud sightseeing", "Airport transfers"],
         cancellation_policy="Free cancellation up to 15 days before departure. 50% charge within 15 days, no refund within 3 days."),
    dict(id=3, name="Maldives", days=4, price_from=78000, is_international=True,
         blurb="Overwater villa, house-reef snorkelling and a sunset cruise.",
         description="Four days at an overwater villa resort — house-reef snorkelling, a sunset "
                      "dolphin cruise, and full board dining looking straight down into the lagoon.",
         inclusions=["Return flights", "Speedboat transfers", "3-night overwater villa",
                     "Full board meals", "Snorkelling equipment", "Sunset cruise"],
         cancellation_policy="Free cancellation up to 21 days before departure. Non-refundable within 21 days."),
    dict(id=4, name="Singapore", days=5, price_from=58900, is_international=True,
         blurb="Gardens by the Bay, Sentosa and Universal Studios.",
         description="Five days in Singapore — Gardens by the Bay's Supertree Grove and domes, a "
                      "full day at Sentosa including Universal Studios, and the Night Safari.",
         inclusions=["Return flights", "4-night hotel stay", "Daily breakfast",
                     "Universal Studios tickets", "Night Safari", "Airport transfers"],
         cancellation_policy="Free cancellation up to 15 days before departure. 50% charge within 15 days, no refund within 3 days."),
    dict(id=5, name="Thailand", days=6, price_from=46500, is_international=True,
         blurb="Bangkok temples, Phi Phi islands and Krabi beaches.",
         description="Six days across Bangkok and Krabi — the Grand Palace and Wat Arun, an "
                      "island-hopping speedboat day to Phi Phi, and Railay Beach.",
         inclusions=["Return flights", "5-night hotel stay", "Daily breakfast",
                     "Phi Phi island day trip", "Bangkok temple tour", "Airport transfers"],
         cancellation_policy="Free cancellation up to 15 days before departure. 50% charge within 15 days, no refund within 3 days."),
    dict(id=6, name="Kashmir", days=5, price_from=32900, is_international=False,
         blurb="Dal Lake houseboat, Gulmarg gondola and Pahalgam valleys.",
         description="Five days across Srinagar, Gulmarg and Pahalgam — a night aboard a Dal Lake "
                      "houseboat, the Gulmarg Gondola, and the Pahalgam and Betaab valleys.",
         inclusions=["Houseboat stay in Srinagar", "Hotel stays in Gulmarg & Pahalgam",
                     "Daily breakfast & dinner", "Gondola tickets", "Private cab throughout"],
         cancellation_policy="Free cancellation up to 7 days before departure. 50% charge within 7 days, no refund within 48 hours."),
    dict(id=7, name="Goa", days=4, price_from=21900, is_international=False,
         blurb="North and South Goa beaches, Old Goa churches, a river cruise.",
         description="Four days across North and South Goa — Baga and Calangute beaches, the "
                      "Basilica of Bom Jesus in Old Goa, and an evening Mandovi river cruise.",
         inclusions=["3-night hotel stay", "Daily breakfast", "North & South Goa sightseeing",
                     "Mandovi river cruise", "Airport transfers"],
         cancellation_policy="Free cancellation up to 7 days before departure. 50% charge within 7 days, no refund within 48 hours."),
]


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {REF_SEQ} START WITH 1 INCREMENT BY 1")

    # ------------------------------------------------------------------ 1/5 --
    op.create_table(
        "customer_packages",
        sa.Column("customer_package_id", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("blurb", sa.String(length=300), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("days", sa.SmallInteger(), nullable=False),
        sa.Column("price_from", sa.Numeric(12, 2), nullable=False),
        # Drives the passport rules on the traveller step, exactly the way
        # is_international already drives them on a flight (0053).
        sa.Column("is_international", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("inclusions", postgresql.ARRAY(sa.String(length=120)), nullable=False,
                  server_default=sa.text("'{}'")),
        sa.Column("cancellation_policy", sa.String(length=255), nullable=True),
        sa.Column("image_key", sa.String(length=60), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_customer_packages_active", "customer_packages", ["is_active"])

    # ------------------------------------------------------------------ 2/5 --
    op.create_table(
        "customer_package_departures",
        sa.Column("customer_package_departure_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "package_id", sa.BigInteger(),
            sa.ForeignKey("customer_packages.customer_package_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("departure_date", sa.Date(), nullable=False),
        sa.Column("price_per_person", sa.Numeric(12, 2), nullable=False),
        sa.Column("seats_left", sa.SmallInteger(), nullable=False, server_default=sa.text("12")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.create_index("ix_customer_package_departures_pkg", "customer_package_departures",
                     ["package_id", "departure_date"])

    # ------------------------------------------------------------------ 3/5 --
    op.create_table(
        "customer_package_bookings",
        sa.Column("customer_package_booking_id", sa.BigInteger(), primary_key=True),
        sa.Column("booking_ref", sa.String(length=20), nullable=False),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("status", _BOOKING_STATUS, nullable=False, server_default=sa.text("'pending'")),

        # --- trip snapshot (see the module docstring on why) ---
        sa.Column(
            "package_id", sa.BigInteger(),
            sa.ForeignKey("customer_packages.customer_package_id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("package_name", sa.String(length=150), nullable=False),
        sa.Column("package_days", sa.SmallInteger(), nullable=False),
        sa.Column("is_international", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "departure_id", sa.BigInteger(),
            sa.ForeignKey("customer_package_departures.customer_package_departure_id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("departure_date", sa.Date(), nullable=False),
        sa.Column("pax_count", sa.Integer(), nullable=False, server_default=sa.text("1")),

        # --- fare breakdown; every line the Fare Summary shows ---
        sa.Column("base_total", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("taxes", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("addon_total", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("discount", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("total_amount", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default=sa.text("'INR'")),
        sa.Column("coupon_code", sa.String(length=40), nullable=True),

        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("uq_customer_package_bookings_ref", "customer_package_bookings",
                     ["booking_ref"], unique=True)
    op.create_index(
        "ix_customer_package_bookings_customer", "customer_package_bookings",
        ["customer_id", sa.text("created_at DESC")],
    )

    # ------------------------------------------------------------------ 4/5 --
    op.create_table(
        "customer_package_booking_travellers",
        sa.Column("customer_package_booking_traveller_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "package_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_package_bookings.customer_package_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("traveller_index", sa.Integer(), nullable=False),
        sa.Column("traveller_type", _TRAVELLER_TYPE, nullable=False, server_default=sa.text("'adult'")),
        sa.Column("title", sa.String(length=10), nullable=True),
        sa.Column("first_name", sa.String(length=100), nullable=False),
        sa.Column("last_name", sa.String(length=100), nullable=False),
        sa.Column("gender", sa.String(length=20), nullable=True),
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column("nationality", sa.String(length=100), nullable=True),
        sa.Column("passport_number", sa.String(length=40), nullable=True),
        sa.Column("passport_expiry", sa.Date(), nullable=True),
        sa.Column("issuing_country", sa.String(length=100), nullable=True),
        sa.Column("is_contact", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("mobile", sa.String(length=30), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "uq_customer_package_booking_traveller", "customer_package_booking_travellers",
        ["package_booking_id", "traveller_index"], unique=True,
    )

    # ------------------------------------------------------------------ 5/5 --
    op.create_table(
        "customer_package_booking_addons",
        sa.Column("customer_package_booking_addon_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "package_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_package_bookings.customer_package_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # NULL means the whole booking, not one traveller — e.g. a hotel
        # upgrade is bought once; travel insurance is bought per traveller.
        sa.Column("traveller_index", sa.Integer(), nullable=True),
        sa.Column("addon_type", _ADDON_TYPE, nullable=False),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=255), nullable=True),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "ix_customer_package_booking_addons_booking", "customer_package_booking_addons",
        ["package_booking_id"],
    )

    op.create_table(
        "customer_package_booking_payments",
        sa.Column("customer_package_booking_payment_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "package_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_package_bookings.customer_package_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("method", sa.String(length=30), nullable=False),
        sa.Column("status", _PAYMENT_STATUS, nullable=False, server_default=sa.text("'pending'")),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default=sa.text("'INR'")),
        sa.Column("provider", sa.String(length=40), nullable=True),
        sa.Column("provider_reference", sa.String(length=120), nullable=True),
        sa.Column("failure_reason", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "ix_customer_package_booking_payments_booking", "customer_package_booking_payments",
        ["package_booking_id"],
    )

    # ------------------------------------------------------------------------
    # Seed inventory — the seven packages SAMPLE_PACKAGES has always shown.
    # ------------------------------------------------------------------------
    bind = op.get_bind()
    packages_table = sa.table(
        "customer_packages",
        sa.column("customer_package_id", sa.BigInteger()),
        sa.column("name", sa.String()),
        sa.column("blurb", sa.String()),
        sa.column("description", sa.Text()),
        sa.column("days", sa.SmallInteger()),
        sa.column("price_from", sa.Numeric()),
        sa.column("is_international", sa.Boolean()),
        sa.column("inclusions", postgresql.ARRAY(sa.String())),
        sa.column("cancellation_policy", sa.String()),
        sa.column("image_key", sa.String()),
    )
    bind.execute(
        packages_table.insert(),
        [
            {
                "customer_package_id": p["id"], "name": p["name"], "blurb": p["blurb"],
                "description": p["description"], "days": p["days"], "price_from": p["price_from"],
                "is_international": p["is_international"], "inclusions": p["inclusions"],
                "cancellation_policy": p["cancellation_policy"], "image_key": None,
            }
            for p in _PACKAGES
        ],
    )
    op.execute(
        "SELECT setval(pg_get_serial_sequence('customer_packages', 'customer_package_id'), "
        f"{len(_PACKAGES)}, true)"
    )

    # Departures: the next eight Saturdays from today, per package — the same
    # "group departures leave on Saturdays" rule buildDepartures() used,
    # persisted instead of recomputed fresh (and un-decrementing) on every
    # page load. Later departures cost a little more, same as the demo did.
    today = dt.date.today()
    first_saturday = today + dt.timedelta(days=(5 - today.weekday()) % 7 or 7)
    departures_table = sa.table(
        "customer_package_departures",
        sa.column("package_id", sa.BigInteger()),
        sa.column("departure_date", sa.Date()),
        sa.column("price_per_person", sa.Numeric()),
        sa.column("seats_left", sa.SmallInteger()),
    )
    rows = []
    for p in _PACKAGES:
        for i in range(8):
            rows.append({
                "package_id": p["id"],
                "departure_date": first_saturday + dt.timedelta(weeks=i),
                "price_per_person": p["price_from"] + i * 1500,
                "seats_left": 2 + ((hash((p["id"], i)) % 11 + 11) % 11),
            })
    bind.execute(departures_table.insert(), rows)


def downgrade() -> None:
    op.drop_table("customer_package_booking_payments")
    op.drop_table("customer_package_booking_addons")
    op.drop_table("customer_package_booking_travellers")
    op.drop_table("customer_package_bookings")
    op.drop_table("customer_package_departures")
    op.drop_table("customer_packages")

    op.execute(f"DROP SEQUENCE IF EXISTS {REF_SEQ}")
