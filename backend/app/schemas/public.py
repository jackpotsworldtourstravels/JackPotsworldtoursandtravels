"""Requests raised from public, unauthenticated pages (the landing page's own
forms) rather than from inside any portal."""
from pydantic import BaseModel, EmailStr, Field


class ContactFormRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    subject: str | None = Field(default=None, max_length=200)
    message: str = Field(min_length=1, max_length=5000)


class NewsletterSubscribeRequest(BaseModel):
    email: EmailStr
