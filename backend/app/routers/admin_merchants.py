from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.admin_merchant import (
    MerchantCreateRequest,
    MerchantDetailOut,
    MerchantListItemOut,
    MerchantUpdateRequest,
    MerchantUserCreateRequest,
    MerchantUserOut,
    MerchantUserUpdateRequest,
    MessageResponse,
    ResetPasswordOut,
)
from app.services import admin_merchant_service

router = APIRouter(prefix="/api/admin/merchants", tags=["admin-merchants"])


@router.get("", response_model=list[MerchantListItemOut], summary="List merchants")
def list_merchants(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.list_merchants(db)


@router.post("", response_model=MerchantDetailOut, summary="Onboard a new merchant")
def create_merchant(payload: MerchantCreateRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.create_merchant(db, payload)


@router.get("/{partner_id}", response_model=MerchantDetailOut, summary="Merchant details")
def get_merchant(partner_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.get_merchant_detail(db, partner_id)


@router.patch("/{partner_id}", response_model=MerchantDetailOut, summary="Edit merchant")
def update_merchant(
    partner_id: int, payload: MerchantUpdateRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    return admin_merchant_service.update_merchant(db, partner_id, payload)


@router.post("/{partner_id}/activate", response_model=MerchantDetailOut, summary="Activate merchant")
def activate_merchant(partner_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.set_merchant_status(db, partner_id, "active")


@router.post("/{partner_id}/deactivate", response_model=MerchantDetailOut, summary="Deactivate merchant")
def deactivate_merchant(partner_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.set_merchant_status(db, partner_id, "inactive")


@router.get("/{partner_id}/users", response_model=list[MerchantUserOut], summary="List a merchant's users")
def list_merchant_users(partner_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.list_merchant_users(db, partner_id)


@router.post("/{partner_id}/users", response_model=MerchantUserOut, summary="Create a user under a merchant")
def create_merchant_user(
    partner_id: int, payload: MerchantUserCreateRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    return admin_merchant_service.create_merchant_user(db, partner_id, payload)


@router.get("/users/{partner_user_id}", response_model=MerchantUserOut, summary="Merchant user detail")
def get_merchant_user(partner_user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.get_merchant_user(db, partner_user_id)


@router.patch("/users/{partner_user_id}", response_model=MerchantUserOut, summary="Edit merchant user")
def update_merchant_user(
    partner_user_id: int, payload: MerchantUserUpdateRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    return admin_merchant_service.update_merchant_user(db, partner_user_id, payload)


@router.post("/users/{partner_user_id}/activate", response_model=MerchantUserOut, summary="Activate merchant user")
def activate_merchant_user(partner_user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.set_merchant_user_status(db, partner_user_id, "active")


@router.post("/users/{partner_user_id}/deactivate", response_model=MerchantUserOut, summary="Deactivate merchant user")
def deactivate_merchant_user(partner_user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_merchant_service.set_merchant_user_status(db, partner_user_id, "inactive")


@router.post("/users/{partner_user_id}/reset-password", response_model=ResetPasswordOut, summary="Reset merchant user password")
def reset_merchant_user_password(partner_user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    new_password = admin_merchant_service.reset_merchant_user_password(db, partner_user_id)
    return ResetPasswordOut(message="Password reset.", new_password=new_password)
