"""Getting a message to a person, and telling the truth about whether it arrived (M5).

WHY THIS EXISTS
Before M5 the platform had two unconnected halves. ``notification_service``
wrote in-app rows and stamped every one ``delivered`` — true for an in-app
notification, which is delivered the moment it is written. ``email_service``
could send mail, but only OTP and password-reset ever called it, and **neither
wrote a ``msg_logs`` row at all**, so a send that was skipped or refused left no
trace. Meanwhile ``communication_settings`` — a per-merchant switchboard with
``email_enabled`` and ``notification_enabled`` — was read by nothing.

This module is the one seam where those three meet:

    who to tell  ->  is this channel switched on for them?  ->  send  ->  log what happened

WHY IT WRAPS THE EXISTING CALL SITES INSTEAD OF REPLACING THEM
Every lifecycle event in the platform already funnels through a handful of
``notification_service`` functions — ``notify_request_merchant``,
``notify_admins``, ``notify_merchant_managers``, ``notify_managers``. Roughly
thirty call sites across a dozen approved services reach them. Adding email at
*this* seam gives every one of those events email delivery without editing a
line of any approved service, which is what §0 asks for.

ONE LAYOUT, NOT THIRTY BESPOKE TEMPLATES
The roadmap asks for templates rendered server-side. The call sites already
carry the event's own words (a title and a message written where the event
happens, in the vocabulary of that workflow). So the template is the **layout** —
branding, greeting, the reference, a call to action, the footer — and the event
supplies its copy. Thirty hand-written bodies would drift out of step with the
in-app text they duplicate; this way the two cannot disagree, because they are
the same sentence.

EMAIL NEVER BREAKS A BOOKING
Sending is best-effort and fully swallowed. A merchant's mail server refusing a
message must not roll back the ticket that was just issued. Failures are
recorded with ``status = failed`` and the reason in ``error_message``, and
surfaced to staff on the admin messages screen — a bounced send that nobody can
see is the failure mode this milestone exists to remove.

LIFECYCLE EMAIL IS SWITCHED OFF BY DEFAULT (2026-08-05)
``settings.lifecycle_emails_enabled`` gates the email half of :func:`deliver`,
and it defaults to False. Everything above still describes how the machinery
works and all of it still runs when the flag is on; what changed is the
business's answer to whether these thirty events warrant mail. The in-app half
is untouched and unconditional — the portal notification IS the notification
now, and no workflow, API or template was removed to achieve that.

**The two authentication emails are not affected and cannot be.** The Login OTP
(``otp_service``, ``partner_auth_service``) and the password reset
(``routers/auth``) call ``email_service`` directly and have never passed through
this module — which is exactly the property that lets one flag here mean "no
lifecycle mail" without ever meaning "nobody can sign in".

KNOWN LIMITATION, STATED HERE RATHER THAN DISCOVERED LATER
Sending is **synchronous**. With SMTP unconfigured it is a no-op and costs
nothing; with a real server it adds that server's latency to the request that
triggered it. The right answer is a queue and a worker, which this platform has
no infrastructure for. The seam is deliberately shaped so that
:func:`_send_email` is the only thing that would move.
"""
import datetime
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_v2 import (
    CommunicationSettings,
    MessageStatus,
    MessageType,
    MsgLog,
    User,
)
from app.config import settings
from app.services import email_service, notification_templates

logger = logging.getLogger("jackpots.delivery")


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# The switchboard
# ---------------------------------------------------------------------------
def channels_for(db: Session, merchant_id: int | None) -> tuple[bool, bool]:
    """``(in_app, email)`` for a merchant, from ``communication_settings``.

    **Platform staff have no merchant and are never opted out.** An admin is not
    a customer who unsubscribed; they are the desk, and a merchant's preference
    must not be able to switch off the platform's own operational alerts. This
    is the rule that stops ``notify_admins`` being silenced by somebody else's
    settings row.

    A merchant with no settings row gets both channels: the column defaults are
    true, and absence of a preference is not a preference against.
    """
    if merchant_id is None:
        return True, True

    settings = db.scalar(
        select(CommunicationSettings).where(CommunicationSettings.merchant_id == merchant_id)
    )
    if settings is None:
        return True, True
    return bool(settings.notification_enabled), bool(settings.email_enabled)


# ---------------------------------------------------------------------------
# Writing what happened
# ---------------------------------------------------------------------------
def _in_app_row(user_id, recipient, title, message, merchant_id, request_id=None) -> MsgLog:
    """An in-app notification. Delivered the moment it is written — that is what
    in-app means, and it is the one case where ``delivered`` is honest."""
    now = _now()
    return MsgLog(
        user_id=user_id,
        merchant_id=merchant_id,
        request_id=request_id,
        message_type=MessageType.NOTIFICATION,
        recipient=recipient,
        subject=title,
        message=message,
        status=MessageStatus.DELIVERED,
        sent_time=now,
        delivered_time=now,
    )


