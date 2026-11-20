"""HTTP-level verification of the Admin wallet PAYMENT REQUESTS (``POST /api/admin/wallet/payment-requests`` and
``…/{id}/cancel``, ``GET /api/admin/merchants/{id}/managers``): the desk asks a merchant's MANAGER to pay. It credits
nothing — the request is ``awaiting_payment``, which the verification endpoints refuse to act on.

Internal ledger records only (no payment provider, no bank, no crypto network is contacted). Real router/services/RBAC on
throw-away SQLite data; notifications mocked.
"""
from __future__ import annotations

import datetime as dt
import decimal
import smtplib

import pytest
from sqlalchemy import select

from app.models_v2 import (
    Merchant, MerchantRole, MerchantStatus, SystemLog, UserRole, UserStatus, User, WalletTopup, WalletTopupMethod,
    WalletTopupStatus, WalletTransaction,
)
from app.routers import payment_admin as payment_admin_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal
BASE = "/api/admin/wallet/payment-requests"
BANK = {"bank_name": "Test Bank", "account_number": "000111222", "ifsc": "TEST0000001", "branch": "Pune"}


@pytest.fixture()
def h(monkeypatch):
    told = []
    monkeypatch.setattr(notification_service, "create_notification", lambda db, uid, t, m: told.append((uid, t, m)))
    monkeypatch.setattr(notification_service, "notify_merchant_managers", lambda db, mid, t, m: told.append(("mgrs", t, m)) or 0)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(payment_admin_router.router)
    harness.told = told
    db = harness.db()
    for mid in (1801, 1802):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"W{mid}", status=MerchantStatus.ACTIVE,
                        wallet_balance=D("100.00")))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def mgr(h):
    return h.user(UserRole.MERCHANT_USER, merchant_id=1801, merchant_role=MerchantRole.MANAGER, name="Mer Manager")


def _req(h, admin, mgr_id, **over):
    body = {"merchant_id": 1801, "manager_id": mgr_id, "amount": "2500.00", "method": "bank_transfer",
            "instructions": dict(BANK), "note": "June top-up"}
    body.update(over)
    return h.client.post(BASE, json=body, headers=admin["headers"])


def _row(h, tid):
    db = h.db()
    t = db.get(WalletTopup, tid)
    db.close()
    return t


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _balance(h, mid=1801):
    db = h.db()
    b = db.get(Merchant, mid).wallet_balance
    n = len(db.scalars(select(WalletTransaction)).all())
    db.close()
    return b, n


# ================================================================== raise
def test_raise_creates_an_awaiting_payment_request_that_credits_nothing(h, admin, mgr):
    r = _req(h, admin, mgr["id"])
    assert r.status_code == 201, r.text
    t = _row(h, r.json()["topup_id"] if "topup_id" in r.json() else r.json()["id"])
    assert t.status is WalletTopupStatus.AWAITING_PAYMENT and t.amount == D("2500.00") and t.merchant_id == 1801
    assert t.raised_by == admin["id"] and t.assigned_manager_id == mgr["id"] and t.method is WalletTopupMethod.BANK_TRANSFER
    assert t.instructions["account_number"] == "000111222" and t.instructions["note"] == "June top-up"
    assert _balance(h) == (D("100.00"), 0), "raising a request moves no money"
    assert any(x[0] == mgr["id"] for x in h.told), "only the named manager is told (delivery mocked)"


def test_raise_is_audited_with_its_description_and_actor(h, admin, mgr):
    """DEFECT-13: the description was passed positionally into log_activity's ``ip_address`` slot, so the audit row lost
    it (stored just the bare action)."""
    _req(h, admin, mgr["id"])
    log = _logs(h, "Payment request raised")
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert "2500" in (log[0].description or "") and "M1801 Co" in (log[0].description or ""), log[0].description


@pytest.mark.parametrize("method,instr", [("cash", {"token_details": "T-9", "note_number": "N-1"}),
                                          ("crypto", {"wallet_address": "TXyz123", "network": "trc-20"})])
def test_cash_and_crypto_requests_store_only_allowed_instruction_keys(h, admin, mgr, method, instr):
    r = _req(h, admin, mgr["id"], method=method, instructions={**instr, "evil": "<script>"})
    assert r.status_code == 201, r.text
    t = _row(h, r.json().get("topup_id") or r.json()["id"])
    assert "evil" not in t.instructions
    if method == "crypto":
        assert t.instructions["network"] == "TRC20"


@pytest.mark.parametrize("over,code", [
    ({"amount": "0"}, 422), ({"amount": "-5"}, 422), ({"amount": "abc"}, 422), ({"method": "cheque"}, 422),
    ({"instructions": {}}, 400), ({"instructions": {**BANK, "ifsc": "  "}}, 400),
    ({"method": "crypto", "instructions": {"wallet_address": "T1", "network": "SOLANA"}}, 400),
    ({"merchant_id": 424242}, 404), ({"note": "n" * 501}, 422), ({"merchant_id": "x"}, 422)])
def test_invalid_requests_create_nothing(h, admin, mgr, over, code):
    r = _req(h, admin, mgr["id"], **over)
    assert r.status_code == code, r.text
    db = h.db()
    assert db.scalars(select(WalletTopup)).all() == []
    db.close()
    assert _logs(h, "Payment request raised") == []


