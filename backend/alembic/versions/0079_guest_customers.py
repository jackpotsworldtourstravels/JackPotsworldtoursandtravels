"""A guest is a customer with no credentials — not a UI label, and not an account.

WHAT "CONTINUE AS GUEST" HAS TO MEAN. A guest browses, saves to a wishlist,
searches and may book; all of that has to belong to somebody, because every one
of those tables is filed under ``customer_id`` and a booking that belongs to
nobody is a booking nobody can be shown afterwards. So a guest IS a customer
row — with ``is_guest`` set, no ``customer_auth`` row, no password, no verified
address, and nothing a person could sign into.

THAT IS NOT "CREATING AN ACCOUNT". Nothing is registered: there is no credential
to use, no way back into the row from another browser, and no email ever sent
to it. What it buys is the thing the brief actually asks for — every existing
endpoint, already scoped to ``get_current_customer``, isolates one guest from
another with no new code and no new rules to get wrong.

THE TWO UNIQUE INDEXES BECOME PARTIAL. ``customers`` is unique on
``lower(email)`` and on ``mobile``, and a guest has neither. It carries
synthetic placeholders instead — ``guest-<32 hex>@guest.invalid`` (``.invalid``
is reserved by RFC 2606 and can never be deliverable) and ``guest-<32 hex>`` —
which are unique but must never sit in the same namespace as real ones: a
placeholder occupying an address a real traveller later tries to sign up with
would turn this convenience into a lockout. Partial indexes keep the guarantee
exactly where it belongs, over real customers.

Reversing this deletes the guest rows outright. That is correct rather than
careless: without ``is_guest`` there is no way to tell them from real customers
afterwards, and leaving anonymous rows with fake addresses behind in a table
the business reads as its customer list is the worse outcome. Their bookings go
with them, which is why the downgrade refuses if any guest has one.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0079_guest_customers"
down_revision: Union[str, None] = "0078_merchant_no_approval"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customers",
        sa.Column("is_guest", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    # Every guest-aware query filters on this, and the admin customer list
    # excludes guests with it.
    op.create_index("ix_customers_is_guest", "customers", ["is_guest"])

    # The email/mobile guarantees now apply to REAL customers only.
    op.drop_index("uq_customers_email_lower", table_name="customers")
    op.create_index(
        "uq_customers_email_lower", "customers", [sa.text("lower(email)")],
        unique=True, postgresql_where=sa.text("is_guest = false"),
    )
    op.drop_index("uq_customers_mobile", table_name="customers")
    op.create_index(
        "uq_customers_mobile", "customers", ["mobile"],
        unique=True, postgresql_where=sa.text("is_guest = false"),
    )
    # A guest's placeholders are unique among guests too, so two sessions can
    # never collide on one row.
    op.create_index(
        "uq_customers_guest_email", "customers", ["email"],
        unique=True, postgresql_where=sa.text("is_guest = true"),
    )


def downgrade() -> None:
    conn = op.get_bind()
    booked = conn.execute(sa.text(
        "SELECT count(*) FROM customer_bookings b "
        "JOIN customers c ON c.customer_id = b.customer_id WHERE c.is_guest"
    )).scalar_one()
    if booked:
        raise RuntimeError(
            f"{booked} booking(s) belong to guest customers. Reversing 0079 would "
            "delete the only record of who made them — move them to real accounts "
            "first, or drop the bookings deliberately."
        )
    conn.execute(sa.text("DELETE FROM customers WHERE is_guest"))

    op.drop_index("uq_customers_guest_email", table_name="customers")
    op.drop_index("uq_customers_mobile", table_name="customers")
    op.create_index("uq_customers_mobile", "customers", ["mobile"], unique=True)
    op.drop_index("uq_customers_email_lower", table_name="customers")
    op.create_index(
        "uq_customers_email_lower", "customers", [sa.text("lower(email)")], unique=True,
    )
    op.drop_index("ix_customers_is_guest", table_name="customers")
    op.drop_column("customers", "is_guest")
