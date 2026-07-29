"""Notification Center — API_CONTRACT.md §6.4.

Named distinctly from the legacy, unmounted ``routers/notifications.py``. The service layer
(``notification_service.py``) was already fully built against the v2 ``msg_logs`` table with
nothing wired to it; this is that wiring, not new logic — added alongside the Merchant Portal
(Phase 2) because its topbar notification bell needs it, not as a full Phase 5 build-out
(no admin broadcast or communication-settings endpoints here — those stay in Phase 5).
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.notifications_v2 import NotificationResponse
from app.schemas.pagination import Page
from app.services import notification_service

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get(
    "",
    response_model=Page[NotificationResponse],
    summary="List my notifications",
    description="Requires `notification.view`. Newest first.",
)
def list_notifications(
    unread_only: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.NOTIFICATION_VIEW)),
):
    items = notification_service.list_user_notifications(db, current_user.user_id)
    if unread_only:
        items = [n for n in items if not n.is_read]
    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start : start + page_size]
    return Page.build([NotificationResponse.of(n) for n in page_items], total, page, page_size)


@router.get(
    "/unread-count",
    summary="Unread notification count",
    description="Requires `notification.view`.",
)
def unread_count(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.NOTIFICATION_VIEW)),
):
    items = notification_service.list_user_notifications(db, current_user.user_id)
    return {"count": sum(1 for n in items if not n.is_read)}


@router.patch(
    "/{notification_id}/read",
    response_model=NotificationResponse,
    summary="Mark one notification read",
    description="Requires `notification.view`.",
)
def mark_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.NOTIFICATION_VIEW)),
):
    return NotificationResponse.of(notification_service.mark_read(db, current_user.user_id, notification_id))


@router.post(
    "/read-all",
    summary="Mark all my notifications read",
    description="Requires `notification.view`.",
)
def mark_all_read(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.NOTIFICATION_VIEW)),
):
    return {"updated": notification_service.mark_all_read(db, current_user.user_id)}
