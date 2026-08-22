"""Customer flight booking — the B2C booking finally has a backend.

Until now the Customer Portal could sign a traveller in and hold their profile,
and that was all. The booking flow itself (traveller details, seats, add-ons,
review, payment, confirmation) ran entirely in the browser: seat maps and
add-on prices were generated from the flight's id, and a completed booking was
written to ``localStorage['jpc_bookings']`` with a reference the page invented.
That is a demo, and a demo cannot issue a PNR.

This migration gives the flow somewhere real to land:

* ``customer_travellers``        the saved traveller list — what makes passport
                                 auto-fetch and "add to My Traveller List" real
                                 rather than a checkbox that does nothing.
* ``customer_bookings``          one row per booking, with the itinerary
                                 snapshotted and the fare broken out.
* ``customer_booking_passengers`` who flew, and in which seat.
* ``customer_booking_addons``    baggage, meals and services actually bought.
* ``customer_booking_payments``  what was attempted and what came back.
* ``customer_coupons``           the discounts the site already advertises,
                                 so a coupon is validated rather than invented.

WHY THE ITINERARY IS SNAPSHOTTED, NOT REFERENCED. There is no flights table to
point at — no GDS, no inventory. Even once there is one, a booking must keep
what was sold at the moment it was sold: an airline retiming a flight next week
must not silently rewrite a ticket issued today. So the flight columns here are
deliberately denormalised copies, not foreign keys.

MONEY IS ``Numeric(12, 2)``, NEVER FLOAT. A fare that ends ...99 must still end
...99 after a coupon is applied, and binary floating point cannot promise that.

NO DATA IS REWRITTEN. Six new tables, four enum types, one sequence, and six
seeded coupon rows that mirror the offer cards already on the landing page.
Nothing existing is touched, so ``downgrade()`` is a clean drop.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0053_customer_flight_booking"
# Runs after the Customer Portal itself, which is where `customers` is created
# and which 0044 re-parented onto the hotel line's tip (0052). Everything below
# is rooted at `customers`, so this is a single linear step behind it.
down_revision: Union[str, None] = "0044_customer_portal"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REF_SEQ = "seq_customer_booking_ref"

# Prefixed `customer_` for the same reason 0044's types are: the merchant side
# already has status enums listing similar words, and widening one of those
# must never widen one of these.
_BOOKING_STATUS = postgresql.ENUM(
    "pending", "confirmed", "cancelled", "completed",
    name="customer_booking_status_enum", create_type=False,
)
_TRAVELLER_TYPE = postgresql.ENUM(
    "adult", "child", "infant",
    name="customer_traveller_type_enum", create_type=False,
)
_ADDON_TYPE = postgresql.ENUM(
    "baggage", "meal", "service",
    name="customer_addon_type_enum", create_type=False,
)
_PAYMENT_STATUS = postgresql.ENUM(
    "pending", "authorized", "captured", "failed", "refunded",
    name="customer_payment_status_enum", create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()

    _BOOKING_STATUS.create(bind, checkfirst=True)
    _TRAVELLER_TYPE.create(bind, checkfirst=True)
    _ADDON_TYPE.create(bind, checkfirst=True)
    _PAYMENT_STATUS.create(bind, checkfirst=True)

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {REF_SEQ} START WITH 1 INCREMENT BY 1")

    # ------------------------------------------------------------------ 1/6 --
    # The saved traveller list. A customer books for the same handful of people
    # over and over; this is what stops them retyping a passport every time.
    op.create_table(
        "customer_travellers",
        sa.Column("customer_traveller_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("traveller_type", _TRAVELLER_TYPE, nullable=False,
                  server_default=sa.text("'adult'")),
        sa.Column("title", sa.String(length=10), nullable=True),
        sa.Column("first_name", sa.String(length=100), nullable=False),
        sa.Column("last_name", sa.String(length=100), nullable=False),
        sa.Column("gender", sa.String(length=20), nullable=True),
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column("nationality", sa.String(length=100), nullable=True),
        # Passport is optional throughout: a domestic-only traveller has no
        # reason to hand one over, and demanding it would be the app inventing
        # a rule the airline did not ask for.
        sa.Column("passport_number", sa.String(length=40), nullable=True),
        sa.Column("passport_expiry", sa.Date(), nullable=True),
        sa.Column("issuing_country", sa.String(length=100), nullable=True),
        sa.Column("frequent_flyer_airline", sa.String(length=100), nullable=True),
        sa.Column("frequent_flyer_number", sa.String(length=60), nullable=True),
        sa.Column("mobile", sa.String(length=30), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "ix_customer_travellers_customer", "customer_travellers", ["customer_id"],
    )
    # Passport auto-fetch looks a traveller up by number, so the number has to
    # be unique WITHIN one customer's list — two people cannot share a passport,
    # but two customers may each have saved the same relative. Partial, because
    # NULL passports are the normal case and must not collide with each other.
    op.execute(
        "CREATE UNIQUE INDEX uq_customer_traveller_passport "
        "ON customer_travellers (customer_id, lower(passport_number)) "
        "WHERE passport_number IS NOT NULL"
    )

    # ------------------------------------------------------------------ 2/6 --
    op.create_table(
        "customer_bookings",
        sa.Column("customer_booking_id", sa.BigInteger(), primary_key=True),
        sa.Column("booking_ref", sa.String(length=20), nullable=False),
        # Null until the airline actually issues one. A PNR the app made up is
        # worse than no PNR at all — the traveller would quote it at a counter.
        sa.Column("pnr", sa.String(length=10), nullable=True),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("product_type", sa.String(length=20), nullable=False,
                  server_default=sa.text("'flight'")),
        sa.Column("status", _BOOKING_STATUS, nullable=False,
                  server_default=sa.text("'pending'")),

        # --- itinerary snapshot (see the module docstring on why) ---
        sa.Column("airline", sa.String(length=100), nullable=True),
        sa.Column("flight_number", sa.String(length=20), nullable=True),
        sa.Column("origin_code", sa.String(length=10), nullable=True),
        sa.Column("origin_city", sa.String(length=100), nullable=True),
        sa.Column("destination_code", sa.String(length=10), nullable=True),
        sa.Column("destination_city", sa.String(length=100), nullable=True),
        sa.Column("travel_date", sa.Date(), nullable=True),
        sa.Column("departure_time", sa.String(length=10), nullable=True),
        sa.Column("arrival_time", sa.String(length=10), nullable=True),
        sa.Column("duration_label", sa.String(length=40), nullable=True),
        sa.Column("stops", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("cabin_class", sa.String(length=40), nullable=True),
        # Drives the passport rules: required and 6-month-checked when true,
        # left alone when false. Stored rather than re-derived so a booking is
        # still explicable after a route's classification changes.
        sa.Column("is_international", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),

        # --- fare breakdown; every line the Fare Summary shows ---
        sa.Column("base_fare", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("taxes", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("seat_charges", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("baggage_total", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("meal_total", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("service_total", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
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
    op.create_index("uq_customer_bookings_ref", "customer_bookings", ["booking_ref"], unique=True)
    # My Bookings is "this customer's, newest first" and nothing else, so the
    # index carries the sort rather than leaving it to a filesort every load.
    op.create_index(
        "ix_customer_bookings_customer", "customer_bookings",
        ["customer_id", sa.text("created_at DESC")],
    )

    # ------------------------------------------------------------------ 3/6 --
    op.create_table(
        "customer_booking_passengers",
        sa.Column("customer_booking_passenger_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Position in the party, 0-based. The seat map and the add-on rows both
        # address passengers by it, so it has to survive on the booking.
        sa.Column("passenger_index", sa.Integer(), nullable=False),
        sa.Column("traveller_type", _TRAVELLER_TYPE, nullable=False,
                  server_default=sa.text("'adult'")),
        sa.Column("title", sa.String(length=10), nullable=True),
        sa.Column("first_name", sa.String(length=100), nullable=False),
        sa.Column("last_name", sa.String(length=100), nullable=False),
        sa.Column("gender", sa.String(length=20), nullable=True),
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column("nationality", sa.String(length=100), nullable=True),
        sa.Column("passport_number", sa.String(length=40), nullable=True),
        sa.Column("passport_expiry", sa.Date(), nullable=True),
        sa.Column("issuing_country", sa.String(length=100), nullable=True),
        sa.Column("frequent_flyer_airline", sa.String(length=100), nullable=True),
        sa.Column("frequent_flyer_number", sa.String(length=60), nullable=True),
        sa.Column("seat_number", sa.String(length=10), nullable=True),
        sa.Column("seat_price", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        # Exactly one passenger carries the booking's contact details — the
        # form only asks the first traveller for them.
        sa.Column("is_contact", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("mobile", sa.String(length=30), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "uq_customer_booking_pax", "customer_booking_passengers",
        ["customer_booking_id", "passenger_index"], unique=True,
    )

    # ------------------------------------------------------------------ 4/6 --
    op.create_table(
        "customer_booking_addons",
        sa.Column("customer_booking_addon_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # NULL means the add-on is the whole booking's, not one traveller's.
        sa.Column("passenger_index", sa.Integer(), nullable=True),
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
        "ix_customer_booking_addons_booking", "customer_booking_addons", ["customer_booking_id"],
    )

    # ------------------------------------------------------------------ 5/6 --
    # An attempt log, not a ledger. There is no payment gateway wired to this
    # portal yet; this records what was asked for and what came back, so that
    # when one is integrated it has somewhere to write without a migration.
    op.create_table(
        "customer_booking_payments",
        sa.Column("customer_booking_payment_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "customer_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("method", sa.String(length=30), nullable=False),
        sa.Column("status", _PAYMENT_STATUS, nullable=False, server_default=sa.text("'pending'")),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default=sa.text("'INR'")),
        # The provider's own id for the attempt. NULL while no provider exists.
        sa.Column("provider", sa.String(length=40), nullable=True),
        sa.Column("provider_reference", sa.String(length=120), nullable=True),
        sa.Column("failure_reason", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "ix_customer_booking_payments_booking", "customer_booking_payments",
        ["customer_booking_id"],
    )

    # ------------------------------------------------------------------ 6/6 --
    op.create_table(
        "customer_coupons",
        sa.Column("customer_coupon_id", sa.BigInteger(), primary_key=True),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("description", sa.String(length=400), nullable=True),
        # 'percent' takes discount_value as a percentage and honours max_discount;
        # 'flat' takes it as rupees and ignores the cap.
        sa.Column("discount_type", sa.String(length=10), nullable=False),
        sa.Column("discount_value", sa.Numeric(12, 2), nullable=False),
        sa.Column("max_discount", sa.Numeric(12, 2), nullable=True),
        sa.Column("min_amount", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        # NULL = every product. Otherwise the one product it applies to, which
        # is what stops a cruise coupon discounting a flight.
        sa.Column("product_type", sa.String(length=20), nullable=True),
        # NULL = domestic and international alike.
        sa.Column("international_only", sa.Boolean(), nullable=True),
        sa.Column("valid_from", sa.Date(), nullable=True),
        sa.Column("valid_to", sa.Date(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("uq_customer_coupons_code", "customer_coupons", ["code"], unique=True)

    # The five offer cards on the landing page have advertised these codes and
    # these terms since the B2C side shipped. They are transcribed, not
    # invented: a customer who reads "Flat 30% off on domestic flights" and
    # types FLYHIGH30 must get exactly that. Only the flight coupon can apply
    # to this flow; the rest are seeded so the other products inherit a real
    # coupon table rather than a second hard-coded list later.
    op.execute(
        """
        INSERT INTO customer_coupons
            (code, title, description, discount_type, discount_value,
             max_discount, min_amount, product_type, international_only, is_active)
        VALUES
            ('FLYHIGH30', 'Flat 30% off on domestic flights',
             'Valid on all major airlines, booked before midnight.',
             'percent', 30, NULL, 0, 'flight', false, true),
            ('CRUISE2000', '₹2,000 instant cashback on cruise bookings',
             'On your first three bookings this month.',
             'flat', 2000, NULL, 0, 'cruise', NULL, true),
            ('STAYMORE', 'Up to 40% off premium hotel stays',
             'Free breakfast included at 2,000+ properties.',
             'percent', 40, NULL, 0, 'hotel', NULL, true),
            ('FAMILYFUN', 'Kids stay & fly free this summer',
             'On select holiday packages for families of 4+.',
             'percent', 15, NULL, 0, 'package', NULL, true),
            ('TOGETHER25', 'Romantic getaways from ₹24,999',
             'Candlelight dinners & couple spa included.',
             'percent', 25, NULL, 24999, 'package', NULL, true)
        """
    )


def downgrade() -> None:
    bind = op.get_bind()

    op.drop_table("customer_coupons")
    op.drop_table("customer_booking_payments")
    op.drop_table("customer_booking_addons")
    op.drop_table("customer_booking_passengers")
    op.drop_table("customer_bookings")
    op.execute("DROP INDEX IF EXISTS uq_customer_traveller_passport")
    op.drop_table("customer_travellers")

    op.execute(f"DROP SEQUENCE IF EXISTS {REF_SEQ}")

    _PAYMENT_STATUS.drop(bind, checkfirst=True)
    _ADDON_TYPE.drop(bind, checkfirst=True)
    _TRAVELLER_TYPE.drop(bind, checkfirst=True)
    _BOOKING_STATUS.drop(bind, checkfirst=True)
