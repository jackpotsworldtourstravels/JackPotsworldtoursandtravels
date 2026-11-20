"""HTTP-level verification of the booking PAYMENT -> TICKET ISSUE chain:

  * merchant payment submission (``POST /api/requests/{id}/pay``) and the Admin verification queue
    (``GET /api/admin/payments/pending``, ``POST /api/admin/payments/{id}/verify``);
  * ticket issuing (``POST /api/admin/requests/{id}/issue-ticket``) on the STANDARD track (needs Paid) and
    on the CLASSIC (enquiry-led, wallet-billed) track (needs documents + fare, debits the wallet).

All money is the platform's INTERNAL ledger on throw-away SQLite rows — no payment provider, supplier or airline
is contacted (``payment_method`` is just text; delivery mocked). Refund-related paths are not touched.
PostgreSQL behaviour (row locks, ``uq_wallet_transactions_booking_debit``, sequences, enum casts) is NOT proven
here; sequences are emulated by the harness.
"""
from __future__ import annotations

import decimal
import smtplib

import pytest
from sqlalchemy import func, select

from app.models_v2 import (
    DocumentType, DocumentVerification, Merchant, MerchantStatus, Payment, PaymentStatus, Provider, ProviderStatus,
    ProviderUser, RequestDocument, RequestSource, RequestStatus, RequestType, ServiceRequest, SystemLog, UserRole,
    WalletTransaction,
)
from app.routers import tickets as tickets_router
from app.services import delivery_service, notification_service
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus


@pytest.fixture()
def h(monkeypatch):
    told = []
    for name in ("create_notification", "notify_admins", "notify_merchant_managers", "notify_request_merchant"):
        monkeypatch.setattr(notification_service, name, lambda *a, _n=name, **k: told.append(_n) or 0)

    def _blocked(*a, **k):
        raise AssertionError("external delivery reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    harness = Harness(tickets_router.router)
    db = harness.db()
    db.add(Merchant(merchant_id=1001, merchant_code="M1001", merchant_name="M", company_name="M Co",
                    email="m1001@tt-qa.com", reference_prefix="TP", status=MerchantStatus.ACTIVE,
                    wallet_balance=D("5000.00"), credit_limit=D("0")))
    db.add(Merchant(merchant_id=1002, merchant_code="M1002", merchant_name="N", company_name="N Co",
                    email="m1002@tt-qa.com", reference_prefix="TQ", status=MerchantStatus.ACTIVE,
                    wallet_balance=D("0.00"), credit_limit=D("0")))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


@pytest.fixture()
def merchant(h):
    return h.user(UserRole.MERCHANT_ADMIN, merchant_id=1001, name="Mer Admin")


def _booking(h, *, status=S.PAYMENT_PENDING, total="1000", classic=False, merchant_id=1001, history=None):
    db = h.db()
    nid = (db.scalar(select(func.max(ServiceRequest.request_id))) or 10000) + 1
    db.add(ServiceRequest(
        request_id=nid, request_number=f"TK-{nid}", merchant_id=merchant_id, request_type=RequestType.BOOKING,
        source=RequestSource.MERCHANT_PORTAL, status=status, title="Delhi to Goa",
        travel_details={"direct_booking": True} if classic else {}, pricing={}, quantity=1,
        total_amount=D(total), status_history=history or []))
    db.commit()
    db.close()
    return nid


def _req(h, rid):
    db = h.db()
    r = db.get(ServiceRequest, rid)
    db.close()
    return r


def _wallet(h, mid=1001):
    db = h.db()
    b = db.get(Merchant, mid).wallet_balance
    db.close()
    return b


def _payments(h, rid=None):
    db = h.db()
    q = select(Payment)
    if rid:
        q = q.where(Payment.request_id == rid)
    rows = db.scalars(q).all()
    db.close()
    return rows


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _pay(h, who, rid, amount="1000", method="bank_transfer", txn="UTR-TEST-1"):
    return h.client.post(f"/api/requests/{rid}/pay", json={"amount": amount, "method": method, "transaction_id": txn},
                         headers=who["headers"])


def _verify(h, who, pid, approve=True, note=None):
    return h.client.post(f"/api/admin/payments/{pid}/verify", json={"approve": approve, "note": note},
                         headers=who["headers"])


def _issue(h, who, rid, **body):
    return h.client.post(f"/api/admin/requests/{rid}/issue-ticket", json=body or None, headers=who["headers"])


# ================================================================ payment submission
def test_merchant_payment_lands_pending_and_does_not_move_the_booking(h, merchant):
    rid = _booking(h)
    r = _pay(h, merchant, rid)
    assert r.status_code == 200, r.text
    p = _payments(h, rid)
    assert len(p) == 1 and p[0].payment_status is PaymentStatus.PENDING and p[0].amount == D("1000")
    assert _req(h, rid).status is S.PAYMENT_PENDING
    assert len(_logs(h, "Payment submitted")) == 1 and _wallet(h) == D("5000.00"), "a bank payment moves no wallet"


@pytest.mark.parametrize("amount", ["0", "-5", "1000.01", "abc"], ids=["zero", "negative", "overpay", "not-a-number"])
def test_payment_amount_rules(h, merchant, amount):
    rid = _booking(h, total="1000")
    r = _pay(h, merchant, rid, amount=amount)
    assert r.status_code in (400, 422), r.text
    assert _payments(h, rid) == [] and _logs(h, "Payment submitted") == []


def test_cannot_pay_twice_beyond_what_is_owed_or_outside_payment_pending(h, merchant):
    rid = _booking(h, total="1000")
    assert _pay(h, merchant, rid, amount="600").status_code == 200
    over = _pay(h, merchant, rid, amount="500")
    assert over.status_code == 400 and "left to pay" in over.json()["detail"]
    assert _pay(h, merchant, rid, amount="400", txn="UTR-2").status_code == 200
    assert len(_payments(h, rid)) == 2
    for st in (S.APPROVED, S.PAID, S.PENDING_APPROVAL, S.TICKET_ISSUED):
        assert _pay(h, merchant, _booking(h, status=st)).status_code == 400, st


def test_wallet_payment_debits_the_wallet_and_is_refused_when_it_cannot_cover(h, merchant):
    rid = _booking(h, total="1500")
    assert _pay(h, merchant, rid, amount="1500", method="wallet").status_code == 200
    assert _wallet(h) == D("3500.00")
    poor = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1002, name="Poor")
    rid2 = _booking(h, total="100", merchant_id=1002)
    r = _pay(h, poor, rid2, amount="100", method="wallet")
    assert r.status_code in (400, 402, 409), r.text
    assert _payments(h, rid2) == [] and _wallet(h, 1002) == D("0.00")


