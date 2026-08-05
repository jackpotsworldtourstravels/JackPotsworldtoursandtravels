"""group booking import — the passenger list arrives as a spreadsheet, not a form

Revision ID: 0042_group_booking_import
Revises: 0041_admin_initiated_payments
Create Date: 2026-08-04

WHAT THIS IS FOR
A group booking is a party too large to type. The merchant downloads a template,
fills one row per traveller, and uploads it; the passengers that reach the
approvals desk are the rows of that sheet. Everything after the import is the
existing workflow — same statuses, same Manager approval, same issuance, same
wallet rules. Only the *entry* of the passengers changes.

WHY A TABLE AND NOT ``travel_details``
The trip's shape (``trip_type``, ``group_journey_type``) stays in the JSONB blob
with every other itinerary field, because nothing aggregates it. The import does
not fit there for three reasons:

1. **It exists before the booking does.** The merchant uploads and reviews the
   sheet while still filling the form, so there is no ``service_requests`` row to
   hang it on yet. ``request_id`` is therefore NULLABLE and set at submission —
   a JSONB key on a row that does not exist cannot express that.
2. **It outlives a failed submission.** A sheet that validated but whose booking
   was never submitted is exactly what "Replace File" and a resumed draft need.
3. **It is evidence.** The desk issuing tickets has to be able to open the file
   the merchant actually sent, months later, and compare it against what was
   ticketed. That is a stored artefact with a checksum, not a form value.

WHY THE BYTES ARE NOT IN ``request_documents``
That table is the right home for passport scans and e-tickets and its threat
model is the one this file would want — generated keys, no static mount, scope
re-checked on every read. It cannot be used here because ``request_id`` is NOT
NULL on it, and the whole point of the staging step above is that the request
does not exist yet. Rather than weaken that constraint for every document, the
manifest carries its own key under a ``group-imports/`` prefix and goes through
the same :mod:`app.services.storage` backend, so an S3 deployment stores it
exactly like everything else.

WHY THE PASSENGERS ARE DENORMALISED INTO JSONB
``passenger_data`` rows are still created at submission and remain the single
source of truth for who is travelling — nothing here replaces them. The JSONB
copy is what the sheet *said*, frozen at import: it is what the validation
summary is computed against, what "View Imported Data" renders before a booking
exists, and what makes a re-import diffable. It is never read back to decide who
is on the aircraft.

VALIDATION STATUS IS NOT A BOOLEAN
``partial`` is a real state and the reason this is an enum: a sheet of 200 rows
with 3 bad ones is neither valid nor invalid, and the merchant is offered a
per-row error report against exactly that case. A booking may only be submitted
from a ``valid`` import — that rule lives in the service, but the enum is what
lets the rule be stated at all.

BACKWARD COMPATIBILITY
Purely additive. One new table, one new enum value on ``document_type_enum``
(unused by existing rows), and no change to any existing column, constraint or
index. ``downgrade()`` drops only what ``upgrade()`` created; the enum value is
left in place, because PostgreSQL cannot remove one from a type in use and an
orphaned label harms nothing.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# The annotations are load-bearing — tests/verify_m9.py discovers the chain by
# regex and a bare assignment is invisible to it. See 0040 for the full story.
revision: str = "0042_group_booking_import"
down_revision: Union[str, None] = "0041_admin_initiated_payments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ``group_manifest`` joins passport/visa/photo_id/ticket/other so the desk
    # can tell a manifest apart from a passport scan in one glance at a listing.
    # ADD VALUE IF NOT EXISTS is idempotent, which matters on a re-run after a
    # partially applied migration.
    op.execute(
        "ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS 'group_manifest'"
    )

    validation_status = postgresql.ENUM(
        "pending",
        "valid",
        "partial",
        "invalid",
        name="group_import_status_enum",
        create_type=False,
    )
    validation_status.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "group_booking_imports",
        sa.Column("import_id", sa.BigInteger, primary_key=True),
        # Scope. Denormalised from the uploader exactly as request_documents
        # denormalises it from the request, so a merchant's import can be
        # filtered without a join and cannot be reached by guessing an id.
        sa.Column(
            "merchant_id",
            sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="CASCADE"),
            nullable=False,
        ),
        # NULL until the booking is raised from this import. Not a weakness:
        # it is the staging window in which the merchant reviews the sheet and
        # may replace it.
        sa.Column(
            "request_id",
            sa.BigInteger,
            sa.ForeignKey("service_requests.request_id", ondelete="CASCADE"),
            nullable=True,
        ),
        # 'one_way_group' | 'round_trip_group'. Free text rather than an enum
        # because trip shape is stored as text in travel_details too, and one
        # of the two has to be authoritative — this column mirrors the blob
        # rather than competing with it.
        sa.Column("journey_type", sa.String(24), nullable=False),
        # The uploaded file. Same shape as request_documents' columns so the
        # download path reads identically.
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("stored_path", sa.String(500), nullable=False),
        sa.Column("content_type", sa.String(120), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("checksum", sa.String(64), nullable=True),
        # What the sheet said, frozen at import — the travellers as a list…
        sa.Column(
            "imported_passengers",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # …and the journey/booking columns the sheet also declared, as an
        # object. Two columns rather than one wrapper object because they are
        # read separately and by different screens: the booking form renders the
        # passengers, the Admin drawer compares the declared journey against the
        # itinerary on the form. Keeping the list a list also means the default
        # above is honest — an import with no travellers really is ``[]``.
        #
        # THE FORM REMAINS THE SOURCE OF THE ITINERARY. This records what the
        # spreadsheet claimed, so a disagreement between the two is visible
        # rather than silently resolved in favour of whichever was read last.
        sa.Column(
            "imported_journey",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "validation_errors",
            postgresql.JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("total_rows", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("valid_rows", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("invalid_rows", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column(
            "passengers_imported", sa.Integer, nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "validation_status",
            validation_status,
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "uploaded_by",
            sa.BigInteger,
            sa.ForeignKey("users.user_id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # A zero-byte upload is a failed transfer, not an empty sheet — the same
    # rule request_documents states for the same reason.
    op.create_check_constraint(
        "ck_group_import_size_positive", "group_booking_imports", "size_bytes > 0"
    )
    # The three row counts have to describe the same sheet. A summary that does
    # not add up is how "12 valid of 10 rows" reaches a merchant's screen.
    op.create_check_constraint(
        "ck_group_import_row_counts",
        "group_booking_imports",
        "valid_rows >= 0 AND invalid_rows >= 0 AND total_rows = valid_rows + invalid_rows",
    )
    op.create_check_constraint(
        "ck_group_import_journey_type",
        "group_booking_imports",
        "journey_type IN ('one_way_group', 'round_trip_group')",
    )

    op.create_index(
        "ix_group_import_merchant", "group_booking_imports", ["merchant_id"]
    )
    # Partial: the only lookup by request is "show me this booking's manifest",
    # and the staging rows have no request to find.
    op.create_index(
        "ix_group_import_request",
        "group_booking_imports",
        ["request_id"],
        postgresql_where=sa.text("request_id IS NOT NULL"),
    )
    # Sweeping abandoned staging rows — an upload nobody ever submitted — is a
    # scan of exactly this set.
    op.create_index(
        "ix_group_import_unattached",
        "group_booking_imports",
        ["created_at"],
        postgresql_where=sa.text("request_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_group_import_unattached", table_name="group_booking_imports")
    op.drop_index("ix_group_import_request", table_name="group_booking_imports")
    op.drop_index("ix_group_import_merchant", table_name="group_booking_imports")
    op.drop_table("group_booking_imports")
    postgresql.ENUM(name="group_import_status_enum").drop(op.get_bind(), checkfirst=True)
    # 'group_manifest' is deliberately left on document_type_enum: PostgreSQL
    # cannot drop a label from a type that other columns still use, and an
    # unreferenced label costs nothing.
