"""Service functions behind the Account Center tabs (migration 0054).

Every query here is scoped by `customer_id` from the authenticated caller —
never from a path or body parameter — for the same reason
`customer_booking_service.list_for_customer` is: an id in a URL is guessable,
so ownership is a filter applied server-side, not a value trusted from the
client.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerNotification,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
    CustomerReview,
    CustomerSupportMessage,
    CustomerSupportTicket,
    CustomerWishlistItem,
)


class AccountError(Exception):
    """A request that is well-formed but cannot be satisfied — 400, not 500."""


# ---------------------------------------------------------------------------
# Payment history — reads the payment rows of ALL THREE booking products
# (flight / hotel / package), writes nothing new.
#
# WHY THREE QUERIES AND A PYTHON MERGE, NOT ONE SQL UNION
# Flight, hotel and package payments live in three separate tables
# (`customer_booking_payments`, `customer_hotel_booking_payments`,
# `customer_package_booking_payments`), each joined to its own booking table for
# the reference. A cross-product UNION would have to agree on column types across
# three dialects (SQLite in tests, PostgreSQL in production); a per-customer set
# is small and bounded, so reading each source and merging in Python is simpler,
# portable, and cannot invent a duplicate — the three tables are disjoint, so no
# row can appear twice.
# ---------------------------------------------------------------------------
#: Pagination bounds. A page is never unbounded (a page_size the caller inflates
#: is clamped), and never empty by request (a page_size of 0 falls back to the
#: default) — "safe pagination" in two numbers.
PAYMENT_PAGE_SIZE_DEFAULT = 20
PAYMENT_PAGE_SIZE_MAX = 100

_REFUNDED = CustomerPaymentStatus.REFUNDED.value


def _status_str(status) -> str:
    """The stored status as a plain string, whether the column handed us the
    enum member or its raw value — both shapes occur across the engines."""
    return status.value if hasattr(status, "value") else str(status)


def _payment_entry(service_type: str, payment, booking_ref: str) -> dict:
    """One unified payment row. Every field the Account Center and the audit
    trail need, with the service it belongs to named and refund state derived
    honestly from the payment's own status (no refund data is invented)."""
    status = _status_str(payment.status)
    return {
        "service_type": service_type,
        "booking_ref": booking_ref,
        "created_at": payment.created_at,
        "amount": payment.amount,
        "currency": payment.currency or "INR",
        "method": payment.method,
        "status": status,
        "transaction_ref": payment.provider_reference,
        # The payment row itself only knows whether it was refunded; the fuller
        # refund ledger (amounts, partials) lives in the cancellation/refund
        # tables and is out of scope for this read. Stated, not guessed.
        "refund_status": "refunded" if status == _REFUNDED else None,
    }


def _as_utc(moment: dt.datetime | None) -> dt.datetime:
    """A comparable, tz-aware instant for sorting. A naive timestamp (which some
    SQLite paths hand back) is read as UTC; a missing one sorts oldest."""
    if moment is None:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    if moment.tzinfo is None:
        return moment.replace(tzinfo=dt.timezone.utc)
    return moment


def _collect_payments(db: Session, customer: Customer) -> list[dict]:
    """Every payment this customer owns, across the three products. Ownership is
    always the booking's `customer_id` from the authenticated caller — never an
    id from the request — so one customer can never reach another's rows."""
    entries: list[dict] = []

    flight = db.execute(
        select(CustomerBookingPayment, CustomerBooking.booking_ref)
        .join(
            CustomerBooking,
            CustomerBooking.customer_booking_id == CustomerBookingPayment.customer_booking_id,
        )
        .where(CustomerBooking.customer_id == customer.customer_id)
    ).all()
    entries.extend(_payment_entry("flight", p, ref) for p, ref in flight)

    hotel = db.execute(
        select(CustomerHotelBookingPayment, CustomerHotelBooking.booking_ref)
        .join(
            CustomerHotelBooking,
            CustomerHotelBooking.customer_hotel_booking_id
            == CustomerHotelBookingPayment.hotel_booking_id,
        )
        .where(CustomerHotelBooking.customer_id == customer.customer_id)
    ).all()
    entries.extend(_payment_entry("hotel", p, ref) for p, ref in hotel)

    package = db.execute(
        select(CustomerPackageBookingPayment, CustomerPackageBooking.booking_ref)
        .join(
            CustomerPackageBooking,
            CustomerPackageBooking.customer_package_booking_id
            == CustomerPackageBookingPayment.package_booking_id,
        )
        .where(CustomerPackageBooking.customer_id == customer.customer_id)
    ).all()
    entries.extend(_payment_entry("package", p, ref) for p, ref in package)

    # Newest first, with a stable tie-break so the order is deterministic across
    # runs and engines (two payments at the same instant never swap places, so
    # pagination boundaries are repeatable).
    entries.sort(
        key=lambda e: (_as_utc(e["created_at"]), e["service_type"], e["booking_ref"],
                       str(e["transaction_ref"] or "")),
        reverse=True,
    )
    return entries