def test_a_merchant_cannot_pay_another_merchants_booking(h, merchant):
    other = _booking(h, merchant_id=1002)
    assert _pay(h, merchant, other).status_code == 404
    assert _payments(h, other) == []


# ================================================================ payment verification
def test_verify_full_payment_marks_success_and_moves_the_booking_to_paid(h, merchant, admin):
    rid = _booking(h)
    _pay(h, merchant, rid)
    pid = _payments(h, rid)[0].payment_id
    q = h.client.get("/api/admin/payments/pending", headers=admin["headers"])
    assert q.status_code == 200 and q.json()["total"] == 1
    r = _verify(h, admin, pid, approve=True, note="Seen on statement")
    assert r.status_code == 200, r.text
    assert _payments(h, rid)[0].payment_status is PaymentStatus.SUCCESS
    assert _req(h, rid).status is S.PAID
    log = _logs(h, "Payment verified")
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert h.client.get("/api/admin/payments/pending", headers=admin["headers"]).json()["total"] == 0


def test_verifying_a_partial_payment_does_not_mark_the_booking_paid(h, merchant, admin):
    rid = _booking(h, total="1000")
    _pay(h, merchant, rid, amount="300")
    pid = _payments(h, rid)[0].payment_id
    assert _verify(h, admin, pid).status_code == 200
    assert _req(h, rid).status is S.PAYMENT_PENDING, "₹300 verified against ₹1000 must not mark it settled"
    _pay(h, merchant, rid, amount="700", txn="UTR-2")
    pid2 = [p for p in _payments(h, rid) if p.payment_status is PaymentStatus.PENDING][0].payment_id
    assert _verify(h, admin, pid2).status_code == 200 and _req(h, rid).status is S.PAID


