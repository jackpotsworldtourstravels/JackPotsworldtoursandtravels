"""Merchant portal — a merchant managing its own staff.

The spec's Merchant User Creation flow::

    Merchant -> Create User -> User gets Username -> Password -> OTP -> Login

The merchant is always the parent. ``merchant_id`` is read from the caller's
own account and never from the request body or path, so one merchant cannot
create or read a user inside another merchant's company — the guard is here
in the service boundary, not in the UI.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.accounts import (
    AccountResponse,
    CreateMerchantUserRequest,
    CredentialsResponse,
    StatusChangeRequest,
    UpdateMerchantUserRequest,
)
from app.schemas.pagination import Page
from app.services import account_service

router = APIRouter(prefix="/api/merchant/team", tags=["merchant · team"])


def _own_merchant_id(current_user: User) -> int:
    """The caller's own merchant. 403 for platform staff, who have none."""
    if current_user.merchant_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available to merchant accounts",
        )
    return current_user.merchant_id


@router.get(
    "",
    response_model=Page[AccountResponse],
    summary="List your company's users",
    description="Requires `merchant_user.manage`. Scoped to the caller's own merchant.",
)
def list_team(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_id = _own_merchant_id(current_user)
    users, total = account_service.list_merchant_users(db, merchant_id, page, page_size, search)
    return Page.build([AccountResponse.of(u) for u in users], total, page, page_size)


@router.post(
    "",
    response_model=CredentialsResponse,
    status_code=201,
    summary="Create a user under your company",
    description=(
        "Requires `merchant_user.create`. Creates a `merchant_admin` or `merchant_user` parented "
        "to the caller's own merchant, optionally with an internal role (Manager, Supervisor, "
        "Operator, Finance, Data Operator) that determines what they may do. The generated "
        "password is returned **once**."
    ),
)
def create_team_member(
    payload: CreateMerchantUserRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_CREATE)),
):
    merchant_id = _own_merchant_id(current_user)
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


@router.get(
    "/{user_id}",
    response_model=AccountResponse,
    summary="Get one of your company's users",
    description=(
        "Requires `merchant_user.manage`. Returns 404 — not 403 — for a user belonging to another "
        "merchant, so the response cannot confirm that the account exists."
    ),
)
def get_team_member(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_id = _own_merchant_id(current_user)
    return AccountResponse.of(account_service.get_merchant_user(db, merchant_id, user_id))


@router.put(
    "/{user_id}",
    response_model=AccountResponse,
    summary="Edit one of your company's users",
    description="Requires `merchant_user.manage`. Use this to change someone's internal role.",
)
def update_team_member(
    user_id: int,
    payload: UpdateMerchantUserRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_id = _own_merchant_id(current_user)
    user = account_service.update_merchant_user(
        db, current_user, merchant_id, user_id,
        payload.full_name, payload.phone, payload.merchant_role,
    )
    return AccountResponse.of(user)


@router.patch(
    "/{user_id}/status",
    response_model=AccountResponse,
    summary="Suspend or reactivate one of your company's users",
    description=(
        "Requires `merchant_user.manage`. Suspending ends that user's sessions and revokes their "
        "tokens immediately."
    ),
)
def set_team_member_status(
    user_id: int,
    payload: StatusChangeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_id = _own_merchant_id(current_user)
    user = account_service.set_merchant_user_status(
        db, current_user, merchant_id, user_id, payload.status
    )
    return AccountResponse.of(user)


@router.post(
    "/{user_id}/reset-password",
    response_model=CredentialsResponse,
    summary="Reset one of your company's users' passwords",
    description="Requires `merchant_user.manage`. Returns the new password once.",
)
def reset_team_member_password(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.MERCHANT_USER_MANAGE)),
):
    merchant_id = _own_merchant_id(current_user)
    user, temp_password = account_service.reset_merchant_user_password(
        db, current_user, merchant_id, user_id
    )
    return CredentialsResponse(
        account=AccountResponse.of(user), temporary_password=temp_password
    )
