"""Issue #6 — the /me response exposes `has_password` so the Account Center can
hide Change Password for passwordless (OTP-only) accounts and guests.

Unit-tests the response flattener directly (no DB): the only new logic is
"a password exists iff an auth row carries a hash"."""
from __future__ import annotations

import datetime as dt
from types import SimpleNamespace as NS

from app.routers.customer_auth import customer_response


def _customer(*, auth=None, guest=False):
    return NS(
        customer_id=1, customer_code="CUS-000001", full_name="Test Traveller",
        email="t@example.com", mobile="9000000000", date_of_birth=None,
        status=NS(value="active"), email_verified=True, mobile_verified=True,
        profile=None, auth=auth, is_guest=guest,
        created_at=dt.datetime.now(dt.timezone.utc),
    )


def test_has_password_true_when_auth_row_has_a_hash():
    c = _customer(auth=NS(password_hash="$2b$...hash...", last_login=None))
    assert customer_response(c).has_password is True


def test_has_password_false_for_otp_only_account():
    # An OTP-only account has an auth row but no password hash... or no auth row.
    assert customer_response(_customer(auth=None)).has_password is False
    assert customer_response(_customer(auth=NS(password_hash=None, last_login=None))).has_password is False
    assert customer_response(_customer(auth=NS(password_hash="", last_login=None))).has_password is False


def test_has_password_false_for_guest():
    assert customer_response(_customer(auth=None, guest=True)).has_password is False
