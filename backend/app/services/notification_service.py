"""Notifications on the v2 ``msg_logs`` table.

Replaces the legacy ``notifications`` and ``partner_notifications`` tables.
A notification is a ``msg_logs`` row with ``message_type='notification'``:
``subject`` is the title, ``message`` the body, and ``is_read`` carries the
read flag exactly as before. ``recipient`` holds the user's email so the row
is still meaningful if the account is later deleted (``user_id`` is
``ON DELETE SET NULL``).
"""
from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models_v2 import MessageStatus, MessageType, MsgLog, User, UserRole
from app.services import activity_service

_ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.ADMIN)


def _notification_filter():
    return MsgLog.message_type == MessageType.NOTIFICATION


def _new(user_id: int, recipient: str, title: str, message: str, merchant_id: int | None = None) -> MsgLog:
    return MsgLog(
        user_id=user_id,
        merchant_id=merchant_id,
        message_type=MessageType.NOTIFICATION,
        recipient=recipient,
        subject=title,
        message=message,
        status=MessageStatus.DELIVERED,
        sent_time=func.now(),
        delivered_time=func.now(),
    )


def create_notification(db: Session, user_id: int, title: str, message: str) -> MsgLog:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    notification = _new(user_id, user.email, title, message, user.merchant_id)
    db.add(notification)
    db.commit()
    db.refresh(notification)
    return notification


def notify_admins(db: Session, title: str, message: str) -> int:
    """Admins are ordinary ``users`` rows, so their existing
    GET /api/notifications already surfaces these — no extra endpoint."""
    admins = db.execute(select(User.user_id, User.email).where(User.role.in_(_ADMIN_ROLES))).all()
    for admin_id, email in admins:
        db.add(_new(admin_id, email, title, message))
    db.commit()
    return len(admins)


def list_user_notifications(db: Session, user_id: int) -> list[MsgLog]:
    stmt = (
        select(MsgLog)
        .where(and_(_notification_filter(), MsgLog.user_id == user_id))
        .order_by(MsgLog.created_at.desc())
    )
    return list(db.scalars(stmt).all())


def _owned(db: Session, user_id: int, notification_id: int) -> MsgLog:
    notification = db.get(MsgLog, notification_id)
    if (
        not notification
        or notification.user_id != user_id
        or notification.message_type is not MessageType.NOTIFICATION
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    return notification


def mark_read(db: Session, user_id: int, notification_id: int) -> MsgLog:
    notification = _owned(db, user_id, notification_id)
    notification.is_read = True
    db.commit()
    db.refresh(notification)
    activity_service.log_activity(
        db,
        user_id,
        f"Notification Read ({notification.subject})",
        activity_type="Notification Read",
        module="Notification",
        reference_id=notification.message_id,
    )
    return notification


def mark_all_read(db: Session, user_id: int) -> int:
    stmt = select(MsgLog).where(
        and_(_notification_filter(), MsgLog.user_id == user_id, MsgLog.is_read.is_(False))
    )
    notifications = list(db.scalars(stmt).all())
    for notification in notifications:
        notification.is_read = True
    db.commit()
    return len(notifications)


def delete_notification(db: Session, user_id: int, notification_id: int) -> None:
    db.delete(_owned(db, user_id, notification_id))
    db.commit()


def delete_read_notifications(db: Session, user_id: int) -> int:
    stmt = select(MsgLog).where(
        and_(_notification_filter(), MsgLog.user_id == user_id, MsgLog.is_read.is_(True))
    )
    notifications = list(db.scalars(stmt).all())
    for notification in notifications:
        db.delete(notification)
    db.commit()
    return len(notifications)


def list_all_notifications_paginated(db: Session, page: int, page_size: int):
    total = (
        db.scalar(select(func.count()).select_from(MsgLog).where(_notification_filter())) or 0
    )
    stmt = (
        select(MsgLog, User.email)
        .join(User, MsgLog.user_id == User.user_id)
        .where(_notification_filter())
        .order_by(MsgLog.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    items = [
        {
            "id": n.message_id,
            "user_id": n.user_id,
            "title": n.subject,
            "message": n.message,
            "is_read": n.is_read,
            "created_at": n.created_at,
            "user_email": email,
        }
        for n, email in db.execute(stmt).all()
    ]
    return items, total


def send_admin_notification(db: Session, user_id: int | None, title: str, message: str) -> int:
    if user_id is not None:
        user = db.get(User, user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        recipients = [(user.user_id, user.email, user.merchant_id)]
    else:
        recipients = [
            (uid, email, mid)
            for uid, email, mid in db.execute(
                select(User.user_id, User.email, User.merchant_id)
            ).all()
        ]
    for uid, email, mid in recipients:
        db.add(_new(uid, email, title, message, mid))
    db.commit()
    return len(recipients)
