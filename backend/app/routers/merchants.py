"""Admin portal — merchant (partner company) management.

Covers the spec's Merchant Management box: create, approve, edit, suspend,
and inspect a merchant's users. Creating a merchant also mints its first
login, so the Admin has credentials to hand over immediately.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import (
    CompanyType,
    Merchant,
    MerchantStatus,
    Payment,
    PaymentStatus,
    RequestStatus,
    ServiceRequest,
    User,
)
from app.schemas.accounts import (
    AccountResponse,
    CreateMerchantUserRequest,
    CredentialsResponse,
    StatusChangeRequest,
)
from app.schemas.merchant import (
    CreateMerchantRequest,
    MerchantCreatedResponse,
    MerchantResponse,
    MerchantStatusRequest,
    ServiceAccessResponse,
    ServiceAccessUpdateRequest,
    UpdateMerchantRequest,
)
from app.schemas.pagination import Page
from app.services import account_service, merchant_service, service_access_service

router = APIRouter(prefix="/api/admin/merchants", tags=["admin · merchants"])


def _with_user_counts(db: Session, merchants: list[Merchant]) -> list[MerchantResponse]:
    """Attach the per-merchant rollups the Admin table shows.

    THREE GROUPED QUERIES FOR THE WHOLE PAGE, NOT THREE PER ROW. Each aggregate
    is a single ``GROUP BY merchant_id`` over the ids already on this page, so
    the cost is constant in the page size rather than linear in it. Lazy-loading
    ``merchant.users`` per row (which ``MerchantResponse.of`` falls back to) is
    what this exists to avoid, and the same reasoning applies to the two counts
    added for the Merchant Management columns.
    """
    if not merchants:
        return []
    ids = [m.merchant_id for m in merchants]

    def _grouped(stmt) -> dict[int, int]:
        return dict(db.execute(stmt).all())

    counts = _grouped(
        select(User.merchant_id, func.count())
        .where(User.merchant_id.in_(ids))
        .group_by(User.merchant_id)
    )
    # "Tickets Issued" is the count of bookings that reached TICKET_ISSUED. It
    # deliberately does NOT include COMPLETED: a completed booking has travelled,
    # and the column is read as "how much has this merchant got out of us right
    # now", not lifetime volume. Change this and the Admin's number stops
    # matching the merchant's own Dashboard tile, which counts the same way.
    tickets = _grouped(
        select(ServiceRequest.merchant_id, func.count())
        .where(
            ServiceRequest.merchant_id.in_(ids),
            ServiceRequest.status == RequestStatus.TICKET_ISSUED,
        )
        .group_by(ServiceRequest.merchant_id)
    )
    # "Awaiting Verification" mirrors the Dashboard's `payments_pending_count`
    # (dashboard_service.py) exactly — payments sitting at PENDING — but scoped
    # to one merchant. Same predicate, so the column and the KPI can never
    # disagree.
    awaiting = _grouped(
        select(Payment.merchant_id, func.count())
        .where(
            Payment.merchant_id.in_(ids),
            Payment.payment_status == PaymentStatus.PENDING,
        )
        .group_by(Payment.merchant_id)
    )

    return [
        MerchantResponse.of(
            m,
            counts.get(m.merchant_id, 0),
            tickets_issued=tickets.get(m.merchant_id, 0),
            awaiting_verification=awaiting.get(m.merchant_id, 0),
        )
        for m in merchants
    ]


@router.get(
    "",
    response_model=Page[MerchantResponse],
    summary="List merchants",
    description=(
        "Requires `merchant.view`. Filterable by status (use `pending_approval` for the approval "
        "queue) and company type, with a search across name, code and email."
    ),
)
def list_merchants(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = None,
    status: MerchantStatus | None = None,
    company_type: CompanyType | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.MERCHANT_VIEW)),
):
    merchants, total = merchant_service.list_merchants(
        db, page, page_size, search, status, company_type
    )
    return Page.build(_with_user_counts(db, merchants), total, page, page_size)


@router.post(
    "",
    response_model=MerchantCreatedResponse,
    status_code=201,
    summary="Create a merchant and its first login",
    description=(
        "Requires `merchant.create` — Admin only; a Super Admin deliberately cannot do this. "
        "Creates the company plus its first `merchant_admin` user and returns that user's "
        "password **once**. The merchant starts at `pending_approval` and cannot sign in until "
        "approved."
    ),
)
def create_merchant(
    payload: CreateMerchantRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_CREATE)),
):
    merchant, first_user, temp_password = merchant_service.create_merchant(
        db,
        current_user,
        company_name=payload.company_name,
        merchant_name=payload.merchant_name,
        company_type=payload.company_type,
        email=payload.email,
        phone=payload.phone,
        contact_person=payload.contact_person,
        contact_email=payload.contact_email,
        country=payload.country,
        country_code=payload.country_code,
        city=payload.city,
        address=payload.address,
        credit_limit=payload.credit_limit,
        merchant_code=payload.merchant_code,
        reference_prefix=payload.reference_prefix,
        service_access=payload.service_access.model_dump() if payload.service_access else None,
    )
    return MerchantCreatedResponse(
        merchant=MerchantResponse.of(
            merchant, 1, service_access=service_access_service.get_access_map(db, merchant.merchant_id)
        ),
        first_user=AccountResponse.of(first_user),
        temporary_password=temp_password,
    )


@router.get(
    "/{merchant_id}",
    response_model=MerchantResponse,
    summary="Get one merchant",
    description="Requires `merchant.view`.",
)
def get_merchant(
    merchant_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.MERCHANT_VIEW)),
):
    merchant = merchant_service.get_merchant(db, merchant_id)
    return MerchantResponse.of(
        merchant, service_access=service_access_service.get_access_map(db, merchant_id)
    )


@router.put(
    "/{merchant_id}",
    response_model=MerchantResponse,
    summary="Edit a merchant",
    description="Requires `merchant.edit`. Only the fields present in the body are changed.",
)
def update_merchant(
    merchant_id: int,
    payload: UpdateMerchantRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_EDIT)),
):
    merchant = merchant_service.update_merchant(
        db, current_user, merchant_id, **payload.model_dump(exclude_unset=True)
    )
    return MerchantResponse.of(
        merchant, service_access=service_access_service.get_access_map(db, merchant_id)
    )


@router.patch(
    "/{merchant_id}/service-access",
    response_model=ServiceAccessResponse,
    summary="Set which products a merchant may use",
    description=(
        "Requires `merchant.edit` — the same code the main Edit form uses, since this is still "
        "editing the merchant, just independently of its other fields. Only the keys present in "
        "the body change; omit a key to leave it as it is. Takes effect immediately: the "
        "merchant's next `POST /api/enquiries` is checked against the new value, with no need "
        "to sign out and back in (though the cached session picks it up on next login/profile "
        "refresh too — see `routers/auth.py`)."
    ),
)
def set_merchant_service_access(
    merchant_id: int,
    payload: ServiceAccessUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_EDIT)),
):
    access = service_access_service.set_access(
        db, current_user, merchant_id, **payload.model_dump(exclude_unset=True)
    )
    return ServiceAccessResponse(merchant_id=merchant_id, **access)


@router.post(
    "/{merchant_id}/approve",
    response_model=MerchantResponse,
    summary="Approve a pending merchant",
    description=(
        "Requires `merchant.approve`. Moves the company from `pending_approval` to `active` and "
        "notifies its users that they can now sign in."
    ),
)
def approve_merchant(
    merchant_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_APPROVE)),
):
    return MerchantResponse.of(merchant_service.approve_merchant(db, current_user, merchant_id))


@router.patch(
    "/{merchant_id}/status",
    response_model=MerchantResponse,
    summary="Suspend or reactivate a merchant",
    description=(
        "Requires `merchant.suspend`. Suspending immediately ends every session belonging to that "
        "company's users and revokes their tokens."
    ),
)
def set_merchant_status(
    merchant_id: int,
    payload: MerchantStatusRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_SUSPEND)),
):
    merchant = merchant_service.set_merchant_status(db, current_user, merchant_id, payload.status)
    return MerchantResponse.of(merchant)


@router.delete(
    "/{merchant_id}",
    status_code=204,
    summary="Delete a merchant",
    description=(
        "Requires `merchant.delete`. Soft-deletes the merchant and every one of its users "
        "(hard deletion is unsafe — most tables referencing a merchant cascade on it, and "
        "`wallet_transactions` restricts it outright). Every user is logged out immediately and "
        "none of them, nor the merchant, can sign in again. The merchant stops appearing in "
        "Merchant List/Search/Filters."
    ),
)
def delete_merchant(
    merchant_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_DELETE)),
):
    merchant_service.delete_merchant(db, current_user, merchant_id)


@router.get(
    "/{merchant_id}/users",
    response_model=Page[AccountResponse],
    summary="List a merchant's users",
    description="Requires `merchant_user.manage`.",
)
def list_merchant_users(
    merchant_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_service.get_merchant(db, merchant_id)  # 404 if it doesn't exist
    users, total = account_service.list_merchant_users(db, merchant_id, page, page_size, search)
    return Page.build([AccountResponse.of(u) for u in users], total, page, page_size)


@router.post(
    "/{merchant_id}/users",
    response_model=CredentialsResponse,
    status_code=201,
    summary="Create a user under a merchant",
    description=(
        "Requires `merchant_user.manage`. Creates a `merchant_admin` or `merchant_user` parented "
        "to the merchant in the path — not to the caller, who is platform staff and has no "
        "merchant of their own. Optionally takes an internal role (Manager, Supervisor, Operator, "
        "Finance, Data Operator). The generated password is returned **once**.\n\n"
        "This is the Admin-side counterpart of `POST /api/merchant/team`, which a merchant uses to "
        "create staff inside its own company. Both funnel into the same "
        "`account_service.create_merchant_user`; only where `merchant_id` comes from differs — the "
        "path here, the caller's own account there."
    ),
)
def create_merchant_user(
    merchant_id: int,
    payload: CreateMerchantUserRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_service.get_merchant(db, merchant_id)  # 404 if it doesn't exist
    user, temp_password = account_service.create_merchant_user(
        db,
        current_user,
        merchant_id=merchant_id,
        full_name=payload.full_name,
        email=payload.email,
        phone=payload.phone,
        role=payload.role,
        merchant_role=payload.merchant_role,
        password=payload.password,
    )
    return CredentialsResponse(
        account=AccountResponse.of(user), temporary_password=temp_password
    )


@router.post(
    "/{merchant_id}/users/{user_id}/reset-password",
    response_model=CredentialsResponse,
    summary="Reset a merchant user's password",
    description="Requires `merchant_user.manage`. Returns the new password once.",
)
def reset_merchant_user_password(
    merchant_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    user, temp_password = account_service.reset_merchant_user_password(
        db, current_user, merchant_id, user_id
    )
    return CredentialsResponse(
        account=AccountResponse.of(user), temporary_password=temp_password
    )


@router.patch(
    "/{merchant_id}/users/{user_id}/status",
    response_model=AccountResponse,
    summary="Activate or deactivate a merchant user",
    description=(
        "Requires `merchant_user.manage`. Deactivating ends that user's sessions and revokes "
        "their tokens immediately."
    ),
)
def set_merchant_user_status(
    merchant_id: int,
    user_id: int,
    payload: StatusChangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    """The Admin-side counterpart to ``PATCH /api/merchant/team/{user_id}/status``.

    THE TWO CANNOT BE ONE ROUTE. The merchant-team version derives the company
    from the CALLER (``_own_merchant_id(current_user)``), which is exactly what
    stops one merchant touching another's staff — and it is also why an Admin,
    who belongs to no merchant, cannot use it. Here the company comes from the
    URL instead, the same asymmetry ``create_merchant_user`` and
    ``reset_merchant_user_password`` above already have.

    Both call the same ``account_service.set_merchant_user_status``, so the
    self-suspension guard, the forced logout, the token revocation and the
    activity-log entry are identical whichever side does it.
    """
    user = account_service.set_merchant_user_status(
        db, current_user, merchant_id, user_id, payload.status
    )
    return AccountResponse.of(user)


@router.delete(
    "/{merchant_id}/users/{user_id}",
    status_code=204,
    summary="Delete a merchant user",
    description=(
        "Requires `merchant_user.delete`. Soft-deletes only this one user — logged out "
        "immediately, can no longer sign in, disappears from the Merchant Users table — so their "
        "historical bookings and enquiries keep their attribution. Their email is freed for reuse "
        "on a new account. Does not affect the merchant account, other users, or existing bookings."
    ),
)
def delete_merchant_user(
    merchant_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_DELETE)),
):
    account_service.delete_merchant_user(db, current_user, merchant_id, user_id)
