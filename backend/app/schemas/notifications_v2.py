"""Notification Center response shapes (API_CONTRACT.md §6.4), v2 schema.

Named distinctly from the legacy ``schemas/notification.py`` (paired with the unmounted
``routers/notification.py``) to avoid any accidental coupling between the two.
"""
import datetime

from pydantic import BaseModel


class NotificationResponse(BaseModel):
    id: int
    title: str | None = None
    message: str | None = None
    is_read: bool
    created_at: datetime.datetime

    @classmethod
    def of(cls, n) -> "NotificationResponse":
        return cls(
            id=n.message_id, title=n.subject, message=n.message,
            is_read=n.is_read, created_at=n.created_at,
        )
