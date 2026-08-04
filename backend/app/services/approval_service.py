"""Unified Approval Queue — API_CONTRACT.md §4.2 (sign-off 2026-07-29).

Merges two different kinds of "awaiting a decision" rows — pending merchants and pending
ticket/service requests — into one paginated, filterable list, so the Admin frontend renders
one sortable table instead of switching between two screens. Implemented as two queries merged
in Python rather than a SQL UNION: the two row shapes come from different tables with
different columns, and the result sets here are small (bounded by page_size) so there's no
performance reason to push the merge into SQL.
"""
import datetime

from sqlalchemy import select

from sqlalchemy.orm import Session

from app.models_v2 import Merchant, MerchantStatus, RequestStatus, RequestType, User
from app.services import lifecycle, ticket_service
from app.services.lifecycle import SPEC_LABELS

#: Ticket/service-request statuses still awaiting an Admin decision.
_AWAITING_ACTION = (RequestStatus.PENDING_APPROVAL, RequestStatus.IN_REVIEW)


def _awaits_admin(request) -> bool:
    """Is this row waiting on *us*, rather than on the merchant?

    Payment Pending is normally the merchant's turn and is deliberately absent
    from :data:`_AWAITING_ACTION` — a queue listing every booking awaiting
    payment would be a list of other people's homework.

    An **unpriced** Payment Pending booking is the exception, and it is the one
    the desk cannot see anywhere else. ``record_payment`` refuses ``amount <= 0``,
    so the merchant is shown "Awaiting amount" rather than a Pay button and can
    do nothing at all; the only move left belongs to an admin, through
    ``POST /api/admin/requests/{id}/reprice``. Approval now refuses to create
    these, but rows created before that landed still exist and would otherwise
    be invisible in every admin screen.
    """
    if request.status in _AWAITING_ACTION:
        return True
    return (
        request.status is RequestStatus.PAYMENT_PENDING
        and (request.total_amount or 0) <= 0
    )


def list_approval_queue(
    db: Session,
    actor: User,
    *,
    status: str | None = None,
    merchant_id: int | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    request_type: str | None = None,
    priority: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[dict], int]:
    items: list[dict] = []

    include_merchants = request_type is None and status in (None, "pending_approval")
    if include_merchants:
        conditions = [Merchant.status == MerchantStatus.PENDING_APPROVAL]
        if merchant_id is not None:
            conditions.append(Merchant.merchant_id == merchant_id)
        if date_from is not None:
            conditions.append(Merchant.created_at >= date_from)
        if date_to is not None:
            conditions.append(Merchant.created_at <= date_to)
        for m in db.scalars(select(Merchant).where(*conditions)).all():
            items.append({
                "id": m.merchant_id, "kind": "merchant", "status": "pending_approval",
                "status_label": "Pending Approval", "priority": None,
                "merchant_id": m.merchant_id, "merchant_name": m.company_name,
                "request_type": None, "title": f"New merchant: {m.company_name}",
                "submitted_at": m.created_at,
            })

    ticket_status = RequestStatus(status) if status else None
    request_types = [request_type] if request_type else None
    candidate_types = request_types or [t.value for t in ticket_service.SERVICE_REQUEST_TYPES] + ["booking"]
    for rtype in candidate_types:
        try:
            rt_enum = RequestType(rtype)
        except ValueError:
            continue
        rows, _ = ticket_service.list_requests(
            db, actor, page=1, page_size=1000, request_type=rt_enum,
            request_status=ticket_status, merchant_id=merchant_id,
            date_from=date_from, date_to=date_to,
        )
        for r in rows:
            # A Classic Tours booking awaits the *Manager*, not this desk
            # (CR-2). Listing it here would offer an Approve button that the
            # service layer refuses by track — the queue must not advertise an
            # action the server will not take.
            if lifecycle.is_classic_track(r):
                continue
            if ticket_status is None and not _awaits_admin(r):
                continue
            if priority is not None and r.priority.value != priority:
                continue
            items.append({
                "id": r.request_id, "kind": "request", "status": r.status.value,
                "status_label": SPEC_LABELS.get(r.status, r.status.value),
                "priority": r.priority.value,
                "merchant_id": r.merchant_id,
                "merchant_name": r.merchant.company_name if r.merchant else None,
                "request_type": r.request_type.value, "title": r.title or r.request_number,
                "submitted_at": r.created_at,
                "total_amount": r.total_amount,
            })

    items.sort(key=lambda x: x["submitted_at"], reverse=True)
    total = len(items)
    start = (page - 1) * page_size
    return items[start : start + page_size], total
