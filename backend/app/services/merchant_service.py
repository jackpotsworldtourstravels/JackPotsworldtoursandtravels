"""Merchant lifecycle, owned by Admin.

Implements the spec's flow::

    Admin -> Create Merchant -> Merchant Details
          -> Merchant Credentials Generated
          -> Merchant Receives Login Credentials -> Merchant Login

Creating a merchant creates its first ``merchant_admin`` login in the same
transaction, because a merchant with no way to sign in is not a usable
record. The generated password is returned exactly once, in the creation
response — it is hashed on the way into the database and cannot be read back.

New merchants start at ``pending_approval`` and cannot sign in until an
Admin approves them (enforced in ``routers/auth.py``).
"""
import re
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models_v2 import (
    CommunicationSettings,
    CompanyType,
    Merchant,
    MerchantStatus,
    Payment,
    PaymentStatus,
    RequestStatus,
    RequestType,
    ServiceRequest,
    User,
    UserRole,
)
from app.services import account_service, activity_service, notification_service

#: Statuses an Admin may set directly. ``pending_approval`` is only ever the
#: creation default — you approve out of it, you don't move back into it.
SETTABLE_STATUSES = (MerchantStatus.ACTIVE, MerchantStatus.INACTIVE, MerchantStatus.SUSPENDED)


def _slug(value: str, length: int) -> str:
    """Uppercase alphanumeric slug from a company name."""
    cleaned = re.sub(r"[^A-Za-z0-9]", "", value).upper()
    return cleaned[:length] if cleaned else "MER"


def _unique(db: Session, column, candidate: str, width: int) -> str:
    """Return ``candidate``, or ``candidate`` + N for the first free value."""
    if db.scalar(select(Merchant).where(column == candidate)) is None:
        return candidate
    for suffix in range(1, 1000):
        attempt = f"{candidate[: width - len(str(suffix))]}{suffix}"
        if db.scalar(select(Merchant).where(column == attempt)) is None:
            return attempt
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Could not allocate a unique merchant code — pick one manually",
    )


def generate_merchant_code(db: Session, company_name: str) -> str:
    return _unique(db, Merchant.merchant_code, _slug(company_name, 10) or "MER", 32)


def generate_reference_prefix(db: Session, company_name: str) -> str:
    """Short prefix stamped onto every booking reference for this merchant."""
    return _unique(db, Merchant.reference_prefix, _slug(company_name, 2) or "MR", 8)


def create_merchant(
    db: Session,
    actor: User,
    *,
    company_name: str,
    merchant_name: str,
    company_type: CompanyType,
    email: str,
    phone: str | None,
    contact_person: str,
    contact_email: str,
    country: str | None = None,
    country_code: str | None = None,
    city: str | None = None,
    address: str | None = None,
    credit_limit: float = 0,
    merchant_code: str | None = None,
    reference_prefix: str | None = None,
) -> tuple[Merchant, User, str]:
    """Create a merchant plus its first admin login.

    Returns ``(merchant, first_user, plaintext_password)``. The password is
    shown once and never recoverable afterwards.
    """
    if db.scalar(select(Merchant).where(Merchant.email == email)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A merchant with that email already exists",
        )

    merchant = Merchant(
        merchant_code=merchant_code or generate_merchant_code(db, company_name),
        merchant_name=merchant_name,
        company_name=company_name,
        company_type=company_type,
        email=email,
        phone=phone,
        reference_prefix=reference_prefix or generate_reference_prefix(db, company_name),
        country=country,
        country_code=country_code,
        city=city,
        address=address,
        credit_limit=credit_limit,
        # The spec has Admin approve a merchant before it can trade.
        status=MerchantStatus.PENDING_APPROVAL,
        created_by=actor.user_id,
    )
    db.add(merchant)
    db.flush()  # need merchant_id for the user and settings rows

    db.add(CommunicationSettings(merchant_id=merchant.merchant_id))

    first_user, temp_password = account_service.create_merchant_user(
        db,
        actor,
        merchant_id=merchant.merchant_id,
        full_name=contact_person,
        email=contact_email,
        phone=phone,
        role=UserRole.MERCHANT_ADMIN,
    )

    db.refresh(merchant)
    activity_service.log_activity(
        db, actor.user_id, "Merchant created",
        activity_type="Merchant", module="Merchant Management",
        description=f"{actor.full_name} created merchant {merchant.company_name}",
        reference_id=merchant.merchant_id, merchant_id=merchant.merchant_id,
    )
    return merchant, first_user, temp_password


