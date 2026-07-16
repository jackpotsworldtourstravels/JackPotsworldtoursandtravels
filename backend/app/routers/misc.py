from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.session import get_db
from app.models.misc import ContactUs, Newsletter
from app.schemas.misc import ContactCreate, ContactOut, NewsletterCreate, NewsletterOut

contact_router = APIRouter(prefix="/api/contact", tags=["contact"])
newsletter_router = APIRouter(prefix="/api/newsletter", tags=["newsletter"])


@contact_router.post(
    "",
    response_model=ContactOut,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a contact message",
    description="Public endpoint. Stores a message from the contact-us form for admin review.",
)
def submit_contact(payload: ContactCreate, db: Session = Depends(get_db)):
    entry = ContactUs(**payload.model_dump())
    db.add(entry)
    db.commit()
    return ContactOut()


@newsletter_router.post(
    "",
    response_model=NewsletterOut,
    status_code=status.HTTP_201_CREATED,
    summary="Subscribe to the newsletter",
    description="Public endpoint. Adds an email to the newsletter list; silently no-ops if it's already subscribed.",
)
def subscribe_newsletter(payload: NewsletterCreate, db: Session = Depends(get_db)):
    existing = db.scalar(select(Newsletter).where(Newsletter.email == payload.email))
    if not existing:
        db.add(Newsletter(email=payload.email))
        db.commit()
    return NewsletterOut()
