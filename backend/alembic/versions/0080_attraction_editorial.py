"""A famous place gets the things a guidebook says about it — as columns, not as copy in a page.

WHY THIS EXISTS. The destination page design asks for what any real travel
site shows about a landmark: when to go, how long to spend, what it is famous
for, who it suits, its history, how to reach it, what to know before you
stand in front of it, and more than one photograph of it. The table held a
name, a one-line description and a single image key — everything else in that
design would have had to be typed into the frontend.

TYPED INTO THE FRONTEND IS THE THING THIS PROJECT KEEPS REFUSING TO DO. A
sentence about Charminar living in JavaScript is a sentence that cannot be
corrected without a deploy, cannot differ per landmark without a branch, and
is invisible to every other reader of this data. So the design's content
becomes columns, the API serves them, and the page renders the sections it
actually has.

EVERY COLUMN IS NULLABLE AND EVERY ONE STARTS EMPTY. This migration writes no
prose. "Best time to visit: Oct-Feb" is a claim about the world, and inventing
93 of them to make a layout look full is exactly the lie the rest of this
codebase is built to avoid — the page simply does not draw a section it has
nothing true to put in. Filling them is an editorial job, done once per
landmark, and the page grows as they are filled.

ARRAYS WHERE THE DESIGN SHOWS A LIST (famous_for, recommended_for,
travel_tips, gallery) so the frontend never splits a string on commas and
hopes. `gallery` holds IMAGE KEYS on the same convention as image_key — the
manifest resolves them, nothing stores a URL.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "0080_attraction_editorial"
down_revision: Union[str, None] = "0079_guest_customers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: (column, type). Text where the design shows a paragraph, array where it
#: shows a list. No defaults: absent is the honest starting value.
_COLUMNS = (
    # The long read under "About the destination". `description` stays the
    # one-line summary the cards use; this is the article beneath it.
    ("long_description", sa.Text()),
    # The information strip.
    ("best_time", sa.String(80)),          # "Oct - Feb"
    ("best_time_note", sa.String(120)),    # "Pleasant weather"
    ("ideal_duration", sa.String(80)),     # "1 - 2 days"
    ("ideal_duration_note", sa.String(120)),
    ("famous_for", ARRAY(sa.String(60))),
    ("recommended_for", ARRAY(sa.String(60))),
    # "Plan your visit".
    ("history", sa.Text()),
    ("how_to_reach", sa.Text()),
    ("travel_tips", ARRAY(sa.String(240))),
    # More photographs of the same place. Image KEYS, resolved through the
    # manifest exactly as image_key is.
    ("gallery", ARRAY(sa.String(80))),
    # A map link, when somebody has checked it points at the right place. No
    # coordinates here: this table has none, and deriving a map URL from a
    # name would drop travellers at whatever the search engine guessed.
    ("map_url", sa.String(400)),
)


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        op.add_column("customer_attractions", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _type in reversed(_COLUMNS):
        op.drop_column("customer_attractions", name)
