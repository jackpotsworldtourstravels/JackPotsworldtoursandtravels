"""What the admin desk reads and writes on the B2C Reviews & Ratings screen —
Phase 6 of the B2C Admin Portal build-out. An allow-list, the same discipline
every other admin/* schema in this package uses. A moderation write can set the
review's status and the desk's reply and nothing else: the customer's own rating
and words are never editable from here.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ReviewCustomerRef(BaseModel):
    id: int
    name: str
    email: str


class ReviewRow(BaseModel):
    review_id: int
    customer: ReviewCustomerRef
    #: flight | hotel | package | gaming | cruise. ``gaming`` is a package whose
    #: catalogue category is gaming — the review table itself only knows
    #: ``package``.
    product: str
    item_id: int
    #: The hotel/package name where the catalogue has one; a plain "Flight #n"
    #: where it does not (flights are supplier-driven and stored nowhere).
    item_name: str
    rating: int
    comment: str | None
    status: str
    admin_reply: str | None
    replied_at: dt.datetime | None
    created_at: dt.datetime
    updated_at: dt.datetime


class ReviewStatusCounts(BaseModel):
    pending: int
    approved: int
    rejected: int


class ReviewList(BaseModel):
    items: list[ReviewRow]
    total: int
    page: int
    page_size: int
    total_pages: int
    #: Per-status totals under the SAME product/rating/search filters, so the
    #: tabs' numbers agree with what each tab would show.
    counts: ReviewStatusCounts


class ReviewModeration(BaseModel):
    """PATCH body. Both fields optional; only what is sent is written.

    ``admin_reply`` of ``""``/``null`` removes an existing reply. There is no
    way to send a status of ``pending`` — the desk decides, it does not un-decide.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    status: Literal["approved", "rejected"] | None = None
    admin_reply: str | None = Field(None, max_length=1000)


class DistributionBucket(BaseModel):
    rating: int
    count: int


class ProductRating(BaseModel):
    product: str
    count: int
    average: Decimal


class ItemRating(BaseModel):
    product: str
    item_id: int
    item_name: str
    count: int
    average: Decimal


class MonthRating(BaseModel):
    month: str
    count: int
    average: Decimal


class ReviewAnalytics(BaseModel):
    #: Ratings are counted over APPROVED reviews only — the ones the public
    #: sees. A pending or rejected review is not yet (or not) part of the score.
    basis: str
    approved: int
    pending: int
    rejected: int
    average: Decimal | None
    distribution: list[DistributionBucket]
    by_product: list[ProductRating]
    top_items: list[ItemRating]
    lowest_items: list[ItemRating]
    monthly: list[MonthRating]
