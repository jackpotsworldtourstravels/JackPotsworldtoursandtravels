"""provider management — who we buy the tickets FROM

Revision ID: 0039_provider_management
Revises: 0038_reschedule_fee_wallet_type
Create Date: 2026-08-02

WHAT A PROVIDER IS, AND WHAT IT IS NOT
A provider is an **external supplier** the operations desk buys from: an airline
consolidator, a booking portal, a cruise wholesaler. A ``provider_users`` row is
a named person *at that supplier* who actually made the booking.

**Neither is a user of this application.** There is no password column, no role,
no permission, no session, and no foreign key to ``users`` from either table
except the audit columns recording which *admin* created the row. That is a
deliberate schema-level statement: nothing here can become a login later without
a migration that somebody has to write and justify.

WHY NOT REUSE ``merchants`` / ``users``
A merchant is a customer who signs in and owes money; a provider is a supplier
who does neither. Putting suppliers in ``merchants`` would put rows with no
wallet, no credit limit and no login into every merchant-scoped query on the
platform — and ``ServiceRequest.merchant_id`` already means "the customer", so
the same column could not also mean "the supplier".

WHY ``provider_code`` COMES FROM A SEQUENCE
Same reasoning as ``seq_wallet_txn_number`` in 0036: ``nextval`` is
non-transactional, so a rolled-back insert leaves a gap in the series rather
than handing PRD007 to two providers. A code assembled in Python from
``COUNT(*) + 1`` is a check-then-act that two concurrent creates both pass.

WHY THE BOOKING COLUMNS ARE NULLABLE
Every booking that already exists was issued before providers did, and there is
no honest value to backfill — inventing one would be fabricating a purchase
record. They are nullable, and the analytics below simply do not count a booking
with no provider. This is what keeps the change backward compatible: an existing
booking is untouched and still issues exactly as it did.

WHY ``ON DELETE RESTRICT`` ON BOTH BOOKING REFERENCES
The business rule is "a provider with bookings against it cannot be deleted —
deactivate it instead". That rule is enforced here, in the schema, rather than
only in a service that could be bypassed. Same reasoning as the ledger's
RESTRICT in 0036: a purchase record must not be erasable by tidying up a
supplier list. The service layer exposes no delete at all, so this is a second
line rather than the only one.

NO DATA IS WRITTEN BY THIS MIGRATION. It creates two empty tables, one
sequence and two nullable columns; nothing existing is rewritten.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0039_provider_management"
down_revision: Union[str, None] = "0038_reschedule_fee_wallet_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CODE_SEQ = "seq_provider_code"

_PROVIDER_STATUS = postgresql.ENUM(
    "active", "inactive", name="provider_status_enum", create_type=False,
)


def upgrade() -> None:
    # A brand-new type, so it may be created and used in the same transaction —
    # the ALTER TYPE ... ADD VALUE restriction that 0038 works around applies
    # only to *existing* types.
    _PROVIDER_STATUS.create(op.get_bind(), checkfirst=True)

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {CODE_SEQ} START WITH 1 INCREMENT BY 1")

    op.create_table(
        "providers",
        sa.Column("provider_id", sa.BigInteger(), primary_key=True),
        sa.Column("provider_code", sa.String(length=20), nullable=False),
        sa.Column("provider_name", sa.String(length=200), nullable=False),
        sa.Column(
            "status", _PROVIDER_STATUS, nullable=False, server_default=sa.text("'active'")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        # Which ADMIN touched the row. Not a link to the provider — the provider
        # has no user account, by design.
        sa.Column(
            "created_by", sa.BigInteger(),
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "updated_by", sa.BigInteger(),
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.create_index(
        "uq_providers_code", "providers", ["provider_code"], unique=True,
    )
    # Case-insensitive: "Sky Travels" and "sky travels" are one supplier, and a
    # list that shows both is a list somebody has to reconcile by hand.
    op.create_index(
        "uq_providers_name_lower", "providers",
        [sa.text("lower(provider_name)")], unique=True,
    )
    op.create_index("ix_providers_status", "providers", ["status"])

    op.create_table(
        "provider_users",
        sa.Column("provider_user_id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "provider_id", sa.BigInteger(),
            # A provider user cannot outlive its provider, and cannot exist
            # without one — the spec's "Cannot exist without Provider", stated
            # as NOT NULL plus a foreign key rather than as a service check.
            sa.ForeignKey("providers.provider_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_name", sa.String(length=150), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("phone_number", sa.String(length=30), nullable=True),
        sa.Column(
            "status", _PROVIDER_STATUS, nullable=False, server_default=sa.text("'active'")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # "Prevent duplicate Provider User names within the same Provider" — scoped
    # to the provider, not global: two suppliers may each employ a John, and a
    # platform-wide unique name would refuse the second one for no reason.
    op.create_index(
        "uq_provider_users_name_per_provider", "provider_users",
        ["provider_id", sa.text("lower(user_name)")], unique=True,
    )
    op.create_index(
        "uq_provider_users_email_per_provider", "provider_users",
        ["provider_id", sa.text("lower(email)")], unique=True,
    )
    op.create_index("ix_provider_users_provider", "provider_users", ["provider_id"])

    # ---- the booking's link to what it was bought through --------------
    op.add_column(
        "service_requests",
        sa.Column("provider_id", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "service_requests",
        sa.Column("provider_user_id", sa.BigInteger(), nullable=True),
    )
    op.create_foreign_key(
        "fk_service_requests_provider", "service_requests", "providers",
        ["provider_id"], ["provider_id"], ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_service_requests_provider_user", "service_requests", "provider_users",
        ["provider_user_id"], ["provider_user_id"], ondelete="RESTRICT",
    )
    # The analytics are derived per provider and per provider user on every
    # read — there are no stored counters to drift — so these two indexes are
    # what keep that honest rather than slow.
    op.create_index(
        "ix_service_requests_provider", "service_requests", ["provider_id"],
        postgresql_where=sa.text("provider_id IS NOT NULL"),
    )
    op.create_index(
        "ix_service_requests_provider_user", "service_requests", ["provider_user_id"],
        postgresql_where=sa.text("provider_user_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_service_requests_provider_user", table_name="service_requests")
    op.drop_index("ix_service_requests_provider", table_name="service_requests")
    op.drop_constraint(
        "fk_service_requests_provider_user", "service_requests", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_service_requests_provider", "service_requests", type_="foreignkey"
    )
    op.drop_column("service_requests", "provider_user_id")
    op.drop_column("service_requests", "provider_id")

    op.drop_table("provider_users")
    op.drop_table("providers")

    op.execute(f"DROP SEQUENCE IF EXISTS {CODE_SEQ}")
    _PROVIDER_STATUS.drop(op.get_bind(), checkfirst=True)