def list_payments_for_customer(
    db: Session,
    customer: Customer,
    *,
    page: int = 1,
    page_size: int = PAYMENT_PAGE_SIZE_DEFAULT,
) -> dict:
    """A page of this customer's unified payment history, newest first.

    Returns ``{"items": [...], "total": n, "page": p, "page_size": s}``. ``total``
    is the full count across all three products, so the caller can render the
    pager without a second request.
    """
    page = max(1, int(page or 1))
    page_size = min(PAYMENT_PAGE_SIZE_MAX, max(1, int(page_size or PAYMENT_PAGE_SIZE_DEFAULT)))

    rows = _collect_payments(db, customer)
    total = len(rows)
    start = (page - 1) * page_size
    items = rows[start:start + page_size]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ---------------------------------------------------------------------------
# Wishlist
# ---------------------------------------------------------------------------
def list_wishlist(db: Session, customer: Customer) -> list[CustomerWishlistItem]:
    return list(db.scalars(
        select(CustomerWishlistItem)
        .where(CustomerWishlistItem.customer_id == customer.customer_id)
        .order_by(CustomerWishlistItem.created_at.desc())
    ))


def clean_wishlist_note(note: str | None) -> str | None:
    """Normalise a note to the single canonical shape the column stores.

    Whitespace is trimmed and a blank note becomes NULL, so "no note", "",
    "   " and None are one state — the UI and every query reason about NULL
    alone and never about an empty string.
    """
    if note is None:
        return None
    cleaned = note.strip()
    return cleaned or None


def add_wishlist_item(
    db: Session, customer: Customer, item_type: str, item_id: int,
    note: str | None = None,
) -> CustomerWishlistItem:
    existing = db.scalar(
        select(CustomerWishlistItem).where(
            CustomerWishlistItem.customer_id == customer.customer_id,
            CustomerWishlistItem.item_type == item_type,
            CustomerWishlistItem.item_id == item_id,
        )
    )
    if existing:
        # Idempotent: a re-save returns the existing row untouched and does NOT
        # overwrite a note the customer already set. Changing a note is an
        # explicit action — update_wishlist_note — so a double-tap on the heart
        # can never silently erase it.
        return existing
    row = CustomerWishlistItem(
        customer_id=customer.customer_id, item_type=item_type, item_id=item_id,
        note=clean_wishlist_note(note),
    )
    db.add(row)
    db.flush()
    return row


def get_owned_wishlist_item(db: Session, customer: Customer, wishlist_id: int) -> CustomerWishlistItem | None:
    return db.scalar(
        select(CustomerWishlistItem).where(
            CustomerWishlistItem.customer_wishlist_id == wishlist_id,
            CustomerWishlistItem.customer_id == customer.customer_id,
        )
    )


def update_wishlist_note(
    db: Session, customer: Customer, wishlist_id: int, note: str | None,
) -> CustomerWishlistItem | None:
    """Set or clear the note on one of this customer's saved items.

    Ownership is enforced by ``get_owned_wishlist_item`` (customer_id filter),
    so a wishlist id that belongs to someone else — or to nobody — returns None
    and the router answers 404, exactly like a delete of a foreign row.
    """
    row = get_owned_wishlist_item(db, customer, wishlist_id)
    if row is None:
        return None
    row.note = clean_wishlist_note(note)
    db.flush()
    return row


