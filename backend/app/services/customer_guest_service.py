"""Continue as guest — an anonymous customer, and the way out of it.

    start_guest(db)                 a new anonymous customer + a real session
    claim_guest(db, guest, owner)   move everything it did onto an account
    is_guest_token(customer)        the question every credential screen asks

WHY A GUEST IS A ROW IN ``customers``. Because everything a guest does has to
belong to somebody: the wishlist, the bookings, the notifications, the reviews
and the support threads are all filed under ``customer_id``, and the whole
Account Center reads them through ``get_current_customer``. Give the guest its
own anonymous customer row and a normal customer token, and every one of those
screens works with NO new endpoint, NO second code path and — the part that
matters — no new isolation rule to get wrong. Guest A cannot see Guest B for
exactly the reason one account cannot see another.

WHAT IT IS NOT. Not a registered account: no ``customer_auth`` row, no
password, no verified address, no way back into it from another browser, and
nothing is ever emailed to the placeholder address. Losing the token is losing
the session, which is what "guest" means.

THE TOKEN IS THE SESSION, AND THE SERVER MINTS IT. The browser never says who
it is: it asks for a guest session and is handed the same signed access/refresh
pair a sign-in produces, carrying the same ``scope: "customer"`` claim and
resolved by the same dependency. A `guest_session_id` invented in JavaScript
and trusted by the API would be a login with no password — this is the
opposite of that.

WHAT A GUEST STILL CANNOT DO. Anything that changes credentials or an identity
it does not have: change a password it has never set, or verify an address that
is a placeholder. Those screens refuse with 409 and say to create an account —
see ``assert_not_guest``.
"""
from __future__ import annotations

import logging
import secrets

from fastapi import HTTPException, status
from sqlalchemy import text, update
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerAssistantSession,
    CustomerAuditLog,
    CustomerBooking,
    CustomerCall,
    CustomerConversation,
    CustomerHotelBooking,
    CustomerNotification,
    CustomerPackageBooking,
    CustomerProfile,
    CustomerReview,
    CustomerStatus,
    CustomerSupportTicket,
    CustomerTraveller,
    CustomerWishlistItem,
)
from app.services import customer_auth_service

log = logging.getLogger(__name__)

#: What a guest is called, everywhere it is shown. One constant, because the
#: header, the profile screen and the booking documents must not disagree.
GUEST_NAME = "My Guest"

#: RFC 2606 reserves `.invalid`, so this can never be a deliverable address and
#: can never collide with a real one. It exists to satisfy NOT NULL and is
#: never shown to anybody — see `customer_response`.
_GUEST_EMAIL_DOMAIN = "guest.invalid"

#: Tables that hold what a guest DID, in the order they are moved. Each is
#: (model, "column"), and the column is always the owning customer.
#:
#: NOT IN THIS LIST, DELIBERATELY: customer_auth, customer_otps,
#: customer_password_resets and customer_sessions. A guest has none of them —
#: that is what makes it a guest — and moving a credential row between people
#: is the one thing this function must never do.
_OWNED: tuple[tuple[type, str], ...] = (
    (CustomerWishlistItem, "customer_id"),
    (CustomerBooking, "customer_id"),
    (CustomerHotelBooking, "customer_id"),
    (CustomerPackageBooking, "customer_id"),
    (CustomerNotification, "customer_id"),
    (CustomerReview, "customer_id"),
    (CustomerSupportTicket, "customer_id"),
    (CustomerConversation, "customer_id"),
    (CustomerCall, "customer_id"),
    (CustomerTraveller, "customer_id"),
    (CustomerAssistantSession, "customer_id"),
    (CustomerAuditLog, "customer_id"),
)


def assert_not_guest(customer: Customer, what: str = "This") -> None:
    """Refuse an action that needs an account rather than a session.

    409 rather than 401 or 403: the caller IS authenticated and IS allowed to
    be here — the request simply asks for something a session without
    credentials cannot have. The message names the way forward, because a
    guest can always create an account and keep everything they have done.
    """
    if customer.is_guest:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{what} needs an account. Create one and your saved items, "
                   "searches and bookings come with you.",
        )


def _placeholder() -> str:
    #: 12 bytes, not 16. `customers.mobile` is varchar(30) and the placeholder
    #: has to fit inside it with its prefix — 24 hex characters plus "g-" is
    #: 26, and the collision odds at this length are not a real number.
    return secrets.token_hex(12)


