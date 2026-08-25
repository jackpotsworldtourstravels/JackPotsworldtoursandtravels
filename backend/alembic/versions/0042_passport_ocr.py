"""passport OCR — extractions, per-field confidence, and the manual-edit audit

Revision ID: 0042_passport_ocr
Revises: 0041_admin_initiated_payments
Create Date: 2026-08-04

WHAT THIS IS FOR
A merchant filling in an international booking types eleven fields per traveller
off a passport. This lets them upload the passport instead: the scan goes to an
OCR provider, the answer comes back as passenger fields with a confidence score
each, and the form is filled in. The merchant still owns every value — nothing
here writes a passenger row, and nothing here can block a submission.

WHY AN EXTRACTION IS ITS OWN TABLE AND NOT A COLUMN ON ``passenger_data``
Three reasons, and the first is the one that decided it:

1. **An extraction happens before there is a passenger row to hang it on.**
   CR-1 removed uploads from the Classic booking flow precisely because they
   forced "Save as draft" first — a passport could only attach to a saved draft,
   which made drafting mandatory on international routes. Repeating that mistake
   here would be worse: OCR is meant to be the *first* thing a merchant does on
   an empty form. So ``request_id`` and ``passenger_id`` are both NULLABLE, and
   an extraction is valid with neither. They are filled in later, if and when
   the booking that used it is saved.
2. **The provider's own answer has to survive.** Debugging "why did it read the
   expiry as 2013" needs what the provider actually returned, not our
   interpretation of it. ``raw_response`` keeps the former and ``normalized``
   the latter, so a normalisation bug can be diagnosed — and re-run — without
   asking the merchant to re-upload.
3. **One passport can fill several bookings** and one booking has several
   passports. A column would force a 1:1 that is not true.

WHY ``normalized`` IS JSONB AND NOT ELEVEN TYPED COLUMNS
Its shape is ``{"passport_number": {"value": "P1234567", "confidence": 0.99}}``
— a value *and* a confidence per field, which is two columns per field, and the
set of fields is the provider's, not ours. A provider that starts returning
place-of-birth should not need a migration. The values that matter are copied
into ``passenger_data`` by the merchant pressing Save, and *those* are typed.

WHY THE RAW RESPONSE IS NOT ENCRYPTED HERE
It contains the same personal data as the passenger row it fills, protected the
same way: the database itself. Encrypting one JSONB column while
``passenger_data.passport_number`` sits in plaintext beside it would be theatre.
The *scan* is the sensitive artefact, and it goes to ``app.services.storage``
under a generated key — never a static mount, never a public bucket, never a
presigned URL — exactly as booking documents already do.

WHY ``passport_ocr_field_edits`` EXISTS
"OCR read JOHN, the merchant changed it to JOHNN" is the question an
investigation asks, and neither value survives on its own: ``normalized`` holds
what OCR said and ``passenger_data`` holds what was saved, but nothing records
that a human moved between them or when. One row per field the merchant
overrode, written when they save — append-only, never updated.

NO DATA IS WRITTEN BY THIS MIGRATION. Two empty tables and one new enum type.
Nothing existing is altered, so every booking that already exists is untouched
and submits exactly as it did.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0042_passport_ocr"
# Re-chained again on landing, now onto 0053_customer_flight_booking. The first re-chain
# (0041 -> 0042_group_booking_import) moved this branch off a fork but attached
# it MID-CHAIN, so once the tracked line grew past it -- 0045..0052, then
# 0044_customer_portal re-parented onto 0052 -- `alembic heads` reported two
# again: 0043_passport_details here and 0044_customer_portal there, and
# `upgrade head` failed outright. Attaching to the tracked tip instead of the
# middle is what stops that recurring: a branch parented at the end cannot be
# overtaken. Nothing in CR-8 touches the customer-portal tables or vice versa,
# so the order remains arbitrary and the tip simply wins.
#
# The file keeps its 0042_ name because the revision id is what alembic and the
# tests/verify_m9.py regex both key on, and renaming it would strand the
# 0043_passport_details.down_revision that points at it.
down_revision: Union[str, None] = "0053_customer_flight_booking"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# queued     — accepted, not started (the request returned 202)
# processing — handed to the provider
# succeeded  — normalized fields are available
# failed     — error_code/error_detail say why; the merchant types the form
_OCR_STATUS = postgresql.ENUM(
    "queued", "processing", "succeeded", "failed",
    name="ocr_status_enum", create_type=False,
)


def upgrade() -> None:
    # A brand-new type, so creating and using it in one transaction is fine —
    # the ALTER TYPE ... ADD VALUE restriction 0038 works around applies only to
    # types that already exist.
    _OCR_STATUS.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "passport_ocr_extractions",
        sa.Column("extraction_id", sa.BigInteger(), primary_key=True),
        # WHO. The scoping boundary: every read re-filters on this, so one
        # merchant can never reach another's scan or extracted data. NOT NULL
        # because platform staff have no merchant and do not run extractions —
        # they read them through the booking, which carries its own scope.
        sa.Column("merchant_id", sa.BigInteger(), nullable=False),
        sa.Column("created_by", sa.BigInteger(), nullable=False),
        # WHERE IT ENDED UP. Both nullable, and that is the whole point — see
        # the module docstring. SET NULL rather than CASCADE: a deleted draft
        # must not erase the audit trail of what was read off a passport.
        sa.Column("request_id", sa.BigInteger(), nullable=True),
        sa.Column("passenger_id", sa.BigInteger(), nullable=True),
        # THE SCAN. Stored by app.services.storage under a generated key, the
        # same way booking documents are. Kept here rather than as a
        # request_documents row because there may be no request yet.
        sa.Column("stored_path", sa.String(length=500), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("checksum", sa.String(length=64), nullable=False),
        # THE RUN.
        sa.Column(
            "status", _OCR_STATUS, nullable=False, server_default=sa.text("'queued'")
        ),
        # Which provider, which model, which API version produced this. All
        # three, because "Azure" alone does not identify a result: the same
        # endpoint returns different fields across api-versions, and a
        # re-extraction after an upgrade must be comparable with the old one.
        sa.Column("provider", sa.String(length=50), nullable=False),
        sa.Column("provider_model", sa.String(length=100), nullable=True),
        sa.Column("provider_api_version", sa.String(length=40), nullable=True),
        sa.Column("raw_response", postgresql.JSONB(), nullable=True),
        sa.Column(
            "normalized",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        # The mean of the per-field confidences, 0..1. Stored rather than
        # derived so the Admin list can sort and filter on it without unpacking
        # the JSONB for every row.
        sa.Column("overall_confidence", sa.Numeric(5, 4), nullable=True),
        sa.Column("processing_ms", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(length=60), nullable=True),
        sa.Column("error_detail", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["merchant_id"], ["merchants.merchant_id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.user_id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["request_id"], ["service_requests.request_id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["passenger_id"], ["passenger_data.passenger_id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "overall_confidence IS NULL OR "
            "(overall_confidence >= 0 AND overall_confidence <= 1)",
            name="ck_ocr_confidence_range",
        ),
        # A succeeded run must have something to show for itself. Enforced in
        # the database because "succeeded with no fields" is the shape a
        # half-written normaliser produces, and the UI would render it as a
        # scan that read a blank passport rather than as the bug it is.
        sa.CheckConstraint(
            "status <> 'succeeded' OR normalized <> '{}'::jsonb",
            name="ck_ocr_succeeded_has_fields",
        ),
        sa.CheckConstraint(
            "status <> 'failed' OR error_code IS NOT NULL",
            name="ck_ocr_failed_has_reason",
        ),
    )
    # The merchant's own history, newest first — what the Scan panel lists and
    # what a retention sweep would walk.
    op.create_index(
        "ix_ocr_merchant_created",
        "passport_ocr_extractions",
        ["merchant_id", sa.text("created_at DESC")],
    )
    # "What was scanned for this booking" — the Admin review panel's only query.
    op.create_index(
        "ix_ocr_request",
        "passport_ocr_extractions",
        ["request_id"],
        postgresql_where=sa.text("request_id IS NOT NULL"),
    )

    op.create_table(
        "passport_ocr_field_edits",
        sa.Column("edit_id", sa.BigInteger(), primary_key=True),
        sa.Column("extraction_id", sa.BigInteger(), nullable=False),
        sa.Column("field_name", sa.String(length=60), nullable=False),
        # Both nullable: OCR may have read nothing for a field the merchant then
        # typed, and the merchant may have cleared a field OCR did read. Both
        # are edits worth recording.
        sa.Column("ocr_value", sa.Text(), nullable=True),
        sa.Column("edited_value", sa.Text(), nullable=True),
        sa.Column("ocr_confidence", sa.Numeric(5, 4), nullable=True),
        sa.Column("edited_by", sa.BigInteger(), nullable=False),
        sa.Column(
            "edited_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["extraction_id"],
            ["passport_ocr_extractions.extraction_id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["edited_by"], ["users.user_id"], ondelete="RESTRICT"),
        # An edit that changed nothing is not an edit. Without this a client
        # that posts its whole form on every keystroke fills the audit with
        # noise and buries the one row an investigation is looking for.
        sa.CheckConstraint(
            "ocr_value IS DISTINCT FROM edited_value", name="ck_ocr_edit_is_a_change"
        ),
    )
    op.create_index(
        "ix_ocr_edits_extraction", "passport_ocr_field_edits", ["extraction_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_ocr_edits_extraction", table_name="passport_ocr_field_edits")
    op.drop_table("passport_ocr_field_edits")
    op.drop_index("ix_ocr_request", table_name="passport_ocr_extractions")
    op.drop_index("ix_ocr_merchant_created", table_name="passport_ocr_extractions")
    op.drop_table("passport_ocr_extractions")
    _OCR_STATUS.drop(op.get_bind(), checkfirst=True)
