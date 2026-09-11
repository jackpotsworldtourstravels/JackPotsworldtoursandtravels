"""Tour packages get a category, so gaming trips are a shelf and not a filter.

WHY A COLUMN AND NOT A NAME MATCH
---------------------------------
The site is adding a Gaming Packages page beside Holiday Packages. Both read
``customer_packages``, so something has to say which trips belong on which
page, and the only candidates already on the row are ``name`` and ``blurb``.
Matching on those is how ``mountPackageCard()`` in travel-explore.js ended up
with the bug its own comment describes: the card's options were package TYPES,
the catalogue's rows were package NAMES, "the two only sometimes read the
same", and a search for one package quietly showed all seven. A shelf a trip
sits on is a property of the trip, not a substring of its title.

``category`` is a plain VARCHAR with a CHECK rather than a Postgres enum. The
vocabulary here is a merchandising decision — the business may want Pilgrimage
or Corporate next, which is the same conversation as adding Gaming — and every
one of those is an ALTER TYPE and a migration if this is an enum. 0053's
statuses are an enum because a booking status is a state machine the code
branches on; this is a label the code groups by.

NOT NULL DEFAULT 'holiday' IS THE WHOLE POINT OF THE BACKFILL. The seven trips
seeded by 0056 are Dubai, Bali, Maldives, Singapore, Thailand, Kashmir and
Goa — every one of them a holiday, and every one of them already advertised on
packages.html. Defaulting keeps that page byte-identical: it asks for
``category=holiday`` and gets exactly the rows it showed yesterday.

NO GAMING ROWS ARE SEEDED HERE, deliberately. This is a real company's real
catalogue and inventing three plausible casino trips with plausible prices
would put products on a public site that nobody agreed to sell — the same
reason the date strip refuses to print a fare for a day it has no data for.
The column and the page are the plumbing; the trips are a commercial decision
and arrive as their own seed (or through an admin screen, which packages do
not have yet — 0056 seeded them and nothing has written to the table since).
Until then the Gaming Packages page renders its empty state, which asks the
visitor to enquire rather than pretending the shelf is stocked.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0069_package_category"
down_revision: Union[str, None] = "0068_call_hold_and_transfers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: The shelves a package can sit on. Adding one is a data change plus a page;
#: it is not an ALTER TYPE, which is why this is not an enum.
CATEGORIES = ("holiday", "gaming")


def upgrade() -> None:
    # server_default backfills the seven existing rows in the same statement,
    # so there is no window where the column exists and is NULL.
    op.add_column(
        "customer_packages",
        sa.Column(
            "category",
            sa.String(length=20),
            nullable=False,
            server_default="holiday",
        ),
    )
    op.create_check_constraint(
        "ck_customer_packages_category",
        "customer_packages",
        sa.text("category IN ('holiday', 'gaming')"),
    )
    # The grid filters on it and nothing else does, so one plain index on the
    # column the WHERE clause names. Partial would be smaller and would stop
    # being used the day a third category arrives.
    op.create_index(
        "ix_customer_packages_category",
        "customer_packages",
        ["category"],
    )


def downgrade() -> None:
    op.drop_index("ix_customer_packages_category", table_name="customer_packages")
    op.drop_constraint(
        "ck_customer_packages_category", "customer_packages", type_="check",
    )
    op.drop_column("customer_packages", "category")
