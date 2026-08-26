"""Real B2C hotel system — inventory and bookings, on tables of their own.

Hotels have been a demo since the B2C site shipped: ``SAMPLE_HOTELS`` in
``travel-data.js`` supplied the catalogue, ``booking-data.js`` invented room
tiers from the hotel's own id, and a completed "booking" was written to
``localStorage['jpc_bookings']`` with a reference the browser made up. That is
what migration 0053 already fixed for flights; this does the equivalent for
hotels, and deliberately does not touch a single flight table to do it:

* ``customer_hotels``              the property — what ``SAMPLE_HOTELS`` was.
* ``customer_hotel_rooms``         its sellable room types — what
                                   ``booking-data.js``'s ``buildRooms()`` made up
                                   from a hotel's nightly rate.
* ``customer_hotel_bookings``      one row per stay booked, itinerary
                                   snapshotted exactly the way 0053 snapshots a
                                   flight's, for the same reason: a property
                                   changing its rates next week must not rewrite
                                   a stay already booked.
* ``customer_hotel_booking_guests``   who is staying.
* ``customer_hotel_booking_addons``   breakfast, transfers, late checkout,
                                      insurance — actually bought.
* ``customer_hotel_booking_payments`` an attempt log, not a ledger — same
                                      shape and same honesty as 0053's: no
                                      gateway is integrated, so nothing here
                                      claims money moved.

WHY THIS IS SIX NEW TABLES AND NOT SIX NEW COLUMNS ON ``customer_bookings``.
A hotel stay and a flight have almost nothing in common — no flight number, no
seat, no cabin class; a check-in date and a room type instead. Bolting hotel
columns onto the flight booking table would mean every flight row carries six
NULL hotel columns and vice versa, and a hotel query would have to filter a
table three-quarters full of someone else's domain. Separate tables are what
"do not mix hotel inventory with flight tables" means in SQL.

WHAT IS SHARED, AND WHY THAT IS FINE. ``customer_booking_status_enum`` and
``customer_payment_status_enum`` (both from 0053) are reused here rather than
declaring ``pending/confirmed/cancelled/completed`` a second time — they are a
status vocabulary, not flight inventory, and a hotel booking can be pending or
cancelled for exactly the reasons a flight booking can. ``customer_coupons``
(0053) already carries a hotel-flagged row (``STAYMORE``) and is read, not
written, by this migration.

THE BOOKING REFERENCE IS ITS OWN SEQUENCE. ``seq_customer_hotel_booking_ref``
produces ``JPH000123`` — a different prefix from a flight's ``JPB000123`` so
the two can never collide and a reference alone says which table to look in.

INVENTORY IS SEEDED, NOT SUPPLIED BY A PROPERTY MANAGEMENT SYSTEM. There is no
real hotel supplier integrated yet, so ``customer_hotels``/``customer_hotel_rooms``
are seeded from exactly the six properties ``SAMPLE_HOTELS`` has always shown,
with the fields the demo never had (guest rating, meal plan, cancellation
policy) added rather than invented from nothing — see
``customer_hotel_catalog_service.py`` for where a real supplier plugs in later.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0055_customer_hotel_system"
down_revision: Union[str, None] = "0054_customer_account_center"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REF_SEQ = "seq_customer_hotel_booking_ref"

# Reused from 0053 — a status vocabulary, not flight inventory. create_type=False
# because both types already exist; nothing here creates or widens them.
_BOOKING_STATUS = postgresql.ENUM(
    "pending", "confirmed", "cancelled", "completed",
    name="customer_booking_status_enum", create_type=False,
)
_PAYMENT_STATUS = postgresql.ENUM(
    "pending", "authorized", "captured", "failed", "refunded",
    name="customer_payment_status_enum", create_type=False,
)
# Also reused from 0053. Hotels only ever use 'adult' and 'child' — there is no
# infant fare for a room — but the value 'infant' existing and unused costs
# nothing, and declaring a second, near-identical enum type would.
_TRAVELLER_TYPE = postgresql.ENUM(
    "adult", "child", "infant",
    name="customer_traveller_type_enum", create_type=False,
)
# Breakfast is a meal, an airport transfer and late checkout are a service —
# the same two groups 0053 already uses for a flight's add-ons.
_ADDON_TYPE = postgresql.ENUM(
    "baggage", "meal", "service",
    name="customer_addon_type_enum", create_type=False,
)


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {REF_SEQ} START WITH 1 INCREMENT BY 1")

    # ------------------------------------------------------------------ 1/6 --
    op.create_table(
        "customer_hotels",
        sa.Column("customer_hotel_id", sa.BigInteger(), primary_key=True),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("star_rating", sa.SmallInteger(), nullable=False, server_default=sa.text("3")),
        sa.Column("guest_rating", sa.Numeric(2, 1), nullable=True),
        # "Area, City" — kept in the one format hotel-search.js's destination
        # index already parses (buildIndex() splits this on a comma).
        sa.Column("location", sa.String(length=200), nullable=False),
        sa.Column("distance_km", sa.Numeric(5, 1), nullable=True),
        # The lowest room's nightly rate, for the results card. The real price
        # a stay is booked at always comes from customer_hotel_rooms.
        sa.Column("price_per_night", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("amenities", postgresql.ARRAY(sa.String(length=60)), nullable=False,
                  server_default=sa.text("'{}'")),
        # Matches a key in HOTEL_IMAGE_FILES (assets/hotels/*.webp) so the real
        # vendored photograph keeps showing rather than a grey box.
        sa.Column("image_key", sa.String(length=60), nullable=True),
        sa.Column("images", postgresql.ARRAY(sa.String(length=60)), nullable=False,
                  server_default=sa.text("'{}'")),
        sa.Column("cancellation_policy", sa.String(length=255), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_customer_hotels_active", "customer_hotels", ["is_active"])

    # ------------------------------------------------------------------ 2/6 --
    op.create_table(
        "customer_hotel_rooms",
        sa.Column("customer_hotel_room_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "hotel_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotels.customer_hotel_id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("code", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=400), nullable=True),
        sa.Column("bed_type", sa.String(length=60), nullable=True),
        sa.Column("size_label", sa.String(length=30), nullable=True),
        sa.Column("max_guests", sa.SmallInteger(), nullable=False, server_default=sa.text("2")),
        sa.Column("base_price_per_night", sa.Numeric(12, 2), nullable=False),
        sa.Column("meal_plan", sa.String(length=60), nullable=False, server_default=sa.text("'Room only'")),
        sa.Column("cancellation_policy", sa.String(length=255), nullable=True),
        sa.Column("perks", postgresql.ARRAY(sa.String(length=60)), nullable=False,
                  server_default=sa.text("'{}'")),
        # What "Only N left" on the room card counts down from. Not a live
        # allotment against dates — there is no channel manager here — but a
        # believable number of this room type the property is selling.
        sa.Column("total_inventory", sa.SmallInteger(), nullable=False, server_default=sa.text("5")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.create_index("ix_customer_hotel_rooms_hotel", "customer_hotel_rooms", ["hotel_id"])

    # ------------------------------------------------------------------ 3/6 --
    op.create_table(
        "customer_hotel_bookings",
        sa.Column("customer_hotel_booking_id", sa.BigInteger(), primary_key=True),
        sa.Column("booking_ref", sa.String(length=20), nullable=False),
        sa.Column(
            "customer_id", sa.BigInteger(),
            sa.ForeignKey("customers.customer_id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("status", _BOOKING_STATUS, nullable=False, server_default=sa.text("'pending'")),

        # --- stay snapshot (see the module docstring on why it is a copy) ---
        sa.Column(
            "hotel_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotels.customer_hotel_id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("hotel_name", sa.String(length=150), nullable=False),
        sa.Column("hotel_location", sa.String(length=200), nullable=True),
        sa.Column(
            "room_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotel_rooms.customer_hotel_room_id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("room_name", sa.String(length=120), nullable=False),
        sa.Column("meal_plan", sa.String(length=60), nullable=True),
        sa.Column("check_in_date", sa.Date(), nullable=False),
        sa.Column("check_out_date", sa.Date(), nullable=False),
        sa.Column("nights", sa.Integer(), nullable=False),
        sa.Column("rooms_count", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("adults", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("children", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("child_ages", postgresql.ARRAY(sa.SmallInteger()), nullable=True),
        sa.Column("special_requests", postgresql.ARRAY(sa.String(length=60)), nullable=True),
        sa.Column("notes", sa.String(length=500), nullable=True),

        # --- fare breakdown; every line the Fare Summary shows ---
        sa.Column("room_subtotal", sa.Numeric(12, 2), nullable=False, server_default=sa.text("0")),
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
    op.create_index("uq_customer_hotel_bookings_ref", "customer_hotel_bookings",
                     ["booking_ref"], unique=True)
    op.create_index(
        "ix_customer_hotel_bookings_customer", "customer_hotel_bookings",
        ["customer_id", sa.text("created_at DESC")],
    )

    # ------------------------------------------------------------------ 4/6 --
    op.create_table(
        "customer_hotel_booking_guests",
        sa.Column("customer_hotel_booking_guest_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "hotel_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("guest_index", sa.Integer(), nullable=False),
        sa.Column("guest_type", _TRAVELLER_TYPE, nullable=False, server_default=sa.text("'adult'")),
        sa.Column("title", sa.String(length=10), nullable=True),
        sa.Column("first_name", sa.String(length=100), nullable=False),
        sa.Column("last_name", sa.String(length=100), nullable=False),
        sa.Column("gender", sa.String(length=20), nullable=True),
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column("nationality", sa.String(length=100), nullable=True),
        # Exactly one guest carries the booking's contact details, same rule
        # 0053 applies to a flight's passengers.
        sa.Column("is_contact", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("mobile", sa.String(length=30), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index(
        "uq_customer_hotel_booking_guest", "customer_hotel_booking_guests",
        ["hotel_booking_id", "guest_index"], unique=True,
    )

    # ------------------------------------------------------------------ 5/6 --
    op.create_table(
        "customer_hotel_booking_addons",
        sa.Column("customer_hotel_booking_addon_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "hotel_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
            nullable=False,
        ),
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
        "ix_customer_hotel_booking_addons_booking", "customer_hotel_booking_addons",
        ["hotel_booking_id"],
    )

    # ------------------------------------------------------------------ 6/6 --
    op.create_table(
        "customer_hotel_booking_payments",
        sa.Column("customer_hotel_booking_payment_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "hotel_booking_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
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
        "ix_customer_hotel_booking_payments_booking", "customer_hotel_booking_payments",
        ["hotel_booking_id"],
    )

    # ------------------------------------------------------------------------
    # Seed inventory — the same six properties SAMPLE_HOTELS has always shown,
    # now with the fields the demo never had. Prices, stars, location and the
    # image key are transcribed from travel-data.js, not reinvented.
    # ------------------------------------------------------------------------
    op.execute(
        """
        INSERT INTO customer_hotels
            (customer_hotel_id, name, description, star_rating, guest_rating, location,
             distance_km, price_per_night, amenities, image_key, images, cancellation_policy)
        VALUES
            (1, 'Taj Palace', 'A landmark five-star address in the heart of Banjara Hills, '
             'built around a heritage courtyard and known for its rooftop pool and full-service spa.',
             5, 4.6, 'Banjara Hills, Hyderabad', 24, 12500,
             ARRAY['Free Wi-Fi','Pool','Spa','Airport shuttle'], 'taj-palace', ARRAY['taj-palace'],
             'Free cancellation up to 48 hours before check-in. Cancel later or no-show and the first night is charged.'),
            (2, 'Novotel Hyderabad', 'A modern business hotel in HITEC City, a short walk from the '
             'financial district, with an all-day dining restaurant and a rooftop pool.',
             5, 4.4, 'HITEC City, Hyderabad', 28, 8200,
             ARRAY['Free Wi-Fi','Pool','Gym','Breakfast'], 'novotel-hyderabad', ARRAY['novotel-hyderabad'],
             'Free cancellation up to 24 hours before check-in. Cancel later or no-show and the first night is charged.'),
            (3, 'Hyatt Regency', 'Contemporary rooms overlooking the Hussain Sagar lake, with a '
             'well-regarded all-day restaurant and a 24-hour gym.',
             5, 4.5, 'Road No. 2, Hyderabad', 26, 9600,
             ARRAY['Free Wi-Fi','Restaurant','Gym'], 'hyatt-regency', ARRAY['hyatt-regency'],
             'Free cancellation up to 48 hours before check-in. Cancel later or no-show and the first night is charged.'),
            (4, 'Radisson', 'A dependable four-star stay in Gachibowli, close to the IT corridor, '
             'with complimentary breakfast and on-site parking.',
             4, 4.1, 'Gachibowli, Hyderabad', 22, 6400,
             ARRAY['Free Wi-Fi','Breakfast','Parking'], 'radisson', ARRAY['radisson'],
             'Free cancellation up to 24 hours before check-in. Cancel later or no-show and the first night is charged.'),
            (5, 'Marriott', 'Lake-view rooms on Tank Bund with a large outdoor pool and a choice '
             'of three restaurants.',
             5, 4.5, 'Tank Bund, Hyderabad', 31, 11200,
             ARRAY['Free Wi-Fi','Pool','Lake view'], 'marriott', ARRAY['marriott'],
             'Free cancellation up to 48 hours before check-in. Cancel later or no-show and the first night is charged.'),
            (6, 'Novotel Bengaluru', 'A well-connected stay on the Outer Ring Road, close to the '
             'tech parks, with a gym and a daily breakfast spread.',
             4, 4.2, 'Outer Ring Road, Bengaluru', 34, 7300,
             ARRAY['Free Wi-Fi','Gym','Breakfast'], 'novotel-bengaluru', ARRAY['novotel-bengaluru'],
             'Free cancellation up to 24 hours before check-in. Cancel later or no-show and the first night is charged.')
        """
    )
    # Bring the identity sequence past the ids inserted by hand above, so the
    # next hotel added through the ORM does not collide with id 6.
    op.execute(
        "SELECT setval(pg_get_serial_sequence('customer_hotels', 'customer_hotel_id'), 6, true)"
    )

    # Three room tiers per property — the same Superior/Deluxe/Executive Suite
    # ladder booking-data.js's buildRooms() generated from a hotel's nightly
    # rate, now priced and named per hotel rather than derived at read time.
    op.execute(
        """
        INSERT INTO customer_hotel_rooms
            (hotel_id, code, name, description, bed_type, size_label, max_guests,
             base_price_per_night, meal_plan, cancellation_policy, perks, total_inventory)
        SELECT
            h.customer_hotel_id, r.code, r.name, r.description, r.bed_type, r.size_label,
            r.max_guests, ROUND(h.price_per_night * r.multiplier / 50) * 50, r.meal_plan,
            h.cancellation_policy, r.perks, r.total_inventory
        FROM customer_hotels h
        CROSS JOIN (VALUES
            ('std', 'Superior Room', 'A comfortable room with a city or garden outlook.',
             '1 King or 2 Twin', '28 m²', 2, 1.0, 'Room only',
             ARRAY['Free Wi-Fi','Air conditioning'], 6),
            ('deluxe', 'Deluxe Room', 'A larger room on a higher floor with an upgraded city view.',
             '1 King', '34 m²', 3, 1.28, 'Breakfast included',
             ARRAY['Free Wi-Fi','Breakfast included','City view'], 4),
            ('suite', 'Executive Suite', 'A suite with a separate living area and lounge access.',
             '1 King + sofa bed', '52 m²', 4, 1.85, 'Half board',
             ARRAY['Free Wi-Fi','Breakfast included','Lounge access','Late checkout'], 2)
        ) AS r(code, name, description, bed_type, size_label, max_guests, multiplier,
               meal_plan, perks, total_inventory)
        """
    )


def downgrade() -> None:
    op.drop_table("customer_hotel_booking_payments")
    op.drop_table("customer_hotel_booking_addons")
    op.drop_table("customer_hotel_booking_guests")
    op.drop_table("customer_hotel_bookings")
    op.drop_table("customer_hotel_rooms")
    op.drop_table("customer_hotels")

    op.execute(f"DROP SEQUENCE IF EXISTS {REF_SEQ}")
