from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.partner_deps import get_current_partner_user
from app.database.session import get_db
from app.models.partner import PartnerUser
from app.schemas.partner_notifications import MessageResponse, NotificationListOut
from app.services import partner_notifications_service

router = APIRouter(prefix="/api/partner/notifications", tags=["partner-notifications"])


@router.get("", response_model=NotificationListOut, summary="List own notifications + unread count")
def list_notifications(db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)):
    return partner_notifications_service.list_notifications(db, current.partner_user_id)


@router.post("/{notification_id}/read", response_model=MessageResponse, summary="Mark one notification as read")
def mark_read(
    notification_id: int, db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)
):
    partner_notifications_service.mark_read(db, current.partner_user_id, notification_id)
    return MessageResponse(message="Marked as read.")


@router.post("/mark-all-read", response_model=MessageResponse, summary="Mark all notifications as read")
def mark_all_read(db: Session = Depends(get_db), current: PartnerUser = Depends(get_current_partner_user)):
    partner_notifications_service.mark_all_read(db, current.partner_user_id)
    return MessageResponse(message="All marked as read.")
