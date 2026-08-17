"""Which travel products a merchant may use — Flights / Hotels / Visa / Holidays.

Orthogonal to ``app/auth/rbac.py``: RBAC governs which *actions* a user may
take inside a portal (approve, issue, view); this governs which *products* a
merchant's company may touch at all, independent of who on their staff is
asking. See migration 0045 for why this is a table rather than columns on
``Merchant``.

Enforcement lives here, not behind a ``Depends`` on every hotel route, because
today's only caller (``enquiry_service.create``) only learns the product from
the already-parsed request body's ``travel_type`` discriminator — the service
code isn't known from the URL the way a permission code is.
"""
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_v2 import Merchant, MerchantServiceAccess, ServiceCode, User
from app.services import activity_service

#: New merchants start with Flights on and the newer products opt-in — mirrors
#: the backfill migration 0045 ran for every merchant that already existed.
DEFAULT_ACCESS: dict[ServiceCode, bool] = {
    ServiceCode.FLIGHTS: True,
    ServiceCode.HOTELS: False,
    ServiceCode.VISA: False,
    ServiceCode.HOLIDAYS: False,
}


def ensure_defaults(
    db: Session, merchant: Merchant, overrides: dict[str, bool] | None = None
) -> None:
    """Seed the three service-access rows for a newly created merchant.

    Called from ``merchant_service.create_merchant`` right after the
    ``CommunicationSettings`` row — same "every merchant gets one of these"
    shape. ``overrides`` is whatever the Onboard form's Service / Product
    Access card sent; anything it doesn't mention keeps its default.
    """
    overrides = overrides or {}
    for code, default in DEFAULT_ACCESS.items():
        db.add(
            MerchantServiceAccess(
                merchant_id=merchant.merchant_id,
                service_code=code,
                enabled=overrides.get(code.value, default),
            )
        )


def get_access_map(db: Session, merchant_id: int) -> dict[str, bool]:
    """Read a merchant's access as ``{"flights": True, "hotels": False, ...}``.

    Defensively fills any row that's missing (a merchant created before
    migration 0045 ran without its backfill reaching this row, or a test
    fixture that inserted a merchant directly) from ``DEFAULT_ACCESS``, so
    callers never have to special-case a partial row set.
    """
    rows = db.scalars(
        select(MerchantServiceAccess).where(
            MerchantServiceAccess.merchant_id == merchant_id
        )
    ).all()
    access = {code.value: default for code, default in DEFAULT_ACCESS.items()}
    for row in rows:
        access[row.service_code.value] = row.enabled
    return access


def set_access(
    db: Session, actor: User, merchant_id: int, **updates: bool | None
) -> dict[str, bool]:
    """Partial update: only the keys actually passed (non-None) change.

    Upserts each row rather than assuming it exists, so a merchant whose
    backfill row is somehow missing still gets a clean write instead of a
    silent no-op.
    """
    merchant = db.get(Merchant, merchant_id)
    if not merchant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")

    changed: list[str] = []
    for code in ServiceCode:
        value = updates.get(code.value)
        if value is None:
            continue
        row = db.scalar(
            select(MerchantServiceAccess).where(
                MerchantServiceAccess.merchant_id == merchant_id,
                MerchantServiceAccess.service_code == code,
            )
        )
        if row is None:
            row = MerchantServiceAccess(merchant_id=merchant_id, service_code=code)
            db.add(row)
        if row.enabled != value:
            row.enabled = value
            changed.append(f"{code.value}={value}")

    db.commit()

    if changed:
        activity_service.log_activity(
            db, actor.user_id, "Merchant service access updated",
            activity_type="Merchant", module="Merchant Management",
            description=f"{actor.full_name} set {', '.join(changed)} for {merchant.company_name}",
            reference_id=merchant.merchant_id, merchant_id=merchant.merchant_id,
        )

    return get_access_map(db, merchant_id)


def assert_enabled(db: Session, actor: User, code: ServiceCode) -> None:
    """Raise 403 unless ``actor``'s merchant has ``code`` enabled.

    Platform staff always pass — same special-case ``assert_same_merchant``
    makes in ``app/auth/rbac.py``, for the same reason: an Admin acting on a
    merchant's behalf isn't the thing being gated.
    """
    if actor.is_platform_staff:
        return
    row = db.scalar(
        select(MerchantServiceAccess).where(
            MerchantServiceAccess.merchant_id == actor.merchant_id,
            MerchantServiceAccess.service_code == code,
        )
    )
    if row is None or not row.enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Your company does not have access to {code.value.title()}. "
                "Contact your account manager."
            ),
        )
