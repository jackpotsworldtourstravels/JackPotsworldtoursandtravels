"""add request_notes — internal operator notes on a booking

Revision ID: 0032_request_notes
Revises: 0031_request_documents
Create Date: 2026-07-30

Phase 4 gives the operations desk somewhere to record what is happening on a
booking: who the airline said what to, why a fare changed, what the merchant
asked for on the phone.

WHY THESE ARE STAFF-ONLY, IN THE SCHEMA AND NOT JUST THE UI
An internal note is written on the assumption the merchant will never read it.
That assumption is the whole point of the feature, so it is enforced in
``booking_ops_service`` (platform staff only, on every read and write) and the
notes are never attached to any merchant-facing response. There is deliberately
no ``visibility`` column: a single table serving both audiences is one wrong
default away from leaking an internal remark to a customer, and the platform
already has notifications and ``remarks`` for things the merchant should see.

WHY A TABLE AND NOT ``travel_details`` JSONB
A note has an author, a timestamp, an edit history and needs ordering and
pagination. That is a row, not a JSON blob — the same reasoning as 0031.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0032_request_notes"
down_revision: Union[str, None] = "0031_request_documents"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "request_notes",
        sa.Column("note_id", sa.BigInteger, primary_key=True),
        sa.Column(
            "request_id", sa.BigInteger,
            sa.ForeignKey("service_requests.request_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Denormalised so "every note on this merchant's bookings" is one
        # indexed read, the same reason request_documents carries it.
        sa.Column(
            "merchant_id", sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="CASCADE"),
            nullable=True,
        ),
        # SET NULL, not CASCADE: an operator leaving the company must not
        # silently delete the record of what they did on a live booking.
        sa.Column(
            "author_id", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("length(btrim(body)) > 0", name="ck_request_notes_body_not_blank"),
    )

    # Covers the only query that matters: this booking's notes, newest first.
    op.create_index(
        "ix_request_notes_request", "request_notes", ["request_id", "note_id"],
    )
    op.create_index("ix_request_notes_merchant", "request_notes", ["merchant_id"])

    op.execute(
        """
        CREATE TRIGGER trg_audit_request_notes
        AFTER INSERT OR UPDATE OR DELETE ON request_notes
        FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('note_id')
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_audit_request_notes ON request_notes")
    op.drop_index("ix_request_notes_merchant", table_name="request_notes")
    op.drop_index("ix_request_notes_request", table_name="request_notes")
    op.drop_table("request_notes")
