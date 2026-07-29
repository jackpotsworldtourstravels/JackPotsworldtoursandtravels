"""Per-merchant channel preferences + Admin broadcast — API_CONTRACT.md §4.4.

Broadcasts fan out one ``msg_logs`` row per recipient, skipping a merchant whose
``communication_settings.notification_enabled`` is false — a broadcast is not a
force-send, it respects what that merchant's account has opted into.
"""
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_v2 import CommunicationSettings, Merchant, MerchantStatus, User
from app.services import notification_service


def get_settings(db: Session, merchant_id: int) -> CommunicationSettings:
    settings = db.scalar(
        select(CommunicationSettings).where(CommunicationSettings.merchant_id == merchant_id)
    )
    if not settings:
        merchant = db.get(Merchant, merchant_id)
        if not merchant:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")
        settings = CommunicationSettings(merchant_id=merchant_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


def update_settings(db: Session, merchant_id: int, **fields) -> CommunicationSettings:
    settings = get_settings(db, merchant_id)
    for key, value in fields.items():
        if value is not None:
            setattr(settings, key, value)
    db.commit()
    db.refresh(settings)
    return settings


def broadcast(db: Session, merchant_ids: list[int] | None, title: str, message: str) -> tuple[int, int]:
    """Send a notification to every user of the given merchants (or every active merchant
    when ``merchant_ids`` is omitted). Returns ``(sent, skipped)``."""
    query = select(Merchant).where(Merchant.status == MerchantStatus.ACTIVE)
    if merchant_ids:
        query = query.where(Merchant.merchant_id.in_(merchant_ids))
    merchants = db.scalars(query).all()

    sent = skipped = 0
    for merchant in merchants:
        settings = get_settings(db, merchant.merchant_id)
        if not settings.notification_enabled:
            skipped += len(merchant.users)
            continue
        for user in merchant.users:
            notification_service.create_notification(db, user.user_id, title, message)
            sent += 1
    return sent, skipped
