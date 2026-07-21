from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.misc import Notification
from app.models.user import Role, User
from app.services import activity_service


def create_notification(db: Session, user_id: int, title: str, message: str) -> Notification:
    notification = Notification(user_id=user_id, title=title, message=message)
    db.add(notification)
    db.commit()
    db.refresh(notification)
    return notification


def notify_admins(db: Session, title: str, message: str) -> int:
    """Reuses the same Notification table as end-user notifications — an admin
    is just a User with role 'admin', so their existing GET /api/notifications
    call already surfaces these with no new endpoint needed.
    """
    admin_ids = db.scalars(select(User.id).join(Role, User.role_id == Role.id).where(Role.name == "admin")).all()
    for admin_id in admin_ids:
        db.add(Notification(user_id=admin_id, title=title, message=message))
    db.commit()
    return len(admin_ids)


def list_user_notifications(db: Session, user_id: int) -> list[Notification]:
    stmt = select(Notification).where(Notification.user_id == user_id).order_by(Notification.created_at.desc())
    return db.scalars(stmt).all()


def mark_read(db: Session, user_id: int, notification_id: int) -> Notification:
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    notification.is_read = True
    db.commit()
    db.refresh(notification)
    activity_service.log_activity(
        db, user_id, f"Notification Read ({notification.title})",
        activity_type="Notification Read", module="Notification", reference_id=notification.id,
    )
    return notification


def delete_notification(db: Session, user_id: int, notification_id: int) -> None:
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    db.delete(notification)
    db.commit()


def list_all_notifications_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(Notification)) or 0
    stmt = (
        select(Notification, User.email)
        .join(User, Notification.user_id == User.id)
        .order_by(Notification.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    items = [{**n.__dict__, "user_email": email} for n, email in db.execute(stmt).all()]
    return items, total


def send_admin_notification(db: Session, user_id: int | None, title: str, message: str) -> int:
    if user_id is not None:
        if not db.get(User, user_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        user_ids = [user_id]
    else:
        user_ids = db.scalars(select(User.id)).all()
    for uid in user_ids:
        db.add(Notification(user_id=uid, title=title, message=message))
    db.commit()
    return len(user_ids)
