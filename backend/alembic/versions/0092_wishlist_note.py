"""wishlist_note — a short customer note on each saved item.

Adds one nullable ``note`` column to ``customer_wishlist`` so a signed-in
customer can annotate a saved hotel or package ("great rooftop pool", "ask
about the May rate"). Purely additive and backward compatible: every existing
row takes NULL, which the account UI renders as "no note", and the save/remove
behaviour that predates this column is untouched. The service normalises a
blank note to NULL, so there is no empty-string state to migrate or reason
about. No foreign key, no index — a note is read only alongside its own row,
which is already fetched by ``customer_wishlist_id``/``customer_id``.

500 chars matches the column on the model (``CustomerWishlistItem.note``); the
API also caps the field at 500 so an over-long note is refused at the edge
rather than truncated here.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0092_wishlist_note"
down_revision: Union[str, None] = "0091_tour_package_enquiries"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_wishlist",
        sa.Column("note", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_wishlist", "note")
