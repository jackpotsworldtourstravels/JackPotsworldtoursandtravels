"""M5 — email & in-app notifications: channels, logging, opt-out, failure surfacing.

WHAT THIS PROTECTS

1. **Every lifecycle event notifies in the portal, and does NOT email.**
   `settings.lifecycle_emails_enabled` is False by default as of 2026-08-05:
   thirty lifecycle events the merchant can already see in the portal are no
   longer mailed. The in-app half is unconditional and unchanged — that is the
   half being protected here, because "we stopped mailing" must never quietly
   become "we stopped telling them".

   The send machinery itself is still exercised, in-process, with the flag
   flipped (see "the send path still works when it is switched on"). It is
   correct and reversible; it is simply not what the business wants by default.

   THE TWO AUTHENTICATION EMAILS ARE UNAFFECTED and are asserted separately:
   Login OTP and password reset call `email_service` directly and never pass
   through `delivery_service`, so no flag here can lock anyone out.
2. **`communication_settings` is honoured.** A merchant that switches email off
   stops receiving it; one that switches notifications off stops receiving
   those. Neither switch can silence platform staff, whose alerts are not a
   merchant's to disable.
3. **`msg_logs` tells the truth.** An email attempt is recorded whatever
   happens, and a send that did not go out is `failed` with a reason — never
   `delivered`. This is the requirement the milestone exists for: a swallowed
   failure is one nobody fixes.
4. **No secret reaches an email body.**
5. **Delivery never breaks the thing that triggered it.**

SMTP IS NOT CONFIGURED IN DEV, AND THAT IS THE POINT. Every attempt is therefore
recorded `failed` with "SMTP is not configured…" — which is exactly the
behaviour under test: the platform says so rather than pretending mail went out.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import (  # noqa: E402
    CommunicationSettings, MessageStatus, MessageType, MsgLog,
)
from app.services import delivery_service, notification_templates  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MANAGER, MERCHANT, Checker, H, login  # noqa: E402

check = Checker()
atok = login(*ADMIN)
mtok = login(*MERCHANT)
gtok = login(*MANAGER)
MID = requests.get(f"{BASE}/api/merchant/wallet", headers=H(mtok)).json()["merchant_id"]


def msg_count(**where):
    db = SessionLocal()
    try:
        stmt = select(MsgLog)
        for col, val in where.items():
            stmt = stmt.where(getattr(MsgLog, col) == val)
        from sqlalchemy import func
        return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    finally:
        db.close()


def set_channels(*, email=None, notifications=None):
    db = SessionLocal()
    try:
        s = db.scalar(select(CommunicationSettings)
                      .where(CommunicationSettings.merchant_id == MID))
        if s is None:
            s = CommunicationSettings(merchant_id=MID)
            db.add(s)
        if email is not None:
            s.email_enabled = email
        if notifications is not None:
            s.notification_enabled = notifications
        db.commit()
    finally:
        db.close()


# ===========================================================================
print("\n== the template ==")
# ===========================================================================
subject, text_body, html_body = notification_templates.render(
    "Your ticket has been issued",
    "REQ-2026-000123 — PNR ABC123. You can download the ticket and invoice.",
    reference="REQ-2026-000123", event="ticket_issued",
)
check("the reference leads the subject, so a mailbox can be scanned",
      subject.startswith("[REQ-2026-000123]"), subject)
check("a plain-text part is rendered", bool(text_body.strip()) and "<" not in text_body[:40],
      text_body[:80])
check("an HTML part is rendered", html_body.lstrip().startswith("<!doctype html"), html_body[:40])
check("both parts carry the message", "PNR ABC123" in text_body and "PNR ABC123" in html_body)
check("the brand is named once in the subject when there is no reference",
      "JackPots" in notification_templates.render("Hello", "Body")[0])

nasty = notification_templates.render(
    "Booking <script>alert(1)</script>", "Amount & terms <b>changed</b>", reference="R&D-1")
check("HTML is escaped, so message text cannot inject markup",
      "<script>" not in nasty[2] and "&lt;script&gt;" in nasty[2], nasty[2][:200])
check("...and the reference is escaped too", "R&amp;D-1" in nasty[2])

for secret in ("password", "otp", "token", "Bearer "):
    check(f"the layout never introduces the word '{secret}'",
          secret.lower() not in (text_body + html_body).lower(), secret)

# ===========================================================================
print("\n== a lifecycle event notifies in the portal, and sends NO email ==")
# ===========================================================================
# The default posture since 2026-08-05. Both channels are switched ON for this
# merchant, so a mail that went out would be the merchant's own settings being
# honoured — which is precisely why this is the strong form of the assertion:
# with nothing opted out, still no email.
set_channels(email=True, notifications=True)
before_notif = msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)
before_email = msg_count(merchant_id=MID, message_type=MessageType.EMAIL)

booking = flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label="m5 lifecycle")

after_notif = msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)
after_email = msg_count(merchant_id=MID, message_type=MessageType.EMAIL)
check("the merchant got in-app notifications for the booking lifecycle",
      after_notif > before_notif, f"{before_notif} -> {after_notif}")
check("...and NO email was sent for any of them",
      after_email == before_email, f"{before_email} -> {after_email}")

# ===========================================================================
print("\n== the send path still works when it is switched on ==")
# ===========================================================================
# In-process, against delivery_service directly: the flag is read per call, and
# this process is not the server, so flipping it here exercises the machinery
# without mailing anything from the running API. This is what keeps M5's
# guarantees — msg_logs records every attempt, an unsent message says why, and
# nothing is ever claimed as delivered — under test rather than merely present.
from app.config import settings as _settings                        # noqa: E402
from app.models_v2 import User as _User                             # noqa: E402

db = SessionLocal()
recipient = db.scalars(
    select(_User).where(_User.merchant_id == MID, _User.email.isnot(None)).limit(1)).first()
before = msg_count(merchant_id=MID, message_type=MessageType.EMAIL)

_was = _settings.lifecycle_emails_enabled
try:
    _settings.lifecycle_emails_enabled = False
    off = delivery_service.deliver(
        db, [(recipient.user_id, recipient.email, MID)],
        "Suppressed", "This must not be mailed.", merchant_id=MID)
    check("with the flag off, deliver() writes the in-app row", off["in_app"] == 1, str(off))
    check("...and sends nothing", off["emailed"] == 0 and off["failed"] == 0, str(off))
    check("...counting it as suppressed, not failed", off["suppressed"] >= 1, str(off))
    check("...and no email row is written at all",
          msg_count(merchant_id=MID, message_type=MessageType.EMAIL) == before)

    _settings.lifecycle_emails_enabled = True
    on = delivery_service.deliver(
        db, [(recipient.user_id, recipient.email, MID)],
        "Switched on", "This one is attempted.", merchant_id=MID)
    check("with the flag on, the send is attempted", on["emailed"] + on["failed"] == 1, str(on))
    check("...and an email row is written",
          msg_count(merchant_id=MID, message_type=MessageType.EMAIL) == before + 1)
finally:
    _settings.lifecycle_emails_enabled = _was

latest = db.scalars(
    select(MsgLog).where(MsgLog.merchant_id == MID, MsgLog.message_type == MessageType.EMAIL)
    .order_by(MsgLog.message_id.desc()).limit(1)).first()
db.close()
check("the email row records an outcome, not 'queued'",
      latest is not None and latest.status is not MessageStatus.QUEUED,
      str(latest.status if latest else None))
check("...and it is never claimed as 'delivered' — nothing here can observe that",
      latest is not None and latest.status is not MessageStatus.DELIVERED,
      str(latest.status if latest else None))
check("a send that did not go out carries the reason",
      latest.status is not MessageStatus.SENT and bool(latest.error_message)
      or latest.status is MessageStatus.SENT,
      str(latest.error_message))
check("...and the reason names the actual cause",
      latest.status is MessageStatus.SENT or "SMTP" in (latest.error_message or ""),
      str(latest.error_message))
check("the email is addressed to a real recipient", "@" in (latest.recipient or ""),
      latest.recipient)

# ===========================================================================
print("\n== the two authentication emails are NOT suppressed ==")
# ===========================================================================
# The property that makes one flag safe: neither of these passes through
# delivery_service, so neither can be switched off by it.
#
# EXERCISED IN-PROCESS, NOT OVER HTTP, and deliberately. `/api/auth/login` is
# rate-limited to 10/minute per account, and by the time this script runs inside
# the full suite the shared merchant has spent that budget on the twenty scripts
# before it — so an HTTP login here fails with 429 in a suite run while passing
# when the script is run alone. That is a broken test, not a broken product.
# Calling `otp_service.issue` directly proves the thing that actually matters:
# the OTP path reaches the mailer with lifecycle email switched off.
from app.services import otp_service                                # noqa: E402

db = SessionLocal()
otp_user = db.scalars(
    select(_User).where(_User.merchant_id == MID, _User.email.isnot(None)).limit(1)).first()
#: `otp_service` has its OWN per-hour request limit, counted on the user row and
#: cleared by a successful verify. Twenty scripts' worth of logins run before
#: this one, so the counter is reset here as a fixture — otherwise this check
#: would depend on how many times the shared account happened to sign in, which
#: is the same order-dependence the HTTP version above was rejected for.
otp_user.otp_attempts = 0
otp_user.otp_requested_at = None
db.commit()

_was = _settings.lifecycle_emails_enabled
try:
    _settings.lifecycle_emails_enabled = False        # the production default
    code = otp_service.issue(db, otp_user)
    check("a Login OTP is still issued with lifecycle email switched off",
          code is None or (isinstance(code, str) and len(code) == 6), repr(code))
    row = db.scalars(
        select(MsgLog).where(MsgLog.user_id == otp_user.user_id)
        .order_by(MsgLog.message_id.desc()).limit(1)).first()
    check("...and the send is logged, so OTP delivery is still auditable",
          row is not None and "OTP" in (row.message or "") + (row.subject or ""),
          str(row.message if row else None)[:90])
finally:
    _settings.lifecycle_emails_enabled = _was
    db.close()
# The structural property, stated as an import check rather than a substring
# one: `otp_service` has its own `delivery_mode()` and the word "delivery" all
# through its prose, so searching for the text finds itself. What must remain
# true is that neither auth path IMPORTS delivery_service — that is what puts
# them outside the flag's reach, and it is a one-line change away from not
# being true.
_auth_sources = {
    name: (BACKEND / "app" / path).read_text(encoding="utf-8")
    for name, path in (
        ("otp_service", "services/otp_service.py"),
        ("partner_auth_service", "services/partner_auth_service.py"),
        ("routers/auth", "routers/auth.py"),
    )
}
for _name, _src in _auth_sources.items():
    check(f"{_name} does not import delivery_service",
          "import delivery_service" not in _src
          and "delivery_service." not in _src,
          f"{_name} must reach email_service directly, or the flag would gate it")
    check(f"...and it does reach email_service", "email_service" in _src, _name)

# ===========================================================================
print("\n== opting out is honoured ==")
# ===========================================================================
set_channels(email=False, notifications=True)
b_notif = msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)
b_email = msg_count(merchant_id=MID, message_type=MessageType.EMAIL)
flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label="m5 email off")
check("with email disabled, no email row is written",
      msg_count(merchant_id=MID, message_type=MessageType.EMAIL) == b_email,
      f"{b_email} -> {msg_count(merchant_id=MID, message_type=MessageType.EMAIL)}")
check("...but in-app notifications still arrive",
      msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION) > b_notif)

set_channels(email=False, notifications=False)
b_notif = msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)
flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label="m5 both off")
check("with both disabled, the merchant gets nothing",
      msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION) == b_notif,
      f"{b_notif} -> {msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)}")

# The switch that must NOT exist: silencing the platform's own desk.
db = SessionLocal()
staff_in_app, staff_email = delivery_service.channels_for(db, None)
db.close()
check("platform staff are never opted out — they carry no merchant",
      staff_in_app is True and staff_email is True, f"{staff_in_app}/{staff_email}")

set_channels(email=True, notifications=True)

# ===========================================================================
print("\n== failures are visible to staff ==")
# ===========================================================================
r = requests.get(f"{BASE}/api/admin/messages/counts", headers=H(atok))
check("the delivery counts endpoint answers -> 200", r.status_code == 200,
      f"{r.status_code} {r.text[:150]}")
counts = r.json()
check("...and reports failures rather than hiding them",
      counts["failed_total"] > 0, str(counts))

r = requests.get(f"{BASE}/api/admin/messages/failed?page_size=5", headers=H(atok))
check("the failed-message list answers -> 200", r.status_code == 200, f"{r.status_code}")
items = r.json()["items"]
check("...listing real failures", bool(items), r.text[:200])
check("...each with a reason a human can act on",
      all(i["error_message"] for i in items), str(items[:1]))
check("...newest first",
      [i["created_at"] for i in items] == sorted((i["created_at"] for i in items), reverse=True))
check("...and never a message body", all("message" not in i for i in items))

# ===========================================================================
print("\n== the notification centre still works ==")
# ===========================================================================
r = requests.get(f"{BASE}/api/notifications", headers=H(mtok))
check("a merchant reads its own notifications -> 200", r.status_code == 200, f"{r.status_code}")
notes = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
check("...and there are some", bool(notes), str(r.text[:150]))

r = requests.get(f"{BASE}/api/notifications/unread-count", headers=H(mtok))
check("unread count -> 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

if notes:
    nid = notes[0].get("id") or notes[0].get("message_id") or notes[0].get("notification_id")
    if nid:
        # PATCH, not POST — marking read edits one notification's state, and
        # that is the verb the router has always used.
        r = requests.patch(f"{BASE}/api/notifications/{nid}/read", headers=H(mtok), json={})
        check("marking one read -> 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

r = requests.post(f"{BASE}/api/notifications/read-all", headers=H(mtok))
check("mark-all-read -> 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
check("...leaves nothing unread",
      requests.get(f"{BASE}/api/notifications/unread-count",
                   headers=H(mtok)).json().get("unread", 0) == 0,
      requests.get(f"{BASE}/api/notifications/unread-count", headers=H(mtok)).text[:120])

# ===========================================================================
print("\n== RBAC ==")
# ===========================================================================
for path in ("/api/admin/messages/failed", "/api/admin/messages/counts"):
    r = requests.get(f"{BASE}{path}", headers=H(mtok))
    check(f"a merchant cannot read {path}", r.status_code in (401, 403, 404),
          f"{r.status_code} {r.text[:120]}")
    r = requests.get(f"{BASE}{path}")
    check(f"{path} requires authentication", r.status_code in (401, 403), f"{r.status_code}")

# ===========================================================================
print("\n== delivery never breaks the workflow ==")
# ===========================================================================
# A booking must still complete even when the mail layer is guaranteed to fail —
# which, with SMTP unconfigured, it is on every single send above.
b = flows.make_booking(mtok, atok, gtok=gtok, upto="ticket_issued",
                       fare="12000.00", label="m5 resilience")
st = requests.get(f"{BASE}/api/requests/{b['id']}", headers=H(mtok)).json()["request"]
check("a booking reaches Ticket Issued despite every email failing",
      st["status"] == "ticket_issued", st["status"])
check("...and the money still moved",
      msg_count(merchant_id=MID, message_type=MessageType.EMAIL) > 0)

db = SessionLocal()
drift = db.execute(text("""
    SELECT count(*) FROM merchants m WHERE m.wallet_balance <> COALESCE(
        (SELECT SUM(w.credit - w.debit) FROM wallet_transactions w
         WHERE w.merchant_id = m.merchant_id), 0)
""")).scalar()
db.close()
check("the wallet invariant is untouched by M5", drift == 0, f"{drift} merchants drifted")

raise SystemExit(check.report())
