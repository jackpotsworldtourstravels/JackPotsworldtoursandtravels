from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.target_schema.deps import require_user_type
from app.database.session import get_db
from app.models.target_schema.service_requests import ServiceRequest
from app.models.target_schema.users import User
from app.schemas.pagination import Page
from app.schemas.target_schema.admin_reports import (
    ActivityLogOut,
    AdminBookingOut,
    AdminNotificationCreate,
    AdminNotificationOut,
    AdminPaymentOut,
    AdminSupportTicketOut,
    BookingStatusUpdate,
    ContactMessageOut,
    MonthlyStatOut,
    NewsletterSubscriberOut,
    ReportsOut,
    SupportTicketStatusUpdate,
)
from app.services.target_schema import admin_service, msg_log_service, service_request_service, system_log_service

router = APIRouter(prefix="/api/admin", tags=["admin"])
get_current_admin = require_user_type("admin")

PageParam = Query(default=1, ge=1)
PageSizeParam = Query(default=20, ge=1, le=100)


@router.get("/bookings", response_model=Page[AdminBookingOut], summary="List all bookings (admin)")
def list_bookings(page: int = PageParam, page_size: int = PageSizeParam, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    rows, total = admin_service.list_all_bookings_paginated(db, page, page_size)
    items = [AdminBookingOut.model_validate({**b.__dict__, "user_email": email}) for b, email in rows]
    return Page.build(items, total, page, page_size)


@router.patch("/bookings/{booking_id}", response_model=AdminBookingOut, summary="Update a booking's status (admin)")
def update_booking_status(booking_id: int, payload: BookingStatusUpdate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    booking, email = admin_service.update_booking_status(db, booking_id, payload.status)
    result = AdminBookingOut.model_validate({**booking.__dict__, "user_email": email})
    system_log_service.log_activity(
        db, user_id=_admin.id, event=f"Admin updated booking #{booking_id} status to {payload.status}",
        entity_type="service_request", entity_id=booking_id, activity_type="Admin Action", module="Admin",
    )
    return result


@router.get("/payments", response_model=Page[AdminPaymentOut], summary="List all payments (admin)")
def list_payments(page: int = PageParam, page_size: int = PageSizeParam, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    rows, total = admin_service.list_all_payments_paginated(db, page, page_size)
    items = [AdminPaymentOut.model_validate({**p.__dict__, "user_email": email}) for p, email in rows]
    return Page.build(items, total, page, page_size)


@router.get("/contact", response_model=Page[ContactMessageOut], summary="List contact messages (admin)")
def list_contact_messages(page: int = PageParam, page_size: int = PageSizeParam, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    items, total = admin_service.list_contact_messages_paginated(db, page, page_size)
    return Page.build([ContactMessageOut.model_validate(i) for i in items], total, page, page_size)


@router.delete("/contact/{message_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a contact message (admin)")
def delete_contact_message(message_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    admin_service.delete_contact_message(db, message_id)
    system_log_service.log_activity(
        db, user_id=_admin.id, event=f"Admin deleted contact message #{message_id}",
        activity_type="Admin Action", module="Admin",
    )


@router.get("/newsletter", response_model=list[NewsletterSubscriberOut], summary="List newsletter subscribers (admin)")
def list_newsletter_subscribers(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return [NewsletterSubscriberOut.model_validate(s) for s in admin_service.list_newsletter_subscribers(db)]


@router.get("/reports", response_model=ReportsOut, summary="Get the admin dashboard summary (admin)")
def get_reports(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.build_reports(db)


@router.get("/reports/monthly", response_model=list[MonthlyStatOut], summary="Get monthly revenue/booking stats (admin)")
def get_monthly_stats(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_service.monthly_stats(db)


@router.get("/reports/export/{kind}", summary="Export a report as CSV (admin)")
def export_report(
    kind: Literal["users", "bookings", "payments", "contact"],
    db: Session = Depends(get_db), _admin: User = Depends(get_current_admin),
):
    csv_text = admin_service.CSV_EXPORTERS[kind](db)
    return Response(
        content=csv_text, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{kind}.csv"'},
    )


@router.get("/support-tickets", response_model=Page[AdminSupportTicketOut], summary="List all support tickets (admin)")
def list_all_support_tickets(page: int = PageParam, page_size: int = PageSizeParam, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    stmt = (
        select(ServiceRequest, User.email).join(User, ServiceRequest.user_id == User.id)
        .where(ServiceRequest.request_type == "support_ticket")
        .order_by(ServiceRequest.created_at.desc())
    )
    total = db.scalar(
        select(func.count()).select_from(ServiceRequest).where(ServiceRequest.request_type == "support_ticket")
    ) or 0
    stmt = stmt.limit(page_size).offset((page - 1) * page_size)
    items = [AdminSupportTicketOut.model_validate({**t.__dict__, "user_email": email}) for t, email in db.execute(stmt).all()]
    return Page.build(items, total, page, page_size)


@router.patch("/support-tickets/{ticket_id}", response_model=AdminSupportTicketOut, summary="Update a support ticket's status (admin)")
def update_support_ticket_status(ticket_id: int, payload: SupportTicketStatusUpdate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    ticket = service_request_service.update_status(db, ticket_id, payload.status, actor_user_id=_admin.id)
    system_log_service.log_activity(
        db, user_id=_admin.id, event=f"Admin updated support ticket #{ticket_id} to {payload.status}",
        activity_type="Admin Action", module="Admin",
    )
    email = db.get(User, ticket.user_id).email
    return AdminSupportTicketOut.model_validate({**ticket.__dict__, "user_email": email})


@router.get("/notifications", response_model=Page[AdminNotificationOut], summary="List all notifications (admin)")
def list_all_notifications(page: int = PageParam, page_size: int = PageSizeParam, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    rows, total = msg_log_service.list_all_notifications_paginated(db, page, page_size)
    items = [AdminNotificationOut.model_validate({**n.__dict__, "user_email": email}) for n, email in rows]
    return Page.build(items, total, page, page_size)


@router.post("/notifications", status_code=status.HTTP_201_CREATED, summary="Send a notification (admin)")
def send_notification(payload: AdminNotificationCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    count = msg_log_service.send_admin_broadcast(db, payload.user_id, payload.title, payload.message)
    system_log_service.log_activity(
        db, user_id=_admin.id, event=f"Admin sent notification to {count} user(s)",
        activity_type="Admin Action", module="Admin",
    )
    return {"message": f"Notification sent to {count} user(s)"}


@router.get("/activity-logs/recent", response_model=list[ActivityLogOut], summary="Recent activity feed (admin)")
def recent_activity(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    rows = system_log_service.list_recent_activity(db, limit=limit)
    return [
        ActivityLogOut.model_validate({**log.__dict__, "user_email": email, "user_name": full_name})
        for log, email, full_name in rows
    ]


@router.get("/activity-logs", response_model=Page[ActivityLogOut], summary="List activity logs (admin)")
def list_activity_logs(
    search: str | None = None, action: str | None = None, module: str | None = None,
    page: int = PageParam, page_size: int = PageSizeParam,
    db: Session = Depends(get_db), _admin: User = Depends(get_current_admin),
):
    rows, total = system_log_service.list_activity_logs_paginated(db, page, page_size, search=search, action=action, module=module)
    items = [
        ActivityLogOut.model_validate({**log.__dict__, "user_email": email, "user_name": full_name})
        for log, email, full_name in rows
    ]
    return Page.build(items, total, page, page_size)


@router.get("/activity-logs/actions", response_model=list[str], summary="List distinct activity log actions (admin)")
def list_activity_log_actions(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return system_log_service.list_distinct_actions(db)


@router.get("/activity-logs/modules", response_model=list[str], summary="List distinct activity log modules (admin)")
def list_activity_log_modules(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return system_log_service.list_distinct_modules(db)
