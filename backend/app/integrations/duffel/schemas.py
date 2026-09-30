"""The Duffel wire shapes we send and the ones we parse back.

Two halves:

  * REQUEST BUILDERS turn our own inputs into the JSON body Duffel wants, so
    the client never hand-assembles a payload and the field names live in one
    place. Every Duffel request body is wrapped in ``{"data": ...}``.

  * RESPONSE PARSERS read Duffel's JSON into small frozen dataclasses. They
    read ONLY what we use and tolerate missing optionals by returning ``None``
    — Duffel adds fields over time, and an unknown key must never break a
    parse. Nothing here invents a value: a field Duffel omits stays ``None``
    and the mapper decides how to represent "unknown" in our schema.

These dataclasses are Duffel's vocabulary (offers, slices, segments), NOT our
internal flight shape. The translation into our schema is ``mapper.py``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence


# --------------------------------------------------------------------------- #
# Request builders
# --------------------------------------------------------------------------- #

def offer_request_body(
    *,
    slices: Sequence[Mapping[str, str]],
    passengers: Sequence[Mapping[str, Any]],
    cabin_class: str | None = None,
    max_connections: int | None = None,
) -> dict:
    """Body for ``POST /air/offer_requests``.

    ``slices`` is a list of ``{"origin", "destination", "departure_date"}``
    (IATA codes, ``YYYY-MM-DD``). ``passengers`` is a list of ``{"type": ...}``
    (``adult`` / ``child`` / ``infant_without_seat``) or ``{"age": n}``.

    ``cabin_class`` and ``max_connections`` are omitted when ``None`` so we
    send Duffel's own defaults rather than asserting one.
    """
    data: dict[str, Any] = {
        "slices": [dict(s) for s in slices],
        "passengers": [dict(p) for p in passengers],
    }
    if cabin_class:
        data["cabin_class"] = cabin_class
    if max_connections is not None:
        data["max_connections"] = int(max_connections)
    return {"data": data}


def order_body(
    *,
    offer_id: str,
    passengers: Sequence[Mapping[str, Any]],
    amount: str,
    currency: str,
    order_type: str = "instant",
    services: Sequence[Mapping[str, Any]] | None = None,
    metadata: Mapping[str, str] | None = None,
) -> dict:
    """Body for ``POST /air/orders``.

    ``order_type`` is ``instant`` (pay now) or ``hold``. For an instant order
    we send a single ``payments`` entry of ``type: balance`` — in TEST MODE the
    Duffel balance is unlimited, so no real money moves. ``amount``/``currency``
    MUST equal the (re-fetched) offer's total; the caller passes exactly that,
    never a converted figure.

    Each passenger maps a Duffel passenger ``id`` (from the offer request) to
    that traveller's details. ``metadata`` is our own key/value store on the
    order — we put our internal ``booking_ref`` there so a timed-out create can
    be reconciled by lookup instead of blindly retried.
    """
    data: dict[str, Any] = {
        "type": order_type,
        "selected_offers": [offer_id],
        "passengers": [dict(p) for p in passengers],
    }
    if order_type == "instant":
        data["payments"] = [{"type": "balance", "amount": amount, "currency": currency}]
    if services:
        data["services"] = [dict(s) for s in services]
    if metadata:
        data["metadata"] = dict(metadata)
    return {"data": data}


# --------------------------------------------------------------------------- #
# Response parsers
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class DuffelPlace:
    iata_code: str | None
    city_name: str | None
    name: str | None
    time_zone: str | None


@dataclass(frozen=True)
class DuffelBaggage:
    type: str | None       # "checked" | "carry_on"
    quantity: int | None


@dataclass(frozen=True)
class DuffelSegment:
    id: str | None
    origin: DuffelPlace
    destination: DuffelPlace
    departing_at: str | None
    arriving_at: str | None
    duration: str | None            # ISO 8601, e.g. "PT2H15M" — may be None
    marketing_carrier_code: str | None
    marketing_carrier_name: str | None
    marketing_flight_number: str | None
    operating_carrier_code: str | None
    baggages: tuple[DuffelBaggage, ...]


@dataclass(frozen=True)
class DuffelSlice:
    id: str | None
    origin: DuffelPlace
    destination: DuffelPlace
    duration: str | None
    segments: tuple[DuffelSegment, ...]


@dataclass(frozen=True)
class DuffelOffer:
    id: str
    expires_at: str | None
    total_amount: str | None
    total_currency: str | None
    base_amount: str | None
    tax_amount: str | None
    owner_name: str | None
    owner_code: str | None
    # None means "Duffel did not say" — never coerced to a bool. The mapper
    # represents that as unknown, and never as "refundable: false".
    refund_before_departure_allowed: bool | None
    change_before_departure_allowed: bool | None
    requires_instant_payment: bool | None
    payment_required_by: str | None
    passenger_ids: tuple[str, ...]
    slices: tuple[DuffelSlice, ...]
    raw: Mapping[str, Any]           # kept for fields we do not model yet


def _place(node: Mapping[str, Any] | None) -> DuffelPlace:
    node = node or {}
    return DuffelPlace(
        iata_code=node.get("iata_code"),
        city_name=node.get("city_name") or (node.get("city") or {}).get("name"),
        name=node.get("name"),
        time_zone=node.get("time_zone"),
    )


def _baggages(passenger_nodes: Sequence[Mapping[str, Any]] | None) -> tuple[DuffelBaggage, ...]:
    out: list[DuffelBaggage] = []
    for p in passenger_nodes or []:
        for b in p.get("baggages") or []:
            out.append(DuffelBaggage(type=b.get("type"), quantity=b.get("quantity")))
    return tuple(out)


def _segment(node: Mapping[str, Any]) -> DuffelSegment:
    mkt = node.get("marketing_carrier") or {}
    op = node.get("operating_carrier") or {}
    return DuffelSegment(
        id=node.get("id"),
        origin=_place(node.get("origin")),
        destination=_place(node.get("destination")),
        departing_at=node.get("departing_at"),
        arriving_at=node.get("arriving_at"),
        duration=node.get("duration"),
        marketing_carrier_code=mkt.get("iata_code"),
        marketing_carrier_name=mkt.get("name"),
        marketing_flight_number=node.get("marketing_carrier_flight_number"),
        operating_carrier_code=op.get("iata_code"),
        baggages=_baggages(node.get("passengers")),
    )


def _slice(node: Mapping[str, Any]) -> DuffelSlice:
    return DuffelSlice(
        id=node.get("id"),
        origin=_place(node.get("origin")),
        destination=_place(node.get("destination")),
        duration=node.get("duration"),
        segments=tuple(_segment(s) for s in node.get("segments") or []),
    )


def _conditions_flag(offer: Mapping[str, Any], key: str) -> bool | None:
    """Read ``conditions.<key>.allowed`` as a tri-state.

    Missing conditions, or a missing sub-object, is ``None`` — genuinely
    unknown — and is never flattened to ``False``.
    """
    cond = (offer.get("conditions") or {}).get(key)
    if not isinstance(cond, Mapping):
        return None
    allowed = cond.get("allowed")
    return allowed if isinstance(allowed, bool) else None


def parse_offer(node: Mapping[str, Any]) -> DuffelOffer:
    """One offer object into :class:`DuffelOffer`. Reads only what we use."""
    reqs = node.get("payment_requirements") or {}
    passenger_ids = tuple(
        p.get("id") for p in (node.get("passengers") or []) if p.get("id")
    )
    return DuffelOffer(
        id=node["id"],
        expires_at=node.get("expires_at"),
        total_amount=node.get("total_amount"),
        total_currency=node.get("total_currency"),
        base_amount=node.get("base_amount"),
        tax_amount=node.get("tax_amount"),
        owner_name=(node.get("owner") or {}).get("name"),
        owner_code=(node.get("owner") or {}).get("iata_code"),
        refund_before_departure_allowed=_conditions_flag(node, "refund_before_departure"),
        change_before_departure_allowed=_conditions_flag(node, "change_before_departure"),
        requires_instant_payment=reqs.get("requires_instant_payment"),
        payment_required_by=reqs.get("payment_required_by"),
        passenger_ids=passenger_ids,
        slices=tuple(_slice(s) for s in node.get("slices") or []),
        raw=node,
    )


def parse_offers(payload: Mapping[str, Any]) -> tuple[DuffelOffer, ...]:
    """Offers out of an offer-request response.

    ``return_offers`` embeds offers under ``data.offers``; a bare offer-list
    response carries them under ``data``. Accept both so the envelope is not a
    second thing to get right.
    """
    data = payload.get("data")
    if isinstance(data, Mapping) and "offers" in data:
        nodes = data.get("offers") or []
    elif isinstance(data, list):
        nodes = data
    else:
        nodes = []
    return tuple(parse_offer(n) for n in nodes if n.get("id"))


def parse_single_offer(payload: Mapping[str, Any]) -> DuffelOffer:
    """The offer out of a ``GET /air/offers/{id}`` response."""
    return parse_offer(payload["data"])


@dataclass(frozen=True)
class DuffelOrder:
    id: str
    booking_reference: str | None
    total_amount: str | None
    total_currency: str | None
    payment_status: str | None          # e.g. "awaiting_payment" / paid
    document_numbers: tuple[str, ...]    # ticket numbers, when issued
    passenger_ids: tuple[str, ...]
    raw: Mapping[str, Any]


def parse_order(payload: Mapping[str, Any]) -> DuffelOrder:
    node = payload["data"]
    docs = tuple(
        d.get("unique_identifier") for d in (node.get("documents") or [])
        if d.get("unique_identifier")
    )
    pax = tuple(p.get("id") for p in (node.get("passengers") or []) if p.get("id"))
    payment_status = (node.get("payment_status") or {})
    return DuffelOrder(
        id=node["id"],
        booking_reference=node.get("booking_reference"),
        total_amount=node.get("total_amount"),
        total_currency=node.get("total_currency"),
        payment_status=(
            "awaiting_payment"
            if payment_status.get("awaiting_payment")
            else (payment_status.get("payment_required_by") and "pending") or "paid"
        ),
        document_numbers=docs,
        passenger_ids=pax,
        raw=node,
    )
