from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session


def list_pending_bookings(db: Session, status_filter: str | None, search: str | None) -> list[dict]:
    rows = db.execute(
        text("SELECT * FROM sp_admin_list_partner_bookings(:status, :search)"),
        {"status": status_filter, "search": search},
    ).mappings().all()
    return [dict(r) for r in rows]


def get_booking_detail(db: Session, booking_id: int) -> dict:
    booking = db.execute(
        text("""
            SELECT pb.*, p.company_name, pu.full_name AS requester_name, pu.email AS requester_email
            FROM partner_bookings pb
            JOIN partners p ON p.partner_id = pb.partner_id
            JOIN partner_users pu ON pu.partner_user_id = pb.partner_user_id
            WHERE pb.booking_id = :id
        """),
        {"id": booking_id},
    ).mappings().first()
    if not booking:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking not found")

    passengers = db.execute(
        text("SELECT * FROM partner_booking_passengers WHERE booking_id = :id ORDER BY passenger_id"),
        {"id": booking_id},
    ).mappings().all()

    result = dict(booking)
    result["passengers"] = [dict(p) for p in passengers]
    return result


def approve_booking(db: Session, booking_id: int, admin_id: int, total_amount: float | None) -> None:
    try:
        db.execute(
            text("SELECT sp_approve_request(:id, :admin_id, :amount)"),
            {"id": booking_id, "admin_id": admin_id, "amount": total_amount},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc.orig).split("CONTEXT")[0].strip()) from exc


def reject_booking(db: Session, booking_id: int, admin_id: int, reason: str) -> None:
    try:
        db.execute(
            text("SELECT sp_reject_request(:id, :admin_id, :reason)"),
            {"id": booking_id, "admin_id": admin_id, "reason": reason},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc.orig).split("CONTEXT")[0].strip()) from exc


def list_service_requests(db: Session, status_filter: str | None, request_type: str | None) -> list[dict]:
    rows = db.execute(
        text("""
            SELECT * FROM vw_service_requests
            WHERE (:status IS NULL OR status = :status)
              AND (:request_type IS NULL OR request_type = :request_type)
            ORDER BY created_at DESC
        """),
        {"status": status_filter, "request_type": request_type},
    ).mappings().all()
    return [dict(r) for r in rows]


def resolve_service_request(db: Session, service_request_id: int, admin_id: int, new_status: str) -> None:
    try:
        db.execute(
            text("SELECT sp_resolve_service_request(:id, :status, :admin_id)"),
            {"id": service_request_id, "status": new_status, "admin_id": admin_id},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc.orig).split("CONTEXT")[0].strip()) from exc