def remove_wishlist_item(db: Session, row: CustomerWishlistItem) -> None:
    db.delete(row)


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------
def list_notifications(db: Session, customer: Customer) -> list[CustomerNotification]:
    return list(db.scalars(
        select(CustomerNotification)
        .where(CustomerNotification.customer_id == customer.customer_id)
        .order_by(CustomerNotification.created_at.desc())
    ))


def notify(
    db: Session, customer_id: int, notification_type: str, title: str, message: str,
    related_ref: str | None = None,
) -> CustomerNotification:
    """Write one notification. Called by the code the notification is about
    (booking creation, cancellation, a payment attempt) — never composed
    ahead of the event it describes."""
    # IDEMPOTENT PER EVENT. A retried request, a re-delivered gateway callback
    # or a page refresh that re-runs the same handler must not stack a second
    # copy of the same message, so the same customer + type + reference + title
    # is written once. A different title (e.g. "Payment received" after
    # "Booking received") is a different event and still gets its own row.
    existing = db.scalar(
        select(CustomerNotification).where(
            CustomerNotification.customer_id == customer_id,
            CustomerNotification.notification_type == notification_type,
            CustomerNotification.title == title,
            CustomerNotification.related_ref.is_(None) if related_ref is None
            else CustomerNotification.related_ref == related_ref,
        ).limit(1)
    )
    if existing is not None:
        return existing
    row = CustomerNotification(
        customer_id=customer_id, notification_type=notification_type,
        title=title, message=message, related_ref=related_ref,
    )
    db.add(row)
    db.flush()
    return row


def unread_notification_count(db: Session, customer: Customer) -> int:
    return db.scalar(
        select(func.count()).select_from(CustomerNotification).where(
            CustomerNotification.customer_id == customer.customer_id,
            CustomerNotification.is_read.is_(False),
        )
    ) or 0


def get_owned_notification(db: Session, customer: Customer, notification_id: int) -> CustomerNotification | None:
    return db.scalar(
        select(CustomerNotification).where(
            CustomerNotification.customer_notification_id == notification_id,
            CustomerNotification.customer_id == customer.customer_id,
        )
    )


def mark_read(db: Session, row: CustomerNotification) -> None:
    if not row.is_read:
        row.is_read = True
        row.read_at = dt.datetime.now(dt.timezone.utc)


def mark_all_read(db: Session, customer: Customer) -> None:
    for row in list_notifications(db, customer):
        mark_read(db, row)


def clear_read(db: Session, customer: Customer) -> None:
    for row in list_notifications(db, customer):
        if row.is_read:
            db.delete(row)


# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------
def list_reviews_for_item(db: Session, item_type: str, item_id: int) -> list[dict]:
    """The PUBLIC list for one item: approved reviews only (0090). A pending or
    rejected review is visible to its author on ``/reviews/mine`` and to the
    admin desk, and to nobody else."""
    rows = db.execute(
        select(CustomerReview, Customer.customer_id, Customer.full_name)
        .join(Customer, Customer.customer_id == CustomerReview.customer_id)
        .where(
            CustomerReview.item_type == item_type, CustomerReview.item_id == item_id,
            CustomerReview.status == "approved",
        )
        .order_by(CustomerReview.created_at.desc())
    ).all()
    return [
        {
            "id": review.customer_review_id, "user_id": customer_id, "user_name": full_name,
            "item_type": review.item_type, "item_id": review.item_id,
            "rating": review.rating, "comment": review.comment, "created_at": review.created_at,
            "status": review.status, "admin_reply": review.admin_reply,
        }
        for review, customer_id, full_name in rows
    ]


def list_reviews_for_customer(db: Session, customer: Customer) -> list[CustomerReview]:
    return list(db.scalars(
        select(CustomerReview)
        .where(CustomerReview.customer_id == customer.customer_id)
        .order_by(CustomerReview.created_at.desc())
    ))


