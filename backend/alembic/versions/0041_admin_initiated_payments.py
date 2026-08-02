"""admin-initiated payment requests — the desk asks, the manager pays

Revision ID: 0041_admin_initiated_payments
Revises: 0040_client_fare
Create Date: 2026-08-02

WHAT CHANGED, IN ONE LINE
Until now a top-up could only start merchant-side: the merchant said "I have
paid you", and the desk confirmed it. This adds the other direction — an Admin
raises a request against a merchant, names the **manager** who must settle it,
and states how (bank / cash / crypto). The manager pays, uploads proof, and the
desk approves. Only then is the wallet credited.

WHY THIS EXTENDS ``wallet_topups`` INSTEAD OF ADDING A TABLE
The two flows differ only in *who starts them*. From the moment proof is
attached they are the same object with the same lifecycle, the same proof file,
the same review, and — critically — the same credit.

That credit is the reason. ``verify_topup`` is documented as **the only path
that credits a merchant wallet from a top-up**, and it is protected by
``uq_wallet_transactions_topup`` (migration 0037), a unique index on
``wallet_transactions.topup_id`` that makes a double credit impossible even if
the row lock were bypassed. A parallel ``payment_requests`` table would need its
own credit path, and that path would sit **outside** that index — two ways to
credit a wallet, one of them unguarded. Extending the existing table keeps one
money path with one guard, which is the whole point of CR-4's design.

THE NEW STATUS
``awaiting_payment`` is where an Admin-raised request sits before the manager
has paid. It is deliberately a status and not a nullable timestamp, because
``_assert_undecided`` already refuses to review anything that is not
``submitted`` — so an Admin cannot approve, and therefore cannot credit, a
request nobody has paid yet. That guard comes for free and cannot be forgotten.

Merchant-initiated top-ups skip it entirely and still start at ``submitted``;
the server default is unchanged, so every one of the 442 existing rows and every
existing caller behaves exactly as before.

THE NEW METHOD
``crypto`` joins the method enum. Bank transfer and cash were already there and
are reused rather than renamed.

WHY ``instructions`` IS JSONB AND ``client_fare`` WAS NOT
The opposite call to 0040, for the opposite reason. These fields are never
summed, never sorted, never filtered — they are read back verbatim on one screen
so the manager knows where to send the money. They are also *different per
method*: a bank needs name/number/IFSC/branch, cash needs a token and a note
number, crypto needs an address and a network. Four nullable columns that are
only ever populated three-at-a-time is a worse model than one object, and no
aggregate will ever touch them.

``ck_wallet_topups_instructions_object`` mirrors ``ck_sr_details_is_object``:
JSONB will happily store a bare string or a number, and every reader here
assumes a mapping.

RESUBMISSION
The spec requires a rejected request to be resubmittable. ``resubmission_count``
records how many times that has happened; the row returns to ``submitted`` and
is reviewed again. This is safe for the UTR uniqueness rule because
``uq_wallet_topups_utr`` excludes rejected rows — so the manager can correct a
mistyped reference, but cannot resubmit a UTR that is live on another request.

BACKWARD COMPATIBILITY
Additive only. Every new column is nullable or defaulted, no existing column
changes type or nullability, no existing row is rewritten, and the existing
merchant-initiated flow is untouched. ``downgrade()`` drops the columns and the
index cleanly. It deliberately does **not** remove the enum values —
PostgreSQL cannot drop one, and a downgrade that must rebuild two enum types
(and every column, index and check that depends on them) to undo an additive
migration is far more dangerous than leaving two unused labels behind.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# Annotated, not bare — tests/verify_m9.py discovers the chain by regex and a
# bare assignment makes the file invisible to it. See 0040 for the incident.
revision: str = "0041_admin_initiated_payments"
down_revision: Union[str, None] = "0040_client_fare"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # PostgreSQL 12+ permits ADD VALUE inside a transaction provided the new
    # label is not *used* in the same transaction. Nothing below writes one, so
    # this is safe under Alembic's transactional DDL. IF NOT EXISTS makes the
    # migration re-runnable against a partially-applied database.
    op.execute(
        "ALTER TYPE wallet_topup_status_enum ADD VALUE IF NOT EXISTS 'awaiting_payment'"
    )
    op.execute(
        "ALTER TYPE wallet_topup_method_enum ADD VALUE IF NOT EXISTS 'crypto'"
    )

    op.add_column(
        "wallet_topups",
        sa.Column("raised_by", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "wallet_topups",
        sa.Column("assigned_manager_id", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "wallet_topups",
        sa.Column(
            "instructions",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "wallet_topups",
        sa.Column(
            "resubmission_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )

    # SET NULL, matching submitted_by/reviewed_by: a staff account being
    # deleted must not take the payment record with it.
    op.create_foreign_key(
        "fk_wallet_topups_raised_by", "wallet_topups", "users",
        ["raised_by"], ["user_id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_wallet_topups_assigned_manager", "wallet_topups", "users",
        ["assigned_manager_id"], ["user_id"], ondelete="SET NULL",
    )

    op.create_check_constraint(
        "ck_wallet_topups_instructions_object",
        "wallet_topups",
        "jsonb_typeof(instructions) = 'object'",
    )
    op.create_check_constraint(
        "ck_wallet_topups_resubmissions_non_negative",
        "wallet_topups",
        "resubmission_count >= 0",
    )

    # The manager's inbox: "what am I being asked to pay?" Partial, because the
    # rows that matter to a manager are a small slice of a growing table.
    op.create_index(
        "ix_wallet_topups_assigned",
        "wallet_topups",
        ["assigned_manager_id", "topup_id"],
        postgresql_where=sa.text("assigned_manager_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_wallet_topups_assigned", table_name="wallet_topups")
    op.drop_constraint(
        "ck_wallet_topups_resubmissions_non_negative", "wallet_topups", type_="check"
    )
    op.drop_constraint(
        "ck_wallet_topups_instructions_object", "wallet_topups", type_="check"
    )
    op.drop_constraint("fk_wallet_topups_assigned_manager", "wallet_topups", type_="foreignkey")
    op.drop_constraint("fk_wallet_topups_raised_by", "wallet_topups", type_="foreignkey")
    op.drop_column("wallet_topups", "resubmission_count")
    op.drop_column("wallet_topups", "instructions")
    op.drop_column("wallet_topups", "assigned_manager_id")
    op.drop_column("wallet_topups", "raised_by")
    # Enum labels are deliberately left in place — see the module docstring.
