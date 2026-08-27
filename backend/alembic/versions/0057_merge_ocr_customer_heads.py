"""Merge point: passport OCR (0042-0043) forked from 0053 the same day the
customer account/hotel/package migrations (0054-0056) did. Both chains are
additive and touch disjoint tables, so there is nothing to reconcile here
beyond giving Alembic a single head again.

Revision ID: 0057_merge_ocr_and_customer_heads
Revises: 0043_passport_details, 0056_customer_package_system
Create Date: 2026-08-25 11:39:36.797157

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0057_merge_ocr_customer_heads'
down_revision: Union[str, None] = ('0043_passport_details', '0056_customer_package_system')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
