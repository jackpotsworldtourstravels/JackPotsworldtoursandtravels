"""Provider Management — the suppliers the desk buys tickets from (0039).

WHAT THIS OWNS
The ``providers`` and ``provider_users`` tables, and the two foreign keys a
booking carries to them. Nothing else. It does not touch wallets, payments,
merchants, quotations or the booking lifecycle — a provider is a note about
*where a ticket was bought*, and recording it must not be able to move money.

EVERY FIGURE ON EVERY SCREEN IS DERIVED
There is no ``total_tickets`` column and there will not be one. Provider and
provider-user totals are ``COUNT``/``SUM`` over the bookings that carry the
foreign key, computed per read. A stored counter is a second copy of a number
the bookings already answer, and the first thing it does is disagree with them —
the same reasoning that put the wallet's balance under a ledger in CR-4.

The cost of deriving is one grouped query per list, never one per row: see
:func:`_totals_by_provider`, which is what keeps a 200-provider page at two
queries rather than four hundred.

WHAT COUNTS AS A PROVIDER'S BOOKING
Every ``request_type = booking`` row carrying that ``provider_id``, whatever its
current status. The rule is deliberately the literal one the business asked for
("provider totals equal the sum of all bookings assigned to that provider"), so
the number on the screen can be checked by hand against the booking list. A
booking cancelled after the fact was still bought from that supplier, and
dropping it would make the ticket count stop matching what was purchased.

NO DELETE, ANYWHERE
A provider with bookings is a purchase record. It is retired with
``status = inactive``, which stops it appearing in the issuance dropdown while
leaving every historical booking still attributable. The schema enforces the
same thing with ``ON DELETE RESTRICT``; this module simply never offers the
operation.
"""
import datetime
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException, status as http_status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    PassengerData,
    Provider,
    ProviderStatus,
    ProviderUser,
    RequestType,
    ServiceRequest,
    User,
)
from app.services import activity_service

ZERO = Decimal("0.00")
_CENTS = Decimal("0.01")

#: How many bookings the detail screen shows under "Recent Bookings". A cap,
#: not a page: this is a summary panel, and the full list lives on the booking
#: screens that already page properly.
RECENT_BOOKINGS = 20


def _q(value) -> Decimal:
    return Decimal(value or 0).quantize(_CENTS)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Codes
# ---------------------------------------------------------------------------
def _next_code(db: Session) -> str:
    """``PRD001``, from a sequence.

    ``nextval`` is non-transactional on purpose, exactly as in
    ``wallet_service._next_number``: a rolled-back create leaves a gap in the
    series rather than handing PRD007 to two providers. Building the code from
    ``COUNT(*) + 1`` instead would be a check-then-act that two concurrent
    creates both pass, and the unique index would then turn the loser into a
    500 rather than a clean row.

    Zero-padded to three digits to match the format the business gave
    (PRD001…PRD004). Past 999 it simply grows to PRD1000 — the padding is a
    minimum width, never a cap.
    """
    seq = db.scalar(select(func.nextval("seq_provider_code")))
    return f"PRD{int(seq):03d}"


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------
def get_provider(db: Session, provider_id: int) -> Provider:
    provider = db.get(Provider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Provider not found"
        )
    return provider


def get_provider_user(db: Session, provider_user_id: int) -> ProviderUser:
    person = db.get(ProviderUser, provider_user_id)
    if person is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Provider user not found"
        )
    return person


def _name_taken(db: Session, name: str, *, exclude_id: int | None = None) -> bool:
    stmt = select(Provider.provider_id).where(
        func.lower(Provider.provider_name) == name.strip().lower()
    )
    if exclude_id is not None:
        stmt = stmt.where(Provider.provider_id != exclude_id)
    return db.scalars(stmt).first() is not None


