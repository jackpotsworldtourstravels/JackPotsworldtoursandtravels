"""The customer's own audit trail.

Writes to ``customer_audit_logs`` only. The merchant side has two log tables —
``system_logs`` (activity, read by Admin) and ``audit_logs`` (trigger-written,
read by Super Admin) — and customer activity belongs in neither.

WHY THIS NEVER RAISES
Logging is a side effect of an action, not the action. A failed insert here
must not turn a successful login into a 500, so :func:`log` swallows and
reports its own errors. The trade-off is deliberate and narrow: it applies to
this table only, and every money path on the platform still fails loudly.
"""
import logging

from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerAuditLog, CustomerAuditStatus

logger = logging.getLogger("jackpots.customer.audit")


def log(
    db: Session,
    customer: Customer | None,
    action: str,
    *,
    module: str = "Auth",
    description: str | None = None,
    meta: dict | None = None,
    status: CustomerAuditStatus = CustomerAuditStatus.SUCCESS,
    customer_code: str | None = None,
    commit: bool = True,
) -> None:
    """Record one customer action.

    ``customer`` may be None for a failed sign-in against an address that
    matches no account — the attempt is still worth recording, and
    ``customer_id`` being NULL is exactly what "we don't know who that was"
    means. Pass ``customer_code`` when the caller knows it but has no row.
    """
    meta = meta or {}

    # ``commit=False`` MAKES THIS JOIN THE CALLER'S TRANSACTION.
    #
    # The default commits, which is right for the login and booking flows this
    # was written for: they call it after their own work is durable, and an
    # audit failure must not fail the request it describes.
    #
    # It is WRONG for a caller that is mid-transaction. The payment path
    # captures money, audits, and then confirms the booking — and with the
    # default this committed the capture before the confirmation had run. A
    # failure after that point left a payment recorded as ``captured`` with its
    # booking still ``pending``: a split money-state that a rollback could not
    # undo, because the commit had already happened. The internal
    # ``except: db.rollback()`` below made it worse — an audit failure would
    # silently discard the caller's uncommitted capture.
    #
    # With ``commit=False`` this only adds the row. It does not commit, does not
    # roll back, and does not swallow: a caller that opts in owns the outcome,
    # which is the only way "capture and confirm are one transaction" can be true.
    if not commit:
        db.add(
            CustomerAuditLog(
                customer_id=customer.customer_id if customer else None,
                customer_code=customer.customer_code if customer else customer_code,
                action=action,
                module=module,
                description=description,
                ip_address=meta.get("ip_address"),
                browser=meta.get("browser"),
                device=meta.get("device"),
                status=status,
            )
        )
        return

    try:
        db.add(
            CustomerAuditLog(
                customer_id=customer.customer_id if customer else None,
                # Denormalised on purpose: the FK is ON DELETE SET NULL, so
                # this is what still names the account afterwards.
                customer_code=customer.customer_code if customer else customer_code,
                action=action,
                module=module,
                description=description,
                ip_address=meta.get("ip_address"),
                browser=meta.get("browser"),
                device=meta.get("device"),
                status=status,
            )
        )
        db.commit()
    except Exception:
        # Never let the trail break the request it is describing.
        db.rollback()
        logger.exception("Failed to write customer audit log for action %r", action)


def log_failure(
    db: Session,
    customer: Customer | None,
    action: str,
    description: str,
    *,
    module: str = "Auth",
    meta: dict | None = None,
    customer_code: str | None = None,
) -> None:
    """Shorthand for the failed-attempt case."""
    log(
        db, customer, action,
        module=module, description=description, meta=meta,
        status=CustomerAuditStatus.FAILED, customer_code=customer_code,
    )
