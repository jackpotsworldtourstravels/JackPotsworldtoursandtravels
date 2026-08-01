"""Global Reports & Analytics — the platform-wide, per-merchant summary table.

The export side (CSV/Excel/PDF) is already covered by ``GET /api/reports/export``,
which every platform-staff role including Super Admin can already call — see
``app/routers/reports.py``. This is only the on-screen aggregate table, which
that endpoint doesn't produce (it exports row-level data, not a rollup).
"""
from decimal import Decimal

from pydantic import BaseModel


class MerchantSummaryRow(BaseModel):
    merchant_id: int
    merchant_code: str
    company_name: str
    status: str
    total_requests: int
    completed_requests: int
    total_revenue: Decimal
    user_count: int


class GlobalSummaryTotals(BaseModel):
    """The four figures the screen's stat cards render.

    Added in M6. The rows are a small bounded dataset and the frontend *could*
    sum them — it did, with ``Number()``, which turns a Decimal into a float and
    drops the paise. ``total_revenue`` is money, so it is added up once, here,
    in ``Decimal``, and crosses the wire as a string.
    """

    merchants: int
    total_requests: int
    completed_requests: int
    total_revenue: Decimal
    user_count: int


class GlobalSummaryResponse(BaseModel):
    #: Row-per-merchant. Small, bounded dataset (one row per company).
    merchants: list[MerchantSummaryRow]
    totals: GlobalSummaryTotals
