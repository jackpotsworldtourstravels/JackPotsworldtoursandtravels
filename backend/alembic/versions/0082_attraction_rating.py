"""A landmark can carry a rating — one somebody sourced, shown with where it came from.

WHY THIS EXISTS, AND WHY IT IS NOT A REVIEW AVERAGE. The design has asked
three times for a rating under the name in the hero, and the page has shown
none, because there was nowhere true to get one: ``customer_reviews`` holds
zero rows for anything at all, and its ``item_type`` enum does not include
landmarks. A number invented to fill the slot is the one thing a booking site
must never print, so the slot stayed empty.

WHAT THESE COLUMNS ARE. A rating the business records, with its SOURCE stored
beside it and displayed with it - "4.6, 12,540 ratings, Google Maps". That is
a different claim from "our customers rated this 4.6", and saying which is
the entire point: the page attributes the figure rather than passing somebody
else's number off as its own. Whoever fills these in is making a statement of
fact they can point at, the same way 0081's opening hours and seasons work.

WHEN CUSTOMER REVIEWS EXIST, THIS BECOMES THE FALLBACK, not the answer. The
honest long-term source is travellers rating the place through this site;
that needs 'attraction' added to customer_item_type_enum and a review form,
and when it lands the aggregate should win and this column should describe
itself as the external figure it always was.

EMPTY ON PURPOSE. Nothing is seeded. The hero draws no rating until somebody
supplies one, exactly as before - what changes is that there is now somewhere
for a real one to live.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0082_attraction_rating"
down_revision: Union[str, None] = "0081_charminar_editorial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    # 0.0 - 5.0, one decimal: the scale every travel site prints and the only
    # one this page knows how to draw.
    ("rating", sa.Numeric(2, 1)),
    # How many ratings that average is over. Null when the source gives no
    # count - the page then shows the score alone rather than inventing a
    # denominator.
    ("rating_count", sa.Integer()),
    # WHERE IT CAME FROM, and the page refuses to show a score without it.
    # "Google Maps", "Tripadvisor", "JackPots guests". A number with no source
    # is an assertion; a number with one is a citation.
    ("rating_source", sa.String(80)),
)


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        op.add_column("customer_attractions", sa.Column(name, type_, nullable=True))
    # A score outside 0-5 is a mistake at the point of entry, not something to
    # discover in a hero. Counts are never negative.
    op.create_check_constraint(
        "ck_customer_attraction_rating_range",
        "customer_attractions",
        "(rating IS NULL OR (rating >= 0 AND rating <= 5))"
        " AND (rating_count IS NULL OR rating_count >= 0)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_customer_attraction_rating_range", "customer_attractions")
    for name, _type in reversed(_COLUMNS):
        op.drop_column("customer_attractions", name)
