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
