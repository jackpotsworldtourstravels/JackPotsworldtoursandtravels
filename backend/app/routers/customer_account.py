"""Customer Account Center — ``/api/customer/{payments,wishlist,notifications,
reviews,support-tickets}``.

Fixes four tabs in index.html's Account Center that have called a
non-existent or wrong-portal endpoint since before this router existed
(``/api/payments/history``, ``/api/wishlist``, ``/api/notifications``,
``/api/reviews/mine``, ``/api/support-tickets`` — see migration 0054). My
Bookings needed no new route; it now calls the real
``GET /api/customer/bookings`` from 0053 directly.

Every route resolves the caller via ``Depends(get_current_customer)`` — there
is no customer id anywhere in a path or a body, so there is nothing for one
customer to change to reach another's rows.

Reviews has one route with no auth at all: ``GET /reviews`` (by item), which
is what a product page shows a visitor before they sign in — the same
"catalogue is public, the booking is not" split ``customer_bookings.py``
already draws for seat maps and add-ons.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_account import (
    NotificationResponse,
    PaymentHistoryEntry,
    ReviewCreate,
    ReviewResponse,
    ReviewUpdate,
    SupportMessageCreate,
    SupportMessageResponse,
    SupportTicketCreate,
    SupportTicketResponse,
    WishlistCreate,
    WishlistResponse,
)
from app.services import customer_account_service as acct

router = APIRouter(prefix="/api/customer", tags=["customer-account"])


# ---------------------------------------------------------------------------
# Payment history
# ---------------------------------------------------------------------------
@router.get(
    "/payments/history",
    response_model=list[PaymentHistoryEntry],
    summary="My payment history",
    description="Requires a customer session. Every payment attempt across this "
                "customer's bookings, newest first — the same rows each booking's "
                "own `payments` array carries, flattened across bookings for this tab.",
)
def payment_history(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return acct.list_payments_for_customer(db, customer)


# ---------------------------------------------------------------------------
# Wishlist
# ---------------------------------------------------------------------------
@router.get("/wishlist", response_model=list[WishlistResponse], summary="My wishlist")
def get_wishlist(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return acct.list_wishlist(db, customer)


@router.post(
    "/wishlist", response_model=WishlistResponse, status_code=status.HTTP_201_CREATED,
    summary="Save an item to the wishlist",
)
def post_wishlist(
    payload: WishlistCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.add_wishlist_item(db, customer, payload.item_type, payload.item_id)
    db.commit()
    db.refresh(row)
    return row


@router.delete(
    "/wishlist/{wishlist_id}", status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a saved item",
    responses={404: {"description": "Not on this customer's wishlist."}},
)
def delete_wishlist(
    wishlist_id: int,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.get_owned_wishlist_item(db, customer, wishlist_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Wishlist item not found.")
    acct.remove_wishlist_item(db, row)
    db.commit()


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------
@router.get("/notifications", response_model=list[NotificationResponse], summary="My notifications")
def get_notifications(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return acct.list_notifications(db, customer)


@router.patch(
    "/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT,
    summary="Mark every notification read",
)
def mark_all_notifications_read(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    acct.mark_all_read(db, customer)
    db.commit()


@router.delete(
    "/notifications/read", status_code=status.HTTP_204_NO_CONTENT,
    summary="Clear every read notification",
)
def clear_read_notifications(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    acct.clear_read(db, customer)
    db.commit()


@router.patch(
    "/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT,
    summary="Mark one notification read",
    responses={404: {"description": "Not this customer's notification."}},
)
def mark_notification_read(
    notification_id: int,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.get_owned_notification(db, customer, notification_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
    acct.mark_read(db, row)
    db.commit()


# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------
@router.get(
    "/reviews", response_model=list[ReviewResponse],
    summary="Reviews for one catalogue item (public)",
)
def get_item_reviews(
    item_type: str = Query(..., pattern="^(flight|hotel|cruise|package)$"),
    item_id: int = Query(...),
    db: Session = Depends(get_db),
):
    return acct.list_reviews_for_item(db, item_type, item_id)


@router.get("/reviews/mine", response_model=list[ReviewResponse], summary="My reviews")
def get_my_reviews(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return acct.list_reviews_for_customer(db, customer)


@router.post(
    "/reviews", response_model=ReviewResponse, status_code=status.HTTP_201_CREATED,
    summary="Write (or update) a review",
    description="One review per customer per item — posting again on the same "
                "item updates it rather than creating a second one.",
)
def post_review(
    payload: ReviewCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.upsert_review(db, customer, payload.item_type, payload.item_id, payload.rating, payload.comment)
    db.commit()
    db.refresh(row)
    return ReviewResponse(
        id=row.customer_review_id, user_id=customer.customer_id, user_name=customer.full_name,
        item_type=row.item_type, item_id=row.item_id, rating=row.rating,
        comment=row.comment, created_at=row.created_at,
    )


@router.put(
    "/reviews/{review_id}", response_model=ReviewResponse,
    summary="Edit my review",
    responses={404: {"description": "Not this customer's review."}},
)
def put_review(
    review_id: int,
    payload: ReviewUpdate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.get_owned_review(db, customer, review_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review not found.")
    row = acct.update_review(db, row, payload.rating, payload.comment)
    db.commit()
    db.refresh(row)
    return ReviewResponse(
        id=row.customer_review_id, user_id=customer.customer_id, user_name=customer.full_name,
        item_type=row.item_type, item_id=row.item_id, rating=row.rating,
        comment=row.comment, created_at=row.created_at,
    )


@router.delete(
    "/reviews/{review_id}", status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete my review",
    responses={404: {"description": "Not this customer's review."}},
)
def delete_review(
    review_id: int,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.get_owned_review(db, customer, review_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review not found.")
    acct.delete_review(db, row)
    db.commit()


# ---------------------------------------------------------------------------
# Support tickets
# ---------------------------------------------------------------------------
@router.get("/support-tickets", response_model=list[SupportTicketResponse], summary="My support tickets")
def get_support_tickets(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return acct.list_tickets(db, customer)


@router.post(
    "/support-tickets", response_model=SupportTicketResponse, status_code=status.HTTP_201_CREATED,
    summary="Raise a support ticket",
)
def post_support_ticket(
    payload: SupportTicketCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.create_ticket(db, customer, payload.subject, payload.description, payload.priority)
    db.commit()
    db.refresh(row)
    return row


@router.get(
    "/support-tickets/{ticket_id}", response_model=SupportTicketResponse,
    summary="One ticket, with its thread",
    responses={404: {"description": "Not this customer's ticket."}},
)
def get_support_ticket(
    ticket_id: int,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    row = acct.get_owned_ticket(db, customer, ticket_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found.")
    return row


@router.post(
    "/support-tickets/{ticket_id}/messages", response_model=SupportMessageResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Reply on a ticket",
    responses={404: {"description": "Not this customer's ticket."}},
)
def post_support_message(
    ticket_id: int,
    payload: SupportMessageCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    ticket = acct.get_owned_ticket(db, customer, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found.")
    row = acct.add_ticket_message(db, ticket, customer, payload.message)
    db.commit()
    db.refresh(row)
    return row
