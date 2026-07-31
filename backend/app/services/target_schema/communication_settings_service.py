import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.target_schema.communication_settings import CommunicationSettings


def get_or_create(db: Session, *, user_id: int | None = None, merchant_id: int | None = None) -> CommunicationSettings:
    if (user_id is None) == (merchant_id is None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Exactly one of user_id/merchant_id required")
    stmt = select(CommunicationSettings).where(
        CommunicationSettings.user_id == user_id, CommunicationSettings.merchant_id == merchant_id
    )
    settings = db.scalar(stmt)
    if settings:
        return settings
    now = datetime.datetime.now(datetime.timezone.utc)
    settings = CommunicationSettings(user_id=user_id, merchant_id=merchant_id, created_at=now, updated_at=now)
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


def update_preferences(db: Session, settings_id: int, **fields) -> CommunicationSettings:
    settings = db.get(CommunicationSettings, settings_id)
    if not settings:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Communication settings not found")
    for field in ("email_enabled", "sms_enabled", "whatsapp_enabled", "push_enabled", "preferences"):
        if field in fields and fields[field] is not None:
            setattr(settings, field, fields[field])
    db.commit()
    db.refresh(settings)
    return settings
