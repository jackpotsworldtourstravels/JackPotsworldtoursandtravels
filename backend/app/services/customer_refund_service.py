"""Giving customers their money back -- the refund lifecycle for B2C cancellations.

Design: docs/D1_REFUND_INVESTIGATION.md and docs/REFUND_ARCHITECTURE_CORRECTIONS.md.
Rows: ``customer_refund_attempts`` (migration 0094).

WHAT THIS MODULE GUARANTEES, AND HOW

1. NEVER MORE BACK THAN CAME IN. The amount still refundable on a payment is its
   CAPTURED amount minus every ``succeeded`` and ``processing`` attempt against
   that payment, across ALL cancellations. ``processing`` counts because its
   money may already be in transit; ``failed`` and ``pending`` do not. The
   payment row is locked ``FOR UPDATE`` while that figure is read and an attempt
   is committed, so two admins cannot both see the same "remaining".

2. NEVER TWICE FOR ONE REQUEST. Each attempt has a persisted idempotency key
   (``rfnd-<cancellation>-<payment row>-<attempt no>``) that is sent to the
   provider (Razorpay ``receipt``, HDFC ``unique_request_id``) and is unique in
   the database. A repeated request while an attempt is open returns THAT
   attempt. A retry after a CLEAN failure is a new attempt with a new key.

3. NEVER GUESS AFTER AN UNCERTAIN ANSWER. A timeout, a dropped connection, a 5xx
   or an unreadable reply means the provider may have refunded. Such an attempt
   stays ``processing`` (so it still counts and blocks a retry) until
   reconciliation finds it at the provider -- by refund id, or by the
   idempotency key -- or an operator with ``refund.reconcile`` confirms it never
   left. Only a 4xx REFUSAL (``PaymentProviderError.definitive``) is a clean
   failure.

4. NEVER "REFUNDED" ON A MESSAGE. A webhook is a claim. The refund is accepted as
   ``succeeded`` only when the provider's authenticated API, asked about that
   refund, says so (``fetch_refund``). A webhook that cannot be matched to
   exactly one attempt is left ``deferred`` for a human.

5. NEVER A GATEWAY REFUND THAT DIDN'T HAPPEN. TrustBrick has no refund API. Its
   attempts are ``manual_required`` and become ``succeeded`` only through
   ``record_manual_refund``: an explicit ``admin_override``, an operator, a
   reference, a reason, and the same cumulative-balance check.

6. NOBODY APPROVES THEIR OWN REFUND. Above ``refund_approval_threshold_minor``
   (default: every refund) the person who initiated an attempt cannot be the
   person who authorises it, and the authoriser must hold ``refund.authorize``
   -- a code no role carries; it is granted per user.

The service commits. Provider calls happen with NO database lock held: the
attempt is committed as ``processing`` first, so a crash mid-call leaves a row
reconciliation can resolve, never a refund nobody recorded.
"""
from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal
from typing import Any, Callable, Sequence

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models_customer import (
    Customer,
    CustomerBookingPayment,
    CustomerCancellationRequest,
    CustomerHotelBookingPayment,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
    CustomerRefundAttempt,
)
from app.services import customer_booking_admin_service as booking_service
from app.services import payments as payment_providers
from app.services.payments.base import (
    FAILED as P_FAILED,
    PROCESSING as P_PROCESSING,
    REFUNDED as P_REFUNDED,
    PaymentMisconfigured,
    PaymentNotConfigured,
    PaymentProviderError,
    ProviderRefund,
    from_minor,
    to_minor,
)

logger = logging.getLogger(__name__)

# --- attempt statuses -------------------------------------------------------
PENDING = "pending"                  # awaiting a second approver; nothing sent
PROCESSING = "processing"            # asked of the provider (or may have been)
SUCCEEDED = "succeeded"              # the provider's API (or an audited manual record) says so
FAILED = "failed"                    # cleanly refused; no money moved
MANUAL_REQUIRED = "manual_required"  # no gateway can do this one; an operator must

#: Statuses whose money has left, or may be leaving.
COMMITTED = (SUCCEEDED, PROCESSING)
#: An attempt that is still open: a repeat request resolves to it.
OPEN = (PENDING, PROCESSING, MANUAL_REQUIRED)

#: Providers with no refund API. Their payments are refunded by an operator and
#: RECORDED here; no gateway call is ever made for them.
MANUAL_ONLY_PROVIDERS = frozenset({"trustbrick"})

#: payment table name -> model, and each model's primary-key attribute.
_PAYMENT_MODELS = {
    CustomerBookingPayment.__tablename__: (CustomerBookingPayment, "customer_booking_payment_id"),
    CustomerHotelBookingPayment.__tablename__: (CustomerHotelBookingPayment, "customer_hotel_booking_payment_id"),
    CustomerPackageBookingPayment.__tablename__: (CustomerPackageBookingPayment, "customer_package_booking_payment_id"),
}