def list_merchants(
    db: Session,
    page: int,
    page_size: int,
    search: str | None = None,
    merchant_status: MerchantStatus | None = None,
    company_type: CompanyType | None = None,
):
    conditions = []
    if search:
        pattern = f"%{search}%"
        conditions.append(
            or_(
                Merchant.company_name.ilike(pattern),
                Merchant.merchant_name.ilike(pattern),
                Merchant.merchant_code.ilike(pattern),
                Merchant.email.ilike(pattern),
            )
        )
    if merchant_status is not None:
        conditions.append(Merchant.status == merchant_status)
    if company_type is not None:
        conditions.append(Merchant.company_type == company_type)
    where = and_(*conditions) if conditions else True

    total = db.scalar(select(func.count()).select_from(Merchant).where(where)) or 0
    stmt = (
        select(Merchant)
        .where(where)
        .order_by(Merchant.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


def get_merchant(db: Session, merchant_id: int) -> Merchant:
    merchant = db.get(Merchant, merchant_id)
    if not merchant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Merchant not found")
    return merchant


def update_merchant(db: Session, actor: User, merchant_id: int, **fields) -> Merchant:
    merchant = get_merchant(db, merchant_id)

    # `merchants.email` carries `UniqueConstraint("email", name="uq_merchants_email")`,
    # so an address already on another company would come back from the loop
    # below as an IntegrityError at commit — a 500 with a database message in it.
    # Checked here instead, which produces the same 400 and the same wording
    # `create_merchant` gives for the same collision.
    #
    # `!= merchant_id` matters: re-saving the form without touching the email
    # sends the merchant its own current address, and that must not be rejected.
    new_email = fields.get("email")
    if new_email is not None and new_email != merchant.email:
        clash = db.scalar(select(Merchant).where(Merchant.email == new_email))
        if clash and clash.merchant_id != merchant_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A merchant with that email already exists",
            )

    for key, value in fields.items():
        if value is not None and hasattr(merchant, key):
            setattr(merchant, key, value)
    db.commit()
    db.refresh(merchant)
    activity_service.log_activity(
        db, actor.user_id, "Merchant updated",
        activity_type="Merchant", module="Merchant Management",
        description=f"{actor.full_name} updated merchant {merchant.company_name}",
        reference_id=merchant.merchant_id, merchant_id=merchant.merchant_id,
    )
    return merchant


def approve_merchant(db: Session, actor: User, merchant_id: int) -> Merchant:
    merchant = get_merchant(db, merchant_id)
    if merchant.status is not MerchantStatus.PENDING_APPROVAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Merchant is already {merchant.status.value}",
        )
    merchant.status = MerchantStatus.ACTIVE
    db.commit()
    db.refresh(merchant)

    activity_service.log_activity(
        db, actor.user_id, "Merchant approved",
        activity_type="Merchant", module="Merchant Management",
        description=f"{actor.full_name} approved merchant {merchant.company_name}",
        reference_id=merchant.merchant_id, merchant_id=merchant.merchant_id,
    )
    for user in merchant.users:
        notification_service.create_notification(
            db, user.user_id, "Your company account has been approved",
            "You can now sign in to the JackPots merchant portal and start raising requests.",
        )
    return merchant


