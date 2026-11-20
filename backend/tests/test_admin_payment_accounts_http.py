"""HTTP-level verification of Admin PAYMENT ACCOUNT management (the bank / UPI / QR accounts
shown to merchants on the Add Money screen). Records only — no payment is initiated.

Covers create / edit / retire, the "an active account must be usable" rule, field allow-listing
(unknown keys are never stored or rendered), label validation, retire-never-deletes, permission
split (`payment.verify` reads, `payment.manage` writes) and the actor-attributed audit trail.
Real router + services on throw-away SQLite data; the QR upload path (file I/O) is not exercised.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models_v2 import PaymentAccount, SystemLog, UserRole
from app.routers import payment_admin as payment_admin_router
from tests._v2_harness import Harness

BASE = "/api/admin/payment-accounts"
BANK = {"account_name": "JackPots Travels", "account_number": "000111222333", "ifsc": "TEST0000001",
        "bank_name": "Test Bank"}


@pytest.fixture()
def h():
    harness = Harness(payment_admin_router.router)
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _create(h, admin, **over):
    body = {"account_type": "bank", "label": "Main bank", "details": dict(BANK), "is_active": True}
    body.update(over)
    return h.client.post(BASE, json=body, headers=admin["headers"])


def _row(h, aid):
    db = h.db()
    a = db.get(PaymentAccount, aid)
    db.close()
    return a


def _actions(h):
    db = h.db()
    out = [(l.action, l.user_id) for l in db.scalars(select(SystemLog)).all()]
    db.close()
    return out


def test_create_bank_account_persists_and_is_audited(h, admin):
    r = _create(h, admin)
    assert r.status_code == 201, r.text
    a = _row(h, r.json()["id"] if "id" in r.json() else r.json()["account_id"])
    assert a.label == "Main bank" and a.is_active and a.details["account_number"] == "000111222333"
    assert any(x[1] == admin["id"] for x in _actions(h))


def test_unknown_detail_keys_are_dropped_not_stored(h, admin):
    body = dict(BANK, evil="<script>alert(1)</script>", upi_id="should@not-be-here")
    r = _create(h, admin, details=body)
    assert r.status_code == 201, r.text
    aid = r.json().get("id") or r.json().get("account_id")
    assert set(_row(h, aid).details) <= {"account_name", "account_number", "ifsc", "bank_name", "branch", "account_type"}


@pytest.mark.parametrize("kind,details", [
    ("bank", {"account_name": "X"}),
    ("bank", {"account_name": "X", "account_number": "1"}),
    ("upi", {"payee_name": "X"}),
    ("upi", {}),
], ids=["bank-no-number", "bank-no-ifsc", "upi-no-id", "upi-empty"])
def test_an_active_account_a_merchant_could_not_pay_into_is_refused(h, admin, kind, details):
    r = _create(h, admin, account_type=kind, details=details, is_active=True)
    assert r.status_code == 400, r.text
    db = h.db()
    assert db.scalars(select(PaymentAccount)).all() == []
    db.close()


def test_an_inactive_qr_account_may_be_created_then_is_refused_activation_without_an_image(h, admin):
    r = _create(h, admin, account_type="qr", details={"upi_id": "pay@bank"}, is_active=False)
    assert r.status_code == 201, r.text
    aid = r.json().get("id") or r.json().get("account_id")
    act = h.client.put(f"{BASE}/{aid}", json={"is_active": True}, headers=admin["headers"])
    assert act.status_code == 400, act.text
    assert not _row(h, aid).is_active


def test_edit_is_partial_and_rechecks_the_resulting_state(h, admin):
    aid = (lambda j: j.get("id") or j.get("account_id"))(_create(h, admin).json())
    ok = h.client.put(f"{BASE}/{aid}", json={"label": "Renamed"}, headers=admin["headers"])
    assert ok.status_code == 200 and _row(h, aid).label == "Renamed"
    assert _row(h, aid).details["account_number"] == "000111222333", "omitted details are left alone"
    bad = h.client.put(f"{BASE}/{aid}", json={"details": {"account_name": "X"}}, headers=admin["headers"])
    assert bad.status_code == 400, "emptying a live account's number must be refused"
    assert _row(h, aid).details["account_number"] == "000111222333"
    assert h.client.put(f"{BASE}/424242", json={"label": "Zz"}, headers=admin["headers"]).status_code == 404


@pytest.mark.parametrize("label", ["", "   "], ids=["empty", "blank"])
def test_blank_labels_are_rejected(h, admin, label):
    """A whitespace-only label passes min_length=1 and would be stored as ''."""
    r = _create(h, admin, label=label)
    assert r.status_code in (400, 422), r.text
    db = h.db()
    assert [a.label for a in db.scalars(select(PaymentAccount)).all()] == []
    db.close()


def test_retire_deactivates_but_never_deletes(h, admin):
    aid = (lambda j: j.get("id") or j.get("account_id"))(_create(h, admin).json())
    r = h.client.delete(f"{BASE}/{aid}", headers=admin["headers"])
    assert r.status_code == 200, r.text
    a = _row(h, aid)
    assert a is not None and a.is_active is False
    assert h.client.delete(f"{BASE}/424242", headers=admin["headers"]).status_code == 404


def test_invalid_account_type_and_missing_label_are_422(h, admin):
    assert _create(h, admin, account_type="paypal").status_code == 422
    assert h.client.post(BASE, json={"account_type": "bank"}, headers=admin["headers"]).status_code == 422


def test_writes_need_payment_manage_and_reads_need_payment_verify(h, admin):
    aid = (lambda j: j.get("id") or j.get("account_id"))(_create(h, admin).json())
    for method, url, body in [("post", BASE, {"account_type": "upi", "label": "U", "details": {"upi_id": "a@b"}}),
                              ("put", f"{BASE}/{aid}", {"label": "Hack"}), ("delete", f"{BASE}/{aid}", None)]:
        kw = {"json": body} if body is not None else {}
        assert getattr(h.client, method)(url, **kw).status_code == 401
        for role in (UserRole.MANAGER, UserRole.MERCHANT_ADMIN):
            who = h.user(role, name="No Access")
            assert getattr(h.client, method)(url, headers=who["headers"], **kw).status_code == 403
    assert _row(h, aid).label == "Main bank" and _row(h, aid).is_active
    assert h.client.get(BASE).status_code == 401
    assert h.client.get(BASE, headers=h.user(UserRole.MANAGER, name="M")["headers"]).status_code == 403
    assert h.client.get(BASE, headers=admin["headers"]).status_code == 200