def _send_email(db: Session, *, user_id, merchant_id, to_email, subject, text_body,
                html_body, request_id=None) -> MsgLog:
    """Attempt one email and record the attempt, whatever the outcome.

    The row is written either way. ``sent`` means the SMTP conversation
    completed; it is deliberately **not** ``delivered``, because nothing here
    knows whether the recipient's server accepted it downstream — claiming
    delivery we cannot observe is exactly the lie this milestone removes from
    the OTP path.
    """
    row = MsgLog(
        user_id=user_id,
        merchant_id=merchant_id,
        request_id=request_id,
        message_type=MessageType.EMAIL,
        recipient=to_email,
        subject=subject,
        message=text_body,
        status=MessageStatus.QUEUED,
    )
    db.add(row)

    try:
        ok = email_service._send(to_email, subject, text_body, html_body)
    except Exception as exc:                      # noqa: BLE001 — see the module docstring
        row.status = MessageStatus.FAILED
        row.error_message = f"{type(exc).__name__}: {exc}"[:1000]
        logger.warning("Email to %s failed: %s", to_email, exc)
        return row

    if ok:
        row.status = MessageStatus.SENT
        row.sent_time = _now()
    else:
        # ``_send`` returns False when SMTP is not configured, or the send was
        # refused. Recorded as failed rather than silently dropped: an operator
        # looking at the messages screen should see that nothing went out.
        row.status = MessageStatus.FAILED
        row.error_message = (
            "SMTP is not configured (smtp_host / smtp_from_email unset), so no mail was sent."
            if not email_service.settings.smtp_host or not email_service.settings.smtp_from_email
            else "The mail server refused the message."
        )
    return row


# ---------------------------------------------------------------------------
# The one entry point
# ---------------------------------------------------------------------------
def deliver(
    db: Session, users, title: str, message: str, *,
    merchant_id: int | None = None,
    request=None,
    event: str | None = None,
    action_label: str | None = None,
    commit: bool = True,
) -> dict:
    """Tell ``users`` something, on every channel they still have switched on.

    ``users`` is an iterable of ``(user_id, email, merchant_id)`` tuples — the
    shape ``notification_service`` already selects — or of :class:`User` rows.

    Returns ``{"in_app": n, "emailed": n, "failed": n, "suppressed": n}`` so a
    caller (and the verification script) can assert what actually happened
    rather than that the function returned without raising.
    """
    request_id = getattr(request, "request_id", None)
    reference = getattr(request, "request_number", None)

    counts = {"in_app": 0, "emailed": 0, "failed": 0, "suppressed": 0}

    for entry in users:
        if isinstance(entry, User):
            user_id, email, own_merchant = entry.user_id, entry.email, entry.merchant_id
        else:
            user_id, email = entry[0], entry[1]
            own_merchant = entry[2] if len(entry) > 2 else merchant_id

        in_app_on, email_on = channels_for(db, own_merchant)

        if in_app_on:
            db.add(_in_app_row(user_id, email, title, message, own_merchant, request_id))
            counts["in_app"] += 1
        else:
            counts["suppressed"] += 1

        # THREE INDEPENDENT REASONS NOT TO MAIL, and they mean different things:
        #   settings.lifecycle_emails_enabled  the platform does not mail
        #                                      lifecycle events at all (default)
        #   email_on                           this merchant opted out
        #   email                              we have no address for this user
        # All three count as `suppressed` — the message was not sent and nothing
        # went wrong. `failed` stays reserved for a send that was attempted and
        # did not arrive, which is what the admin messages screen is looking at;
        # folding a policy decision into that number would fill a failure report
        # with things that never failed.
        if not settings.lifecycle_emails_enabled or not email_on or not email:
            counts["suppressed"] += 1
        else:
            subject, text_body, html_body = notification_templates.render(
                title, message, reference=reference, event=event,
                action_label=action_label,
            )
            row = _send_email(
                db, user_id=user_id, merchant_id=own_merchant, to_email=email,
                subject=subject, text_body=text_body, html_body=html_body,
                request_id=request_id,
            )
            if row.status is MessageStatus.SENT:
                counts["emailed"] += 1
            else:
                counts["failed"] += 1

    if commit:
        db.commit()
    return counts


# ---------------------------------------------------------------------------
# What went wrong, for the people who can do something about it
# ---------------------------------------------------------------------------
def failed_messages(db: Session, *, page: int = 1, page_size: int = 20):
    """Sends that did not go out, newest first.

    The roadmap's requirement in one function: *"a bounced or failed send is
    visible to staff, not silently swallowed."* Before M5 there was nothing to
    look at — no failure was ever recorded, because no row was ever written.
    """
    from sqlalchemy import func

    where = MsgLog.status.in_((MessageStatus.FAILED, MessageStatus.BOUNCED))
    total = db.scalar(select(func.count()).select_from(MsgLog).where(where)) or 0
    rows = db.scalars(
        select(MsgLog).where(where)
        .order_by(MsgLog.created_at.desc(), MsgLog.message_id.desc())
        .limit(page_size).offset((page - 1) * page_size)
    ).all()
    return list(rows), total


def failure_counts(db: Session) -> dict:
    """Badge figures for the messages screen, in one grouped query."""
    from sqlalchemy import func

    rows = db.execute(
        select(MsgLog.message_type, MsgLog.status, func.count())
        .where(MsgLog.status.in_((MessageStatus.FAILED, MessageStatus.BOUNCED)))
        .group_by(MsgLog.message_type, MsgLog.status)
    ).all()
    out = {"failed_total": 0, "by_type": {}}
    for message_type, _status, count in rows:
        out["failed_total"] += count
        key = message_type.value if hasattr(message_type, "value") else str(message_type)
        out["by_type"][key] = out["by_type"].get(key, 0) + count
    return out
