from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.schemas.notification import NotificationOut
from app.services import notification_service

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get(
    "",
    response_model=list[NotificationOut],
    summary="List my notifications",
    description="Requires authentication. Returns all notifications for the current user.",
)
def my_notifications(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return notification_service.list_user_notifications(db, current_user.id)


@router.patch(
    "/read-all",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Mark all notifications as read",
    description="Requires authentication. Marks every unread notification owned by the current user as read.",
)
def mark_all_notifications_read(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    notification_service.mark_all_read(db, current_user.id)


@router.patch(
    "/{notification_id}/read",
    response_model=NotificationOut,
    summary="Mark a notification as read",
    description="Requires authentication. Marks a notification owned by the current user as read and returns it.",
)
def mark_notification_read(
    notification_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return notification_service.mark_read(db, current_user.id, notification_id)


@router.delete(
    "/read",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Clear all read notifications",
    description="Requires authentication. Deletes every read notification owned by the current user; unread notifications are left untouched.",
)
def delete_read_notifications(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    notification_service.delete_read_notifications(db, current_user.id)


@router.delete(
    "/{notification_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a notification",
    description="Requires authentication. Deletes a notification owned by the current user.",
)
def delete_notification(
    notification_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    notification_service.delete_notification(db, current_user.id, notification_id)