def _person_conflict(
    db: Session, provider_id: int, *, name: str | None = None,
    email: str | None = None, exclude_id: int | None = None,
) -> str | None:
    """Which field collides with an existing person at this provider, if any.

    Checked here so the caller gets a sentence naming the field rather than the
    unique index's ``IntegrityError``. The index is still the guarantee — this
    is the message, not the enforcement.
    """
    base = select(ProviderUser).where(ProviderUser.provider_id == provider_id)
    if exclude_id is not None:
        base = base.where(ProviderUser.provider_user_id != exclude_id)

    if name:
        hit = db.scalars(
            base.where(func.lower(ProviderUser.user_name) == name.strip().lower())
        ).first()
        if hit is not None:
            return f"{hit.user_name} is already listed against this provider."
    if email:
        hit = db.scalars(
            base.where(func.lower(ProviderUser.email) == email.strip().lower())
        ).first()
        if hit is not None:
            return f"{hit.email} is already listed against this provider."
    return None


# ---------------------------------------------------------------------------
# Derived analytics
# ---------------------------------------------------------------------------
def _booked(column) -> Select:
    """Bookings attributable to a provider (or provider user), grouped by it.

    ``request_type == BOOKING`` is stated explicitly rather than relied upon.
    Only ticket issuance writes these foreign keys and it only ever runs on a
    booking, so the filter is redundant today — but it is what stops a future
    request type that happens to carry a provider from being counted as a
    ticket purchased.
    """
    return (
        select(
            column.label("key"),
            func.count().label("tickets"),
            func.coalesce(func.sum(ServiceRequest.total_amount), 0).label("amount"),
        )
        .where(
            and_(
                column.isnot(None),
                ServiceRequest.request_type == RequestType.BOOKING,
            )
        )
        .group_by(column)
    )


def _totals_by_provider(db: Session, provider_ids: list[int]) -> dict[int, tuple[int, Decimal]]:
    """One grouped query for a whole page of providers, never one per row."""
    if not provider_ids:
        return {}
    rows = db.execute(
        _booked(ServiceRequest.provider_id).where(
            ServiceRequest.provider_id.in_(provider_ids)
        )
    ).all()
    return {int(r.key): (int(r.tickets), _q(r.amount)) for r in rows}


def _totals_by_provider_user(
    db: Session, provider_user_ids: list[int]
) -> dict[int, tuple[int, Decimal]]:
    if not provider_user_ids:
        return {}
    rows = db.execute(
        _booked(ServiceRequest.provider_user_id).where(
            ServiceRequest.provider_user_id.in_(provider_user_ids)
        )
    ).all()
    return {int(r.key): (int(r.tickets), _q(r.amount)) for r in rows}


def _user_counts(db: Session, provider_ids: list[int]) -> dict[int, int]:
    if not provider_ids:
        return {}
    rows = db.execute(
        select(ProviderUser.provider_id, func.count())
        .where(ProviderUser.provider_id.in_(provider_ids))
        .group_by(ProviderUser.provider_id)
    ).all()
    return {int(pid): int(n) for pid, n in rows}


# ---------------------------------------------------------------------------
# Serialising
# ---------------------------------------------------------------------------
def provider_out(
    provider: Provider, totals: tuple[int, Decimal] = (0, ZERO), user_count: int = 0
) -> dict:
    tickets, amount = totals
    return {
        "id": provider.provider_id,
        "provider_code": provider.provider_code,
        "provider_name": provider.provider_name,
        "status": provider.status.value,
        "total_tickets": tickets,
        "total_amount": amount,
        "user_count": user_count,
        "created_at": provider.created_at,
        "updated_at": provider.updated_at,
    }


def provider_user_out(person: ProviderUser, totals: tuple[int, Decimal] = (0, ZERO)) -> dict:
    tickets, amount = totals
    return {
        "id": person.provider_user_id,
        "provider_id": person.provider_id,
        "user_name": person.user_name,
        "email": person.email,
        "phone_number": person.phone_number,
        "status": person.status.value,
        "tickets_booked": tickets,
        "total_amount": amount,
        "created_at": person.created_at,
        "updated_at": person.updated_at,
    }


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
_SORTS = {
    "provider_code": Provider.provider_code,
    "provider_name": Provider.provider_name,
    "status": Provider.status,
    "created_at": Provider.created_at,
}


