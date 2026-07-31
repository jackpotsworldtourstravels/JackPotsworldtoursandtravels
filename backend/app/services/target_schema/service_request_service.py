import datetime
import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.target_schema.service_requests import ServiceRequest
from app.services.target_schema import merchant_service


def get_by_id(db: Session, request_id: int) -> ServiceRequest:
    req = db.get(ServiceRequest, request_id)
    if not req:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service request not found")
    return req


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def create_booking(
    db: Session, *, channel: str, user_id: int | None, merchant_id: int | None,
    item_type: str, item_id: int, total_amount, request_status: str = "pending", **fields,
) -> ServiceRequest:
    # Named request_status, not status: this module imports fastapi's `status`
    # (status.HTTP_400_BAD_REQUEST below) — a `status` parameter would shadow it.
    now = _now()
    if channel == "merchant":
        if merchant_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="merchant_id required for merchant channel")
        request_number = merchant_service.next_reference_number(db, merchant_id)
    else:
        request_number = f"BK-{uuid.uuid4().hex[:10].upper()}"

    req = ServiceRequest(
        request_number=request_number, request_type="booking", channel=channel,
        user_id=user_id, merchant_id=merchant_id, item_type=item_type, item_id=item_id,
        total_amount=total_amount, status=request_status, created_at=now, updated_at=now,
        **{k: v for k, v in fields.items() if v is not None},
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return req


def create_subtype_request(
    db: Session, *, request_type: str, channel: str, user_id: int | None, merchant_id: int | None,
    parent_request_id: int | None = None, reason: str | None = None, details: dict | None = None, **fields,
) -> ServiceRequest:
    """parent_request_id is optional: support_ticket/ticket_enquiry requests
    aren't about an existing booking, unlike cancellation/refund/date_change/
    passenger_modification which normally are."""
    if request_type not in (
        "ticket_enquiry", "cancellation", "refund", "date_change", "passenger_modification", "support_ticket",
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid request_type: {request_type}")
    parent = get_by_id(db, parent_request_id) if parent_request_id else None
    now = _now()
    prefix = {"cancellation": "CX", "refund": "RF", "date_change": "DC", "passenger_modification": "PM",
              "support_ticket": "ST", "ticket_enquiry": "TE"}[request_type]
    req = ServiceRequest(
        request_number=f"{prefix}-{uuid.uuid4().hex[:10].upper()}", request_type=request_type, channel=channel,
        user_id=user_id, merchant_id=merchant_id, parent_request_id=parent.id if parent else None,
        reason=reason, details=details, status="pending", created_at=now, updated_at=now,
        **{k: v for k, v in fields.items() if v is not None},
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return req


def update_status(
    db: Session, request_id: int, new_status: str, *, actor_user_id: int | None = None,
    rejection_reason: str | None = None,
) -> ServiceRequest:
    req = get_by_id(db, request_id)
    req.status = new_status
    now = _now()
    if new_status == "approved":
        req.approved_by, req.approved_at = actor_user_id, now
    elif new_status == "rejected":
        req.rejected_by, req.rejected_at, req.rejection_reason = actor_user_id, now, rejection_reason
    elif new_status in ("resolved", "completed"):
        req.resolved_by, req.resolved_at = actor_user_id, now
    db.commit()
    db.refresh(req)
    return req


def list_by_user(db: Session, user_id: int, *, request_type: str | None = None) -> list[ServiceRequest]:
    stmt = select(ServiceRequest).where(ServiceRequest.user_id == user_id)
    if request_type:
        stmt = stmt.where(ServiceRequest.request_type == request_type)
    return db.scalars(stmt.order_by(ServiceRequest.created_at.desc())).all()


def list_by_merchant(db: Session, merchant_id: int, *, request_type: str | None = None) -> list[ServiceRequest]:
    stmt = select(ServiceRequest).where(ServiceRequest.merchant_id == merchant_id)
    if request_type:
        stmt = stmt.where(ServiceRequest.request_type == request_type)
    return db.scalars(stmt.order_by(ServiceRequest.created_at.desc())).all()


def list_subtypes_for_parent(db: Session, parent_request_id: int) -> list[ServiceRequest]:
    return db.scalars(
        select(ServiceRequest)
        .where(ServiceRequest.parent_request_id == parent_request_id)
        .order_by(ServiceRequest.created_at.desc())
    ).all()
