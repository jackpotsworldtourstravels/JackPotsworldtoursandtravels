"""HTTP-level verification of the Admin WALLET DESK money paths (internal ledger only):
``POST /api/admin/wallet/topups/{id}/verify`` and ``/reject`` plus ``/wallet/reconciliation``.

No real payment is involved: a top-up is a merchant's *claim*; verify writes ONE internal
``wallet_recharge`` ledger row. Real router + services on throw-away SQLite data. Delivery is
mocked; external channels raise if reached. SQLite ignores ``SELECT … FOR UPDATE`` and the
partial unique index ``uq_wallet_transactions_topup`` (PostgreSQL-only), so the *database-level*
double-credit guard is NOT proven here — the application-level first-wins rule is.
"""
from __future__ import annotations

import datetime as dt
import decimal
import smtplib

import pytest
from sqlalchemy import func, select

from app.models_v2 import (
    Merchant, MerchantStatus, SystemLog, UserRole, WalletTopup, WalletTopupMethod, WalletTopupStatus,
    WalletTransaction,
)
from app.routers import payment_admin as payment_admin_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal


@pytest.fixture()
def h(monkeypatch):
    told = []
    monkeypatch.setattr(notification_service, "create_notification",
                        lambda db, uid, title, msg: told.append(title))
    monkeypatch.setattr(notification_service, "notify_merchant_managers",
                        lambda db, mid, title, msg: told.append(title) or 0)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    harness = Harness(payment_admin_router.router)
    harness.told = told
    db = harness.db()
    db.add(Merchant(merchant_id=601, merchant_code="M601", merchant_name="Mer", company_name="Mer Co",
                    email="m601@tt-qa.com", reference_prefix="MW", status=MerchantStatus.ACTIVE,
                    wallet_balance=D("100.00"), credit_limit=D("0")))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


_T = {"n": 8000}


def _topup(h, *, amount="2500.00", status=WalletTopupStatus.SUBMITTED, utr=None):
    _T["n"] += 1
    db = h.db()
    db.add(WalletTopup(
        topup_id=_T["n"], topup_number=f"WTU-T-{_T['n']}", merchant_id=601, amount=D(amount),
        method=WalletTopupMethod.UPI, utr=utr or f"UTR{_T['n']}", status=status,
        submitted_at=dt.datetime.now(dt.timezone.utc)))
    db.commit()
    db.close()
    return _T["n"]


def _balance(h):
    db = h.db()
    b = db.get(Merchant, 601).wallet_balance
    db.close()
    return b


def _txns(h, topup_id=None):
    db = h.db()
    q = select(WalletTransaction)
    if topup_id is not None:
        q = q.where(WalletTransaction.topup_id == topup_id)
    rows = db.scalars(q).all()
    db.close()
    return rows


def _topup_row(h, tid):
    db = h.db()
    t = db.get(WalletTopup, tid)
    db.close()
    return t


def _verify(h, who, tid, **body):
    return h.client.post(f"/api/admin/wallet/topups/{tid}/verify", json=body or None, headers=who["headers"])


def _reject(h, who, tid, **body):
    return h.client.post(f"/api/admin/wallet/topups/{tid}/reject", json=body, headers=who["headers"])


def _actions(h):
    db = h.db()
    out = [(l.action, l.user_id) for l in db.scalars(select(SystemLog)).all()]
    db.close()
    return out


# ------------------------------------------------------------------- verify
def test_verify_credits_the_wallet_exactly_once_and_reports_balances(h, admin):
    tid = _topup(h, amount="2500.00")
    r = _verify(h, admin, tid, remarks="Seen in bank statement")
    assert r.status_code == 200, r.text
    body = r.json()
    assert D(str(body["wallet_balance_before"])) == D("100.00")
    assert D(str(body["wallet_balance_after"])) == D("2600.00")
    assert body["transaction_reference"]
    assert _balance(h) == D("2600.00")
    txns = _txns(h, tid)
    assert len(txns) == 1 and txns[0].credit == D("2500.00") and not txns[0].debit
    t = _topup_row(h, tid)
    assert t.status is WalletTopupStatus.VERIFIED and t.reviewed_by == admin["id"]
    assert t.review_remarks == "Seen in bank statement"
    assert ("Wallet top-up verified", admin["id"]) in _actions(h)
    assert h.told, "the merchant's managers are told (delivery mocked)"


