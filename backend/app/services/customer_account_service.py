"""Service functions behind the Account Center tabs (migration 0054).

Every query here is scoped by `customer_id` from the authenticated caller —
never from a path or body parameter — for the same reason
`customer_booking_service.list_for_customer` is: an id in a URL is guessable,
so ownership is a filter applied server-side, not a value trusted from the
client.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerNotification,
    CustomerReview,
    CustomerSupportMessage,
    CustomerSupportTicket,
    CustomerWishlistItem,
)


class AccountError(Exception):
    """A request that is well-formed but cannot be satisfied — 400, not 500."""


# ---------------------------------------------------------------------------
# Payment history — reads 0053's payment rows, writes nothing new.
# ---------------------------------------------------------------------------
def list_payments_for_customer(db: Session, customer: Customer) -> list[dict]:
    rows = db.execute(
        select(CustomerBookingPayment, CustomerBooking.booking_ref)
        .join(CustomerBooking, CustomerBooking.customer_booking_id == CustomerBookingPayment.customer_booking_id)
        .where(CustomerBooking.customer_id == customer.customer_id)
        .order_by(CustomerBookingPayment.created_at.desc())
    ).all()
    return [
        {
            "booking_ref": booking_ref,
            "created_at": payment.created_at,
            "amount": payment.amount,
            "method": payment.method,
            "status": payment.status,
            "transaction_ref": payment.provider_reference,
        }
        for payment, booking_ref in rows
    ]


# ---------------------------------------------------------------------------
# Wishlist
# ---------------------------------------------------------------------------
def list_wishlist(db: Session, customer: Customer) -> list[CustomerWishlistItem]:
    return list(db.scalars(
        select(CustomerWishlistItem)
        .where(CustomerWishlistItem.customer_id == customer.customer_id)
        .order_by(CustomerWishlistItem.created_at.desc())
    ))


def add_wishlist_item(db: Session, customer: Customer, item_type: str, item_id: int) -> CustomerWishlistItem:
    existing = db.scalar(
        select(CustomerWishlistItem).where(
            CustomerWishlistItem.customer_id == customer.customer_id,
            CustomerWishlistItem.item_type == item_type,
            CustomerWishlistItem.item_id == item_id,
        )
    )
    if existing:
        return existing
    row = CustomerWishlistItem(customer_id=customer.customer_id, item_type=item_type, item_id=item_id)
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
    row = CustomerNotification(
        customer_id=customer_id, notification_type=notification_type,
        title=title, message=message, related_ref=related_ref,
    )
    db.add(row)
    db.flush()
    return row


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
    rows = db.execute(
        select(CustomerReview, Customer.customer_id, Customer.full_name)
        .join(Customer, Customer.customer_id == CustomerReview.customer_id)
        .where(CustomerReview.item_type == item_type, CustomerReview.item_id == item_id)
        .order_by(CustomerReview.created_at.desc())
    ).all()
    return [
        {
            "id": review.customer_review_id, "user_id": customer_id, "user_name": full_name,
            "item_type": review.item_type, "item_id": review.item_id,
            "rating": review.rating, "comment": review.comment, "created_at": review.created_at,
        }
        for review, customer_id, full_name in rows
    ]


def list_reviews_for_customer(db: Session, customer: Customer) -> list[CustomerReview]:
    return list(db.scalars(
        select(CustomerReview)
        .where(CustomerReview.customer_id == customer.customer_id)
        .order_by(CustomerReview.created_at.desc())
    ))


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
