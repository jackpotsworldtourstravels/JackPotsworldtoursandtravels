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
from app.models_v2 import CompanyType, Merchant, MerchantStatus, User
from app.schemas.accounts import AccountResponse, CredentialsResponse
from app.schemas.merchant import (
    CreateMerchantRequest,
    MerchantCreatedResponse,
    MerchantResponse,
    MerchantStatusRequest,
    UpdateMerchantRequest,
)
from app.schemas.pagination import Page
from app.services import account_service, merchant_service

router = APIRouter(prefix="/api/admin/merchants", tags=["admin · merchants"])


def _with_user_counts(db: Session, merchants: list[Merchant]) -> list[MerchantResponse]:
    """Attach user counts in one query rather than lazy-loading per row."""
    if not merchants:
        return []
    ids = [m.merchant_id for m in merchants]
    counts = dict(
        db.execute(
            select(User.merchant_id, func.count())
            .where(User.merchant_id.in_(ids))
            .group_by(User.merchant_id)
        ).all()
    )
    return [MerchantResponse.of(m, counts.get(m.merchant_id, 0)) for m in merchants]


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
    )
    return MerchantCreatedResponse(
        merchant=MerchantResponse.of(merchant, 1),
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
    return MerchantResponse.of(merchant_service.get_merchant(db, merchant_id))


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
    return MerchantResponse.of(merchant)


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
