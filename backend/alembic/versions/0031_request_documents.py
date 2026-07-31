"""add request_documents — supporting files on a booking request

Revision ID: 0031_request_documents
Revises: 0030_enquiry_sequence
Create Date: 2026-07-30

Phase 3 lets a merchant attach passports, visas and IDs to the booking request
raised from an answered enquiry.

WHY A TABLE AND NOT JSONB
Everything type-specific in this schema lives in ``travel_details`` JSONB, and
that was the right call for enquiry form fields. Documents are different: each
file carries its own verification state (``document.verify`` has existed as a
permission code since 0023 and this is what it was reserved for), its own
uploader and timestamps, and needs a foreign key to the passenger it belongs
to. A JSONB array cannot express that per-element, cannot be indexed per file,
and would make "show me everything awaiting verification" a full scan of every
request. The nine-table redesign collapsed 42 legacy tables that duplicated one
another; it was never a hard cap on genuinely new entities.

WHAT IS NOT STORED HERE
The file bytes. ``stored_path`` is a server-side path under the configured
upload root, with an opaque generated name — files are streamed back through an
authenticated endpoint that re-checks merchant scope on every read. They are
deliberately NOT reachable through a static mount: these are passport scans,
and a static directory would make every one of them readable by URL, across
merchants, with no authentication at all.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0031_request_documents"
down_revision: Union[str, None] = "0030_enquiry_sequence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

VERIFICATION_ENUM = "document_verification_enum"
DOC_TYPE_ENUM = "document_type_enum"


def upgrade() -> None:
    verification = postgresql.ENUM(
        "pending", "verified", "rejected",
        name=VERIFICATION_ENUM, create_type=False,
    )
    doc_type = postgresql.ENUM(
        "passport", "visa", "photo_id", "ticket", "other",
        name=DOC_TYPE_ENUM, create_type=False,
    )
    verification.create(op.get_bind(), checkfirst=True)
    doc_type.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "request_documents",
        sa.Column("document_id", sa.BigInteger, primary_key=True),
        sa.Column(
            "request_id", sa.BigInteger,
            sa.ForeignKey("service_requests.request_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Denormalised from the request so every scoping query and the upload
        # path itself can be checked without a join — the same reason
        # passenger_data carries it.
        sa.Column(
            "merchant_id", sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # NULL for a document about the booking as a whole (a corporate
        # authorisation letter); set for anything belonging to one traveller.
        sa.Column(
            "passenger_id", sa.BigInteger,
            sa.ForeignKey("passenger_data.passenger_id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("doc_type", doc_type, nullable=False, server_default=sa.text("'other'")),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("stored_path", sa.String(500), nullable=False),
        sa.Column("content_type", sa.String(120), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        # SHA-256 of the bytes: lets a re-upload of the identical file be
        # recognised, and gives verification something to pin to.
        sa.Column("checksum", sa.String(64), nullable=True),
        sa.Column(
            "uploaded_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "verification_status", verification, nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "verified_by", sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("size_bytes > 0", name="ck_request_documents_size_positive"),
        sa.CheckConstraint(
            "verification_status <> 'rejected' OR rejection_reason IS NOT NULL",
            name="ck_request_documents_rejection_reason",
        ),
    )

    op.create_index("ix_request_documents_request", "request_documents", ["request_id"])
    op.create_index("ix_request_documents_merchant", "request_documents", ["merchant_id"])
    op.create_index(
        "ix_request_documents_passenger", "request_documents", ["passenger_id"],
        postgresql_where=sa.text("passenger_id IS NOT NULL"),
    )
    # Drives the Admin "documents awaiting verification" view without scanning.
    op.create_index(
        "ix_request_documents_pending", "request_documents", ["verification_status"],
        postgresql_where=sa.text("verification_status = 'pending'"),
    )

    # Same audit trigger every other business table carries (see 0023). Gives
    # documents full before/after history for free; the acting user is recorded
    # separately in system_logs, since the trigger has no session context.
    op.execute(
        """
        CREATE TRIGGER trg_audit_request_documents
        AFTER INSERT OR UPDATE OR DELETE ON request_documents
        FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('document_id')
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_audit_request_documents ON request_documents")
    op.drop_index("ix_request_documents_pending", table_name="request_documents")
    op.drop_index("ix_request_documents_passenger", table_name="request_documents")
    op.drop_index("ix_request_documents_merchant", table_name="request_documents")
    op.drop_index("ix_request_documents_request", table_name="request_documents")
    op.drop_table("request_documents")
    op.execute(f"DROP TYPE IF EXISTS {DOC_TYPE_ENUM}")
    op.execute(f"DROP TYPE IF EXISTS {VERIFICATION_ENUM}")
