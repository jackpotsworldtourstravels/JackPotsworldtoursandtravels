"""one verified top-up credits the wallet exactly once

Revision ID: 0037_topup_credit_once
Revises: 0036_wallet_ledger
Create Date: 2026-08-01

CR-4d. Additive only — migration 0036 is not reopened.

WHY THIS INDEX EXISTS
``docs/WALLET_ARCHITECTURE.md`` §8 states the guarantee in as many words: a
top-up is credited "only when an admin verifies it, at which point **exactly
one** ``wallet_transactions`` row is written and linked back through
``topup_id``". Nothing enforced it. §2.6 of the same document is explicit about
what that has to mean:

    "The database owns correctness. A uniqueness rule that must hold is a
    constraint or a unique index, never a check-then-act in Python."

Verification is a read-modify-write on a shared row — two admins clicking Verify
on the same claim at the same instant. The service takes ``SELECT ... FOR
UPDATE`` on the top-up and re-checks its status, which is what makes the loser
get an ordinary 409 instead of a stack trace. But that lock is what owns the
*response*; this index is what owns the *money*. CR-4b's lesson, learned the
expensive way on ``uq_wallet_transactions_booking_debit``: with the index and no
lock the money stayed right and the responses were wrong; with the lock and no
index a single missed guard silently doubles a merchant's balance, and nothing
in the schema would have said no.

PARTIAL, BECAUSE MOST ROWS HAVE NO TOP-UP
Booking debits, refunds, credit notes and manual adjustments all carry
``topup_id IS NULL``, and NULLs are distinct in a unique index anyway — the
predicate keeps the index small and says what it means. Exactly the shape of
``uq_wallet_transactions_booking_debit``.

SAFE ON EXISTING DATA
No top-up has been credited yet: CR-4c ships submission only and
``topup_service`` contains no call to ``wallet_service.post``, so every
``wallet_transactions`` row in existence carries ``topup_id IS NULL``. The index
is created against a population it cannot conflict with. Verified before
writing this: 141 submitted top-ups, 0 transactions linked to any of them.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0037_topup_credit_once"
down_revision: Union[str, None] = "0036_wallet_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "uq_wallet_transactions_topup",
        "wallet_transactions",
        ["topup_id"],
        unique=True,
        postgresql_where=sa.text("topup_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_wallet_transactions_topup", table_name="wallet_transactions")
