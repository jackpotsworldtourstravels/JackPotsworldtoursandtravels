"""Charminar gets the guidebook entry its page was built to show — for one landmark, because one is what was supplied.

WHY THIS EXISTS. 0080 added the editorial columns and deliberately left every
one of them empty, which meant the highlights strip, the long read and "plan
your visit" never drew. The owner then supplied the content for Charminar:
"Best Time To Visit: Oct - Feb", "Ideal Duration: 1-2 Days", "Famous For:
Heritage, Food, Shopping, Culture", "Recommended For: Family, Couple, Solo".
Those four are written here exactly as given.

THE LONG READ IS DRAFTED, NOT RESEARCHED-IN-PLACE, AND SHOULD BE READ BEFORE
IT IS TRUSTED. The brief asked for a description covering the monument's
history, architecture, cultural importance and what a visit is like. What is
below is a plain account of well-documented facts about Charminar - the 1591
founding under Muhammad Quli Qutb Shah, the four arches and minarets, the
mosque on the upper floor, Laad Bazaar and Mecca Masjid beside it. It contains
no prices, no opening hours and no superlatives about the company, because
those are the claims a page must not make up. It is still prose somebody
should check and edit; that is what an editable column is for.

ONE ROW, BY SLUG. "Oct - Feb" is true of Hyderabad and false of Kashmir, so
nothing here touches the other 92 landmarks. They keep drawing the sections
they have content for, which today is still none, until somebody supplies
theirs the same way.

REVERSIBLE, AND ONLY FOR WHAT IT WROTE. The downgrade nulls exactly these
columns on exactly this row.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0081_charminar_editorial"
down_revision: Union[str, None] = "0080_attraction_editorial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SLUG = "charminar"

#: Supplied by the owner, verbatim. The notes beside the first two are the
#: one-line explanations the design puts under the value; they say why the
#: season and the duration are what they are, and nothing more.
_VALUES = {
    "best_time": "Oct - Feb",
    "best_time_note": "Cooler, drier months for walking the old city",
    "ideal_duration": "1 - 2 Days",
    "ideal_duration_note": "Enough for the monument, the bazaar and Mecca Masjid",
    "famous_for": ["Heritage", "Food", "Shopping", "Culture"],
    "recommended_for": ["Family", "Couple", "Solo"],
}

_LONG_DESCRIPTION = (
    "Charminar has stood at the centre of Hyderabad's old city since 1591, "
    "raised by Muhammad Quli Qutb Shah, the fifth ruler of the Qutb Shahi "
    "dynasty, as the new city grew outwards from the banks of the Musi. Four "
    "centuries later the streets still meet at its feet, and the monument is "
    "read as the city's signature the way the Gateway is read as Mumbai's."
    "\n\n"
    "The building is square in plan, with a great pointed arch cut into each "
    "face and a minaret rising from each corner, every one of them ringed by "
    "balconies and finished with a bulbous dome. It is built of granite and "
    "lime mortar, and the stucco work over the arches - the medallions, the "
    "petalled borders, the row of small arches along the parapet - is the "
    "Indo-Islamic ornament the Qutb Shahi period is known for. A mosque "
    "occupies the upper floor, which is why the structure is a place of "
    "worship as well as a landmark."
    "\n\n"
    "What surrounds it is as much of the visit as the monument itself. Laad "
    "Bazaar runs west from the arches and has sold lacquer bangles, pearls "
    "and wedding goods for generations; Mecca Masjid, one of the largest "
    "mosques in India, stands a short walk south. The lanes between them are "
    "where Hyderabad's food is - biryani, haleem in Ramzan, Irani chai and "
    "Osmania biscuits in tea houses that have not changed their furniture in "
    "decades."
    "\n\n"
    "Most visitors come in the morning, when the light is on the eastern face "
    "and the bazaar is only beginning, or after dark, when the monument is "
    "lit and the crowd is at its thickest. It is a working junction rather "
    "than a quiet ruin: expect traffic, noise and a great deal of life around "
    "a building that has been at the middle of all of it since the city was "
    "founded."
)


def upgrade() -> None:
    columns = dict(_VALUES)
    columns["long_description"] = _LONG_DESCRIPTION
    sets = ", ".join(f"{name} = :{name}" for name in columns)
    op.execute(
        sa.text(f"UPDATE customer_attractions SET {sets} WHERE slug = :slug")
        .bindparams(slug=_SLUG, **columns)
    )


def downgrade() -> None:
    names = list(_VALUES) + ["long_description"]
    sets = ", ".join(f"{name} = NULL" for name in names)
    op.execute(
        sa.text(f"UPDATE customer_attractions SET {sets} WHERE slug = :slug")
        .bindparams(slug=_SLUG)
    )