class RefundError(Exception):
    """A refused refund action. ``code`` is stable and safe to branch on;
    ``http_status`` is what the router answers; ``str(exc)`` is for staff."""

    def __init__(self, code: str, message: str, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------------------
# Resolving the payment a cancellation refunds
# ---------------------------------------------------------------------------
class _PaymentContext:
    __slots__ = ("product", "booking", "row", "table", "row_id", "provider", "currency", "captured_minor")

    def __init__(self, product, booking, row) -> None:
        model, pk_attr = _PAYMENT_MODELS[type(row).__tablename__]
        self.product, self.booking, self.row = product, booking, row
        self.table = type(row).__tablename__
        self.row_id = int(getattr(row, pk_attr))
        self.provider = (row.provider or "").strip().lower()
        self.currency = (row.currency or "INR").upper()
        self.captured_minor = to_minor(Decimal(str(row.amount)), self.currency)


def _payment_pk_attr(row) -> str:
    return _PAYMENT_MODELS[type(row).__tablename__][1]


def _resolve_payment(
    db: Session, cancellation: CustomerCancellationRequest, *, include_refunded: bool = False,
) -> _PaymentContext:
    """The ONE captured payment this cancellation's money went in through.

    ``include_refunded`` is for DISPLAY only: a fully refunded payment is no
    longer ``captured`` but the admin screen still has to show its figures."""
    product, booking, payments = booking_service.booking_payment_rows(db, cancellation.booking_ref)
    if booking is None:
        raise RefundError("not_found", "The booking for this cancellation no longer exists.", 404)
    wanted = {CustomerPaymentStatus.CAPTURED.value}
    if include_refunded:
        wanted.add(CustomerPaymentStatus.REFUNDED.value)
    captured = [p for p in payments if str(getattr(p.status, "value", p.status)) in wanted]
    if not captured:
        refunded = [p for p in payments if str(getattr(p.status, "value", p.status)) == CustomerPaymentStatus.REFUNDED.value]
        if refunded:
            raise RefundError("fully_refunded", "This booking's payment is already fully refunded.", 409)
        raise RefundError(
            "no_captured_payment",
            "No captured payment exists for this booking, so there is nothing to refund through a "
            "provider. (Demo and unpaid bookings have no money to return.)", 409,
        )
    if len(captured) > 1:
        raise RefundError(
            "ambiguous_payment",
            "More than one captured payment exists for this booking. Refunding is blocked until an "
            "engineer decides which one the customer is owed.", 409,
        )
    ctx = _PaymentContext(product, booking, captured[0])
    if not ctx.provider:
        raise RefundError(
            "no_provider",
            "This payment was not collected through a payment provider, so it cannot be refunded here.", 409,
        )
    return ctx


def _lock_payment(db: Session, ctx: _PaymentContext):
    """Serialise every refund decision against this payment (SELECT ... FOR UPDATE).

    Re-reads the row under the lock. The captured amount is taken from the
    LOCKED row, never from a value read before the lock was held."""
    model, pk_attr = _PAYMENT_MODELS[ctx.table]
    row = db.execute(
        select(model).where(getattr(model, pk_attr) == ctx.row_id).with_for_update()
    ).scalar_one()
    ctx.row = row
    ctx.captured_minor = to_minor(Decimal(str(row.amount)), ctx.currency)
    return row


def _sum_minor(db: Session, ctx: _PaymentContext, statuses: Sequence[str], *, exclude_id: int | None = None) -> int:
    q = select(func.coalesce(func.sum(CustomerRefundAttempt.amount_minor), 0)).where(
        CustomerRefundAttempt.payment_table == ctx.table,
        CustomerRefundAttempt.payment_row_id == ctx.row_id,
        CustomerRefundAttempt.status.in_(tuple(statuses)),
    )
    if exclude_id is not None:
        q = q.where(CustomerRefundAttempt.refund_attempt_id != exclude_id)
    return int(db.execute(q).scalar() or 0)


def remaining_refundable_minor(db: Session, ctx: _PaymentContext, *, exclude_id: int | None = None) -> int:
    """Captured minus everything that has left or may be leaving the account.

    Negative is possible only if rows were edited by hand; callers treat <= 0 as
    "nothing left" and refuse."""
    return ctx.captured_minor - _sum_minor(db, ctx, COMMITTED, exclude_id=exclude_id)


def _cancellation_target_minor(db: Session, c: CustomerCancellationRequest, ctx: _PaymentContext) -> int:
    """What the desk intends to refund for THIS cancellation. Defaults to the
    booking's own total, as the old start_refund did, and persists it."""
    if c.refund_amount is None:
        total = getattr(ctx.booking, "total_amount", None)
        if total is None:
            raise RefundError("invalid_amount", "No refund amount is set and the booking has no total.", 400)
        c.refund_amount = total
    return to_minor(Decimal(str(c.refund_amount)), ctx.currency)


def _cancellation_committed_minor(db: Session, cancellation_ref: str, statuses: Sequence[str] = COMMITTED) -> int:
    return int(db.execute(
        select(func.coalesce(func.sum(CustomerRefundAttempt.amount_minor), 0)).where(
            CustomerRefundAttempt.cancellation_ref == cancellation_ref,
            CustomerRefundAttempt.status.in_(tuple(statuses)),
        )
    ).scalar() or 0)


def approval_required(amount_minor: int) -> bool:
    """Maker-checker applies at or above the configured threshold (0 = always)."""
    return amount_minor >= int(settings.refund_approval_threshold_minor)


def _lock_cancellation(db: Session, cancellation_ref: str) -> CustomerCancellationRequest:
    c = db.execute(
        select(CustomerCancellationRequest)
        .where(CustomerCancellationRequest.cancellation_ref == cancellation_ref)
        .with_for_update()
    ).scalars().first()
    if c is None:
        raise RefundError("not_found", "No such cancellation request.", 404)
    return c


def _has(actor: Any, code: str) -> bool:
    from app.auth.rbac import has_permission

    return has_permission(actor, code)


def _require(actor: Any, code: str) -> None:
    if not _has(actor, code):
        raise RefundError("forbidden", f"Missing required permission: {code}", 403)


# ---------------------------------------------------------------------------
# Initiating
# ---------------------------------------------------------------------------
def _next_attempt_number(db: Session, cancellation_ref: str) -> int:
    return int(db.execute(
        select(func.coalesce(func.max(CustomerRefundAttempt.attempt_number), 0))
        .where(CustomerRefundAttempt.cancellation_ref == cancellation_ref)
    ).scalar() or 0) + 1


def initiate_refund(
    db: Session, cancellation_ref: str, actor: Any, *,
    amount_minor: int | None = None, target_minor: int | None = None,
) -> tuple[CustomerRefundAttempt, str]:
    """The maker's step. Returns ``(attempt, outcome)``.

    ``outcome``: ``"existing"`` (an open attempt already covered this request --
    nothing new was created), ``"awaiting_approval"``, ``"manual_required"``, or
    whatever :func:`dispatch_attempt` returned (``"succeeded"``, ``"processing"``,
    ``"failed"``, ``"uncertain"``).
    """
    _require(actor, "refund.execute")
    try:
        c = _lock_cancellation(db, cancellation_ref)
        if c.status not in ("approved", "refund_processing"):
            raise RefundError("wrong_state", f"A refund cannot start from status {c.status!r}.", 409)

        open_attempt = db.execute(
            select(CustomerRefundAttempt).where(
                CustomerRefundAttempt.cancellation_ref == cancellation_ref,
                CustomerRefundAttempt.status.in_(OPEN),
            ).order_by(CustomerRefundAttempt.attempt_number.desc())
        ).scalars().first()
        if open_attempt is not None:
            # IDEMPOTENT: a double-click, a retried request or a second admin
            # lands on the attempt that is already in flight.
            db.rollback()
            return open_attempt, "existing"

        ctx = _resolve_payment(db, c)
        if target_minor is not None:
            # The desk fixes how much THIS cancellation refunds, once, before any
            # money has gone. After that the figure is locked: changing what a
            # cancellation owes mid-refund is how totals stop adding up.
            if target_minor <= 0:
                raise RefundError("invalid_amount", "The refund amount must be positive.", 400)
            if _cancellation_committed_minor(db, cancellation_ref) > 0:
                raise RefundError(
                    "target_locked", "Money has already been refunded or is in progress, so the refund "
                    "amount can no longer be changed.", 409,
                )
            c.refund_amount = from_minor(target_minor, ctx.currency)
        target = _cancellation_target_minor(db, c, ctx)
        _lock_payment(db, ctx)
        remaining_for_cancellation = target - _cancellation_committed_minor(db, cancellation_ref)
        if remaining_for_cancellation <= 0:
            raise RefundError("fully_refunded", "This cancellation's refund amount has already been refunded.", 409)

        amount = remaining_for_cancellation if amount_minor is None else int(amount_minor)
        if amount <= 0:
            raise RefundError("invalid_amount", "A refund must be for a positive amount.", 400)
        if amount > remaining_for_cancellation:
            raise RefundError(
                "exceeds_cancellation",
                f"Requested {from_minor(amount, ctx.currency)} but only "
                f"{from_minor(remaining_for_cancellation, ctx.currency)} of this cancellation's refund is left.", 409,
            )
        _check_against_payment(db, ctx, amount)

        number = _next_attempt_number(db, cancellation_ref)
        attempt = CustomerRefundAttempt(
            cancellation_ref=cancellation_ref,
            attempt_number=number,
            payment_table=ctx.table,
            payment_row_id=ctx.row_id,
            provider=ctx.provider,
            idempotency_key=f"rfnd-{cancellation_ref}-{ctx.row_id}-{number}"[:80],
            amount_minor=amount,
            currency=ctx.currency,
            status=PENDING,
            approval_required=approval_required(amount),
            initiated_by_user_id=getattr(actor, "user_id", None),
        )
        if ctx.provider in MANUAL_ONLY_PROVIDERS:
            attempt.status = MANUAL_REQUIRED
            attempt.is_manual = True
            attempt.provider_status = "manual_required"
        db.add(attempt)
        if c.status == "approved":
            c.status = "refund_processing"
        db.commit()
    except RefundError:
        db.rollback()
        raise
    except IntegrityError:
        # The one-in-flight index (or the idempotency key) caught a concurrent
        # initiate that got in first. Resolve to the winner.
        db.rollback()
        winner = db.execute(
            select(CustomerRefundAttempt).where(
                CustomerRefundAttempt.cancellation_ref == cancellation_ref,
                CustomerRefundAttempt.status.in_(OPEN),
            )
        ).scalars().first()
        if winner is None:
            raise RefundError("conflict", "A concurrent refund request changed this cancellation; try again.", 409)
        return winner, "existing"

    if attempt.status == MANUAL_REQUIRED:
        return attempt, "manual_required"
    if attempt.approval_required:
        return attempt, "awaiting_approval"
    return attempt, dispatch_attempt(db, attempt.refund_attempt_id, actor)


def _check_against_payment(db: Session, ctx: _PaymentContext, amount: int, *, exclude_id: int | None = None) -> None:
    remaining = remaining_refundable_minor(db, ctx, exclude_id=exclude_id)
    if remaining <= 0:
        raise RefundError(
            "fully_refunded",
            "This payment is fully refunded, or processing refunds already cover all of it.", 409,
        )
    if amount > remaining:
        committed = ctx.captured_minor - remaining
        raise RefundError(
            "exceeds_remaining",
            f"Requested {from_minor(amount, ctx.currency)} but only {from_minor(remaining, ctx.currency)} "
            f"remains on this payment (captured {from_minor(ctx.captured_minor, ctx.currency)}, "
            f"already refunded or in progress {from_minor(committed, ctx.currency)}).", 409,
        )


# ---------------------------------------------------------------------------
# Approving (the checker) and sending
# ---------------------------------------------------------------------------
def authorize_refund(
    db: Session, attempt_id: int, actor: Any, *, cancellation_ref: str | None = None,
) -> tuple[CustomerRefundAttempt, str]:
    """The checker's step: a DIFFERENT person with ``refund.authorize`` releases a
    ``pending`` attempt to the provider."""
    _require(actor, "refund.authorize")
    attempt = db.execute(
        select(CustomerRefundAttempt).where(CustomerRefundAttempt.refund_attempt_id == attempt_id).with_for_update()
    ).scalars().first()
    if attempt is None or (cancellation_ref and attempt.cancellation_ref != cancellation_ref):
        db.rollback()
        raise RefundError("not_found", "No such refund attempt for this cancellation.", 404)
    if attempt.status != PENDING:
        db.rollback()
        if attempt.status in (PROCESSING, SUCCEEDED):
            return attempt, "existing"           # already released: harmless repeat
        raise RefundError("wrong_state", f"An attempt in status {attempt.status!r} cannot be authorised.", 409)
    if attempt.initiated_by_user_id is not None and attempt.initiated_by_user_id == getattr(actor, "user_id", None):
        db.rollback()
        raise RefundError(
            "self_approval", "You initiated this refund, so a different authoriser must approve it.", 403,
        )
    attempt.approved_by_user_id = getattr(actor, "user_id", None)
    attempt.approved_at = _now()
    db.commit()
    return attempt, dispatch_attempt(db, attempt_id, actor)


def dispatch_attempt(db: Session, attempt_id: int, actor: Any = None) -> str:
    """Send a ``pending`` attempt to its provider. Returns the outcome word.

    Phase 1 (locked): re-check the balance and COMMIT the attempt as
    ``processing`` so it counts. Phase 2 (no lock): the provider call. Phase 3:
    record exactly what came back.
    """
    attempt = db.execute(
        select(CustomerRefundAttempt).where(CustomerRefundAttempt.refund_attempt_id == attempt_id)
    ).scalars().first()
    if attempt is None or attempt.status != PENDING:
        return attempt.status if attempt is not None else "missing"
    cancellation = db.execute(
        select(CustomerCancellationRequest).where(CustomerCancellationRequest.cancellation_ref == attempt.cancellation_ref)
    ).scalars().first()
    try:
        ctx = _resolve_payment(db, cancellation)
        _lock_payment(db, ctx)
        _check_against_payment(db, ctx, attempt.amount_minor, exclude_id=attempt.refund_attempt_id)
    except RefundError as exc:
        # The balance moved while the attempt waited for approval. Fail it
        # cleanly -- nothing was sent.
        db.rollback()
        attempt = db.get(CustomerRefundAttempt, attempt_id)
        attempt.status = FAILED
        attempt.failure_reason = f"Not sent: {exc}"[:2000]
        attempt.completed_at = _now()
        db.commit()
        return FAILED

    attempt = db.get(CustomerRefundAttempt, attempt_id)
    attempt.status = PROCESSING
    attempt.provider_status = "submitting"
    if attempt.approved_by_user_id is None and not attempt.approval_required:
        attempt.approved_by_user_id = attempt.initiated_by_user_id
        attempt.approved_at = _now()
    db.commit()                                   # releases the payment lock; the row now counts

    provider_payment_id = ctx.row.provider_payment_id or ctx.row.provider_order_id
    try:
        if not provider_payment_id:
            raise PaymentMisconfigured("The payment row carries no provider payment id to refund.")
        provider = payment_providers.get_provider_named(attempt.provider)
        refund = provider.refund(
            provider_payment_id=provider_payment_id,
            amount_minor=attempt.amount_minor,
            idempotency_key=attempt.idempotency_key,
            notes={"cancellation_ref": attempt.cancellation_ref, "booking_ref": cancellation.booking_ref},
        )
    except PaymentProviderError as exc:
        return _record_provider_exception(db, attempt_id, exc)
    except Exception as exc:                      # noqa: BLE001 -- unknown means uncertain
        logger.exception("Refund attempt %s: unexpected provider error", attempt_id)
        return _record_uncertain(db, attempt_id, f"{type(exc).__name__}: {exc}")

    return apply_provider_refund(db, attempt_id, refund)


def _record_provider_exception(db: Session, attempt_id: int, exc: PaymentProviderError) -> str:
    attempt = db.get(CustomerRefundAttempt, attempt_id)
    if getattr(exc, "code", "") == "refund_unsupported":
        attempt.status = MANUAL_REQUIRED
        attempt.is_manual = True
        attempt.provider_status = "manual_required"
        attempt.failure_reason = "This provider has no refund API; refund it manually and record it."
        db.commit()
        return MANUAL_REQUIRED
    clean = getattr(exc, "definitive", False) or isinstance(exc, (PaymentMisconfigured, PaymentNotConfigured))
    if clean:
        attempt.status = FAILED
        attempt.provider_status = getattr(exc, "code", "failed")
        attempt.failure_reason = str(exc)[:2000]
        attempt.completed_at = _now()
        db.commit()
        return FAILED
    return _record_uncertain(db, attempt_id, str(exc))


def _record_uncertain(db: Session, attempt_id: int, detail: str) -> str:
    """The provider may or may not have refunded. The attempt stays ``processing``
    -- it keeps counting against the payment and blocks a retry -- until
    reconciliation or an operator resolves it."""
    attempt = db.get(CustomerRefundAttempt, attempt_id)
    attempt.status = PROCESSING
    attempt.provider_status = "uncertain"
    attempt.failure_reason = f"Outcome unknown: {detail}"[:2000]
    db.commit()
    logger.warning("Refund attempt %s outcome unknown; left processing for reconciliation: %s", attempt_id, detail)
    return "uncertain"


# ---------------------------------------------------------------------------
# Applying what the provider says (the ONLY place an attempt becomes succeeded)
# ---------------------------------------------------------------------------
def apply_provider_refund(db: Session, attempt_id: int, refund: ProviderRefund) -> str:
    """Record a provider-reported refund on its attempt. Callers pass a refund
    obtained from the provider's authenticated API -- never a webhook body."""
    attempt = db.execute(
        select(CustomerRefundAttempt).where(CustomerRefundAttempt.refund_attempt_id == attempt_id).with_for_update()
    ).scalars().first()
    if attempt is None:
        return "missing"
    if attempt.status == SUCCEEDED:
        db.rollback()
        return SUCCEEDED                           # duplicate delivery / repeat sweep: harmless
    if attempt.status in (FAILED,):
        # A late "processed" for an attempt we closed as failed would mean money
        # moved that we think did not. Do NOT silently flip it: surface it.
        if refund.status == P_REFUNDED:
            attempt.failure_reason = (
                (attempt.failure_reason or "") + " | WARNING: provider later reports this refund as processed; "
                "needs manual review."
            )[:2000]
            db.commit()
            logger.error("Refund attempt %s was failed locally but provider reports it processed", attempt_id)
        else:
            db.rollback()
        return FAILED

    if refund.provider_refund_id and not attempt.provider_refund_id:
        attempt.provider_refund_id = refund.provider_refund_id[:120]
    attempt.provider_status = (refund.provider_status or "")[:60] or attempt.provider_status
    attempt.raw_response = _clip(dict(refund.raw))

    if refund.amount_minor and refund.amount_minor != attempt.amount_minor:
        # The provider refunded a different figure from the one we asked for.
        # Keep the LARGER one counted so the balance can never be overstated,
        # and leave the attempt for a human instead of calling it done.
        attempt.amount_minor = max(attempt.amount_minor, int(refund.amount_minor))
        attempt.status = PROCESSING
        attempt.failure_reason = (
            f"Provider reports a refund of {refund.amount_minor} minor units but {attempt.amount_minor} "
            "was requested; needs manual review."
        )
        db.commit()
        return "uncertain"

    if refund.status == P_REFUNDED:
        attempt.status = SUCCEEDED
        attempt.completed_at = _now()
        attempt.failure_reason = None
        _finalise_success(db, attempt)
        db.commit()
        return SUCCEEDED
    if refund.status == P_FAILED:
        attempt.status = FAILED
        attempt.completed_at = _now()
        attempt.failure_reason = (refund.failure_reason or f"Provider reports the refund as {refund.provider_status}.")[:2000]
        db.commit()
        return FAILED
    attempt.status = PROCESSING
    attempt.failure_reason = None
    db.commit()
    return PROCESSING


def _clip(raw: dict) -> dict:
    """Keep the provider body for the audit trail, bounded."""
    try:
        import json

        text = json.dumps(raw, default=str)
        return raw if len(text) < 20000 else {"truncated": True}
    except (TypeError, ValueError):
        return {"unserialisable": True}


def _finalise_success(db: Session, attempt: CustomerRefundAttempt) -> None:
    """After an attempt succeeded: finish the cancellation if its refund is
    complete, and close the payment row if the whole payment has gone back."""
    db.flush()
    c = db.execute(
        select(CustomerCancellationRequest)
        .where(CustomerCancellationRequest.cancellation_ref == attempt.cancellation_ref).with_for_update()
    ).scalars().first()
    model, pk_attr = _PAYMENT_MODELS[attempt.payment_table]
    pay = db.execute(
        select(model).where(getattr(model, pk_attr) == attempt.payment_row_id).with_for_update()
    ).scalar_one()
    currency = (pay.currency or "INR").upper()
    if c is not None and c.refund_amount is not None:
        target = to_minor(Decimal(str(c.refund_amount)), currency)
        done = _cancellation_committed_minor(db, c.cancellation_ref, (SUCCEEDED,))
        if done >= target and c.status == "refund_processing":
            c.status = "refunded"
    captured = to_minor(Decimal(str(pay.amount)), currency)
    paid_back = int(db.execute(
        select(func.coalesce(func.sum(CustomerRefundAttempt.amount_minor), 0)).where(
            CustomerRefundAttempt.payment_table == attempt.payment_table,
            CustomerRefundAttempt.payment_row_id == attempt.payment_row_id,
            CustomerRefundAttempt.status == SUCCEEDED,
        )
    ).scalar() or 0)
    if paid_back >= captured:
        pay.status = CustomerPaymentStatus.REFUNDED.value


# ---------------------------------------------------------------------------
# TrustBrick / manual
# ---------------------------------------------------------------------------
def record_manual_refund(
    db: Session, cancellation_ref: str, actor: Any, *, amount_minor: int | None,
    reference: str, reason: str, admin_override: bool,
) -> CustomerRefundAttempt:
    """Record that an operator returned the money OUTSIDE any gateway.

    This is the only way a ``manual_required`` attempt becomes ``succeeded``.
    It does not call a provider and is never confused with a gateway refund: the
    row is flagged ``is_manual`` / ``admin_override`` and carries the operator,
    the reference they quote and their reason.
    """
    if admin_override is not True:
        raise RefundError(
            "override_required",
            "Recording a manual refund needs admin_override: true. No gateway refund is made for this "
            "provider; this only records money you have already returned.", 400,
        )
    reference = (reference or "").strip()
    reason = (reason or "").strip()
    if not reference or not reason:
        raise RefundError("details_required", "A manual refund needs the bank/UTR reference and a reason.", 400)

    try:
        c = _lock_cancellation(db, cancellation_ref)
        attempt = db.execute(
            select(CustomerRefundAttempt).where(
                CustomerRefundAttempt.cancellation_ref == cancellation_ref,
                CustomerRefundAttempt.status == MANUAL_REQUIRED,
            ).with_for_update()
        ).scalars().first()
        if attempt is None:
            raise RefundError("wrong_state", "There is no manual refund waiting to be recorded for this cancellation.", 409)
        if attempt.approval_required:
            _require(actor, "refund.authorize")
            if attempt.initiated_by_user_id is not None and attempt.initiated_by_user_id == getattr(actor, "user_id", None):
                raise RefundError(
                    "self_approval", "You initiated this refund, so a different authoriser must record it.", 403,
                )
        else:
            _require(actor, "refund.execute")

        ctx = _resolve_payment(db, c)
        _lock_payment(db, ctx)
        target = _cancellation_target_minor(db, c, ctx)
        amount = attempt.amount_minor if amount_minor is None else int(amount_minor)
        if amount <= 0:
            raise RefundError("invalid_amount", "A refund must be for a positive amount.", 400)
        already = _cancellation_committed_minor(db, cancellation_ref)
        if amount > target - already:
            raise RefundError(
                "exceeds_cancellation",
                f"Recorded {from_minor(amount, ctx.currency)} exceeds the {from_minor(max(target - already, 0), ctx.currency)} "
                "left on this cancellation.", 409,
            )
        _check_against_payment(db, ctx, amount, exclude_id=attempt.refund_attempt_id)

        attempt.amount_minor = amount
        attempt.status = SUCCEEDED
        attempt.is_manual = True
        attempt.admin_override = True
        attempt.manual_reference = reference[:120]
        attempt.manual_reason = reason
        attempt.provider_status = "manual_recorded"
        attempt.failure_reason = None
        attempt.approved_by_user_id = getattr(actor, "user_id", None)
        attempt.approved_at = _now()
        attempt.completed_by_user_id = getattr(actor, "user_id", None)
        attempt.completed_at = _now()
        db.flush()
        _finalise_success(db, attempt)
        db.commit()
    except RefundError:
        db.rollback()
        raise
    return attempt


# ---------------------------------------------------------------------------
# Operator resolution of an uncertain attempt
# ---------------------------------------------------------------------------
def resolve_uncertain_as_failed(
    db: Session, attempt_id: int, actor: Any, reason: str, *, cancellation_ref: str | None = None,
) -> CustomerRefundAttempt:
    """An operator confirms, at the provider's dashboard, that an uncertain
    attempt never produced a refund. Only then may it stop counting and a retry
    be made. Needs ``refund.reconcile`` and a written reason."""
    _require(actor, "refund.reconcile")
    reason = (reason or "").strip()
    if not reason:
        raise RefundError("details_required", "State what you checked at the provider.", 400)
    attempt = db.execute(
        select(CustomerRefundAttempt).where(CustomerRefundAttempt.refund_attempt_id == attempt_id).with_for_update()
    ).scalars().first()
    if attempt is None or (cancellation_ref and attempt.cancellation_ref != cancellation_ref):
        db.rollback()
        raise RefundError("not_found", "No such refund attempt for this cancellation.", 404)
    if attempt.status != PROCESSING or attempt.provider_refund_id:
        db.rollback()
        raise RefundError(
            "wrong_state",
            "Only a processing attempt the provider never acknowledged can be closed this way.", 409,
        )
    attempt.status = FAILED
    attempt.provider_status = "operator_resolved"
    attempt.failure_reason = f"Confirmed not executed by operator: {reason}"[:2000]
    attempt.completed_by_user_id = getattr(actor, "user_id", None)
    attempt.completed_at = _now()
    db.commit()
    return attempt


# ---------------------------------------------------------------------------
# Webhooks: correlate, then VERIFY with the provider
# ---------------------------------------------------------------------------
def correlate_refund_report(
    db: Session, *, provider: str, payment_row, report: ProviderRefund,
) -> CustomerRefundAttempt | None:
    """The one attempt this report is about, or ``None`` when that is not certain.

    Strongest evidence first: the provider's refund id. Then, among attempts
    still ``processing`` on THIS payment, the amount; then the lone candidate.
    Two candidates that cannot be told apart return ``None`` -- the caller
    defers the event rather than advancing the wrong cancellation."""
    table = type(payment_row).__tablename__
    row_id = int(getattr(payment_row, _payment_pk_attr(payment_row)))
    base = select(CustomerRefundAttempt).where(
        CustomerRefundAttempt.provider == provider,
        CustomerRefundAttempt.payment_table == table,
        CustomerRefundAttempt.payment_row_id == row_id,
    )
    if report.provider_refund_id:
        by_id = db.execute(
            base.where(CustomerRefundAttempt.provider_refund_id == report.provider_refund_id)
        ).scalars().first()
        if by_id is not None:
            return by_id
    # Our own idempotency token echoed back by the provider.
    if report.request_ref:
        by_key = db.execute(
            base.where(CustomerRefundAttempt.idempotency_key == report.request_ref)
        ).scalars().first()
        if by_key is not None:
            return by_key
    candidates = db.execute(
        base.where(CustomerRefundAttempt.status == PROCESSING).order_by(CustomerRefundAttempt.created_at)
    ).scalars().all()
    # A processing attempt that already carries a DIFFERENT refund id is a
    # different refund, whatever the amount says.
    candidates = [
        a for a in candidates
        if not (a.provider_refund_id and report.provider_refund_id and a.provider_refund_id != report.provider_refund_id)
    ]
    if report.amount_minor:
        same = [a for a in candidates if a.amount_minor == report.amount_minor]
        if len(same) == 1:
            return same[0]
        if len(same) > 1:
            return None
        return None                      # amount contradicts every candidate: do not guess
    if len(candidates) == 1:
        return candidates[0]
    return None


def handle_refund_event(
    db: Session, provider_name: str, payment_row, reports: Sequence[ProviderRefund],
    *, provider_factory: Callable[[str], Any] | None = None,
) -> tuple[str, str]:
    """Webhook entry: returns ``(processed|deferred|ignored, note)``.

    A report only IDENTIFIES the refund; the status is read back from the
    provider's authenticated API before anything is recorded."""
    factory = provider_factory or payment_providers.get_provider_named
    notes: list[str] = []
    deferred = False
    for report in reports:
        attempt = correlate_refund_report(db, provider=provider_name, payment_row=payment_row, report=report)
        if attempt is None:
            deferred = True
            notes.append(
                f"refund {report.provider_refund_id or '?'}: could not be matched to exactly one refund attempt; "
                "deferred for reconciliation."
            )
            continue
        if attempt.status == SUCCEEDED:
            notes.append(f"refund {attempt.refund_attempt_id}: already succeeded; no change.")
            continue
        try:
            provider = factory(provider_name)
            verified = provider.fetch_refund(
                provider_payment_id=payment_row.provider_payment_id or payment_row.provider_order_id,
                provider_refund_id=report.provider_refund_id or attempt.provider_refund_id,
                idempotency_key=attempt.idempotency_key,
            )
        except Exception as exc:                  # noqa: BLE001
            deferred = True
            notes.append(f"refund attempt {attempt.refund_attempt_id}: could not verify with {provider_name} ({type(exc).__name__}); deferred.")
            continue
        if verified is None:
            deferred = True
            notes.append(f"refund attempt {attempt.refund_attempt_id}: {provider_name} reports no such refund; deferred.")
            continue
        outcome = apply_provider_refund(db, attempt.refund_attempt_id, verified)
        notes.append(f"refund attempt {attempt.refund_attempt_id}: {outcome}.")
    return ("deferred" if deferred else "processed"), " ".join(notes)[:1900]


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------
def reconcile_pending_refunds(
    db: Session, *, limit: int = 50, min_age_seconds: int | None = None,
    provider_factory: Callable[[str], Any] | None = None,
) -> dict[str, int]:
    """Ask each provider about every refund still ``processing``. READ-ONLY at the
    provider: it never submits a refund. Idempotent -- running it twice is the
    same as running it once."""
    factory = provider_factory or payment_providers.get_provider_named
    age = settings.refund_reconcile_min_age_seconds if min_age_seconds is None else min_age_seconds
    cutoff = _now() - dt.timedelta(seconds=max(age, 0))
    stale_cutoff = _now() - dt.timedelta(hours=settings.refund_stale_hours)
    ids = [r[0] for r in db.execute(
        select(CustomerRefundAttempt.refund_attempt_id).where(
            CustomerRefundAttempt.status == PROCESSING,
            CustomerRefundAttempt.updated_at <= cutoff,
        ).order_by(CustomerRefundAttempt.created_at).limit(limit)
    ).all()]
    tally = {"seen": len(ids), "succeeded": 0, "failed": 0, "still_processing": 0, "not_found": 0, "stale": 0, "errors": 0}
    for attempt_id in ids:
        attempt = db.get(CustomerRefundAttempt, attempt_id)
        if attempt is None or attempt.status != PROCESSING:
            continue
        model, pk_attr = _PAYMENT_MODELS[attempt.payment_table]
        pay = db.execute(select(model).where(getattr(model, pk_attr) == attempt.payment_row_id)).scalar_one_or_none()
        if pay is None:
            tally["errors"] += 1
            continue
        try:
            provider = factory(attempt.provider)
            found = provider.fetch_refund(
                provider_payment_id=pay.provider_payment_id or pay.provider_order_id,
                provider_refund_id=attempt.provider_refund_id,
                idempotency_key=attempt.idempotency_key,
            )
        except Exception as exc:                  # noqa: BLE001
            logger.warning("Refund reconcile: cannot ask %s about attempt %s: %s", attempt.provider, attempt_id, exc)
            tally["errors"] += 1
            continue
        if found is None:
            # The provider answered and has no such refund. That is information,
            # not permission: an operator closes it (resolve_uncertain_as_failed).
            tally["not_found"] += 1
            if attempt.created_at and _aware(attempt.created_at) <= stale_cutoff:
                tally["stale"] += 1
            continue
        outcome = apply_provider_refund(db, attempt_id, found)
        key = {SUCCEEDED: "succeeded", FAILED: "failed"}.get(outcome, "still_processing")
        tally[key] += 1
    return tally


def _aware(value: dt.datetime) -> dt.datetime:
    return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)