def list_providers(
    db: Session, *,
    page: int = 1,
    page_size: int = 25,
    search: str | None = None,
    status: str | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    sort: str = "provider_code",
    direction: str = "asc",
) -> tuple[list[dict], int]:
    """The Provider Management list, with totals derived per page.

    ``search`` matches the code, the name, **and the names of the people at that
    provider** — an operator who remembers "John booked it" but not which
    supplier John works for is the case this list has to answer.
    """
    conditions = []
    if status in ("active", "inactive"):
        conditions.append(Provider.status == ProviderStatus(status))
    if date_from is not None:
        conditions.append(Provider.created_at >= date_from)
    if date_to is not None:
        # Inclusive of the whole end day, the same rule wallet_service.ledger
        # applies — a filter to "2 Aug" that drops everything after midnight
        # reads as broken.
        conditions.append(
            Provider.created_at < date_to + datetime.timedelta(days=1)
        )
    if search:
        pattern = f"%{search.strip()}%"
        people = (
            select(ProviderUser.provider_id)
            .where(
                or_(
                    ProviderUser.user_name.ilike(pattern),
                    ProviderUser.email.ilike(pattern),
                )
            )
        )
        conditions.append(
            or_(
                Provider.provider_code.ilike(pattern),
                Provider.provider_name.ilike(pattern),
                Provider.provider_id.in_(people),
            )
        )

    where = and_(*conditions) if conditions else None
    count_stmt = select(func.count()).select_from(Provider)
    if where is not None:
        count_stmt = count_stmt.where(where)
    total = db.scalar(count_stmt) or 0

    column = _SORTS.get(sort, Provider.provider_code)
    order = column.desc() if direction == "desc" else column.asc()

    stmt = select(Provider)
    if where is not None:
        stmt = stmt.where(where)
    providers = list(
        db.scalars(
            stmt.order_by(order).limit(page_size).offset((page - 1) * page_size)
        ).all()
    )

    ids = [p.provider_id for p in providers]
    totals = _totals_by_provider(db, ids)
    counts = _user_counts(db, ids)
    items = [
        provider_out(p, totals.get(p.provider_id, (0, ZERO)), counts.get(p.provider_id, 0))
        for p in providers
    ]
    return items, total


def _recent_bookings(db: Session, provider_id: int) -> list[dict]:
    """The last few tickets bought through this provider.

    ``selectinload`` on passengers rather than a lazy read per row: this renders
    a passenger name per booking, and without it a 20-row panel is 21 queries.
    """
    rows = list(
        db.scalars(
            select(ServiceRequest)
            .options(
                selectinload(ServiceRequest.passengers),
                selectinload(ServiceRequest.provider_user),
            )
            .where(
                and_(
                    ServiceRequest.provider_id == provider_id,
                    ServiceRequest.request_type == RequestType.BOOKING,
                )
            )
            .order_by(ServiceRequest.request_id.desc())
            .limit(RECENT_BOOKINGS)
        ).all()
    )

    out = []
    for r in rows:
        details = r.travel_details or {}
        lead: Optional[PassengerData] = (r.passengers or [None])[0]
        name = None
        if lead is not None:
            name = " ".join(
                p for p in (lead.first_name, lead.last_name) if p
            ).strip() or None
        out.append({
            "id": r.request_id,
            "request_number": r.request_number,
            "passenger_name": name,
            "airline": details.get("airline"),
            "travel_date": r.travel_date,
            "amount": _q(r.total_amount),
            "provider_user_name": r.provider_user.user_name if r.provider_user else None,
            # The moment the ticket was issued is the moment the provider was
            # recorded, so this is the purchase date. `approved_at` is not it —
            # that is the merchant-side approval, which happens earlier and on a
            # different track.
            "ticket_issued_at": r.updated_at if r.ticket_number else None,
            "ticket_number": r.ticket_number,
        })
    return out


