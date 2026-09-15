"""Hotels learn where they are, and where they came from.

THE PROBLEM THIS FIXES. ``customer_hotels`` has carried a free-text
``location`` — 'Banjara Hills, Hyderabad' — since 0055. It reads well on a card
and is useless as a relationship: you cannot ask it for "every hotel in Goa"
without matching strings, and string matching is exactly how a hotel ends up
filed under the wrong city. Meanwhile 0070 gave us real geography
(``customer_destinations`` -> ``customer_locations``) that nothing pointed at.

This migration connects the two, and adds the columns a supplier-sourced
catalogue needs.

WHY THE FOREIGN KEYS ARE NULLABLE. A hotel with no location must remain
sellable. Making these NOT NULL would mean either inventing a location for
every unmatched row or deleting rows, and both are worse than a null. The
listing route treats null as "not in any location" and simply does not show it
under a location filter; it still appears under the destination when the
destination is known.

WHY ``destination_id`` IS STORED ON THE HOTEL AS WELL AS REACHABLE VIA
``location_id``. Two reasons, and neither is denormalisation for speed alone.
A hotel can be known to be in Goa before anyone has decided it is in Calangute
— that is the ordinary state of a freshly synced record — and "every hotel in
this destination" is the single most common query this table will serve. One
indexed predicate beats a join for it.

THE BACKFILL IS EXACT-MATCH ONLY, AND RUNS ONCE. Five of the six seeded hotels
carry a ``location`` whose leading segment equals a ``customer_locations.name``
exactly ('Banjara Hills, Hyderabad' -> 'Banjara Hills'). Those are linked. The
sixth, Hyatt Regency at 'Road No. 2, Hyderabad', has no matching location row
and is deliberately left with a null ``location_id`` and only its destination
set. Guessing it into a neighbouring zone would be inventing data.

This is a ONE-TIME data migration, not a runtime strategy. Nothing in the
application resolves a hotel's location by matching its name or its address
text; from here on the foreign key is the only answer, which is the whole
point of adding it.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0072_hotel_destination_links"
down_revision: Union[str, None] = "0071_destination_image_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---------------------------------------------------------- geography --
    op.add_column("customer_hotels", sa.Column("destination_id", sa.BigInteger(), nullable=True))
    op.add_column("customer_hotels", sa.Column("location_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        "fk_customer_hotels_destination", "customer_hotels", "customer_destinations",
        ["destination_id"], ["customer_destination_id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_customer_hotels_location", "customer_hotels", "customer_locations",
        ["location_id"], ["customer_location_id"], ondelete="SET NULL",
    )
    # The two predicates the listing route is built on.
    op.create_index("ix_customer_hotels_destination", "customer_hotels", ["destination_id"])
    op.create_index("ix_customer_hotels_location", "customer_hotels", ["location_id"])

    # ------------------------------------------------- supplier provenance --
    # `source` says where a row came from, so a sync can refresh what it owns
    # without touching hand-seeded rows. Existing rows are 'seed' by definition.
    op.add_column(
        "customer_hotels",
        sa.Column("source", sa.String(20), nullable=False, server_default="seed"),
    )
    # Hotelbeds' own hotel code. UNIQUE so a re-run updates rather than
    # duplicates — the sync's idempotency rests entirely on this constraint.
    op.add_column("customer_hotels", sa.Column("hotelbeds_code", sa.Integer(), nullable=True))
    op.create_unique_constraint(
        "uq_customer_hotels_hotelbeds_code", "customer_hotels", ["hotelbeds_code"],
    )
    op.add_column("customer_hotels", sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True))

    # --------------------------------------------------- content the API has --
    # Fields Hotelbeds returns that we had nowhere to put. All nullable: the
    # seeded rows have none of them and are not wrong for that.
    op.add_column("customer_hotels", sa.Column("address", sa.String(255), nullable=True))
    op.add_column("customer_hotels", sa.Column("postal_code", sa.String(20), nullable=True))
    op.add_column("customer_hotels", sa.Column("city", sa.String(120), nullable=True))
    op.add_column("customer_hotels", sa.Column("country_code", sa.String(2), nullable=True))
    op.add_column("customer_hotels", sa.Column("latitude", sa.Numeric(9, 6), nullable=True))
    op.add_column("customer_hotels", sa.Column("longitude", sa.Numeric(9, 6), nullable=True))

    # Facility names from Hotelbeds regularly exceed 60 characters ("Free
    # cancellation up to 24 hours before arrival" is 44; plenty are longer).
    # Widening loses nothing and stops the adapter having to discard them.
    op.execute("ALTER TABLE customer_hotels ALTER COLUMN amenities TYPE varchar(120)[]")
    # Supplier image paths ('00/000112/000112a_hb_ro_025.jpg') are ~31 chars,
    # but room-level paths run longer.
    op.execute("ALTER TABLE customer_hotels ALTER COLUMN images TYPE varchar(160)[]")

    # ------------------------------------------- external destination codes --
    # Never assume our slug equals a supplier code. These hold the mapping.
    op.add_column("customer_destinations", sa.Column("hotelbeds_destination_code", sa.String(10), nullable=True))
    op.add_column("customer_locations", sa.Column("hotelbeds_zone_code", sa.Integer(), nullable=True))

    # ------------------------------------------------------------ backfill --
    # Destination first, from the trailing segment of `location` ('…, Hyderabad').
    op.execute(sa.text("""
        UPDATE customer_hotels h
           SET destination_id = d.customer_destination_id
          FROM customer_destinations d
         WHERE h.destination_id IS NULL
           AND btrim(split_part(h.location, ',', 2)) = d.name
    """))
    # Then location, from the leading segment, and only within the destination
    # we just established — so a zone name shared by two cities cannot cross over.
    op.execute(sa.text("""
        UPDATE customer_hotels h
           SET location_id = l.customer_location_id
          FROM customer_locations l
         WHERE h.location_id IS NULL
           AND h.destination_id = l.destination_id
           AND btrim(split_part(h.location, ',', 1)) = l.name
    """))


def downgrade() -> None:
    op.drop_column("customer_locations", "hotelbeds_zone_code")
    op.drop_column("customer_destinations", "hotelbeds_destination_code")

    op.execute("ALTER TABLE customer_hotels ALTER COLUMN images TYPE varchar(60)[]")
    op.execute("ALTER TABLE customer_hotels ALTER COLUMN amenities TYPE varchar(60)[]")

    for col in ("longitude", "latitude", "country_code", "city", "postal_code", "address",
                "last_synced_at"):
        op.drop_column("customer_hotels", col)
    op.drop_constraint("uq_customer_hotels_hotelbeds_code", "customer_hotels", type_="unique")
    op.drop_column("customer_hotels", "hotelbeds_code")
    op.drop_column("customer_hotels", "source")

    op.drop_index("ix_customer_hotels_location", table_name="customer_hotels")
    op.drop_index("ix_customer_hotels_destination", table_name="customer_hotels")
    op.drop_constraint("fk_customer_hotels_location", "customer_hotels", type_="foreignkey")
    op.drop_constraint("fk_customer_hotels_destination", "customer_hotels", type_="foreignkey")
    op.drop_column("customer_hotels", "location_id")
    op.drop_column("customer_hotels", "destination_id")
