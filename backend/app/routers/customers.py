from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.auth import MessageResponse
from app.schemas.customer import (
    CustomerEditRequest,
    CustomerEmailRequest,
    CustomerListOut,
    CustomerNotifyRequest,
    CustomerProfileOut,
    CustomerResetPasswordOut,
    CustomerStatsOut,
)
from app.schemas.pagination import Page
from app.services import activity_service, customer_service, notification_service, user_service

router = APIRouter(prefix="/api/admin/customers", tags=["admin-customers"])

PageParam = Query(default=1, ge=1)
PageSizeParam = Query(default=20, ge=1, le=100)


@router.get(
    "",
    response_model=Page[CustomerListOut],
    summary="List customers (admin)",
    description="Requires admin role. Returns a paginated, searchable, filterable, sortable list of every customer account with booking/payment/online aggregates.",
)
def list_customers(
    search: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    sort: str = "newest",
    page: int = PageParam,
    page_size: int = PageSizeParam,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    items, total = customer_service.list_customers_paginated(
        db, page, page_size, search=search, status_filter=status_filter, sort=sort
    )
    return Page.build([CustomerListOut(**item) for item in items], total, page, page_size)


@router.get(
    "/stats",
    response_model=CustomerStatsOut,
    summary="Customer management stat cards (admin)",
    description="Requires admin role. Returns aggregate customer stats for dashboard cards: totals, online, blocked, new today, top performers.",
)
def customer_stats(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return customer_service.get_customer_stats(db)


@router.get(
    "/{customer_id}",
    response_model=CustomerProfileOut,
    summary="Get full customer profile (admin)",
    description="Requires admin role. Returns the full customer profile bundle: personal info, session info, analytics, bookings, payments, activity timeline, support tickets, reviews, and wishlist.",
)
def get_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return customer_service.get_customer_profile(db, customer_id)


@router.put(
    "/{customer_id}",
    response_model=CustomerProfileOut,
    summary="Edit a customer's profile (admin)",
    description="Requires admin role. Updates a customer's personal/contact details and verification flag.",
)
def edit_customer(
    customer_id: int, payload: CustomerEditRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    user = customer_service.update_customer_by_admin(db, customer_id, payload)
    activity_service.log_activity(
        db, _admin.id, f"Admin edited customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin updated customer profile for {user.full_name} ({user.email})",
    )
    return customer_service.get_customer_profile(db, customer_id)


@router.patch(
    "/{customer_id}/activate",
    response_model=MessageResponse,
    summary="Activate a customer account (admin)",
    description="Requires admin role. Re-enables login for a deactivated customer account.",
)
def activate_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = user_service.set_user_active(db, customer_id, True)
    activity_service.log_activity(
        db, _admin.id, f"Admin activated customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin activated customer account for {user.full_name}",
    )
    return MessageResponse(message="Customer activated")


@router.patch(
    "/{customer_id}/deactivate",
    response_model=MessageResponse,
    summary="Deactivate a customer account (admin)",
    description="Requires admin role. Disables login for a customer account without deleting any data.",
)
def deactivate_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = user_service.set_user_active(db, customer_id, False)
    activity_service.log_activity(
        db, _admin.id, f"Admin deactivated customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin deactivated customer account for {user.full_name}",
    )
    return MessageResponse(message="Customer deactivated")


@router.patch(
    "/{customer_id}/block",
    response_model=MessageResponse,
    summary="Block a customer account (admin)",
    description="Requires admin role. Blocks a customer from logging in — separate from deactivation, for policy/abuse enforcement.",
)
def block_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = customer_service.set_customer_blocked(db, customer_id, True)
    activity_service.log_activity(
        db, _admin.id, f"Admin blocked customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin blocked customer account for {user.full_name}",
    )
    return MessageResponse(message="Customer blocked")


@router.patch(
    "/{customer_id}/unblock",
    response_model=MessageResponse,
    summary="Unblock a customer account (admin)",
    description="Requires admin role. Removes a block from a customer account.",
)
def unblock_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = customer_service.set_customer_blocked(db, customer_id, False)
    activity_service.log_activity(
        db, _admin.id, f"Admin unblocked customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin unblocked customer account for {user.full_name}",
    )
    return MessageResponse(message="Customer unblocked")


@router.post(
    "/{customer_id}/reset-password",
    response_model=CustomerResetPasswordOut,
    summary="Trigger a password reset for a customer (admin)",
    description="Requires admin role. Issues a password reset token for the customer, same mechanism as the self-service 'forgot password' flow. Email delivery isn't configured, so the reset link is returned directly for the admin to relay.",
)
def reset_customer_password(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = customer_service.get_customer_or_404(db, customer_id)
    reset_link = customer_service.reset_customer_password(db, customer_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin triggered password reset for {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin triggered a password reset for {user.full_name}",
    )
    return CustomerResetPasswordOut(message="Password reset link generated", reset_link=reset_link)


@router.post(
    "/{customer_id}/force-logout",
    response_model=MessageResponse,
    summary="Force-logout a customer (admin)",
    description="Requires admin role. Immediately ends every active session for the customer and invalidates any access/refresh tokens issued before now.",
)
def force_logout_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = customer_service.get_customer_or_404(db, customer_id)
    customer_service.force_logout_customer(db, customer_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin force-logged-out {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin force-logged-out {user.full_name}",
    )
    return MessageResponse(message="Customer has been logged out of all sessions")


@router.post(
    "/{customer_id}/notify",
    response_model=MessageResponse,
    summary="Send an in-app notification to a customer (admin)",
    description="Requires admin role. Sends a titled notification to this customer only.",
)
def notify_customer(
    customer_id: int, payload: CustomerNotifyRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    user = customer_service.get_customer_or_404(db, customer_id)
    notification_service.create_notification(db, customer_id, payload.title, payload.message)
    activity_service.log_activity(
        db, _admin.id, f"Admin sent notification to {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin sent a notification to {user.full_name}: {payload.title}",
    )
    return MessageResponse(message="Notification sent")


@router.post(
    "/{customer_id}/send-email",
    response_model=MessageResponse,
    summary="Send an email to a customer (admin)",
    description=(
        "Requires admin role. No SMTP/email provider is configured yet, so this is delivered as an in-app "
        "notification (same delivery channel as 'Send Notification') — swap in real SMTP later without "
        "changing this endpoint's contract."
    ),
)
def email_customer(
    customer_id: int, payload: CustomerEmailRequest, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)
):
    user = customer_service.get_customer_or_404(db, customer_id)
    notification_service.create_notification(db, customer_id, payload.subject, payload.message)
    activity_service.log_activity(
        db, _admin.id, f"Admin emailed {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin sent an email (in-app delivery) to {user.full_name}: {payload.subject}",
    )
    return MessageResponse(message="Email sent (delivered as an in-app notification)")


@router.delete(
    "/{customer_id}",
    response_model=MessageResponse,
    summary="Soft-delete a customer (admin)",
    description="Requires admin role. Marks the customer as deleted and disables login, but preserves every booking, payment, and activity record — nothing is permanently removed.",
)
def delete_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = customer_service.soft_delete_customer(db, customer_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin soft-deleted customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin soft-deleted customer account for {user.full_name}",
    )
    return MessageResponse(message="Customer soft-deleted — all history preserved")


@router.post(
    "/{customer_id}/restore",
    response_model=MessageResponse,
    summary="Restore a soft-deleted customer (admin)",
    description="Requires admin role. Reverses a soft-delete. The account still needs a separate 'Activate' to allow login again.",
)
def restore_customer(customer_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    user = customer_service.restore_customer(db, customer_id)
    activity_service.log_activity(
        db, _admin.id, f"Admin restored customer {user.email}",
        module="Admin", activity_type="Admin Action", reference_id=customer_id,
        description=f"Admin restored soft-deleted customer account for {user.full_name}",
    )
    return MessageResponse(message="Customer restored")
