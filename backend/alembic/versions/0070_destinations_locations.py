"""Destinations and locations become real tables instead of a query over inventory.

WHAT WAS WRONG
--------------
The Destinations shelf on the homepage derived a destination by reading
``customer_hotels.location`` and ``customer_packages.name``. That made a place
exist only for as long as something was for sale in it, and the symptom was
exact: Goa — a destination this company sells a seven-day tour package to —
reported "No locations available", because no Goa hotel had been loaded into
``customer_hotels`` and the only locations the old code could see were hotel
neighbourhoods. Seven of the nine destinations it found were dead ends for the
same reason.

A destination is a fact about the world. Whether we have a room there tonight is
a fact about our catalogue. The first is master data and belongs in its own
table; the second is inventory and already has one.

WHY SEEDING GEOGRAPHY IS NOT THE THING 0069 REFUSED TO DO
---------------------------------------------------------
0069 deliberately seeded no gaming packages, on the grounds that inventing
plausible trips with plausible prices "would put products on a public site that
nobody agreed to sell". That reasoning is about COMMERCIAL OFFERS, and it still
holds — this migration creates no hotel, no package, no price and no departure.

What it seeds is geography: Panaji is in Goa, Banjara Hills is in Hyderabad,
Ubud is in Bali. Those are checkable facts, not claims about what is on sale,
and the shelf they feed advertises nothing — pressing a location opens the
existing hotel search for that city, which will honestly return whatever is
actually there, including nothing.

WHERE THE LIST COMES FROM
-------------------------
Every destination below is one the product already references:

  * the seven tour packages seeded by 0056 — Dubai, Bali, Maldives, Singapore,
    Thailand, Kashmir, Goa
  * the cities ``customer_hotels`` has properties in — Hyderabad, Bengaluru
  * cities on the flight route map in assets/js/airports.js, reached from the
    Hyderabad base the departures board is built around — Delhi, Kolkata,
    Jaipur, Vijayawada, Tirupati
  * Mumbai, which the business asked for explicitly

Nowhere invented, nothing here that the catalogue has never heard of.

NOTHING REFERENCES THESE TABLES YET
-----------------------------------
``customer_hotels`` and ``customer_packages`` are untouched: no column added, no
row changed, no foreign key. Pointing them at a destination means matching free
text ("Banjara Hills, Hyderabad") to a row, which is a data migration with its
own failure modes and deserves its own change. The hierarchy exists now so that
work has something to point at.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0070_destinations_locations"
down_revision: Union[str, None] = "0069_package_category"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: (name, country, sort_order, [locations])
#: `sort_order` leads with the places the catalogue sells most in, so the shelf
#: opens on something useful; everything else is alphabetical behind them.
SEED: list[tuple[str, str, int, list[str]]] = [
    ("Goa", "India", 10, [
        "North Goa", "South Goa", "Panaji", "Calangute",
        "Candolim", "Baga", "Anjuna", "Vagator",
    ]),
    ("Hyderabad", "India", 20, [
        "Banjara Hills", "Jubilee Hills", "HITEC City", "Gachibowli",
        "Madhapur", "Secunderabad", "Tank Bund",
    ]),
    ("Mumbai", "India", 30, [
        "Colaba", "Bandra", "Andheri", "Juhu", "Powai", "Navi Mumbai",
    ]),
    ("Delhi", "India", 40, [
        "Connaught Place", "Aerocity", "Karol Bagh", "Saket",
        "Dwarka", "Paharganj",
    ]),
    ("Bengaluru", "India", 50, [
        "MG Road", "Indiranagar", "Koramangala", "Whitefield",
        "Electronic City", "Outer Ring Road",
    ]),
    ("Kashmir", "India", 60, [
        "Srinagar", "Gulmarg", "Pahalgam", "Sonamarg", "Dal Lake",
    ]),
    ("Jaipur", "India", 70, [
        "Amer", "Civil Lines", "MI Road", "Bani Park", "Vaishali Nagar",
    ]),
    ("Kolkata", "India", 80, [
        "Park Street", "Salt Lake", "New Town", "Alipore", "Howrah",
    ]),
    ("Vijayawada", "India", 90, [
        "Benz Circle", "Governorpet", "Labbipet", "Gannavaram",
    ]),
    ("Tirupati", "India", 100, [
        "Tirumala", "Alipiri", "Renigunta",
    ]),
    ("Dubai", "United Arab Emirates", 110, [
        "Downtown Dubai", "Dubai Marina", "Palm Jumeirah",
        "Jumeirah", "Deira", "Bur Dubai",
    ]),
    ("Bali", "Indonesia", 120, [
        "Ubud", "Seminyak", "Kuta", "Nusa Dua", "Canggu", "Uluwatu",
    ]),
    ("Maldives", "Maldives", 130, [
        "Malé", "North Malé Atoll", "South Malé Atoll",
        "Ari Atoll", "Baa Atoll",
    ]),
    ("Singapore", "Singapore", 140, [
        "Marina Bay", "Orchard", "Sentosa", "Chinatown", "Clarke Quay",
    ]),
    ("Thailand", "Thailand", 150, [
        "Bangkok", "Phuket", "Krabi", "Pattaya", "Chiang Mai", "Koh Samui",
    ]),
]


def _slug(value: str) -> str:
    """Mirrors the service's slug rule — ascii-folded, lowercase, hyphenated.

    Kept here rather than imported so the migration does not depend on
    application code that may change shape after it has already run.
    """
    import re
    import unicodedata

    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")


def upgrade() -> None:
    op.create_table(
        "customer_destinations",
        sa.Column("customer_destination_id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=120), nullable=False),
        sa.Column("country", sa.String(length=80), nullable=True),
        sa.Column("image_key", sa.String(length=60), nullable=True),
        sa.Column("sort_order", sa.SmallInteger(), nullable=False, server_default="100"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("customer_destination_id"),
        sa.UniqueConstraint("slug", name="uq_customer_destination_slug"),
    )

    op.create_table(
        "customer_locations",
        sa.Column("customer_location_id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("destination_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=120), nullable=False),
        sa.Column("sort_order", sa.SmallInteger(), nullable=False, server_default="100"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["destination_id"], ["customer_destinations.customer_destination_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("customer_location_id"),
        sa.UniqueConstraint("destination_id", "slug", name="uq_customer_location_slug"),
    )
    op.create_index("ix_customer_locations_destination_id", "customer_locations",
                    ["destination_id"])

    # ---------------------------------------------------------------- seed
    conn = op.get_bind()
    dest_t = sa.table(
        "customer_destinations",
        sa.column("customer_destination_id", sa.BigInteger),
        sa.column("name", sa.String), sa.column("slug", sa.String),
        sa.column("country", sa.String), sa.column("sort_order", sa.SmallInteger),
    )
    loc_t = sa.table(
        "customer_locations",
        sa.column("destination_id", sa.BigInteger),
        sa.column("name", sa.String), sa.column("slug", sa.String),
        sa.column("sort_order", sa.SmallInteger),
    )

    for name, country, order, locations in SEED:
        dest_id = conn.execute(
            dest_t.insert()
            .values(name=name, slug=_slug(name), country=country, sort_order=order)
            .returning(dest_t.c.customer_destination_id)
        ).scalar_one()

        if not locations:
            continue
        conn.execute(loc_t.insert(), [
            {"destination_id": dest_id, "name": loc, "slug": _slug(loc),
             "sort_order": (i + 1) * 10}
            for i, loc in enumerate(locations)
        ])


def downgrade() -> None:
    op.drop_index("ix_customer_locations_destination_id", table_name="customer_locations")
    op.drop_table("customer_locations")
    op.drop_table("customer_destinations")