def test_double_verification_and_unknown_payment(h, merchant, admin):
    rid = _booking(h)
    _pay(h, merchant, rid)
    pid = _payments(h, rid)[0].payment_id
    assert _verify(h, admin, pid).status_code == 200
    again = _verify(h, admin, pid)
    assert again.status_code == 400 and "already" in again.json()["detail"]
    assert _verify(h, admin, pid, approve=False, note="late").status_code == 400
    assert _payments(h, rid)[0].payment_status is PaymentStatus.SUCCESS
    assert len(_logs(h, "Payment verified")) == 1
    assert _verify(h, admin, 99999999).status_code == 404


def test_rejecting_a_payment_leaves_the_booking_payable_and_returns_wallet_money(h, merchant, admin):
    rid = _booking(h, total="800")
    _pay(h, merchant, rid, amount="800", method="wallet")
    assert _wallet(h) == D("4200.00")
    pid = _payments(h, rid)[0].payment_id
    r = _verify(h, admin, pid, approve=False, note="Reference not found")
    assert r.status_code == 200, r.text
    assert _payments(h, rid)[0].payment_status is PaymentStatus.FAILED
    assert _req(h, rid).status is S.PAYMENT_PENDING
    assert _wallet(h) == D("5000.00"), "the wallet money taken at submission must go back"
    assert _pay(h, merchant, rid, amount="800", txn="UTR-RETRY").status_code == 200, "the merchant may try again"


def test_payment_permissions(h, merchant, admin):
    rid = _booking(h)
    assert h.client.post(f"/api/requests/{rid}/pay", json={"amount": "10", "method": "x"}).status_code == 401
    # Staff cannot pay on a merchant's behalf; merchants cannot verify.
    assert h.client.post(f"/api/requests/{rid}/pay", json={"amount": "10", "method": "x"},
                         headers=admin["headers"]).status_code == 403
    _pay(h, merchant, rid)
    pid = _payments(h, rid)[0].payment_id
    assert h.client.post(f"/api/admin/payments/{pid}/verify", json={"approve": True}).status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    for who in (merchant, mgr):
        assert _verify(h, who, pid).status_code == 403
        assert h.client.get("/api/admin/payments/pending", headers=who["headers"]).status_code == 403
    assert _payments(h, rid)[0].payment_status is PaymentStatus.PENDING and _req(h, rid).status is S.PAYMENT_PENDING
    assert _logs(h, "Payment verified") == []


# ================================================================ ticket issuing — standard track
def test_issue_ticket_allocates_numbers_once_and_is_audited(h, admin):
    rid = _booking(h, status=S.PAID)
    r = _issue(h, admin, rid)
    assert r.status_code == 200, r.text
    row = _req(h, rid)
    assert row.status is S.TICKET_ISSUED and row.pnr and row.ticket_number and row.invoice_number
    assert _payments(h, rid) == [], "a standard-track ticket is not wallet-billed"
    assert [l.user_id for l in _logs(h, "Ticket issued")] == [admin["id"]]
    again = _issue(h, admin, rid)
    assert again.status_code in (400, 409), again.text
    row2 = _req(h, rid)
    assert (row2.pnr, row2.ticket_number, row2.invoice_number) == (row.pnr, row.ticket_number, row.invoice_number)
    other = _booking(h, status=S.PAID)
    assert _issue(h, admin, other).status_code == 200
    assert _req(h, other).ticket_number != row.ticket_number and _req(h, other).invoice_number != row.invoice_number


@pytest.mark.parametrize("st", [S.DRAFT, S.PENDING_APPROVAL, S.APPROVED, S.PAYMENT_PENDING, S.REJECTED, S.CANCELLED,
                                S.COMPLETED])
def test_issue_ticket_refuses_every_state_but_paid_and_changes_nothing(h, admin, st):
    rid = _booking(h, status=st)
    r = _issue(h, admin, rid)
    assert r.status_code in (400, 409), (st, r.text)
    row = _req(h, rid)
    assert row.status is st and row.pnr is None and row.ticket_number is None and row.invoice_number is None
    assert _logs(h, "Ticket issued") == []


