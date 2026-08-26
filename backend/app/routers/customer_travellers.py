"""The customer's saved traveller list — ``/api/customer/travellers/*``.

Scoped to the caller the same way ``customer_profile`` is: the collection route
carries no customer id, and the two routes that do take a traveller id resolve
it through ``get_owned``, which filters on the session's own customer. A
guessed id from another account resolves to 404, not to someone else's passport.
"""
import datetime as dt

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy.orm import Session

from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.models_customer import Customer
from app.schemas.customer_booking import TravellerCreate, TravellerResponse
from app.schemas.customer_passport_ocr import OcrAvailabilityOut, PassportExtractionOut
from app.services import activity_service, customer_audit_service, customer_passport_ocr_service
from app.services import customer_traveller_service as service

router = APIRouter(prefix="/api/customer/travellers", tags=["customer-travellers"])


@router.get(
    "",
    response_model=list[TravellerResponse],
    summary="My saved travellers",
    description=(
        "Requires a customer session. The people this customer has saved, so the booking form "
        "can offer them instead of asking for the same passport again."
    ),
)
def list_travellers(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    return service.list_for_customer(db, customer)


@router.get(
    "/lookup",
    response_model=TravellerResponse,
    summary="Find a saved traveller by passport number",
    description=(
        "Requires a customer session. Powers the traveller form's passport auto-fill: the "
        "customer types a passport number and, **if they have saved that passport before**, "
        "their own previously entered details come back.\n\n"
        "This searches one customer's own list and nothing else. It does not read any other "
        "account, and it derives nothing from the passport number itself — a passport number "
        "does not encode a name or a date of birth, so a number that has not been saved "
        "returns `404` and the traveller fills the form in."
    ),
    responses={404: {"description": "No saved traveller with that passport number."}},
)
def lookup_by_passport(
    passport_number: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    traveller = service.find_by_passport(db, customer, passport_number)
    if traveller is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No saved traveller with that passport number.",
        )
    return traveller


@router.get(
    "/passport/availability",
    response_model=OcrAvailabilityOut,
    summary="Should the traveller step offer a Scan control?",
    description=(
        "No session required — a guest fills in traveller details before signing in on some "
        "flows, and the traveller step needs to know whether to render the Scan button before "
        "that. Reads `false` on a deployment with no OCR provider configured, so the button "
        "never appears rather than appearing and failing when pressed."
    ),
)
def passport_ocr_availability():
    return OcrAvailabilityOut(available=customer_passport_ocr_service.is_available())


@router.post(
    "/passport/extract",
    response_model=PassportExtractionOut,
    summary="Scan a passport to prefill the traveller form",
    description=(
        "Requires a customer session. Uploads a passport photo or PDF and reads back the "
        "fields the traveller form can use — first/last name, gender, date of birth, "
        "nationality, passport number, expiry and issuing country. Nothing is written to the "
        "database and the image is not stored; the traveller's own review and Save is what "
        "keeps anything. A failed or unclear scan returns an error the form can show without "
        "blocking manual entry — scanning is a shortcut over a form that works without it."
    ),
    responses={
        415: {"description": "Unsupported file type — PDF, JPEG, PNG or WebP only."},
        422: {"description": "The passport could not be read clearly."},
        503: {"description": "Passport scanning is not enabled on this deployment."},
        504: {"description": "The scan took too long."},
    },
)
def extract_passport(
    file: UploadFile = File(...),
    travel_date: dt.date | None = Form(default=None),
    _: Customer = Depends(get_current_customer),
):
    return customer_passport_ocr_service.extract(file, travel_date)


@router.post(
    "",
    response_model=TravellerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Save a traveller",
    description=(
        "Requires a customer session. If the passport number already exists in this customer's "
        "list the existing entry is updated rather than duplicated — ticking 'save these "
        "travellers' on three trips running should not produce three copies of the same person."
    ),
)
def create_traveller(
    request: Request,
    payload: TravellerCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    traveller = service.upsert(db, customer, payload.model_dump(exclude_unset=True))
    customer_audit_service.log(
        db, customer, "Traveller saved", module="Travellers",
        description=f"{traveller.first_name} {traveller.last_name}",
        meta=activity_service.request_context(request),
    )
    db.commit()
    db.refresh(traveller)
    return traveller


@router.patch(
    "/{traveller_id}",
    response_model=TravellerResponse,
    summary="Update a saved traveller",
    responses={404: {"description": "No such traveller in this customer's list."}},
)
def update_traveller(
    traveller_id: int,
    payload: TravellerCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    traveller = service.get_owned(db, customer, traveller_id)
    if traveller is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Traveller not found.")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(traveller, field, value)
    db.commit()
    db.refresh(traveller)
    return traveller


@router.delete(
    "/{traveller_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a saved traveller",
    description=(
        "Requires a customer session. Removes the address-book entry only — bookings already "
        "made keep their own frozen copy of who travelled and are untouched."
    ),
    responses={404: {"description": "No such traveller in this customer's list."}},
)
def delete_traveller(
    request: Request,
    traveller_id: int,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    if not service.delete(db, customer, traveller_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Traveller not found.")
    customer_audit_service.log(
        db, customer, "Traveller removed", module="Travellers",
        description=f"Traveller {traveller_id}",
        meta=activity_service.request_context(request),
    )
    db.commit()
    return None
