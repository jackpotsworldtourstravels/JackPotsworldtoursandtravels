from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.database.session import get_db
from app.models.user import User
from app.schemas.admin_partner import (
    AdminPartnerBookingDetailOut,
    AdminPartnerBookingListItemOut,
    AdminServiceRequestListItemOut,
    ApproveBookingRequest,
    MessageResponse,
    RejectBookingRequest,
    ResolveServiceRequestRequest,
)
from app.services import admin_partner_service

router = APIRouter(prefix="/api/admin/partner-requests", tags=["admin-partner-requests"])


@router.get("/bookings", response_model=list[AdminPartnerBookingListItemOut], summary="List partner booking requests")
def list_bookings(
    status: str | None = "pending_approval",
    search: str | None = None,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    return admin_partner_service.list_pending_bookings(db, status, search)


@router.get("/bookings/{booking_id}", response_model=AdminPartnerBookingDetailOut, summary="Partner booking detail")
def get_booking(booking_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    return admin_partner_service.get_booking_detail(db, booking_id)


@router.post("/bookings/{booking_id}/approve", response_model=MessageResponse, summary="Approve a pending partner booking")
def approve_booking(
    booking_id: int,
    payload: ApproveBookingRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    admin_partner_service.approve_booking(db, booking_id, _admin.id, payload.total_amount)
    return MessageResponse(message="Booking approved.")


@router.post("/bookings/{booking_id}/reject", response_model=MessageResponse, summary="Reject a pending partner booking")
def reject_booking(
    booking_id: int,
    payload: RejectBookingRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    admin_partner_service.reject_booking(db, booking_id, _admin.id, payload.reason)
    return MessageResponse(message="Booking rejected.")


@router.get("/service-requests", response_model=list[AdminServiceRequestListItemOut], summary="List partner service requests")
def list_service_requests(
    status: str | None = "submitted",
    request_type: str | None = None,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    return admin_partner_service.list_service_requests(db, status, request_type)


@router.post(
    "/service-requests/{service_request_id}/resolve",
    response_model=MessageResponse,
    summary="Approve/reject/complete a partner service request",
)
def resolve_service_request(
    service_request_id: int,
    payload: ResolveServiceRequestRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    admin_partner_service.resolve_service_request(db, service_request_id, _admin.id, payload.status)
    return MessageResponse(message="Service request resolved.")
