"""Customer recommendations — ``/api/customer/recommendations`` and the
activity that feeds it, ``/api/customer/activity``.

Both routes are implicitly scoped to the caller: no path carries a customer id,
so there is nothing to tamper with and no "whose activity is this" to get wrong.
A guest holds a real anonymous customer session, so both work for a guest the
same as for a signed-in customer; a fully signed-out visitor has no session and
is served the client-side shelf instead.
"""
from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.models_customer import Customer
from app.services import recommendation_service

router = APIRouter(prefix="/api/customer", tags=["customer-recommendations"])


class ActivityRequest(BaseModel):
    """One thing the customer just did. The vocabulary is validated here, at the
    edge, so the service and the table can trust it."""
    activity_type: str = Field(..., description="view | wishlist | booking | search")
    entity_type: str = Field(..., description="destination | hotel | package")
    entity_id: str = Field(..., min_length=1, max_length=128)
    meta: dict | None = Field(default=None, description="Optional small context, e.g. a destination slug.")

    def normalised(self) -> tuple[str, str] | None:
        at = self.activity_type.strip().lower()
        et = self.entity_type.strip().lower()
        if at not in recommendation_service.ACTIVITY_TYPES:
            return None
        if et not in recommendation_service.ENTITY_TYPES:
            return None
        return at, et


class ActivityResponse(BaseModel):
    recorded: bool


class RecommendationItem(BaseModel):
    type: str
    id: str
    name: str
    reason: str
    image: str | None = None
    price: float | None = None
    destination: str | None = None


class RecommendationsResponse(BaseModel):
    recommendations: list[RecommendationItem]


@router.post(
    "/activity",
    response_model=ActivityResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Record one activity for recommendations",
    description=(
        "Requires a customer session (a guest's counts). Appends a single "
        "view / wishlist / booking / search signal. Unknown vocabulary is "
        "accepted with `recorded: false` rather than a 4xx, so a client that "
        "learns a new signal before the server does never breaks a page over "
        "analytics. Meta is small and caller-controlled; nothing else is stored."
    ),
)
@limiter.limit("120/minute")
def record_activity(
    request: Request,
    payload: ActivityRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    norm = payload.normalised()
    if norm is None:
        # Not an error: a page should never fail because it sent a signal the
        # server does not score yet. It simply is not recorded.
        return ActivityResponse(recorded=False)
    activity_type, entity_type = norm
    meta = payload.meta if isinstance(payload.meta, dict) else None
    recommendation_service.record_activity(
        db, customer.customer_id, activity_type, entity_type, payload.entity_id, meta
    )
    db.commit()
    return ActivityResponse(recorded=True)


@router.get(
    "/recommendations",
    response_model=RecommendationsResponse,
    summary="My personalised recommendations",
    description=(
        "Requires a customer session. Returns real catalogue items chosen from "
        "the destinations this customer has shown interest in, each with the "
        "reason it was chosen. Returns an EMPTY list when there is not enough "
        "activity to stand on — the frontend shows nothing rather than a guess."
    ),
)
@limiter.limit("60/minute")
def get_recommendations(
    request: Request,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    recs = recommendation_service.get_recommendations(db, customer.customer_id)
    return RecommendationsResponse(
        recommendations=[
            RecommendationItem(
                type=r.type, id=r.id, name=r.name, reason=r.reason,
                image=r.image, price=r.price, destination=r.destination,
            )
            for r in recs
        ]
    )
