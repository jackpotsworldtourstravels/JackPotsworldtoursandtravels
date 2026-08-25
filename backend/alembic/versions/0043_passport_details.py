"""place of birth and passport type — the two passport fields the form could not hold

Revision ID: 0043_passport_details
Revises: 0042_passport_ocr
Create Date: 2026-08-04

WHY THESE TWO AND NOT THE OTHERS
CR-8 reads twelve fields off a passport. Ten already had a home in
``passenger_data``; these two did not, so a scan that read them had nowhere to
put them and the merchant's form could not show them. Adding the columns is what
lets "populate the passenger form from the extracted values" mean all of it
rather than most of it.

WHY THERE IS NO ``mrz`` COLUMN HERE
The machine-readable zone is deliberately NOT a passenger attribute. It is the
*evidence* the other fields were derived from — a single 88-character string that
restates the number, both dates, the nationality and the names. Storing it beside
them would duplicate nine columns into one and then require the two to be kept in
step for ever; the first correction a merchant made to a surname would leave the
row self-contradictory. It lives on ``passport_ocr_extractions`` where the rest of
the read lives, is shown read-only on the form so a doubtful field can be checked
against it, and is what ``passport_ocr.base.merge_mrz`` verifies check digits
against. See ``base.NON_PASSENGER_FIELDS``.

BOTH NULLABLE, NO BACKFILL
61,000 existing passengers never recorded either. NULL means "not recorded",
which is the truth; a default would be inventing one. Nothing reads these to
decide anything — no rule, no settlement, no eligibility — so a NULL is inert
everywhere rather than being a hole some caller has to defend against.

``passport_type`` IS THE ICAO CODE, NOT A WORD
``P`` for an ordinary passport, ``PD`` diplomatic, ``PS`` service, ``PO``
official — the first two characters of the MRZ. Short on purpose: it is a code
read off a document, not a label chosen by this platform, and widening it to
hold "Ordinary Passport" would invite translation.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# ANNOTATED, matching every other migration in this directory. `verify_m9`
# parses these declarations to walk the chain and its regex requires the
# annotation — a bare `revision = "..."` makes the file invisible to that check,
# which then reports the previous migration as the head and the live database as
# ahead of it. That is a confusing way to learn about a style convention.
revision: str = "0043_passport_details"
down_revision: Union[str, None] = "0042_passport_ocr"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "passenger_data",
        sa.Column("place_of_birth", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "passenger_data",
        sa.Column("passport_type", sa.String(length=2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("passenger_data", "passport_type")
    op.drop_column("passenger_data", "place_of_birth")
