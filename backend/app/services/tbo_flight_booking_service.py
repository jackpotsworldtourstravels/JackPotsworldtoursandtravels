"""TBO flight booking-path orchestration (Phase 2, items 2–5).

The single place that drives the TBO Air lifecycle over the adapter and maps its
answers onto our internal contracts. It calls the TBO client; it never touches
the database or the payment path directly — the caller (``supplier_guard`` /
reconciliation) owns the transaction, so this stays pure and fully mock-testable.

WHAT IT COVERS
  * fare rules      — FareRule (free-text airline rules, sanitised)
  * fare quote      — FareQuote re-price + fare-family flags + price-change guard
  * ancillaries     — SSR mapped to the seats / meals / baggage contract
  * reserve         — FareQuote → Book/Ticket (LCC vs Non-LCC) → GetBookingDetails
  * cancel          — SendChangeRequest
  * reconcile       — GetChangeRequestStatus (refund settlement)

THE SAFETY RULES (mandated, enforced here)
  * FAIL CLOSED. Nothing is reserved or ticketed unless TBO is actually
    configured; an absent credential raises :class:`TBONotConfigured` and the
    caller leaves the booking held rather than confirming it.
  * IDEMPOTENT. ``reserve`` never issues a second PNR/ticket: if the booking
    already carries a supplier order id it RECONCILES via GetBookingDetails
    instead of booking again, and a write (Book/Ticket) TIMEOUT is resolved by
    GetBookingDetails(TraceId) — never by retrying the write.
  * NEVER FABRICATE. A PNR / ticket number / status is only ever what TBO
    returned; a field TBO omits stays ``None``. A booking is reported ticketed
    ONLY when TBO says every passenger has a ticket number and a success status.
  * NEVER OVER-CHARGE. A FareQuote that reprices above what the customer was
    shown raises :class:`TBOPriceChanged`; we do not book at the new price.

NO LIVE VERIFICATION. TBO sandbox access (hosts + IP whitelist + credentials)
is unavailable, so this is proven against the documented contracts and mocked
payloads only — exactly like the adapter's own unit tests. It is wired behind
``flight_supplier_service.tbo_available()`` and the ``FLIGHT_SUPPLIER=tbo``
switch; the demo path is untouched and remains the default.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from app.integrations.tbo import mapper
from app.integrations.tbo.client import TBOFlightClient
from app.integrations.tbo.exceptions import TBOTimeout
from app.integrations.tbo.schemas import BOOKING_STATUS, TBOItinerary

logger = logging.getLogger(__name__)

#: TBO FlightItinerary.Status == 1 means "Successful".
_STATUS_SUCCESSFUL = 1
#: A per-passenger ticket Status TBO reports as issued.
_TICKET_OK = {"Ticketed", "Success", "Successful", "Confirmed"}


# --------------------------------------------------------------------------- #
# Result shapes mapped onto our own vocabulary
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class TBOReservation:
    """The outcome of a reserve/reconcile, in our terms. Everything here is read
    straight from TBO — nothing is invented."""

    #: TBO BookingId, as text — this is our ``supplier_order_id``.
    order_id: str | None
    pnr: str | None
    ticket_numbers: tuple[str, ...]
    #: Our label for the supplier state, from BOOKING_STATUS.
    supplier_status: str | None
    #: True only when TBO reports a BookingId AND every passenger has a ticket
    #: number AND the itinerary status is Successful.
    ticketed: bool
    is_lcc: bool | None = None
    raw_status: int | None = None


@dataclass(frozen=True)
class TBOFareOption:
    """A customer-facing fare option from FareQuote (the re-priced, bookable fare)."""

    offer_handle: str
    currency: str | None
    base_fare: float | None
    taxes: float | None
    total: float | None
    is_lcc: bool | None
    is_refundable: bool | None
    is_price_changed: bool | None
    passport_required_at_book: bool | None
    passport_required_at_ticket: bool | None
    pan_required_at_book: bool | None
    gst_mandatory: bool | None
    last_ticket_date: str | None
    fare_lines: tuple[Mapping[str, Any], ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class TBOCancellation:
    change_request_id: int | None
    status_code: int | None
    status_label: str | None
    refund_amount: float | None
    currency: str | None


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _client(client: TBOFlightClient | None) -> TBOFlightClient:
    # Construction raises TBONotConfigured when credentials/hosts are absent —
    # that is the fail-closed boundary for every entry point here.
    return client or TBOFlightClient()


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def _amounts_differ(shown: Any, now: Any) -> bool:
    try:
        return Decimal(str(shown)).normalize() != Decimal(str(now)).normalize()
    except (InvalidOperation, ValueError):
        return str(shown) != str(now)


def _is_ticketed(itin: TBOItinerary) -> bool:
    if itin.booking_id is None or itin.status != _STATUS_SUCCESSFUL:
        return False
    if not itin.tickets:
        return False
    return all(t.ticket_number and (t.status is None or t.status in _TICKET_OK) for t in itin.tickets)


def _reservation_from(itin: TBOItinerary) -> TBOReservation:
    return TBOReservation(
        order_id=str(itin.booking_id) if itin.booking_id is not None else None,
        pnr=itin.pnr,
        ticket_numbers=tuple(t.ticket_number for t in itin.tickets if t.ticket_number),
        supplier_status=BOOKING_STATUS.get(itin.status) if itin.status is not None else None,
        ticketed=_is_ticketed(itin),
        is_lcc=itin.is_lcc,
        raw_status=itin.status,
    )


# --------------------------------------------------------------------------- #
# Item 2 — fare families & rules
# --------------------------------------------------------------------------- #
def fare_rules(offer_handle: str, *, client: TBOFlightClient | None = None) -> dict:
    """FareRule for an offer — the airline's rules panel (free text). Read-only.

    Returned verbatim from TBO (the client already sanitises the transport); the
    UI renders it as supplier-provided rules, never as our own promise.
    """
    trace_id, result_index = mapper.parse_offer_handle(offer_handle)
    return _client(client).fare_rule(trace_id, result_index)


def fare_quote(
    offer_handle: str, *, shown_amount: Any = None, client: TBOFlightClient | None = None,
) -> TBOFareOption:
    """FareQuote — the re-priced, bookable fare and its flags (item 2).

    This is the single source of ``IsLCC`` and the required-field flags, per the
    spec. When ``shown_amount`` is given and the re-price moved above it, raises
    :class:`TBOPriceChanged` so we never book a fare the customer did not see.
    The provider-in-force gate is the caller's; this just drives the API.
    """
    trace_id, result_index = mapper.parse_offer_handle(offer_handle)
    quote = _client(client).fare_quote(trace_id, result_index)
    if shown_amount is not None and quote.fare.offered_fare is not None:
        if _amounts_differ(shown_amount, quote.fare.offered_fare):
            from app.integrations.tbo.exceptions import TBOPriceChanged
            raise TBOPriceChanged(
                offer_handle, str(shown_amount), str(quote.fare.offered_fare),
                quote.fare.currency or "",
            )
    return TBOFareOption(
        offer_handle=offer_handle,
        currency=quote.fare.currency,
        base_fare=_num(quote.fare.base_fare),
        taxes=_num(quote.fare.tax),
        total=_num(quote.fare.offered_fare),
        is_lcc=quote.is_lcc,
        is_refundable=quote.is_refundable,
        is_price_changed=quote.is_price_changed,
        passport_required_at_book=quote.is_passport_required_at_book,
        passport_required_at_ticket=quote.is_passport_required_at_ticket,
        pan_required_at_book=quote.is_pan_required_at_book,
        gst_mandatory=quote.is_gst_mandatory,
        last_ticket_date=quote.last_ticket_date,
        fare_lines=tuple(quote.fare_breakdown),
    )


# --------------------------------------------------------------------------- #
# Item 3 — SSR / ancillaries (seats, meals, baggage)
# --------------------------------------------------------------------------- #
def ancillaries(offer_handle: str, *, client: TBOFlightClient | None = None) -> dict:
    """SSR for an offer, mapped to our extras contract (item 3).

    Returns ``{seats, meals, baggage, unsupported}``. TBO states each group by
    segment; a group it does not return comes back EMPTY and is named in
    ``unsupported`` so the UI can show "not offered on this flight" rather than
    invent choices. Seat SELECTION itself is sent at Book/Ticket, not here.
    """
    trace_id, result_index = mapper.parse_offer_handle(offer_handle)
    raw = _client(client).ssr(trace_id, result_index)

    seats = raw.get("SeatDynamic") or raw.get("SegmentSeat") or []
    meals = raw.get("MealDynamic") or raw.get("Meal") or []
    baggage = raw.get("Baggage") or []
    unsupported = [name for name, group in
                   (("seats", seats), ("meals", meals), ("baggage", baggage)) if not group]
    return {
        "seats": seats,
        "meals": meals,
        "baggage": baggage,
        "unsupported": unsupported,
    }


# --------------------------------------------------------------------------- #
# Item 4 — Book / Ticket / GetBookingDetails
# --------------------------------------------------------------------------- #
def reserve(
    *,
    offer_handle: str,
    passengers: Sequence[Mapping[str, Any]],
    existing_order_id: str | None = None,
    shown_amount: Any = None,
    passport: Sequence[Mapping[str, Any]] | None = None,
    client: TBOFlightClient | None = None,
) -> TBOReservation:
    """Reserve and ticket a TBO flight, idempotently (item 4).

    Order: FareQuote (re-price guard) → branch on ``IsLCC`` → Book/Ticket →
    GetBookingDetails (the authority). Returns a :class:`TBOReservation`.

    IDEMPOTENCE / DUPLICATE PREVENTION
      * If ``existing_order_id`` is set (we already booked), this NEVER books
        again — it reconciles that BookingId via GetBookingDetails and returns
        its current state.
      * A write (Book/Ticket) TIMEOUT does not retry the write; it resolves the
        unknown outcome via GetBookingDetails(TraceId). If that cannot confirm a
        booking, the TBOTimeout propagates and the caller leaves the booking held.
    """
    c = _client(client)

    # Already reserved → reconcile, never re-book.
    if existing_order_id:
        return reconcile_booking(existing_order_id, client=c)

    trace_id, result_index = mapper.parse_offer_handle(offer_handle)

    # 1. Re-price and guard against a price change before any write.
    quote = c.fare_quote(trace_id, result_index)
    if shown_amount is not None and quote.fare.offered_fare is not None:
        if _amounts_differ(shown_amount, quote.fare.offered_fare):
            from app.integrations.tbo.exceptions import TBOPriceChanged
            raise TBOPriceChanged(
                offer_handle, str(shown_amount), str(quote.fare.offered_fare),
                quote.fare.currency or "",
            )

    pax = mapper.passengers_to_book(passengers, quote.fare_breakdown)

    # 2. LCC books AND issues in one Ticket call; Non-LCC holds a PNR then issues.
    try:
        if quote.is_lcc:
            itin = c.ticket_lcc(trace_id=trace_id, result_index=result_index, passengers=pax)
        else:
            booked = c.book(trace_id=trace_id, result_index=result_index, passengers=pax)
            if booked.booking_id is None:
                # Book did not return a handle — nothing to ticket; surface the state.
                return _reservation_from(booked)
            itin = c.ticket_non_lcc(
                trace_id=trace_id, pnr=booked.pnr or "", booking_id=booked.booking_id,
                passport=passport,
            )
    except TBOTimeout:
        # The write's outcome is UNKNOWN. Do NOT retry it. Ask the authority.
        logger.warning("TBO write timed out for %s — resolving via GetBookingDetails(TraceId).",
                       offer_handle)
        resolved = c.get_booking_details(trace_id=trace_id)
        if resolved.booking_id is None:
            raise  # genuinely unknown: let the caller hold the booking
        itin = resolved

    # 3. GetBookingDetails is the authority on the final state.
    if itin.booking_id is not None:
        try:
            itin = c.get_booking_details(booking_id=int(itin.booking_id))
        except TBOTimeout:
            logger.info("GetBookingDetails timed out post-ticket for %s; using the ticket response.",
                        offer_handle)
    return _reservation_from(itin)


def reconcile_booking(order_id: str, *, client: TBOFlightClient | None = None) -> TBOReservation:
    """Read the current TBO state of an already-booked order (GetBookingDetails).

    Used by the idempotent reserve path and by reconciliation sweeps — it books
    nothing and issues nothing.
    """
    itin = _client(client).get_booking_details(booking_id=int(order_id))
    return _reservation_from(itin)


# --------------------------------------------------------------------------- #
# Item 5 — cancellation & reconciliation
# --------------------------------------------------------------------------- #
def cancellation_charges(order_id: str, *, client: TBOFlightClient | None = None) -> dict:
    """GetCancellationCharges — a quote only; cancels nothing."""
    return _client(client).get_cancellation_charges(int(order_id))


def request_cancellation(
    order_id: str, *, remarks: str = "Customer cancellation", client: TBOFlightClient | None = None,
) -> TBOCancellation:
    """SendChangeRequest — raise a cancellation (item 5).

    Cannot be withdrawn once raised; the caller must persist the returned
    ``change_request_id`` so the refund can be reconciled against it.
    """
    raw = _client(client).send_change_request(int(order_id), remarks=remarks)
    crid = raw.get("ChangeRequestId") if isinstance(raw, Mapping) else None
    return TBOCancellation(
        change_request_id=int(crid) if crid is not None else None,
        status_code=None, status_label="requested", refund_amount=None, currency=None,
    )


def reconcile_cancellation(
    change_request_id: int, *, client: TBOFlightClient | None = None,
) -> TBOCancellation:
    """GetChangeRequestStatus — settle a refund once the status is Completed (4).

    The refund amount is only read from TBO's ``RefundedAmount``; we never
    compute a refund ourselves from a cancellation we cannot confirm.
    """
    raw = _client(client).get_change_request_status(int(change_request_id))
    status = raw.get("ChangeRequestStatus") if isinstance(raw, Mapping) else None
    refunded = raw.get("RefundedAmount") if isinstance(raw, Mapping) else None
    labels = {1: "requested", 2: "in_progress", 3: "pending", 4: "completed", 5: "rejected"}
    return TBOCancellation(
        change_request_id=change_request_id,
        status_code=int(status) if status is not None else None,
        status_label=labels.get(status) if status is not None else None,
        refund_amount=_num(refunded),
        currency=(raw.get("Currency") if isinstance(raw, Mapping) else None),
    )