def get_provider_detail(db: Session, provider_id: int) -> dict:
    provider = get_provider(db, provider_id)

    totals = _totals_by_provider(db, [provider_id]).get(provider_id, (0, ZERO))
    tickets, amount = totals

    people = list(
        db.scalars(
            select(ProviderUser)
            .where(ProviderUser.provider_id == provider_id)
            .order_by(ProviderUser.provider_user_id)
        ).all()
    )
    person_totals = _totals_by_provider_user(db, [p.provider_user_id for p in people])

    # Computed server-side, and only where there is something to divide: a
    # browser doing total / count on two decimal strings is a float division,
    # and this is money.
    average = _q(amount / tickets) if tickets else ZERO

    return {
        "provider": provider_out(provider, totals, len(people)),
        "stats": {
            "total_tickets": tickets,
            "total_amount": amount,
            "average_ticket_value": average,
            "provider_user_count": len(people),
        },
        "users": [
            provider_user_out(p, person_totals.get(p.provider_user_id, (0, ZERO)))
            for p in people
        ],
        "recent_bookings": _recent_bookings(db, provider_id),
    }


def provider_options(db: Session) -> list[dict]:
    """Active providers and their active people, for the issuance dropdown.

    Only ``active`` rows: deactivating a supplier is how the desk stops new
    tickets being attributed to it, so an inactive one must not be selectable.
    Historical bookings keep pointing at it regardless — that is the whole
    reason this is a status rather than a delete.

    One query with the people eager-loaded, so the dependent dropdown needs no
    second round trip when a provider is picked.
    """
    providers = list(
        db.scalars(
            select(Provider)
            .options(selectinload(Provider.users))
            .where(Provider.status == ProviderStatus.ACTIVE)
            .order_by(Provider.provider_name)
        ).all()
    )
    return [
        {
            "id": p.provider_id,
            "provider_code": p.provider_code,
            "provider_name": p.provider_name,
            "users": [
                {"id": u.provider_user_id, "user_name": u.user_name}
                for u in p.users
                if u.status is ProviderStatus.ACTIVE
            ],
        }
        for p in providers
    ]


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------
def create_provider(db: Session, actor: User, *, provider_name: str) -> Provider:
    name = provider_name.strip()
    if _name_taken(db, name):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=f"A provider called {name} already exists.",
        )

    provider = Provider(
        provider_code=_next_code(db),
        provider_name=name,
        status=ProviderStatus.ACTIVE,
        created_by=actor.user_id,
        updated_by=actor.user_id,
    )
    db.add(provider)
    db.commit()
    db.refresh(provider)

    activity_service.log_activity(
        db, actor.user_id, "Provider created",
        activity_type="Provider", module="Provider Management",
        description=f"{actor.full_name} added provider {provider.provider_code} ({provider.provider_name})",
        reference_id=provider.provider_id,
        details={"provider_code": provider.provider_code, "provider_name": provider.provider_name},
    )
    return provider


def update_provider(
    db: Session, actor: User, provider_id: int, *,
    provider_name: str | None = None, status: str | None = None,
) -> Provider:
    provider = get_provider(db, provider_id)
    if provider_name is None and status is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Send a name or a status to change.",
        )

    changed: dict[str, Any] = {}
    if provider_name is not None:
        name = provider_name.strip()
        if name.lower() != provider.provider_name.lower() and _name_taken(
            db, name, exclude_id=provider_id
        ):
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT,
                detail=f"A provider called {name} already exists.",
            )
        if name != provider.provider_name:
            changed["provider_name"] = [provider.provider_name, name]
            provider.provider_name = name
    if status is not None:
        wanted = ProviderStatus(status)
        if wanted is not provider.status:
            changed["status"] = [provider.status.value, wanted.value]
            provider.status = wanted

    # The code is never editable, by anyone, through any payload — it is the
    # stable reference a booking's purchase history is read against.
    if not changed:
        return provider

    provider.updated_by = actor.user_id
    provider.updated_at = _now()
    db.commit()
    db.refresh(provider)

    activity_service.log_activity(
        db, actor.user_id, "Provider updated",
        activity_type="Provider", module="Provider Management",
        description=(
            f"{actor.full_name} updated {provider.provider_code}: "
            + ", ".join(f"{k} {a} -> {b}" for k, (a, b) in changed.items())
        ),
        reference_id=provider.provider_id,
        details={"provider_code": provider.provider_code, "changed": changed},
    )
    return provider