def test_double_verify_is_a_409_and_never_credits_twice(h, admin):
    tid = _topup(h)
    assert _verify(h, admin, tid).status_code == 200
    again = _verify(h, admin, tid)
    assert again.status_code == 409, again.text
    assert _balance(h) == D("2600.00") and len(_txns(h, tid)) == 1
    other = h.user(UserRole.ADMIN, name="Bo Second")
    assert "by another operator" in _verify(h, other, tid).json()["detail"]
    assert _balance(h) == D("2600.00")


def test_verify_on_a_rejected_or_unsubmitted_claim_moves_no_money(h, admin):
    rejected = _topup(h, status=WalletTopupStatus.REJECTED)
    awaiting = _topup(h, status=WalletTopupStatus.AWAITING_PAYMENT)
    for tid in (rejected, awaiting):
        assert _verify(h, admin, tid).status_code == 409
    assert _balance(h) == D("100.00") and _txns(h) == []


def test_verify_missing_claim_is_404(h, admin):
    assert _verify(h, admin, 99999999).status_code == 404


# ------------------------------------------------------------------- reject
def test_reject_requires_remarks_moves_no_money_and_is_audited(h, admin):
    tid = _topup(h)
    for body in ({}, {"remarks": ""}, {"remarks": "   "}):
        assert _reject(h, admin, tid, **body).status_code in (400, 422), body
    assert _topup_row(h, tid).status is WalletTopupStatus.SUBMITTED
    r = _reject(h, admin, tid, remarks="UTR does not match the statement")
    assert r.status_code == 200, r.text
    t = _topup_row(h, tid)
    assert t.status is WalletTopupStatus.REJECTED and t.review_remarks.startswith("UTR does not match")
    assert _balance(h) == D("100.00") and _txns(h) == []
    assert ("Wallet top-up rejected", admin["id"]) in _actions(h)


def test_a_rejected_claim_cannot_then_be_verified_or_rejected_again(h, admin):
    tid = _topup(h)
    assert _reject(h, admin, tid, remarks="Wrong amount").status_code == 200
    assert _verify(h, admin, tid).status_code == 409
    assert _reject(h, admin, tid, remarks="again").status_code == 409
    assert _balance(h) == D("100.00")


def test_a_verified_claim_cannot_be_rejected_afterwards(h, admin):
    tid = _topup(h)
    assert _verify(h, admin, tid).status_code == 200
    assert _reject(h, admin, tid, remarks="changed my mind").status_code == 409
    assert _topup_row(h, tid).status is WalletTopupStatus.VERIFIED and _balance(h) == D("2600.00")


# ---------------------------------------------------------- reconciliation
def test_reconciliation_shows_zero_drift_after_credits(h, admin):
    _verify(h, admin, _topup(h, amount="400.00"))
    r = h.client.get("/api/admin/wallet/reconciliation", headers=admin["headers"])
    assert r.status_code == 200, r.text
    text = r.text
    assert "drift" in text


# -------------------------------------------------------------- permissions
def test_unprivileged_callers_cannot_decide_a_claim(h, admin):
    tid = _topup(h)
    assert h.client.post(f"/api/admin/wallet/topups/{tid}/verify").status_code == 401
    assert h.client.post(f"/api/admin/wallet/topups/{tid}/reject", json={"remarks": "x"}).status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    mer = h.user(UserRole.MERCHANT_ADMIN, merchant_id=601, name="Mer Admin")
    for who in (mgr, mer):
        assert _verify(h, who, tid).status_code == 403
        assert _reject(h, who, tid, remarks="x").status_code == 403
        assert h.client.get("/api/admin/wallet/reconciliation", headers=who["headers"]).status_code == 403
    assert _topup_row(h, tid).status is WalletTopupStatus.SUBMITTED
    assert _balance(h) == D("100.00") and _txns(h) == []
    assert not [a for a in _actions(h) if "top-up" in a[0]]
