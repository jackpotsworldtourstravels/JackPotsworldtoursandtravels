from sqlalchemy import text
from sqlalchemy.orm import Session


def list_notifications(db: Session, partner_user_id: int, limit: int = 20) -> dict:
    rows = db.execute(
        text("""
            SELECT notification_id, title, message, is_read, created_at
            FROM partner_notifications
            WHERE partner_user_id = :id
            ORDER BY created_at DESC
            LIMIT :limit
        """),
        {"id": partner_user_id, "limit": limit},
    ).mappings().all()
    unread_count = db.execute(
        text("SELECT count(*) FROM partner_notifications WHERE partner_user_id = :id AND is_read = false"),
        {"id": partner_user_id},
    ).scalar()
    return {"unread_count": unread_count, "notifications": [dict(r) for r in rows]}


def mark_read(db: Session, partner_user_id: int, notification_id: int) -> None:
    db.execute(
        text("""
            UPDATE partner_notifications SET is_read = true
            WHERE notification_id = :nid AND partner_user_id = :pid
        """),
        {"nid": notification_id, "pid": partner_user_id},
    )
    db.commit()


def mark_all_read(db: Session, partner_user_id: int) -> None:
    db.execute(
        text("UPDATE partner_notifications SET is_read = true WHERE partner_user_id = :id AND is_read = false"),
        {"id": partner_user_id},
    )
    db.commit()