# ---------------------------------------------------------------------------
# What the admin screen reads
# ---------------------------------------------------------------------------
_STATUS_LABEL = {
    PENDING: "Awaiting approval",
    PROCESSING: "Processing",
    SUCCEEDED: "Refunded",
    FAILED: "Failed",
    MANUAL_REQUIRED: "Manual refund required",
}


def _user_ref(users: dict[int, Any], user_id: int | None) -> dict[str, Any] | None:
    if user_id is None:
        return None
    u = users.get(user_id)
    return {"id": user_id, "name": getattr(u, "full_name", None) or f"User {user_id}"}


def _user_names(db: Session, user_ids: set[int]) -> dict[int, Any]:
    """Who the user ids on an attempt are. A separate function so the admin
    ``users`` table (a different model base) is read in exactly one place."""
    from app.models_v2 import User

    return {u.user_id: u for u in db.execute(select(User).where(User.user_id.in_(user_ids))).scalars().all()}


def refund_overview(db: Session, cancellation_ref: str) -> dict[str, Any] | None:
    """Everything the refund panel shows for one cancellation. ``None`` if there
    is no such cancellation. Never raises for 'no payment': the panel then says
    so, because the same screen also shows demo bookings."""
    c = db.execute(
        select(CustomerCancellationRequest).where(CustomerCancellationRequest.cancellation_ref == cancellation_ref)
    ).scalars().first()
    if c is None:
        return None
    attempts = db.execute(
        select(CustomerRefundAttempt).where(CustomerRefundAttempt.cancellation_ref == cancellation_ref)
        .order_by(CustomerRefundAttempt.attempt_number)
    ).scalars().all()

    user_ids = {u for a in attempts for u in (a.initiated_by_user_id, a.approved_by_user_id, a.completed_by_user_id) if u}
    users = _user_names(db, user_ids) if user_ids else {}

    out: dict[str, Any] = {
        "cancellation_id": c.cancellation_ref,
        "payment": None, "provider": None, "currency": "INR",
        "captured_amount": None, "previously_refunded": None, "in_progress": None,
        "remaining_refundable": None, "requested_amount": None, "cancellation_remaining": None,
        "approval_required": None, "manual_only": False, "blocker": None,
        "attempts": [],
    }
    try:
        ctx = _resolve_payment(db, c, include_refunded=True)
    except RefundError as exc:
        out["blocker"] = {"code": exc.code, "message": str(exc)}
        ctx = None
    if ctx is not None:
        cur = ctx.currency
        succeeded = _sum_minor(db, ctx, (SUCCEEDED,))
        processing = _sum_minor(db, ctx, (PROCESSING,))
        target = None
        try:
            if c.refund_amount is not None:
                target = to_minor(Decimal(str(c.refund_amount)), cur)
            elif getattr(ctx.booking, "total_amount", None) is not None:
                target = to_minor(Decimal(str(ctx.booking.total_amount)), cur)
        except PaymentProviderError:
            target = None
        out.update(
            payment={"table": ctx.table, "id": ctx.row_id, "status": str(getattr(ctx.row.status, "value", ctx.row.status)),
                     "provider_payment_id": ctx.row.provider_payment_id},
            provider=ctx.provider, currency=cur, manual_only=ctx.provider in MANUAL_ONLY_PROVIDERS,
            captured_amount=from_minor(ctx.captured_minor, cur),
            previously_refunded=from_minor(succeeded, cur),
            in_progress=from_minor(processing, cur),
            remaining_refundable=from_minor(max(ctx.captured_minor - succeeded - processing, 0), cur),
        )
        if ctx.captured_minor - succeeded - processing <= 0:
            out["blocker"] = {"code": "fully_refunded",
                              "message": "This payment is fully refunded, or in-progress refunds cover all of it."}
        if target is not None:
            left = max(target - _cancellation_committed_minor(db, c.cancellation_ref), 0)
            out["requested_amount"] = from_minor(target, cur)
            out["cancellation_remaining"] = from_minor(left, cur)
            out["approval_required"] = approval_required(left or target)
    for a in attempts:
        cur = a.currency or "INR"
        out["attempts"].append({
            "attempt_id": a.refund_attempt_id, "attempt_number": a.attempt_number,
            "status": a.status, "status_label": _STATUS_LABEL.get(a.status, a.status),
            "amount": from_minor(a.amount_minor, cur), "currency": cur, "provider": a.provider,
            "provider_refund_id": a.provider_refund_id, "provider_status": a.provider_status,
            "failure_reason": a.failure_reason, "is_manual": a.is_manual, "admin_override": a.admin_override,
            "manual_reference": a.manual_reference, "manual_reason": a.manual_reason,
            "approval_required": a.approval_required,
            "uncertain": a.status == PROCESSING and a.provider_status in ("uncertain", "submitting") and not a.provider_refund_id,
            "initiated_by": _user_ref(users, a.initiated_by_user_id),
            "approved_by": _user_ref(users, a.approved_by_user_id),
            "completed_by": _user_ref(users, a.completed_by_user_id),
            "created_at": a.created_at, "updated_at": a.updated_at, "completed_at": a.completed_at,
        })
    return out


def customer_name(db: Session, customer_id: int) -> str | None:
    c = db.get(Customer, customer_id)
    return c.full_name if c else None
