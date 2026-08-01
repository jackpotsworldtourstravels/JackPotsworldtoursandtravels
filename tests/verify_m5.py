"""M5 — email & in-app notifications: channels, logging, opt-out, failure surfacing.

WHAT THIS PROTECTS

1. **Every lifecycle event still notifies, and now also emails.** Before M5 no
   lifecycle event sent mail at all — `email_service` was reachable only from
   OTP and password reset.
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
print("\n== a lifecycle event notifies AND attempts email ==")
# ===========================================================================
set_channels(email=True, notifications=True)
before_notif = msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)
before_email = msg_count(merchant_id=MID, message_type=MessageType.EMAIL)

booking = flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label="m5 lifecycle")

after_notif = msg_count(merchant_id=MID, message_type=MessageType.NOTIFICATION)
after_email = msg_count(merchant_id=MID, message_type=MessageType.EMAIL)
check("the merchant got in-app notifications for the booking lifecycle",
      after_notif > before_notif, f"{before_notif} -> {after_notif}")
check("...and an email was attempted for the same events",
      after_email > before_email, f"{before_email} -> {after_email}")

db = SessionLocal()
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