def start_guest(db: Session) -> tuple[Customer, str, str]:
    """A fresh anonymous customer, and the tokens that are its session."""
    tag = _placeholder()
    guest = Customer(
        customer_code=customer_auth_service.next_customer_code(db),
        full_name=GUEST_NAME,
        # NOT NULL columns with nothing honest to put in them. Unique among
        # guests, invisible everywhere, and excluded from the real customers'
        # unique indexes by 0079.
        email=f"guest-{tag}@{_GUEST_EMAIL_DOMAIN}",
        mobile=f"g-{tag}",
        status=CustomerStatus.ACTIVE,
        is_guest=True,
    )
    db.add(guest)
    db.flush()
    # The Account Center reads a profile row for half its fields and renders an
    # empty screen without one. A guest gets the same empty profile a new
    # account gets, rather than a different shape of nothing.
    db.add(CustomerProfile(customer_id=guest.customer_id))
    db.commit()
    db.refresh(guest)

    access, refresh = customer_auth_service.issue_tokens(guest)
    log.info("guest session started: customer_id=%s", guest.customer_id)
    return guest, access, refresh


def claim_guest(db: Session, guest: Customer, owner: Customer) -> dict[str, int]:
    """Move everything a guest did onto a real account. Returns the counts.

    CALLED WHEN A GUEST SIGNS IN OR SIGNS UP, and this is the point the brief
    calls migration. Nothing is copied and nothing is duplicated: each row's
    ``customer_id`` is repointed, in one transaction, so a wishlist item exists
    once before and once after.

    IT REFUSES ANYTHING THAT IS NOT A GUEST. Passing two real customers here
    would move one person's bookings to another, which is why the check is a
    guard in the function rather than a rule for its callers to remember.
    """
    if not guest.is_guest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That session is not a guest session.",
        )
    if owner.is_guest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A guest session cannot inherit another guest session.",
        )
    if guest.customer_id == owner.customer_id:
        return {}

    moved: dict[str, int] = {}
    for model, column in _OWNED:
        result = db.execute(
            update(model)
            .where(getattr(model, column) == guest.customer_id)
            .values(**{column: owner.customer_id})
        )
        if result.rowcount:
            moved[model.__tablename__] = result.rowcount

    # The empty shell is retired rather than deleted: its customer_code may
    # already be printed on something a booking generated while it was the
    # owner, and a dangling code is worse than a closed row. Its placeholder
    # address is excluded from the real unique indexes, so it blocks nothing.
    # INACTIVE, which is the enum's own word for "closed". There is no DELETED
    # member and there should not be one: the row is retired rather than
    # removed because its customer_code may already be printed on something a
    # booking produced while it was the owner. Inactive also ends the session
    # at once — the token resolver refuses anything that is not ACTIVE — so the
    # old guest token stops working the moment its data belongs to somebody.
    guest.status = CustomerStatus.INACTIVE
    guest.full_name = f"{GUEST_NAME} (migrated)"
    db.commit()
    log.info("guest %s claimed by customer %s: %s",
             guest.customer_id, owner.customer_id, moved or "nothing to move")
    return moved


def guest_from_token(db: Session, token: str | None) -> Customer | None:
    """The guest a token names, or None — never raises on a bad token.

    Used by the claim endpoint, which is handed the OLD guest token alongside
    the NEW account's. A token that has expired, was tampered with, or names a
    real customer simply means there is nothing to migrate: a claim is a
    convenience on top of a sign-in that has already succeeded, so it must
    never be the thing that makes signing in fail.
    """
    if not token:
        return None
    from app.auth.security import CUSTOMER_SCOPE, decode_token

    payload = decode_token(token)
    if not payload or payload.get("scope") != CUSTOMER_SCOPE:
        return None
    try:
        customer = db.get(Customer, int(payload["sub"]))
    except (KeyError, TypeError, ValueError):
        return None
    return customer if (customer and customer.is_guest) else None


def purge_stale_guests(db: Session, older_than_days: int = 30) -> int:
    """Delete abandoned guest rows that never did anything. Returns the count.

    NOT WIRED TO A SCHEDULE HERE — it is a function an operator or a future job
    can call. A guest that booked, saved or wrote anything is left alone
    whatever its age: those rows are somebody's trip, and the table is small
    either way. This exists so that "a row per Continue-as-guest click" has a
    documented answer rather than becoming a surprise in a year.
    """
    result = db.execute(text("""
        DELETE FROM customers c
         WHERE c.is_guest
           AND c.created_at < now() - make_interval(days => :days)
           AND NOT EXISTS (SELECT 1 FROM customer_bookings b WHERE b.customer_id = c.customer_id)
           AND NOT EXISTS (SELECT 1 FROM customer_hotel_bookings h WHERE h.customer_id = c.customer_id)
           AND NOT EXISTS (SELECT 1 FROM customer_package_bookings p WHERE p.customer_id = c.customer_id)
           AND NOT EXISTS (SELECT 1 FROM customer_wishlist w WHERE w.customer_id = c.customer_id)
           AND NOT EXISTS (SELECT 1 FROM customer_support_tickets t WHERE t.customer_id = c.customer_id)
           AND NOT EXISTS (SELECT 1 FROM customer_reviews r WHERE r.customer_id = c.customer_id)
    """), {"days": older_than_days})
    db.commit()
    return result.rowcount
