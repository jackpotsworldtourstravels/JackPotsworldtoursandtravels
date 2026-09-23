"""A tour package becomes something you can browse, filter and read about — not just a name and a price.

WHAT WAS THERE. ``customer_packages`` (0056) holds a name, a blurb, a
description, a number of days, a from-price, an international flag and a
shelf. That is enough to sell from a grid of seven tiles and no more: there is
nothing to filter by, nothing to put in a listing card, and nothing a detail
page could show beyond the paragraph it already has.

WHAT THE JOURNEY NEEDS. Category (domestic / pilgrimage / international),
destination, nights, a hotel standard, a rating, highlights, exclusions - and,
on their own tables because they are lists of rows, a day-by-day itinerary and
the hotels a trip puts you in.

WHAT IS BACKFILLED AND WHY IT IS SAFE. Three of the new columns are restated
facts, not new claims:

  destination   The seven packages are NAMED for where they go: "Goa",
                "Dubai", "Kashmir". Copying the name into `destination` states
                what the row already says, and it is a column from here on so
                that "Goa Beach Escape" can be named one thing and filed under
                another.
  nights        days - 1. A five-day trip is four nights; this is arithmetic
                on a column that is already there, not a guess about the trip.
  trip_type     `is_international` already says international or not, so it
                decides between those two. PILGRIMAGE IS NEVER GUESSED - no
                row is filed under it by this migration, because whether a
                trip is a pilgrimage is a merchandising decision about the
                product and not something a flag can imply.
  image_key     Only where artwork of that destination already shipped with
                the build (frontend/assets/destinations). The seven slugs are
                checked against that list by hand below; a package whose
                destination has no photograph keeps a null key and the card
                falls back to its drawn scene, exactly as today.

WHAT SHIPS EMPTY, AND STAYS EMPTY. hotel_category, rating, rating_count,
rating_source, highlights, exclusions, every itinerary row and every hotel
row. A day-by-day itinerary is a commercial promise about what a traveller
will be given; inventing one to make a page look finished would be inventing
the product. The detail page draws each section only when it has rows, so the
pages get longer as these are filled and never show a heading over nothing.

THE RATING FOLLOWS 0082's RULE: a score is served only with its source, and
the page prints the two together.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "0083_package_catalogue"
down_revision: Union[str, None] = "0082_attraction_rating"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: Destination slugs that HAVE artwork in frontend/assets/destinations. Listed
#: rather than derived: this migration cannot see the filesystem, and a key
#: pointing at a file that never shipped is a broken image on every card.
_HAVE_ART = ("bali", "dubai", "goa", "kashmir", "maldives", "singapore", "thailand", "tirupati")

_PACKAGE_COLUMNS = (
    ("destination", sa.String(120)),
    ("nights", sa.SmallInteger()),
    # domestic | pilgrimage | international. VARCHAR + CHECK for the reason
    # 0069 gives for `category`: the vocabulary is a merchandising decision,
    # and the next one should not need an ALTER TYPE.
    ("trip_type", sa.String(20)),
    # 3, 4 or 5. Null means the trip does not advertise one - which is most of
    # them today, and the filter simply offers the values that exist.
    ("hotel_category", sa.SmallInteger()),
    ("rating", sa.Numeric(2, 1)),
    ("rating_count", sa.Integer()),
    ("rating_source", sa.String(80)),
    # The three or four lines a listing card shows under the name. Separate
    # from `inclusions`, which is the contractual list on the detail page.
    ("highlights", ARRAY(sa.String(120))),
    ("exclusions", ARRAY(sa.String(120))),
)


def upgrade() -> None:
    for name, type_ in _PACKAGE_COLUMNS:
        op.add_column("customer_packages", sa.Column(name, type_, nullable=True))

    # -- restate what the rows already say --------------------------------
    op.execute(sa.text("UPDATE customer_packages SET destination = name WHERE destination IS NULL"))
    op.execute(sa.text(
        "UPDATE customer_packages SET nights = GREATEST(days - 1, 0) WHERE nights IS NULL"
    ))
    op.execute(sa.text(
        "UPDATE customer_packages SET trip_type = "
        "CASE WHEN is_international THEN 'international' ELSE 'domestic' END "
        "WHERE trip_type IS NULL"
    ))
    # Artwork only where artwork exists.
    op.execute(
        sa.text(
            "UPDATE customer_packages SET image_key = lower(destination) "
            "WHERE image_key IS NULL AND lower(destination) = ANY(:slugs)"
        ).bindparams(sa.bindparam("slugs", value=list(_HAVE_ART), type_=ARRAY(sa.String())))
    )

    op.create_check_constraint(
        "ck_customer_packages_trip_type",
        "customer_packages",
        "trip_type IS NULL OR trip_type IN ('domestic', 'pilgrimage', 'international')",
    )
    op.create_check_constraint(
        "ck_customer_packages_rating",
        "customer_packages",
        "(rating IS NULL OR (rating >= 0 AND rating <= 5))"
        " AND (rating_count IS NULL OR rating_count >= 0)"
        " AND (hotel_category IS NULL OR hotel_category BETWEEN 1 AND 7)",
    )
    # The listing filters by these two and by nothing else that is not already
    # indexed, so these are the two indexes the page actually asks for.
    op.create_index("ix_customer_packages_trip_type", "customer_packages", ["trip_type"])
    op.create_index("ix_customer_packages_destination", "customer_packages", ["destination"])

    # -- the day-by-day ----------------------------------------------------
    # ONE ROW PER DAY, not a blob of text with "Day 1:" in it: the page renders
    # a numbered list, the admin edits one day, and nothing has to parse prose
    # to find out how many days are described.
    op.create_table(
        "customer_package_itinerary",
        sa.Column("customer_package_itinerary_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "package_id", sa.BigInteger(),
            sa.ForeignKey("customer_packages.customer_package_id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        sa.Column("day_number", sa.SmallInteger(), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("location", sa.String(120), nullable=True),
        # Image KEY, resolved through a shipped manifest like every other
        # image on this site. Never a URL.
        sa.Column("image_key", sa.String(60), nullable=True),
        sa.Column("meals", ARRAY(sa.String(20)), nullable=True),
        sa.UniqueConstraint("package_id", "day_number", name="uq_package_itinerary_day"),
    )

    # -- where you sleep ---------------------------------------------------
    op.create_table(
        "customer_package_hotels",
        sa.Column("customer_package_hotel_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "package_id", sa.BigInteger(),
            sa.ForeignKey("customer_packages.customer_package_id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        sa.Column("hotel_name", sa.String(150), nullable=False),
        sa.Column("city", sa.String(120), nullable=True),
        sa.Column("star_rating", sa.SmallInteger(), nullable=True),
        sa.Column("room_type", sa.String(120), nullable=True),
        sa.Column("nights", sa.SmallInteger(), nullable=True),
        # OPTIONAL LINK TO A REAL HOTEL WE SELL. When it is set the page can
        # show that property's own photograph and rating instead of a name in
        # a box; when it is null the row is a name the tour operator gave us,
        # which is the usual case and is said as such.
        sa.Column(
            "hotel_id", sa.BigInteger(),
            sa.ForeignKey("customer_hotels.customer_hotel_id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("image_key", sa.String(60), nullable=True),
        sa.Column("sort_order", sa.SmallInteger(), nullable=False, server_default="100"),
    )


def downgrade() -> None:
    op.drop_table("customer_package_hotels")
    op.drop_table("customer_package_itinerary")
    op.drop_index("ix_customer_packages_destination", table_name="customer_packages")
    op.drop_index("ix_customer_packages_trip_type", table_name="customer_packages")
    op.drop_constraint("ck_customer_packages_rating", "customer_packages")
    op.drop_constraint("ck_customer_packages_trip_type", "customer_packages")
    for name, _type in reversed(_PACKAGE_COLUMNS):
        op.drop_column("customer_packages", name)
