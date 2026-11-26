"""Resolve a HELD TBO flight booking into a confirmed, ticketed one (item 4).

This is the DB-aware bridge between the pure orchestration
(``tbo_flight_booking_service``) and the held-booking machinery
(``supplier_guard``). It runs AFTER payment capture: a TBO booking holds
(``reservation_missing``) because ``confirm_booking`` will not confirm a
live-supplier flight with no ``supplier_order_id``; this reserves+tickets it with
TBO and then confirms it through the SAME ``complete_reservation`` every held
booking uses — so the existing payment path is untouched.

SAFETY (all enforced):
  * FAIL CLOSED. If TBO is not configured, nothing happens and the booking stays
    held (money already captured and never lost); returns ``not_configured``.
  * IDEMPOTENT. ``reserve`` reconciles instead of re-booking when the booking
    already carries a supplier order id, and ``complete_reservation`` confirms at
    most once. Re-running this on a confirmed booking is a no-op.
  * NEVER CONFIRM UNTICKETED. The booking is confirmed only when TBO reports it
    genuinely ticketed; otherwise it stays held for reconciliation.
  * NEVER FABRICATE. PNR / order id come only from TBO.

LIVE VERIFICATION is unavailable (no TBO sandbox creds), so in this environment
``tbo_available()`` is False and this always fails closed. The logic is proven by
mock tests; it is NOT TBO-verified.
"""
from __future__ import annotations

import logging

from app.integrations.tbo.exceptions import TBOError
from app.services import supplier_guard
from app.services import tbo_flight_booking_service as tbo

logger = logging.getLogger(__name__)


def _passenger_dicts(booking) -> list[dict]:
    """``CustomerBookingPassenger`` rows → the dicts the TBO mapper reads.

    The booking's contact passenger is the lead. GST (if present) rides on the
    booking, not the passenger, and is forwarded separately when the live Book
    body is assembled (see MMT_PHASE2_FLIGHTS limitations).
    """
    out: list[dict] = []
    for p in sorted(booking.passengers, key=lambda x: x.passenger_index):
        out.append({
            "title": p.title,
            "first_name": p.first_name,
            "last_name": p.last_name,
            "type": p.traveller_type,
            "gender": p.gender,
            "date_of_birth": p.date_of_birth.isoformat() if p.date_of_birth else None,
            "nationality": p.nationality,
            "passport_no": p.passport_number,
            "passport_expiry": p.passport_expiry.isoformat() if p.passport_expiry else None,
            "mobile": p.mobile,
            "email": p.email,
            "is_lead": bool(p.is_contact),
        })
    return out


def resolve_reservation(db, booking, *, client=None) -> str:
    """Reserve+ticket a held TBO booking with the supplier, then confirm it once.

    Returns a short stable code: ``confirmed``, ``held`` (TBO did not ticket it),
    ``not_configured`` (TBO unavailable — fail closed), ``not_live_supplier`` (not
    a TBO booking), ``supplier_error`` (a TBO failure; booking stays held). The
    caller commits.
    """
    from app.services import flight_supplier_service as supplier

    if supplier_guard.booking_supplier(booking) != tbo.mapper.SUPPLIER and supplier.active_provider() != supplier.TBO:
        return "not_live_supplier"

    # FAIL CLOSED: no credentials ⇒ do not attempt a reservation; the booking
    # stays held with its captured payment intact.
    if not supplier.tbo_available():
        logger.info("TBO reservation skipped for %s: TBO not configured (fail-closed).",
                    getattr(booking, "booking_ref", "?"))
        return "not_configured"

    offer_handle = (getattr(booking, "supplier_offer_id", None) or "").strip()
    if not offer_handle:
        logger.error("TBO reservation refused for %s: no supplier offer handle.",
                     getattr(booking, "booking_ref", "?"))
        return "supplier_error"

    try:
        res = tbo.reserve(
            offer_handle=offer_handle,
            passengers=_passenger_dicts(booking),
            existing_order_id=(getattr(booking, "supplier_order_id", None) or None),
            shown_amount=getattr(booking, "supplier_total_amount", None),
            client=client,
        )
    except TBOError as exc:
        # Any TBO failure (not configured, price change, timeout unresolved, API
        # refusal) leaves the booking HELD. The money is captured and safe; an
        # operator/sweep can retry or cancel+refund.
        logger.warning("TBO reservation failed for %s: %s", getattr(booking, "booking_ref", "?"),
                       type(exc).__name__)
        return "supplier_error"

    if not (res.ticketed and res.order_id):
        logger.error("TBO did not ticket %s (order_id=%s status=%s); staying held.",
                     getattr(booking, "booking_ref", "?"), res.order_id, res.supplier_status)
        return "held"

    code = supplier_guard.complete_reservation(
        db, booking.booking_ref,
        supplier_order_id=res.order_id, pnr=res.pnr,
        supplier_status=(res.supplier_status or "confirmed"), verified_by="tbo",
    )
    return "confirmed" if code in ("confirmed", "already_confirmed") else code
