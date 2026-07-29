"""extend the nine-table schema for the 3-role B2B spec

Revision ID: 0025_b2b_three_role_spec
Revises: 0024_user_auth_state
Create Date: 2026-07-29

Adds what the Super Admin -> Admin -> Merchant flow needs on top of the
nine-table design. No new tables: still exactly nine.

Request status lifecycle
------------------------
The spec's lifecycle is::

    Created -> Pending -> Under Review -> Approved
            -> Payment Pending -> Paid -> Ticket Issued -> Completed

    Created -> Pending -> Rejected

Most of it already exists under different names, so only the three payment
stages are new. The mapping is:

    ===================  ==========================
    Spec stage           request_status_enum value
    ===================  ==========================
    Created              ``draft``
    Pending              ``pending_approval``
    Under Review         ``in_review``
    Approved             ``approved``
    Payment Pending      ``payment_pending``   (new)
    Paid                 ``paid``              (new)
    Ticket Issued        ``ticket_issued``     (new)
    Completed            ``completed``
    Rejected             ``rejected``
    ===================  ==========================

Deliberately not adding ``created``/``pending``/``under_review`` as separate
values — they would be exact synonyms of existing ones, and two spellings for
one state is how status bugs start.

Documents and attachments
-------------------------
Document management (passport/visa/ID/company docs) and support-ticket
attachments become ``service_requests`` rows with ``request_type='document'``
or ``'attachment'``, parented to whatever they belong to. A document upload
*is* a request with a review workflow — submitted, reviewed, verified or
rejected — so it fits the existing status machinery instead of needing a
tenth table. File bytes live under ``uploads/``; the row holds the metadata
in ``travel_details``.

Merchant sub-roles
------------------
``users.merchant_role`` scopes a merchant's own staff (Manager, Supervisor,
Operator, Finance, Data Operator). It is orthogonal to ``users.role``, which
stays the portal-level role, and is NULL for platform staff.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0025_b2b_three_role_spec"
down_revision: Union[str, None] = "0024_user_auth_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


NEW_REQUEST_STATUSES = ("payment_pending", "paid", "ticket_issued", "verified")

NEW_REQUEST_TYPES = (
    "document",        # passport / visa / ID / company document
    "attachment",      # file attached to a support ticket or request
    "live_chat",       # a chat conversation thread
    "extra_baggage",   # ancillary service requests, per the spec
    "meal",
    "seat",
)

MERCHANT_ROLES = ("manager", "supervisor", "operator", "finance", "data_operator")


def upgrade() -> None:
    # --- enum extensions -------------------------------------------------
    # ALTER TYPE ... ADD VALUE is transactional on PostgreSQL 12+, but the
    # new labels cannot be *used* until this transaction commits. Nothing
    # below writes them, so a single migration is safe.
    for value in NEW_REQUEST_STATUSES:
        op.execute(f"ALTER TYPE request_status_enum ADD VALUE IF NOT EXISTS '{value}'")

    for value in NEW_REQUEST_TYPES:
        op.execute(f"ALTER TYPE request_type_enum ADD VALUE IF NOT EXISTS '{value}'")

    # Admin approves a merchant before it can trade.
    op.execute("ALTER TYPE merchant_status_enum ADD VALUE IF NOT EXISTS 'pending_approval'")

    # --- merchant sub-roles ----------------------------------------------
    merchant_role_enum = sa.Enum(*MERCHANT_ROLES, name="merchant_role_enum")
    merchant_role_enum.create(op.get_bind(), checkfirst=True)
    op.add_column("users", sa.Column("merchant_role", merchant_role_enum, nullable=True))

    # Only a merchant's own staff carry a merchant sub-role.
    op.create_check_constraint(
        "ck_users_merchant_role_scope",
        "users",
        "merchant_role IS NULL OR role IN ('merchant_admin', 'merchant_user')",
    )

    # --- identifiers the spec's search and downloads need ----------------
    op.add_column("service_requests", sa.Column("pnr", sa.String(20), nullable=True))
    op.add_column("service_requests", sa.Column("ticket_number", sa.String(40), nullable=True))
    op.add_column("service_requests", sa.Column("invoice_number", sa.String(40), nullable=True))

    op.create_unique_constraint("uq_sr_ticket_number", "service_requests", ["ticket_number"])
    op.create_unique_constraint("uq_sr_invoice_number", "service_requests", ["invoice_number"])
    # Advanced search: "find by PNR" is a primary lookup in the spec.
    op.create_index("ix_sr_pnr", "service_requests", ["pnr"], postgresql_where=sa.text("pnr IS NOT NULL"))

    # Advanced search: by passenger name.
    op.create_index("ix_passenger_names", "passenger_data", ["last_name", "first_name"])

    # Merchant list/approval queue filters on status constantly.
    op.create_index("ix_merchants_status_name", "merchants", ["status", "company_name"])


def downgrade() -> None:
    op.drop_index("ix_merchants_status_name", table_name="merchants")
    op.drop_index("ix_passenger_names", table_name="passenger_data")
    op.drop_index("ix_sr_pnr", table_name="service_requests")
    op.drop_constraint("uq_sr_invoice_number", "service_requests", type_="unique")
    op.drop_constraint("uq_sr_ticket_number", "service_requests", type_="unique")
    op.drop_column("service_requests", "invoice_number")
    op.drop_column("service_requests", "ticket_number")
    op.drop_column("service_requests", "pnr")

    op.drop_constraint("ck_users_merchant_role_scope", "users", type_="check")
    op.drop_column("users", "merchant_role")
    sa.Enum(name="merchant_role_enum").drop(op.get_bind(), checkfirst=True)

    # PostgreSQL cannot remove a value from an ENUM. The labels added by
    # upgrade() stay; they are harmless once unused.
