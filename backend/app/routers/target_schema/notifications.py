from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import get_current_user
from app.database.session import get_db
from app.models.target_schema.users import User
from app.schemas.target_schema.notification import NotificationOut
from app.services.target_schema import msg_log_service

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut], summary="List my notifications")
def my_notifications(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return msg_log_service.list_for_user(db, current_user.id, channel="notification")


@router.patch("/read-all", status_code=status.HTTP_204_NO_CONTENT, summary="Mark all notifications as read")
def mark_all_notifications_read(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    msg_log_service.mark_all_read(db, current_user.id)


@router.patch("/{notification_id}/read", response_model=NotificationOut, summary="Mark a notification as read")
def mark_notification_read(notification_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return msg_log_service.mark_read(db, current_user.id, notification_id)


@router.delete("/read", status_code=status.HTTP_204_NO_CONTENT, summary="Clear all read notifications")
def delete_read_notifications(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    msg_log_service.delete_read_for_user(db, current_user.id)


@router.delete("/{notification_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a notification")
def delete_notification(notification_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    msg_log_service.delete_for_user(db, current_user.id, notification_id)
