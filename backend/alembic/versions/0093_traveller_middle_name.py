"""traveller_middle_name — keep a middle name apart from the first name.

Adds one nullable ``middle_name`` column to ``customer_travellers`` so a saved
traveller can carry first / middle / last independently. Purely additive: every
existing row takes NULL, which means "no separate middle name recorded". Legacy
rows whose ``first_name`` already holds a combined "First Middle" string are
deliberately NOT split here -- guessing where a given name ends would corrupt
names like "Mary Ann" or "Anna Maria" -- so they read back exactly as saved.

The booking tables (flight / hotel / package) are untouched: they keep storing
the airline-facing given name in ``first_name``, composed from first + middle
at the booking boundary.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0093_traveller_middle_name"
down_revision: Union[str, None] = "0092_wishlist_note"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_travellers",
        sa.Column("middle_name", sa.String(length=100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_travellers", "middle_name")
