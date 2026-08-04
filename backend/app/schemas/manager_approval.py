"""Schemas for the merchant's own approval queue.

Deliberately a narrower shape than ``RequestResponse``: this queue answers one
question — "should this go to JackPots?" — so it carries what a manager needs to
decide (who asked, against which booking, for what, and why) and nothing else.
Passenger rows, payments and documents are a click away on the request itself.
"""
import datetime

from pydantic import BaseModel, Field


class ManagerDecisionRequest(BaseModel):
    """A rejection. Approval sends no body — there is nothing to say."""

    reason: str = Field(min_length=1, max_length=2000)


class ManagerQueueItem(BaseModel):
    id: int
    request_number: str
    request_type: str
    request_type_label: str

    status: str
    status_label: str
    #: `pending` / `approved` / `rejected` — see services/manager_approval.py.
    manager_state: str | None = None
    manager_approval: dict = Field(default_factory=dict)

    booking_id: int | None = None
    booking_request_number: str | None = None
    booking_reference: str | None = None
    pnr: str | None = None

    #: Who raised it. The whole point of the queue is that a manager is signing
    #: off somebody else's request, so the name is not optional context.
    raised_by: str | None = None
    reason: str | None = None
    details: dict = Field(default_factory=dict)

    created_at: datetime.datetime
    updated_at: datetime.datetime | None = None

    @classmethod
    def of(cls, r) -> "ManagerQueueItem":
        from app.services import manager_approval
        from app.services.lifecycle import SPEC_LABELS

        details = r.travel_details or {}
        spec_label = SPEC_LABELS.get(r.status, r.status.value)
        return cls(
            id=r.request_id,
            request_number=r.request_number,
            request_type=r.request_type.value,
            request_type_label=r.request_type.value.replace("_", " ").title(),
            status=r.status.value,
            status_label=manager_approval.status_label(r, spec_label),
            manager_state=manager_approval.state(r),
            manager_approval=manager_approval.block(r),
            booking_id=r.parent_request_id,
            booking_request_number=details.get("booking_request_number"),
            booking_reference=r.booking_reference,
            pnr=r.pnr,
            raised_by=r.user.full_name if r.user else None,
            reason=details.get("reason") or r.remarks,
            # The type-specific payload — a date change's new date, a seat
            # request's seat. Passed through whole rather than flattened per
            # type, so a new service request type needs no change here.
            details={k: v for k, v in details.items() if k != manager_approval.FIELD},
            created_at=r.created_at,
            updated_at=r.updated_at,
        )


class ManagerQueueCounts(BaseModel):
    """One number, for the sidebar badge."""

    pending: int = 0
