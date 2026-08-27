"""Endpoints behind the landing page's own forms — reachable with no session,
because nobody is signed in when they use them.

Kept out of every other router because those are all scoped to an
authenticated portal (merchant, admin, or customer); this is the one surface
that is neither."""
from fastapi import APIRouter, HTTPException, Request, status

from app.auth.rate_limit import limiter
from app.schemas.public import (
    ContactFormRequest,
    HotelGroupEnquiryRequest,
    NewsletterSubscribeRequest,
)
from app.services import email_service

router = APIRouter(prefix="/api", tags=["public"])


@router.post(
    "/contact",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Landing page contact form",
    description="Public endpoint. Relays the message to the business inbox by email.",
)
@limiter.limit("5/minute")
def submit_contact_form(request: Request, payload: ContactFormRequest):
    sent = email_service.send_contact_form_email(
        name=payload.name,
        from_email=payload.email,
        subject=payload.subject,
        message=payload.message,
    )
    if not sent:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="We couldn't send your message right now — please email us directly instead.",
        )


@router.post(
    "/hotel-group-enquiry",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Landing page Group Deals enquiry",
    description=(
        "Public endpoint. A hotel party too large for the standard 4-room search, sent to the "
        "group desk as an enquiry to be quoted by hand — it deliberately returns no availability."
    ),
)
@limiter.limit("5/minute")
def submit_hotel_group_enquiry(request: Request, payload: HotelGroupEnquiryRequest):
    if not email_service.send_hotel_group_enquiry_email(payload):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="We couldn't send your enquiry right now — please call us instead.",
        )


@router.post(
    "/newsletter",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Landing page newsletter signup",
    description="Public endpoint. Relays the subscriber's address to the business inbox by email.",
)
@limiter.limit("10/minute")
def submit_newsletter_signup(request: Request, payload: NewsletterSubscribeRequest):
    sent = email_service.send_newsletter_signup_email(payload.email)
    if not sent:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="We couldn't subscribe you right now — please try again shortly.",
        )
