import datetime

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.target_schema.msg_logs import MsgLog
from app.models.target_schema.users import User


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def send(
    db: Session, *, channel: str, user_id: int | None = None, merchant_id: int | None = None,
    recipient_email: str | None = None, recipient_phone: str | None = None,
    subject: str | None = None, message: str | None = None,
    related_entity_type: str | None = None, related_entity_id: int | None = None,
) -> MsgLog:
    """Records an outbound message. Actual delivery (SMTP/SMS/WhatsApp gateway)
    stays the caller's responsibility — this only persists the log row, same
    separation of concerns as the legacy notification/email services.
    """
    log = MsgLog(
        channel=channel, direction="outbound", user_id=user_id, merchant_id=merchant_id,
        recipient_email=recipient_email, recipient_phone=recipient_phone, subject=subject, message=message,
        related_entity_type=related_entity_type, related_entity_id=related_entity_id,
        status="sent", sent_at=_now(), created_at=_now(),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def record_inbound(
    db: Session, *, channel: str, recipient_email: str | None = None, subject: str | None = None,
    message: str | None = None,
) -> MsgLog:
    log = MsgLog(
        channel=channel, direction="inbound", recipient_email=recipient_email, subject=subject,
        message=message, created_at=_now(),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def notify_admins(db: Session, subject: str, message: str) -> int:
    admin_ids = db.scalars(select(User.id).where(User.user_type == "admin")).all()
    for admin_id in admin_ids:
        send(db, channel="notification", user_id=admin_id, subject=subject, message=message)
    return len(admin_ids)


def mark_read(db: Session, user_id: int, msg_log_id: int) -> MsgLog:
    log = db.get(MsgLog, msg_log_id)
    if not log or log.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    log.is_read = True
    log.read_at = _now()
    log.status = "read"
    db.commit()
    db.refresh(log)
    return log


def mark_all_read(db: Session, user_id: int) -> int:
    logs = db.scalars(select(MsgLog).where(MsgLog.user_id == user_id, MsgLog.is_read.is_(False))).all()
    now = _now()
    for log in logs:
        log.is_read = True
        log.read_at = now
        log.status = "read"
    db.commit()
    return len(logs)


def delete_for_user(db: Session, user_id: int, msg_log_id: int) -> None:
    log = db.get(MsgLog, msg_log_id)
    if not log or log.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    db.delete(log)
    db.commit()


def delete_read_for_user(db: Session, user_id: int) -> int:
    logs = db.scalars(select(MsgLog).where(MsgLog.user_id == user_id, MsgLog.is_read.is_(True))).all()
    for log in logs:
        db.delete(log)
    db.commit()
    return len(logs)


def list_for_user(db: Session, user_id: int, *, channel: str | None = None, unread_only: bool = False) -> list[MsgLog]:
    stmt = select(MsgLog).where(MsgLog.user_id == user_id)
    if channel:
        stmt = stmt.where(MsgLog.channel == channel)
    if unread_only:
        stmt = stmt.where(MsgLog.is_read.is_(False))
    return db.scalars(stmt.order_by(MsgLog.created_at.desc())).all()


def count_unread(db: Session, user_id: int, *, channel: str | None = None) -> int:
    stmt = select(func.count()).select_from(MsgLog).where(MsgLog.user_id == user_id, MsgLog.is_read.is_(False))
    if channel:
        stmt = stmt.where(MsgLog.channel == channel)
    return db.scalar(stmt) or 0


def list_for_merchant(db: Session, merchant_id: int, *, channel: str | None = None, unread_only: bool = False) -> list[MsgLog]:
    stmt = select(MsgLog).where(MsgLog.merchant_id == merchant_id)
    if channel:
        stmt = stmt.where(MsgLog.channel == channel)
    if unread_only:
        stmt = stmt.where(MsgLog.is_read.is_(False))
    return db.scalars(stmt.order_by(MsgLog.created_at.desc())).all()


# ---------------------------------------------------------------------------
# Admin views — no ownership scoping, unlike the user-facing functions above.
# ---------------------------------------------------------------------------

def list_by_channel_paginated(db: Session, channel: str, page: int, page_size: int) -> tuple[list[MsgLog], int]:
    stmt = select(MsgLog).where(MsgLog.channel == channel)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    stmt = stmt.order_by(MsgLog.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    return db.scalars(stmt).all(), total


def admin_delete(db: Session, msg_log_id: int) -> None:
    log = db.get(MsgLog, msg_log_id)
    if not log:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    db.delete(log)
    db.commit()


def list_all_notifications_paginated(db: Session, page: int, page_size: int):
    stmt = (
        select(MsgLog, User.email)
        .join(User, MsgLog.user_id == User.id)
        .where(MsgLog.channel == "notification")
        .order_by(MsgLog.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    total = db.scalar(
        select(func.count()).select_from(MsgLog).where(MsgLog.channel == "notification")
    ) or 0
    return db.execute(stmt).all(), total


def send_admin_broadcast(db: Session, user_id: int | None, subject: str, message: str) -> int:
    if user_id is not None:
        if not db.get(User, user_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        user_ids = [user_id]
    else:
        user_ids = db.scalars(select(User.id).where(User.user_type == "customer")).all()
    for uid in user_ids:
        send(db, channel="notification", user_id=uid, subject=subject, message=message)
    return len(user_ids)
