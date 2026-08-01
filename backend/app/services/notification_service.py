"""Notifications on the v2 ``msg_logs`` table.

Replaces the legacy ``notifications`` and ``partner_notifications`` tables.
A notification is a ``msg_logs`` row with ``message_type='notification'``:
``subject`` is the title, ``message`` the body, and ``is_read`` carries the
read flag exactly as before. ``recipient`` holds the user's email so the row
is still meaningful if the account is later deleted (``user_id`` is
``ON DELETE SET NULL``).
"""
from fastapi import HTTPException, status
import logging

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models_v2 import (
    MerchantRole,
    MessageStatus,
    MessageType,
    MsgLog,
    User,
    UserRole,
    UserStatus,
)
from app.services import activity_service

_ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.ADMIN)


def _notification_filter():
    return MsgLog.message_type == MessageType.NOTIFICATION


def _deliver(recipients, db: Session, title: str, message: str, *,
             merchant_id: int | None = None, request=None, event: str | None = None):
    """Hand off to M5's delivery layer, which owns channels and logging.

    Imported inside the function, not at module scope: ``delivery_service``
    reaches ``email_service`` and the templates, and a top-level import here
    would put that whole chain behind every module that only wants to write a
    notification.

    **Delivery never breaks the thing that triggered it.** A mail server being
    unreachable must not roll back the ticket that was just issued, so anything
    escaping the delivery layer is logged and swallowed — the in-app row is
    written first inside ``deliver`` and is what the portals read.
    """
    from app.services import delivery_service

    try:
        return delivery_service.deliver(
            db, recipients, title, message,
            merchant_id=merchant_id, request=request, event=event,
        )
    except Exception:                              # noqa: BLE001 — see docstring
        logging.getLogger("jackpots.delivery").exception(
            "Delivery failed for %r; the triggering action is unaffected.", title
        )
        db.rollback()
        # Fall back to the pre-M5 behaviour so the notification itself is never
        # lost because email was the thing that broke.
        for entry in recipients:
            db.add(_new(entry[0], entry[1], title, message,
                        entry[2] if len(entry) > 2 else merchant_id))
        db.commit()
        return {"in_app": len(list(recipients)), "emailed": 0, "failed": 0, "suppressed": 0}


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
    # M5 routes this through delivery_service so the same event reaches the
    # merchant by email too, when that merchant still has email switched on.
    # The in-app row is returned as before, so every existing caller is
    # unaffected — including the ones that read its id.
    before = db.query(MsgLog.message_id).order_by(MsgLog.message_id.desc()).limit(1).scalar()
    _deliver([(user_id, user.email, user.merchant_id)], db, title, message,
             merchant_id=user.merchant_id)
    notification = db.scalars(
        select(MsgLog).where(
            MsgLog.user_id == user_id,
            _notification_filter(),
            MsgLog.message_id > (before or 0),
        ).order_by(MsgLog.message_id.desc()).limit(1)
    ).first()
    return notification or _new(user_id, user.email, title, message, user.merchant_id)


def notify_admins(db: Session, title: str, message: str) -> int:
    """Admins are ordinary ``users`` rows, so their existing
    GET /api/notifications already surfaces these — no extra endpoint."""
    admins = db.execute(select(User.user_id, User.email).where(User.role.in_(_ADMIN_ROLES))).all()
    # M5: staff carry no merchant, so delivery_service never opts them out — a
    # merchant's communication preferences must not be able to silence the
    # platform's own operational alerts.
    _deliver([(uid, email, None) for uid, email in admins], db, title, message)
    return len(admins)


def notify_merchant_managers(db: Session, merchant_id: int | None, title: str, message: str) -> int:
    """Notify the people at one merchant who can sign off a service request.

    The same definition as ``manager_approval.is_manager`` — a MANAGER, or the
    company's merchant_admin — expressed as a query rather than by loading every
    user and filtering in Python. Returns how many were told, so a caller can
    notice a company with nobody able to approve.
    """
    if merchant_id is None:
        return 0
    managers = db.execute(
        select(User.user_id, User.email).where(
            and_(
                User.merchant_id == merchant_id,
                or_(
                    User.merchant_role == MerchantRole.MANAGER,
                    User.role == UserRole.MERCHANT_ADMIN,
                ),
            )
        )
    ).all()
    _deliver([(uid, email, merchant_id) for uid, email in managers], db, title, message,
             merchant_id=merchant_id)
    return len(managers)


def notify_managers(db: Session, title: str, message: str) -> int:
    """Notify the Manager approval desk (CR-2).

    Separate from :func:`notify_admins` on purpose. A submitted Classic Tours
    booking is not the admins' work — the generic approval path refuses that
    track — so telling them would be an alert nobody can act on, and telling
    only the managers keeps the two desks' inboxes honest about what is theirs.
    """
    managers = db.execute(
        select(User.user_id, User.email).where(
            and_(User.role == UserRole.MANAGER, User.status == UserStatus.ACTIVE)
        )
    ).all()
    _deliver([(uid, email, None) for uid, email in managers], db, title, message)
    return len(managers)


def notify_request_merchant(db, request, title: str, message: str) -> None:
    """Notify whoever raised a request, falling back to the company's admins.

    Lives here rather than in one caller because two services now need it, and
    a second copy of "who counts as the merchant for this request" is exactly
    how one of them ends up notifying nobody after a refactor.

    ``request`` is a ``ServiceRequest``; typed loosely to avoid a circular
    import back into the models this module already reaches through ``User``.
    """
    if request.user_id:
        create_notification(db, request.user_id, title, message)
        return
    if request.merchant is None:
        return
    for user in request.merchant.users:
        create_notification(db, user.user_id, title, message)


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
