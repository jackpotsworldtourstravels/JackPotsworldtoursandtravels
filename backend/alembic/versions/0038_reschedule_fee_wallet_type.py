"""reschedule fee — a dedicated wallet transaction type

Revision ID: 0038_reschedule_fee_wallet_type
Revises: 0037_topup_credit_once
Create Date: 2026-08-02

M3 quotes a reschedule's fare difference and change fee (``total_payable``) but
never charged it anywhere — the figure sat on the change request and the
wallet never moved. This adds the ledger type an approved reschedule bills
against, on a wallet-billed (Classic/enquiry-led) booking, the same way
``cancellation_charge`` already sits in the enum for the cancellation side.

WHY THE VALUE IS ADDED IN ITS OWN MIGRATION STEP, IN AN AUTOCOMMIT BLOCK
``ALTER TYPE ... ADD VALUE`` is transactional on PostgreSQL 12+, but the new
label cannot be *used* by the same transaction that adds it — see migration
0033, which added 'manager' the same way. Nothing here writes a
``reschedule_fee`` row; that happens later, from application code, in its own
transaction.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0038_reschedule_fee_wallet_type"
down_revision: Union[str, None] = "0037_topup_credit_once"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE wallet_txn_type_enum ADD VALUE IF NOT EXISTS 'reschedule_fee'")


def downgrade() -> None:
    # PostgreSQL cannot drop a value from an enum type. Removing it would mean
    # recreating wallet_txn_type_enum and rewriting every row that uses it,
    # which is a bigger operation than this migration exists to do — see
    # migration 0033's downgrade for the same call on user_role_enum.
    pass
