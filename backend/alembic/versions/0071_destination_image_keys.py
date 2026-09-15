"""Destinations get their image keys, so the shelf can stop showing flat tints.

0070 created ``customer_destinations`` with an ``image_key`` column and left every
row null, because it seeded geography and there was no artwork to point at. There
is now: ``scripts/fetch_destination_images.py`` vendors one photograph per
destination from Wikimedia Commons into ``frontend/assets/destinations/``, the
same pipeline ``fetch_hotel_images.py`` has used for hotel art, with the same
licence gate (Public Domain / CC0 / CC BY / CC BY-SA only) and the same
regenerated CREDITS.md.

THE KEY IS THE SLUG, and that is not laziness. ``customer_hotels.image_key``
already works this way — 'taj-palace' is both the property's key and its file
name — and one convention across both catalogues means one resolver in the
frontend instead of two. What it must NOT become is an invitation for the
browser to skip the column: the API sends ``image``, read from ``image_key``,
and home-destinations.js reads that field. It never derives art from ``slug``,
which is what keeps "goa -> goa-beach" a data decision (spec §27).

WHY UPDATE RATHER THAN RE-SEED. The rows are 0070's and may already have been
edited; this sets ``image_key`` only where it is still null, so a hand-chosen key
survives a re-run. It touches nothing else on the row.

A DESTINATION WITHOUT ART IS NOT BROKEN. If a key has no file, the generated
manifest (frontend/assets/js/destination-images.js) simply does not list it and
the card keeps the tinted ground it has today. That is why this migration can set
a key for every row without first proving a file exists for each — the frontend's
contract is "listed in the manifest", not "has a non-null key".
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0071_destination_image_keys"
down_revision: Union[str, None] = "0070_destinations_locations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE customer_destinations "
            "SET image_key = slug "
            "WHERE image_key IS NULL"
        )
    )


def downgrade() -> None:
    """Clear only the keys that match the slug — anything hand-set is left alone."""
    op.execute(
        sa.text(
            "UPDATE customer_destinations "
            "SET image_key = NULL "
            "WHERE image_key = slug"
        )
    )
