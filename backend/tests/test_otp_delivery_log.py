"""Partner-portal login OTP: the delivery log row, and why a failed send says why.

QA finding (2026-11-09): a login code whose email failed was written to ``msg_logs``
with ``status = failed`` and **no** ``error_message``, so the staff "failed messages"
screen showed a failure with no reason. ``delivery_service`` (lifecycle mail) always
filled it; ``otp_service`` did not. These tests pin the repaired behaviour.

No database: ``issue`` only needs something with ``add`` and ``commit``, and the user
is a plain object, so the ORM row it builds can be inspected directly.

Secrets: the code is never in the log row, and neither is any SMTP credential.
"""
from __future__ import annotations

import types

import pytest

from app.models_v2 import MessageStatus, MessageType, MsgLog, OtpPurpose
from app.services import otp_service

SMTP_PASSWORD_SENTINEL = "smtp-password-sentinel-DO-NOT-LOG"
CODE = "482913"


class _Db:
    def __init__(self):
        self.added = []
        self.committed = 0

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.committed += 1


def _user():
    return types.SimpleNamespace(
        user_id=7, merchant_id=3, email="staff@example.com",
        otp_code_hash=None, otp_purpose=None, otp_expires_at=None,
        otp_attempts=0, otp_requested_at=None,
    )


def _configure(monkeypatch, *, smtp=True, dev_echo=False, send_result=True):
    monkeypatch.setattr(otp_service, "settings", types.SimpleNamespace(
        smtp_host="smtp.example.com" if smtp else "",
        smtp_from_email="no-reply@example.com" if smtp else "",
        smtp_password=SMTP_PASSWORD_SENTINEL,
        otp_dev_echo=dev_echo,
    ))
    monkeypatch.setattr(otp_service, "generate_otp_code", lambda: CODE)
    monkeypatch.setattr(otp_service.email_service, "send_otp_email",
                        lambda to, code, minutes: send_result)


def _log_row(db) -> MsgLog:
    rows = [r for r in db.added if isinstance(r, MsgLog)]
    assert len(rows) == 1, "exactly one delivery row per issued code"
    return rows[0]


def test_a_successful_send_is_logged_sent_with_no_error(monkeypatch):
    _configure(monkeypatch, smtp=True, send_result=True)
    db = _Db()
    returned = otp_service.issue(db, _user(), OtpPurpose.LOGIN)

    row = _log_row(db)
    assert returned is None                     # emailed: the API never echoes the code
    assert row.status == MessageStatus.SENT
    assert row.message_type == MessageType.OTP
    assert row.error_message is None
    assert row.sent_time is not None
    assert db.committed == 1


def test_a_failed_send_is_logged_failed_with_a_reason(monkeypatch):
    _configure(monkeypatch, smtp=True, send_result=False)
    db = _Db()
    otp_service.issue(db, _user(), OtpPurpose.LOGIN)

    row = _log_row(db)
    assert row.status == MessageStatus.FAILED
    assert row.error_message, "a failed send must say why (this was NULL before the fix)"
    assert "not delivered" in row.error_message
    assert row.delivered_time is None
    assert db.committed == 1                    # the failure is recorded, not rolled back


def test_the_failure_reason_for_unconfigured_smtp_names_the_cause(monkeypatch):
    _configure(monkeypatch, smtp=False)
    assert "SMTP is not configured" in otp_service._failure_reason()


def test_dev_delivery_is_not_a_failure_and_carries_no_error(monkeypatch):
    # SMTP unset => dev mode: the code is returned to the caller, the row is DELIVERED.
    _configure(monkeypatch, smtp=False)
    db = _Db()
    returned = otp_service.issue(db, _user(), OtpPurpose.LOGIN)

    row = _log_row(db)
    assert returned == CODE
    assert row.status == MessageStatus.DELIVERED
    assert row.error_message is None


@pytest.mark.parametrize("send_result", [True, False])
def test_neither_the_code_nor_an_smtp_secret_reaches_the_log_row(monkeypatch, send_result):
    _configure(monkeypatch, smtp=True, send_result=send_result)
    db = _Db()
    otp_service.issue(db, _user(), OtpPurpose.LOGIN)

    row = _log_row(db)
    visible = " | ".join(str(v) for v in (row.subject, row.message, row.error_message, row.recipient))
    assert CODE not in visible
    assert SMTP_PASSWORD_SENTINEL not in visible
    assert "smtp.example.com" not in (row.error_message or "")


def test_the_stored_hash_is_not_the_code(monkeypatch):
    _configure(monkeypatch, smtp=True, send_result=False)
    user = _user()
    otp_service.issue(_Db(), user, OtpPurpose.LOGIN)
    assert user.otp_code_hash and user.otp_code_hash != CODE


def test_the_staff_failed_message_schema_carries_the_reason():
    from app.routers.messages import FailedMessage

    assert "error_message" in FailedMessage.model_fields