def add_provider_user(
    db: Session, actor: User, provider_id: int, *,
    user_name: str, email: str, phone_number: str | None = None,
) -> ProviderUser:
    provider = get_provider(db, provider_id)

    clash = _person_conflict(db, provider_id, name=user_name, email=email)
    if clash:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=clash)

    person = ProviderUser(
        provider_id=provider.provider_id,
        user_name=user_name.strip(),
        email=email.strip(),
        phone_number=(phone_number or "").strip() or None,
        status=ProviderStatus.ACTIVE,
    )
    db.add(person)
    db.commit()
    db.refresh(person)

    activity_service.log_activity(
        db, actor.user_id, "Provider user added",
        activity_type="Provider", module="Provider Management",
        description=(
            f"{actor.full_name} added {person.user_name} to {provider.provider_code} "
            f"({provider.provider_name})"
        ),
        reference_id=provider.provider_id,
        details={"provider_code": provider.provider_code, "user_name": person.user_name},
    )
    return person


def update_provider_user(
    db: Session, actor: User, provider_user_id: int, *,
    user_name: str | None = None, email: str | None = None,
    phone_number: str | None = None, status: str | None = None,
) -> ProviderUser:
    person = get_provider_user(db, provider_user_id)

    clash = _person_conflict(
        db, person.provider_id, name=user_name, email=email, exclude_id=provider_user_id
    )
    if clash:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail=clash)

    changed: dict[str, Any] = {}
    if user_name is not None and user_name.strip() != person.user_name:
        changed["user_name"] = [person.user_name, user_name.strip()]
        person.user_name = user_name.strip()
    if email is not None and email.strip() != person.email:
        changed["email"] = [person.email, email.strip()]
        person.email = email.strip()
    if phone_number is not None:
        new_phone = phone_number.strip() or None
        if new_phone != person.phone_number:
            changed["phone_number"] = [person.phone_number, new_phone]
            person.phone_number = new_phone
    if status is not None:
        wanted = ProviderStatus(status)
        if wanted is not person.status:
            changed["status"] = [person.status.value, wanted.value]
            person.status = wanted

    if not changed:
        return person

    person.updated_at = _now()
    db.commit()
    db.refresh(person)

    activity_service.log_activity(
        db, actor.user_id, "Provider user updated",
        activity_type="Provider", module="Provider Management",
        description=(
            f"{actor.full_name} updated {person.user_name}: "
            + ", ".join(f"{k} {a} -> {b}" for k, (a, b) in changed.items())
        ),
        reference_id=person.provider_id,
        details={"user_name": person.user_name, "changed": changed},
    )
    return person


# ---------------------------------------------------------------------------
# Ticket issuance
# ---------------------------------------------------------------------------
def resolve_for_issuance(
    db: Session, provider_id: int | None, provider_user_id: int | None,
) -> tuple[Optional[Provider], Optional[ProviderUser]]:
    """Validate the pair a ticket is being issued against.

    Both are optional at this layer, and that is a deliberate backward-
    compatibility decision rather than an omission: ``issue_ticket`` predates
    providers by several milestones, every booking issued before this module
    existed carries neither, and hard-requiring them in the API would break
    every existing caller and in-flight booking at once. The Booking Operations
    screen requires both before it will submit, which is where the business rule
    is enforced for the people actually doing the work.

    What is *not* optional is coherence. If a provider user is named it must
    belong to the named provider — otherwise a booking could be attributed to
    John at a supplier John has never worked for, and the per-user totals would
    quietly disagree with the per-provider ones.
    """
    if provider_user_id is not None and provider_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Choose a provider before choosing the person who booked it.",
        )

    if provider_id is None:
        return None, None

    provider = db.get(Provider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Provider not found"
        )
    if provider.status is not ProviderStatus.ACTIVE:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{provider.provider_name} is inactive and cannot be selected for a "
                "new ticket. Reactivate it in Provider Management, or choose another."
            ),
        )

    if provider_user_id is None:
        return provider, None

    person = db.get(ProviderUser, provider_user_id)
    if person is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Provider user not found"
        )
    if person.provider_id != provider.provider_id:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{person.user_name} does not work at {provider.provider_name}. "
                "Pick a person listed against the provider you chose."
            ),
        )
    if person.status is not ProviderStatus.ACTIVE:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"{person.user_name} is inactive and cannot be selected for a new ticket.",
        )
    return provider, person


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
#: ``(key, header)`` per column, the shape ``export_service.build_export`` takes.
EXPORT_COLUMNS = {
    "providers": [
        ("provider_code", "Provider Code"),
        ("provider_name", "Provider Name"),
        ("status", "Status"),
        ("total_tickets", "Total Tickets"),
        ("total_amount", "Total Booking Amount"),
        ("user_count", "Provider Users"),
        ("created_at", "Created"),
    ],
    "provider_users": [
        ("provider_code", "Provider Code"),
        ("provider_name", "Provider Name"),
        ("user_name", "Name"),
        ("email", "Email"),
        ("phone_number", "Phone"),
        ("status", "Status"),
        ("tickets_booked", "Tickets Booked"),
        ("total_amount", "Total Amount"),
    ],
    "booking_summary": [
        ("request_number", "Booking Number"),
        ("provider_code", "Provider Code"),
        ("provider_name", "Provider Name"),
        ("provider_user_name", "Provider User"),
        ("passenger_name", "Passenger"),
        ("airline", "Airline"),
        ("travel_date", "Travel Date"),
        ("amount", "Amount"),
        ("ticket_number", "Ticket No."),
    ],
}