def test_issue_ticket_unknown_booking_and_cross_scope(h, admin):
    assert _issue(h, admin, 99999999).status_code == 404


def test_issue_ticket_validates_the_supplier_and_burns_no_number(h, admin):
    rid = _booking(h, status=S.PAID)
    db = h.db()
    db.add(Provider(provider_id=11, provider_code="PRD011", provider_name="Alpha Air", status=ProviderStatus.ACTIVE))
    db.add(Provider(provider_id=12, provider_code="PRD012", provider_name="Beta Bus", status=ProviderStatus.ACTIVE))
    db.add(Provider(provider_id=13, provider_code="PRD013", provider_name="Old Co", status=ProviderStatus.INACTIVE))
    db.add(ProviderUser(provider_user_id=21, provider_id=12, user_name="Bea", email="b@tt-qa.com"))
    db.commit()
    db.close()
    for body in ({"provider_id": 999}, {"provider_id": 13}, {"provider_id": 11, "provider_user_id": 21}):
        r = _issue(h, admin, rid, **body)
        assert r.status_code == 400, (body, r.text)
    row = _req(h, rid)
    assert row.status is S.PAID and row.ticket_number is None and row.provider_id is None
    ok = _issue(h, admin, rid, provider_id=12, provider_user_id=21)
    assert ok.status_code == 200 and _req(h, rid).provider_id == 12 and _req(h, rid).provider_user_id == 21


def test_issue_ticket_permissions(h, admin):
    rid = _booking(h, status=S.PAID)
    assert h.client.post(f"/api/admin/requests/{rid}/issue-ticket").status_code == 401
    merchant = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1001, name="Mer Admin")
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    for who in (merchant, mgr):
        assert h.client.post(f"/api/admin/requests/{rid}/issue-ticket", headers=who["headers"]).status_code == 403
    assert _req(h, rid).status is S.PAID and _logs(h, "Ticket issued") == []


# ================================================================ ticket issuing — classic / wallet-billed
def _ticket_doc(h, rid, mid=1001):
    db = h.db()
    nid = (db.scalar(select(func.max(RequestDocument.document_id))) or 0) + 1
    db.add(RequestDocument(document_id=nid, request_id=rid, merchant_id=mid, doc_type=DocumentType.TICKET,
                           original_filename="ticket.pdf", stored_path="/nonexistent/t.pdf",
                           content_type="application/pdf", size_bytes=5,
                           verification_status=DocumentVerification.PENDING))
    db.commit()
    db.close()


def test_classic_issue_needs_documents_and_a_fare_then_debits_the_wallet_once(h, admin):
    rid = _booking(h, status=S.APPROVED, total="0", classic=True)
    no_docs = _issue(h, admin, rid, fare_amount="1800.00")
    assert no_docs.status_code == 400 and "Upload the issued ticket documents" in no_docs.json()["detail"]
    _ticket_doc(h, rid)
    for body in ({}, {"fare_amount": "0"}, {"fare_amount": "-5"}):
        r = _issue(h, admin, rid, **body)
        assert r.status_code in (400, 422), (body, r.text)
    row = _req(h, rid)
    assert row.status is S.APPROVED and row.ticket_number is None and row.total_amount == D("0")
    assert _wallet(h) == D("5000.00") and _payments(h, rid) == []

    r = _issue(h, admin, rid, fare_amount="1800.00")
    assert r.status_code == 200, r.text
    row = _req(h, rid)
    assert row.status is S.TICKET_ISSUED and row.total_amount == D("1800.00") and row.ticket_number
    assert _wallet(h) == D("3200.00")
    db = h.db()
    txns = db.scalars(select(WalletTransaction).where(WalletTransaction.request_id == rid)).all()
    db.close()
    assert len(txns) == 1 and txns[0].debit == D("1800.00") and txns[0].balance_after == D("3200.00")
    assert len(_payments(h, rid)) == 1, "the booking is also written as settled so the debt is not reported twice"
    assert len(_logs(h, "Wallet debited for booking")) == 1 and len(_logs(h, "Ticket issued")) == 1
    again = _issue(h, admin, rid, fare_amount="1800.00")
    assert again.status_code in (400, 409)
    assert _wallet(h) == D("3200.00"), "re-issuing must never debit twice"