def has_completed_booking_for(
    db: Session, customer: Customer, item_type: str, item_id: int
) -> bool:
    """Issue #19 — operational-completion evidence behind a review.

    True only when this customer OWNS a booking for exactly this item that
    reached ``COMPLETED`` — the status set once the service has actually been
    delivered (``customer_booking_admin_service`` marks it), NOT a travel date
    that has merely passed, and NOT a mere confirmed/paid booking. ``cruise``
    (and any unknown type) has no bookable product here and is never eligible.
    """
    done = CustomerBookingStatus.COMPLETED.value
    if item_type == "hotel":
        stmt = select(CustomerHotelBooking.customer_hotel_booking_id).where(
            CustomerHotelBooking.customer_id == customer.customer_id,
            CustomerHotelBooking.hotel_id == item_id,
            CustomerHotelBooking.status == done,
        )
    elif item_type == "package":
        stmt = select(CustomerPackageBooking.customer_package_booking_id).where(
            CustomerPackageBooking.customer_id == customer.customer_id,
            CustomerPackageBooking.package_id == item_id,
            CustomerPackageBooking.status == done,
        )
    elif item_type == "flight":
        # A flight carries no catalogue id, so a flight review is vouched for by
        # any completed flight booking this customer owns.
        stmt = select(CustomerBooking.customer_booking_id).where(
            CustomerBooking.customer_id == customer.customer_id,
            CustomerBooking.status == done,
        )
    else:  # cruise / anything else — nothing completable to review
        return False
    return db.scalar(stmt.limit(1)) is not None


def upsert_review(
    db: Session, customer: Customer, item_type: str, item_id: int, rating: int, comment: str | None,
) -> CustomerReview:
    """One review per customer per item — a second `create` on the same pair
    updates the first rather than erroring, matching the frontend's own
    "Update Review" behaviour when it already knows the id."""
    existing = db.scalar(
        select(CustomerReview).where(
            CustomerReview.customer_id == customer.customer_id,
            CustomerReview.item_type == item_type,
            CustomerReview.item_id == item_id,
        )
    )
    if existing:
        existing.rating = rating
        existing.comment = comment
        existing.status = "pending"   # an edited review is read again (0090)
        db.flush()
        return existing
    row = CustomerReview(
        customer_id=customer.customer_id, item_type=item_type, item_id=item_id,
        rating=rating, comment=comment,
    )
    db.add(row)
    db.flush()
    return row


def get_owned_review(db: Session, customer: Customer, review_id: int) -> CustomerReview | None:
    return db.scalar(
        select(CustomerReview).where(
            CustomerReview.customer_review_id == review_id,
            CustomerReview.customer_id == customer.customer_id,
        )
    )


def update_review(db: Session, row: CustomerReview, rating: int, comment: str | None) -> CustomerReview:
    row.rating = rating
    row.comment = comment
    row.status = "pending"            # an edited review is read again (0090)
    db.flush()
    return row


def delete_review(db: Session, row: CustomerReview) -> None:
    db.delete(row)


# ---------------------------------------------------------------------------
# Support tickets
# ---------------------------------------------------------------------------
def list_tickets(db: Session, customer: Customer) -> list[CustomerSupportTicket]:
    return list(db.scalars(
        select(CustomerSupportTicket)
        .where(CustomerSupportTicket.customer_id == customer.customer_id)
        .order_by(CustomerSupportTicket.created_at.desc())
    ))


def create_ticket(
    db: Session, customer: Customer, subject: str, description: str, priority: str,
) -> CustomerSupportTicket:
    row = CustomerSupportTicket(
        customer_id=customer.customer_id, subject=subject, description=description, priority=priority,
    )
    db.add(row)
    db.flush()
    # The description is the ticket's own first message, so the thread reads
    # naturally from the start rather than beginning on the first reply.
    db.add(CustomerSupportMessage(
        customer_support_ticket_id=row.customer_support_ticket_id,
        author_name=customer.full_name, is_staff=False, message=description,
    ))
    db.flush()
    return row


def get_owned_ticket(db: Session, customer: Customer, ticket_id: int) -> CustomerSupportTicket | None:
    return db.scalar(
        select(CustomerSupportTicket).where(
            CustomerSupportTicket.customer_support_ticket_id == ticket_id,
            CustomerSupportTicket.customer_id == customer.customer_id,
        )
    )


def add_ticket_message(
    db: Session, ticket: CustomerSupportTicket, customer: Customer, message: str,
) -> CustomerSupportMessage:
    row = CustomerSupportMessage(
        customer_support_ticket_id=ticket.customer_support_ticket_id,
        author_name=customer.full_name, is_staff=False, message=message,
    )
    db.add(row)
    if ticket.status == "resolved":
        ticket.status = "open"
    db.flush()
    return row
