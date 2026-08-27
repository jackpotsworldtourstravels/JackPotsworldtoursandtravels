import html
import logging
import smtplib
from email.message import EmailMessage

from app.config import settings

logger = logging.getLogger("jackpots.email")


def _send(to_email: str, subject: str, text_body: str, html_body: str) -> bool:
    """Sends one email over SMTP. Returns True on success, False on any failure —
    callers must never let email delivery problems block the request itself
    (e.g. password reset still has to respond generically either way)."""
    if not settings.smtp_host or not settings.smtp_from_email:
        logger.warning("SMTP not configured (smtp_host/smtp_from_email unset) — skipping email to %s.", to_email)
        return False

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email}>"
    message["To"] = to_email
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            if settings.smtp_use_tls:
                server.starttls()
            if settings.smtp_username and settings.smtp_password:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(message)
        return True
    except Exception:
        logger.exception("Failed to send email to %s.", to_email)
        return False


def send_password_reset_email(to_email: str, reset_link: str, expire_minutes: int) -> bool:
    subject = "Reset your JackPots World Tours & Travels password"
    text_body = (
        f"We received a request to reset your password.\n\n"
        f"Reset it here: {reset_link}\n\n"
        f"This link expires in {expire_minutes} minutes and can only be used once. "
        f"If you didn't request this, you can safely ignore this email."
    )
    html_body = f"""
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#0A2540;">
      <h2 style="color:#0A2540;">Reset your password</h2>
      <p>We received a request to reset your JackPots World Tours &amp; Travels password.</p>
      <p style="margin:28px 0;">
        <a href="{reset_link}" style="background:#FF4D4D; color:#fff; padding:12px 24px; border-radius:100px; text-decoration:none; font-weight:bold;">
          Reset Password
        </a>
      </p>
      <p style="font-size:13px; color:#666;">
        This link expires in {expire_minutes} minutes and can only be used once.
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
    """
    return _send(to_email, subject, text_body, html_body)


#: Where a landing-page contact form submission is delivered. Not a Settings
#: field because it is not an operator-configurable deployment knob like
#: smtp_host — it is the one fixed inbox this business reads enquiries from.
CONTACT_FORM_RECIPIENT = "jackpotsworldtours.travels@gmail.com"


def send_contact_form_email(name: str, from_email: str, subject: str | None, message: str) -> bool:
    """Relays a landing-page "Contact us" submission to the business inbox.

    `reply_to` is set to the visitor's own address so replying from the inbox
    goes straight back to them, without exposing that address as the
    envelope/From (which some receiving servers would flag as spoofing)."""
    mail_subject = f"Website enquiry: {subject}" if subject else f"Website enquiry from {name}"
    text_body = (
        f"New message from the website contact form.\n\n"
        f"Name: {name}\n"
        f"Email: {from_email}\n"
        f"Subject: {subject or '(none)'}\n\n"
        f"Message:\n{message}"
    )
    html_body = f"""
    <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#0A2540;">
      <h2 style="color:#0A2540;">New website enquiry</h2>
      <p><strong>Name:</strong> {html.escape(name)}</p>
      <p><strong>Email:</strong> {html.escape(from_email)}</p>
      <p><strong>Subject:</strong> {html.escape(subject) if subject else '(none)'}</p>
      <p style="white-space:pre-wrap; border-left:3px solid #FF4D4D; padding-left:12px; margin-top:20px;">
        {html.escape(message)}
      </p>
    </div>
    """
    return _send_with_reply_to(CONTACT_FORM_RECIPIENT, mail_subject, text_body, html_body, reply_to=from_email)


def send_newsletter_signup_email(subscriber_email: str) -> bool:
    """Relays a landing-page newsletter signup to the business inbox.

    There is no subscriber-list table yet, so this is the record of the
    signup for now — same as the contact form, `reply_to` is the visitor's
    own address."""
    subject = "New newsletter subscriber"
    text_body = f"{subscriber_email} subscribed to the newsletter from the website."
    html_body = f"""
    <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#0A2540;">
      <h2 style="color:#0A2540;">New newsletter subscriber</h2>
      <p><strong>{html.escape(subscriber_email)}</strong> subscribed from the website footer.</p>
    </div>
    """
    return _send_with_reply_to(CONTACT_FORM_RECIPIENT, subject, text_body, html_body, reply_to=subscriber_email)


def _send_with_reply_to(to_email: str, subject: str, text_body: str, html_body: str, reply_to: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from_email:
        logger.warning("SMTP not configured (smtp_host/smtp_from_email unset) — skipping email to %s.", to_email)
        return False

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email}>"
    message["To"] = to_email
    message["Reply-To"] = reply_to
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            if settings.smtp_use_tls:
                server.starttls()
            if settings.smtp_username and settings.smtp_password:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(message)
        return True
    except Exception:
        logger.exception("Failed to send email to %s.", to_email)
        return False


def send_otp_email(to_email: str, otp_code: str, expire_minutes: int) -> bool:
    subject = "Your JackPots Partner Portal verification code"
    text_body = (
        f"Your verification code is: {otp_code}\n\n"
        f"This code expires in {expire_minutes} minutes. "
        f"If you didn't request this, you can safely ignore this email."
    )
    html_body = f"""
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#0A2540;">
      <h2 style="color:#0A2540;">Your verification code</h2>
      <p>Use this code to continue signing in to the JackPots Partner Portal.</p>
      <p style="margin:28px 0; font-size:32px; font-weight:800; letter-spacing:.15em; color:#0A2540;">
        {otp_code}
      </p>
      <p style="font-size:13px; color:#666;">
        This code expires in {expire_minutes} minutes.
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
    """
    return _send(to_email, subject, text_body, html_body)
