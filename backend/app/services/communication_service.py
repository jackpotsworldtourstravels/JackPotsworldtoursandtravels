"""Per-merchant channel preferences + Admin broadcast — API_CONTRACT.md §4.4.

Broadcasts fan out one ``msg_logs`` row per recipient, skipping a merchant whose
``communication_settings.notification_enabled`` is false — a broadcast is not a
force-send, it respects what that merchant's account has opted into.
"""
import logging

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_v2 import CommunicationSettings, Merchant, MerchantStatus, User
from app.services import notification_service

logger = logging.getLogger(__name__)

_BIGINT_MAX = 9_223_372_036_854_775_807   # merchants.merchant_id is BIGINT


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


def broadcast(
    db: Session, send_to_all: bool, merchant_ids: list[int] | None, title: str, message: str,
) -> tuple[int, int, int]:
    """Send a notification to every user of the given merchants, or to every active
    merchant when ``send_to_all`` is explicitly true. Returns ``(sent, skipped, failed)``.

    **Fail-closed audience.** An empty, missing or null ``merchant_ids`` is NEVER
    read as "everyone": without ``send_to_all=True`` the caller must name at least
    one merchant, every id must be a positive int, and every id must be an ACTIVE
    merchant. Anything else raises BEFORE a single notification is created, so a bad
    request can neither send to the wrong audience nor send to a silently shrunken
    one. ``ValueError`` guards direct (non-HTTP) callers; unknown/inactive ids are a
    400 for the HTTP layer.

    Each recipient's notification is committed on its own (``notification_service``
    commits per recipient), so a failure on ONE recipient must not abort the whole
    run and leave a partial, untraceable send. A per-recipient failure is caught,
    the session is rolled back to a clean state, the recipient is counted as
    ``failed``, and the loop continues. No recipient is attempted twice, so this
    never duplicates a notification; the caller records ``(sent, skipped, failed)``
    in the audit trail, so a partial result is always traceable.
    """
    query = select(Merchant).where(Merchant.status == MerchantStatus.ACTIVE)
    if send_to_all:
        if merchant_ids is not None:
            raise ValueError("send_to_all=True cannot be combined with merchant_ids")
    else:
        if not merchant_ids:
            raise ValueError(
                "merchant_ids is required unless send_to_all=True; an empty list never means everyone"
            )
        if any(isinstance(i, bool) or not isinstance(i, int) or not 1 <= i <= _BIGINT_MAX
               for i in merchant_ids):
            raise ValueError("merchant_ids must be integers between 1 and the BIGINT maximum")
        wanted = set(merchant_ids)
        active = set(db.scalars(
            select(Merchant.merchant_id).where(
                Merchant.merchant_id.in_(wanted), Merchant.status == MerchantStatus.ACTIVE
            )
        ).all())
        missing = sorted(wanted - active)
        if missing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown or inactive merchant id(s): {missing}. Nothing was sent.",
            )
        query = query.where(Merchant.merchant_id.in_(wanted))
    merchants = db.scalars(query).all()

    sent = skipped = failed = 0
    for merchant in merchants:
        settings = get_settings(db, merchant.merchant_id)
        if not settings.notification_enabled:
            skipped += len(merchant.users)
            continue
        for user in merchant.users:
            try:
                notification_service.create_notification(db, user.user_id, title, message)
                sent += 1
            except Exception:  # noqa: BLE001 — one bad recipient must not abort the broadcast
                db.rollback()
                failed += 1
                logger.warning(
                    "Broadcast: notification to user %s failed; continuing", user.user_id,
                    exc_info=True,
                )
    return sent, skipped, failed