def test_the_addressee_must_be_an_active_manager_of_that_merchant(h, admin, mgr):
    other_company = h.user(UserRole.MERCHANT_USER, merchant_id=1802, merchant_role=MerchantRole.MANAGER, name="Other Mgr")
    operator = h.user(UserRole.MERCHANT_USER, merchant_id=1801, merchant_role=MerchantRole.OPERATOR, name="Operator")
    staff_manager = h.user(UserRole.MANAGER, name="Platform Manager")
    inactive = h.user(UserRole.MERCHANT_USER, merchant_id=1801, merchant_role=MerchantRole.MANAGER, name="Inactive Mgr")
    db = h.db()
    db.get(User, inactive["id"]).status = UserStatus.INACTIVE
    db.commit()
    db.close()
    for who in (other_company["id"], operator["id"], staff_manager["id"], inactive["id"], 99999999):
        r = _req(h, admin, who)
        assert r.status_code == 400, (who, r.text)
    db = h.db()
    assert db.scalars(select(WalletTopup)).all() == []
    db.close()


def test_manager_dropdown_lists_only_active_managers_of_that_company(h, admin, mgr):
    h.user(UserRole.MERCHANT_USER, merchant_id=1801, merchant_role=MerchantRole.OPERATOR, name="Operator")
    h.user(UserRole.MERCHANT_USER, merchant_id=1802, merchant_role=MerchantRole.MANAGER, name="Other Mgr")
    r = h.client.get("/api/admin/merchants/1801/managers", headers=admin["headers"])
    assert r.status_code == 200 and [m["user_id"] for m in r.json()] == [mgr["id"]]
    assert h.client.get("/api/admin/merchants/424242/managers", headers=admin["headers"]).status_code == 404


def test_an_awaiting_request_can_never_be_verified_into_a_wallet_credit(h, admin, mgr):
    tid = _req(h, admin, mgr["id"]).json().get("topup_id") or _req(h, admin, mgr["id"]).json()["id"]
    r = h.client.post(f"/api/admin/wallet/topups/{tid}/verify", headers=admin["headers"])
    assert r.status_code == 409, r.text
    assert _balance(h) == (D("100.00"), 0)


# ================================================================== cancel
def test_cancel_withdraws_an_unpaid_request_with_a_mandatory_reason_and_is_audited(h, admin, mgr):
    tid = _req(h, admin, mgr["id"]).json().get("topup_id") or None
    tid = tid or max(t.topup_id for t in _all(h))
    for body in ({}, {"remarks": ""}, {"remarks": "ab"}, {"remarks": "x" * 501}):
        assert h.client.post(f"{BASE}/{tid}/cancel", json=body, headers=admin["headers"]).status_code == 422
    assert _row(h, tid).status is WalletTopupStatus.AWAITING_PAYMENT
    r = h.client.post(f"{BASE}/{tid}/cancel", json={"remarks": "Raised in error"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    t = _row(h, tid)
    assert t.status is WalletTopupStatus.REJECTED and t.review_remarks == "Raised in error" and t.reviewed_by == admin["id"]
    assert _balance(h) == (D("100.00"), 0)
    log = _logs(h, "Payment request withdrawn")
    assert len(log) == 1 and log[0].user_id == admin["id"], "a withdrawal must leave an actor-attributed audit entry (DEFECT-13)"
    again = h.client.post(f"{BASE}/{tid}/cancel", json={"remarks": "again please"}, headers=admin["headers"])
    assert again.status_code == 409 and len(_logs(h, "Payment request withdrawn")) == 1
    assert h.client.post(f"{BASE}/99999999/cancel", json={"remarks": "nothing here"}, headers=admin["headers"]).status_code == 404


def test_a_request_the_manager_has_already_paid_cannot_be_withdrawn(h, admin, mgr):
    tid = _req(h, admin, mgr["id"]).json().get("topup_id") or max(t.topup_id for t in _all(h))
    db = h.db()
    db.get(WalletTopup, tid).status = WalletTopupStatus.SUBMITTED
    db.commit()
    db.close()
    r = h.client.post(f"{BASE}/{tid}/cancel", json={"remarks": "too late now"}, headers=admin["headers"])
    assert r.status_code == 409 and _row(h, tid).status is WalletTopupStatus.SUBMITTED


def _all(h):
    db = h.db()
    rows = db.scalars(select(WalletTopup)).all()
    db.close()
    return rows


# ================================================================== permissions
def test_permissions(h, admin, mgr):
    tid = _req(h, admin, mgr["id"]).json().get("topup_id") or max(t.topup_id for t in _all(h))
    calls = [("post", BASE, {"merchant_id": 1801, "manager_id": mgr["id"], "amount": "1", "method": "cash",
                              "instructions": {"token_details": "a", "note_number": "b"}}),
             ("post", f"{BASE}/{tid}/cancel", {"remarks": "no thanks"}), ("get", "/api/admin/merchants/1801/managers", None)]
    for m, u, b in calls:
        kw = {"json": b} if b is not None else {}
        assert getattr(h.client, m)(u, **kw).status_code == 401
        for who in (h.user(UserRole.MANAGER, name="Mo Manager"), mgr, h.user(UserRole.MERCHANT_ADMIN, merchant_id=1801, name="Mer Admin")):
            assert getattr(h.client, m)(u, headers=who["headers"], **kw).status_code == 403, (who, u)
    assert len(_all(h)) == 1 and _row(h, tid).status is WalletTopupStatus.AWAITING_PAYMENT
