"""Customer sign-in sessions.

Writes to ``customer_sessions`` and nowhere else. The merchant side keeps its
sessions in ``system_logs``, which is what Admin > Active Users reads — a
customer appearing on that screen is one of the leaks this module exists to
prevent, and having no code path to that table is a stronger guarantee than
remembering to filter it.

The row is a record of a sign-in, not the credential: the JWT is the
credential, and revocation runs through ``customer_auth.force_logout_at``.
Closing a session row therefore does not by itself invalidate a token, which is
why :func:`end_session` is always called alongside
``customer_auth_service.logout``.
"""
import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerSession


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def start_session(db: Session, customer: Customer, meta: dict) -> CustomerSession:
    """Open a session row from ``activity_service.request_context`` metadata.

    ``meta`` is read-only here: that helper only inspects the request, so
    borrowing it costs nothing and keeps browser/device parsing in one place
    for the whole product.
    """
    session = CustomerSession(
        customer_id=customer.customer_id,
        ip_address=meta.get("ip_address"),
        browser=meta.get("browser"),
        device=meta.get("device"),
        # Truncated to the column width rather than left to error: a long UA
        # string is not a reason to fail a login that already succeeded.
        user_agent=(meta.get("user_agent") or "")[:400] or None,
        login_at=_now(),
        last_seen_at=_now(),
        is_active=True,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def touch(db: Session, customer: Customer) -> None:
    """Move the live session's ``last_seen_at`` forward."""
    db.execute(
        update(CustomerSession)
        .where(
            CustomerSession.customer_id == customer.customer_id,
            CustomerSession.is_active.is_(True),
        )
        .values(last_seen_at=_now())
    )
    db.commit()


def end_session(db: Session, customer_id: int) -> None:
    """Close every live session for this customer.

    All of them, not just the newest: ``customer_auth_service.logout`` revokes
    every outstanding token at once, so leaving another row marked live would
    show a session that cannot actually make a request.
    """
    db.execute(
        update(CustomerSession)
        .where(
            CustomerSession.customer_id == customer_id,
            CustomerSession.is_active.is_(True),
        )
        .values(is_active=False, logout_at=_now())
    )
    db.commit()


def active_sessions(db: Session, customer_id: int) -> list[CustomerSession]:
    """This customer's own live sessions — for a "where you're signed in" screen."""
    return list(
        db.scalars(
            select(CustomerSession)
            .where(
                CustomerSession.customer_id == customer_id,
                CustomerSession.is_active.is_(True),
            )
            .order_by(CustomerSession.login_at.desc())
        )
    )