def set_merchant_status(
    db: Session, actor: User, merchant_id: int, new_status: MerchantStatus
) -> Merchant:
    if new_status not in SETTABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot set a merchant to {new_status.value}",
        )
    merchant = get_merchant(db, merchant_id)
    merchant.status = new_status
    db.commit()
    db.refresh(merchant)

    if new_status is not MerchantStatus.ACTIVE:
        # Suspension must take effect immediately, not at next login.
        from app.services import session_service
        from app.services.auth_service import logout as revoke_tokens

        for user in merchant.users:
            session_service.force_logout_all(db, user.user_id)
            revoke_tokens(db, user)

    activity_service.log_activity(
        db, actor.user_id, f"Merchant {new_status.value}",
        activity_type="Merchant", module="Merchant Management",
        description=f"{actor.full_name} set {merchant.company_name} to {new_status.value}",
        reference_id=merchant.merchant_id, merchant_id=merchant.merchant_id,
    )
    for user in merchant.users:
        notification_service.create_notification(
            db, user.user_id, f"Your company account is now {new_status.value}",
            "Contact your account manager if you believe this is an error.",
        )
    return merchant


def next_booking_reference(db: Session, merchant: Merchant) -> str:
    """Allocate the merchant's next booking reference.

    Replaces the legacy ``booking_reference_counters`` table and the
    ``sp_generate_booking_reference`` procedure. Locks the merchant row so
    two concurrent requests cannot take the same number.
    """
    locked = db.execute(
        select(Merchant).where(Merchant.merchant_id == merchant.merchant_id).with_for_update()
    ).scalar_one()
    locked.booking_sequence += 1
    db.flush()
    return f"{locked.reference_prefix}{locked.booking_sequence:06d}"


def global_reports_summary(db: Session) -> list[dict]:
    """Per-merchant rollup for the Super Admin's Global Reports & Analytics
    screen: request volume, completion, revenue, and headcount.

    Three grouped queries rather than one join, so a merchant with zero
    requests or zero payments still gets a row (an inner join across all
    three would silently drop it).
    """
    request_counts = dict(
        db.execute(
            select(ServiceRequest.merchant_id, func.count())
            .where(ServiceRequest.request_type != RequestType.CATALOG_ITEM)
            .group_by(ServiceRequest.merchant_id)
        ).all()
    )
    completed_counts = dict(
        db.execute(
            select(ServiceRequest.merchant_id, func.count())
            .where(
                ServiceRequest.request_type != RequestType.CATALOG_ITEM,
                ServiceRequest.status == RequestStatus.COMPLETED,
            )
            .group_by(ServiceRequest.merchant_id)
        ).all()
    )
    revenue = dict(
        db.execute(
            select(Payment.merchant_id, func.coalesce(func.sum(Payment.amount), 0))
            .where(Payment.payment_status == PaymentStatus.SUCCESS)
            .group_by(Payment.merchant_id)
        ).all()
    )
    user_counts = dict(
        db.execute(
            select(User.merchant_id, func.count())
            .where(User.merchant_id.isnot(None))
            .group_by(User.merchant_id)
        ).all()
    )

    merchants = db.scalars(select(Merchant).order_by(Merchant.company_name)).all()
    rows = [
        {
            "merchant_id": m.merchant_id,
            "merchant_code": m.merchant_code,
            "company_name": m.company_name,
            "status": m.status.value,
            "total_requests": request_counts.get(m.merchant_id, 0),
            "completed_requests": completed_counts.get(m.merchant_id, 0),
            "total_revenue": revenue.get(m.merchant_id, Decimal("0")),
            "user_count": user_counts.get(m.merchant_id, 0),
        }
        for m in merchants
    ]

    # M6: the totals come back with the rows. They used to be summed in the
    # browser with ``Number()`` — the last surviving client-side money sum after
    # M4 removed ten of them — which floats the value and drops the paise. The
    # arithmetic is the same arithmetic; doing it here is what makes the figure
    # a query result rather than a rendering artefact.
    totals = {
        "merchants": len(rows),
        "total_requests": sum(r["total_requests"] for r in rows),
        "completed_requests": sum(r["completed_requests"] for r in rows),
        "total_revenue": sum((r["total_revenue"] for r in rows), Decimal("0")),
        "user_count": sum(r["user_count"] for r in rows),
    }
    return rows, totals
