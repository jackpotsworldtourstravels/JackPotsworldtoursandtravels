"""GST invoicing details on flight bookings

Revision ID: 0104_flight_booking_gst
Revises: 0103_hotel_supplier_references
Create Date: 2026-11-26

Phase 2 (Flights). Optional business-invoice details a traveller may provide to
receive a GST tax invoice for a flight booking (common for corporate/business
travel in India). Five additive, NULLABLE columns on ``customer_bookings`` —
a personal booking leaves them all NULL and is unaffected, so this is safe to
apply ahead of any UI change.

They map one-to-one onto the TBO Book request's GST fields, so a booking made
against the TBO supplier can forward them verbatim:
  gst_number          -> GSTNumber
  gst_company_name    -> GSTCompanyName
  gst_company_address -> GSTCompanyAddress
  gst_company_email   -> GSTCompanyEmail
  gst_company_contact -> GSTCompanyContactNumber

HAND-WRITTEN: autogenerate does not see ``models_customer``; this DDL tracks the
new ``CustomerBooking`` columns exactly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0104_flight_booking_gst"
down_revision: Union[str, None] = "0103_hotel_supplier_references"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("gst_number", sa.String(length=20)),
    ("gst_company_name", sa.String(length=160)),
    ("gst_company_address", sa.String(length=300)),
    ("gst_company_email", sa.String(length=160)),
    ("gst_company_contact", sa.String(length=20)),
)


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        op.add_column("customer_bookings", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        op.drop_column("customer_bookings", name)
