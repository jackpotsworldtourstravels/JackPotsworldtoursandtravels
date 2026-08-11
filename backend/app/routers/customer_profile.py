"""Customer Portal (V1) profile — ``/api/customer/profile/*``.

Every route here is implicitly scoped to the caller: no path carries a
``customer_id``, so there is no identifier to tamper with and no
"can I read someone else's profile" question to get wrong. Same property
``wallet.router`` has on the merchant side, for the same reason.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer, CustomerProfile
from app.routers.customer_auth import customer_response
from app.schemas.customer import (
    CustomerProfileUpdateRequest,
    CustomerResponse,
    CustomerSessionResponse,
)
from app.services import (
    activity_service,
    customer_audit_service,
    customer_auth_service,
    customer_session_service,
)

router = APIRouter(prefix="/api/customer/profile", tags=["customer-profile"])

#: Fields that live on ``customers`` rather than ``customer_profiles``.
_IDENTITY_FIELDS = ("full_name", "mobile", "date_of_birth")


@router.get(
    "",
    response_model=CustomerResponse,
    summary="Get my profile",
    description="Requires a customer session. Returns the caller's own identity and profile.",
)
def get_profile(customer: Customer = Depends(get_current_customer)):
    return customer_response(customer)


@router.patch(
    "",
    response_model=CustomerResponse,
    summary="Update my profile",
    description=(
        "Requires a customer session. Partial update — omitted fields are left alone, which is "
        "what makes it safe for the form to submit only what changed. **Email is not editable "
        "here**: it is the login identifier, so changing it is an account-recovery operation "
        "rather than a profile edit."
    ),
)
def update_profile(
    request: Request,
    payload: CustomerProfileUpdateRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    # exclude_unset, not exclude_none: a form clearing "Address line 2" sends
    # null and means it, while a form that never touched the field sends
    # nothing. Collapsing the two would make a field impossible to erase.
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return customer_response(customer)

    new_mobile = changes.get("mobile")
    if new_mobile and new_mobile != customer.mobile:
        # Unique across customers, so a readable 400 rather than the unique
        # index's IntegrityError. Checked against customers only — a merchant
        # user with the same number is a different person in a different system.
        clash = db.scalar(
            select(Customer).where(
                Customer.mobile == new_mobile,
                Customer.customer_id != customer.customer_id,
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="That mobile number is already registered to another account",
            )
        # A changed number is an unverified number again.
        customer.mobile_verified = False

    for field in _IDENTITY_FIELDS:
        if field in changes:
            setattr(customer, field, changes[field])

    profile = customer.profile
    if profile is None:
        # Signup always creates one; this covers a row made before it did.
        profile = CustomerProfile(customer_id=customer.customer_id)
        db.add(profile)
        customer.profile = profile

    for field, value in changes.items():
        if field in _IDENTITY_FIELDS:
            continue
        setattr(profile, field, value)

    db.commit()
    db.refresh(customer)

    meta = activity_service.request_context(request)
    customer_audit_service.log(
        db, customer, "Profile updated", module="Profile",
        description="Updated: " + ", ".join(sorted(changes)), meta=meta,
    )
    return customer_response(customer)


@router.get(
    "/sessions",
    response_model=list[CustomerSessionResponse],
    summary="Where I'm signed in",
    description=(
        "Requires a customer session. Lists the caller's own live sessions. These come from "
        "`customer_sessions` and never appear in the Admin portal's Active Users."
    ),
)
def my_sessions(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return [
        CustomerSessionResponse(
            id=s.customer_session_id,
            ip_address=s.ip_address,
            browser=s.browser,
            device=s.device,
            login_at=s.login_at,
            last_seen_at=s.last_seen_at,
        )
        for s in customer_session_service.active_sessions(db, customer.customer_id)
    ]
