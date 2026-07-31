from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_merchant_staff
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.merchant_profile import (
    MerchantChangePasswordRequest,
    MerchantProfileOut,
    MerchantProfileUpdateRequest,
    MessageResponse,
)
from app.schemas.target_schema.merchant_reference import BAGGAGE_OPTIONS, MEAL_OPTIONS, AncillaryOptionOut
from app.schemas.target_schema.notification import NotificationOut
from app.services.target_schema import msg_log_service, user_service

profile_router = APIRouter(prefix="/api/partner/profile", tags=["partner-profile"])
notifications_router = APIRouter(prefix="/api/partner/notifications", tags=["partner-notifications"])
reference_router = APIRouter(prefix="/api/partner", tags=["partner-reference"])


def _profile_out(user: User) -> MerchantProfileOut:
    return MerchantProfileOut(
        partner_user_id=user.id, full_name=user.full_name, email=user.email, phone_number=user.phone_number,
        partner_id=user.merchant_id, company_name=user.merchant.company_name, company_code=user.merchant.company_code,
    )


@profile_router.get("", response_model=MerchantProfileOut, summary="View own profile")
def get_profile(current: User = Depends(get_current_merchant_staff)):
    return _profile_out(current)


@profile_router.patch("", response_model=MerchantProfileOut, summary="Update name/phone")
def update_profile(payload: MerchantProfileUpdateRequest, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    user_service.update_profile(db, current, **payload.model_dump(exclude_unset=True))
    return _profile_out(current)


@profile_router.post("/change-password", response_model=MessageResponse, summary="Change password")
def change_password(payload: MerchantChangePasswordRequest, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    user_service.change_password(db, current, payload.current_password, payload.new_password)
    return MessageResponse(message="Password changed.")


@notifications_router.get("", summary="List my notifications with unread count")
def my_notifications(db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    notifications = msg_log_service.list_for_user(db, current.id, channel="notification")
    unread_count = msg_log_service.count_unread(db, current.id, channel="notification")
    return {
        "unread_count": unread_count,
        "notifications": [NotificationOut.model_validate(n) for n in notifications],
    }


@notifications_router.patch("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT, summary="Mark a notification as read")
def mark_read(notification_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    msg_log_service.mark_read(db, current.id, notification_id)


@notifications_router.patch("/read-all", status_code=status.HTTP_204_NO_CONTENT, summary="Mark all notifications as read")
def mark_all_read(db: Session = Depends(get_db), current: User = Depends(get_current_merchant_staff)):
    msg_log_service.mark_all_read(db, current.id)


@reference_router.get(
    "/ancillary-catalog", response_model=dict[str, list[AncillaryOptionOut]],
    summary="Baggage/meal options for Request Ticket",
)
def list_ancillary_catalog(current: User = Depends(get_current_merchant_staff)):
    return {"baggage": BAGGAGE_OPTIONS, "meal": MEAL_OPTIONS}
