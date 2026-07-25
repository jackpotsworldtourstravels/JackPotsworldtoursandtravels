from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas.partner_service_request import (
    CancellationRequestCreate,
    DateChangeRequestCreate,
    PassengerModificationRequestCreate,
    RefundRequestCreate,
)


def cancel_passengers(db: Session, partner_id: int, partner_user_id: int, payload: CancellationRequestCreate) -> str:
    _verify_reference_belongs_to_partner(db, partner_id, payload.reference_number)
    sr_number = db.execute(
        text("SELECT sp_cancel_selected_passengers(:ref, :ids, :reason, :user_id)"),
        {
            "ref": payload.reference_number, "ids": payload.passenger_ids,
            "reason": payload.reason, "user_id": partner_user_id,
        },
    ).scalar()
    db.commit()
    return sr_number


def create_date_change(db: Session, partner_id: int, partner_user_id: int, payload: DateChangeRequestCreate) -> str:
    _verify_reference_belongs_to_partner(db, partner_id, payload.reference_number)
    sr_number = db.execute(
        text("SELECT sp_create_date_change_request(:ref, :passenger_id, :new_date, :reason, :user_id)"),
        {
            "ref": payload.reference_number, "passenger_id": payload.passenger_id,
            "new_date": payload.new_travel_date, "reason": payload.reason, "user_id": partner_user_id,
        },
    ).scalar()
    db.commit()
    return sr_number


def create_refund(db: Session, partner_id: int, partner_user_id: int, payload: RefundRequestCreate) -> str:
    _verify_reference_belongs_to_partner(db, partner_id, payload.reference_number)
    sr_number = db.execute(
        text("SELECT sp_create_refund_request(:ref, :amount, :reason, :user_id)"),
        {"ref": payload.reference_number, "amount": payload.amount, "reason": payload.reason, "user_id": partner_user_id},
    ).scalar()
    db.commit()
    return sr_number


def create_passenger_modification(
    db: Session, partner_id: int, partner_user_id: int, payload: PassengerModificationRequestCreate
) -> str:
    _verify_reference_belongs_to_partner(db, partner_id, payload.reference_number)
    sr_number = db.execute(
        text("""
            SELECT sp_create_passenger_modification_request(
                :ref, :passenger_id, :field_changed, :old_value, :new_value, :reason, :user_id
            )
        """),
        {
            "ref": payload.reference_number, "passenger_id": payload.passenger_id,
            "field_changed": payload.field_changed, "old_value": payload.old_value,
            "new_value": payload.new_value, "reason": payload.reason, "user_id": partner_user_id,
        },
    ).scalar()
    db.commit()
    return sr_number


def _verify_reference_belongs_to_partner(db: Session, partner_id: int, reference_number: str) -> None:
    """The stored procedures resolve a booking purely by reference_number —
    without this check here, a partner could target another partner's
    booking just by guessing/knowing its reference number. Same RBAC
    boundary as _get_own_booking_or_404 in partner_booking_service."""
    owner = db.execute(
        text("SELECT partner_id FROM partner_bookings WHERE reference_number = :ref"), {"ref": reference_number}
    ).scalar()
    if owner is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking reference not found")
    if owner != partner_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Booking reference not found")
