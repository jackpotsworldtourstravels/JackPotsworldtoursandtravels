from app.services.target_schema import service_request_service
from app.services.target_schema.merchant_booking_service import verify_reference_belongs_to_merchant


def cancel_passengers(db, merchant_id: int, user_id: int, *, reference_number: str, passenger_ids: list[int], reason: str):
    booking = verify_reference_belongs_to_merchant(db, merchant_id, reference_number)
    request = service_request_service.create_subtype_request(
        db, request_type="cancellation", channel="merchant", user_id=user_id, merchant_id=merchant_id,
        parent_request_id=booking.id, reason=reason, details={"passenger_ids": passenger_ids},
    )
    return request.request_number


def create_date_change(db, merchant_id: int, user_id: int, *, reference_number: str, passenger_id: int, new_travel_date, reason: str):
    booking = verify_reference_belongs_to_merchant(db, merchant_id, reference_number)
    request = service_request_service.create_subtype_request(
        db, request_type="date_change", channel="merchant", user_id=user_id, merchant_id=merchant_id,
        parent_request_id=booking.id, reason=reason, new_travel_date=new_travel_date,
        details={"passenger_id": passenger_id},
    )
    return request.request_number


def create_refund(db, merchant_id: int, user_id: int, *, reference_number: str, amount: float, reason: str):
    booking = verify_reference_belongs_to_merchant(db, merchant_id, reference_number)
    request = service_request_service.create_subtype_request(
        db, request_type="refund", channel="merchant", user_id=user_id, merchant_id=merchant_id,
        parent_request_id=booking.id, reason=reason, amount_requested=amount,
    )
    return request.request_number


def create_passenger_modification(
    db, merchant_id: int, user_id: int, *, reference_number: str, passenger_id: int,
    field_changed: str, old_value: str | None, new_value: str | None, reason: str,
):
    booking = verify_reference_belongs_to_merchant(db, merchant_id, reference_number)
    request = service_request_service.create_subtype_request(
        db, request_type="passenger_modification", channel="merchant", user_id=user_id, merchant_id=merchant_id,
        parent_request_id=booking.id, reason=reason,
        details={"passenger_id": passenger_id, "field_changed": field_changed, "old_value": old_value, "new_value": new_value},
    )
    return request.request_number