def export_rows(db: Session, kind: str, *, provider_id: int | None = None) -> list[dict]:
    """Rows for one of the three exports.

    Reuses the same derivation the screens read, so an export and the page it
    was taken from cannot disagree — the figures are not recomputed a second
    way here.
    """
    if kind == "providers":
        items, _ = list_providers(db, page=1, page_size=10_000)
        return [
            {**i, "total_amount": str(i["total_amount"]),
             "created_at": i["created_at"].date().isoformat() if i["created_at"] else ""}
            for i in items
        ]

    if kind == "provider_users":
        stmt = select(ProviderUser, Provider).join(
            Provider, Provider.provider_id == ProviderUser.provider_id
        )
        if provider_id is not None:
            stmt = stmt.where(ProviderUser.provider_id == provider_id)
        pairs = db.execute(stmt.order_by(Provider.provider_code, ProviderUser.provider_user_id)).all()
        totals = _totals_by_provider_user(db, [p.provider_user_id for p, _ in pairs])
        rows = []
        for person, provider in pairs:
            tickets, amount = totals.get(person.provider_user_id, (0, ZERO))
            rows.append({
                "provider_code": provider.provider_code,
                "provider_name": provider.provider_name,
                "user_name": person.user_name,
                "email": person.email,
                "phone_number": person.phone_number or "",
                "status": person.status.value,
                "tickets_booked": tickets,
                "total_amount": str(amount),
            })
        return rows

    # booking_summary
    stmt = (
        select(ServiceRequest)
        .options(
            selectinload(ServiceRequest.passengers),
            selectinload(ServiceRequest.provider),
            selectinload(ServiceRequest.provider_user),
        )
        .where(
            and_(
                ServiceRequest.provider_id.isnot(None),
                ServiceRequest.request_type == RequestType.BOOKING,
            )
        )
    )
    if provider_id is not None:
        stmt = stmt.where(ServiceRequest.provider_id == provider_id)

    rows = []
    for r in db.scalars(stmt.order_by(ServiceRequest.request_id.desc())).all():
        details = r.travel_details or {}
        lead = (r.passengers or [None])[0]
        name = None
        if lead is not None:
            name = " ".join(p for p in (lead.first_name, lead.last_name) if p).strip() or None
        rows.append({
            "request_number": r.request_number,
            "provider_code": r.provider.provider_code if r.provider else "",
            "provider_name": r.provider.provider_name if r.provider else "",
            "provider_user_name": r.provider_user.user_name if r.provider_user else "",
            "passenger_name": name or "",
            "airline": details.get("airline") or "",
            "travel_date": r.travel_date.isoformat() if r.travel_date else "",
            "amount": str(_q(r.total_amount)),
            "ticket_number": r.ticket_number or "",
        })
    return rows
