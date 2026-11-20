"""Phase 4 (audit follow-up) — the B2C Support Tickets module is a live, two-way,
customer-facing system that coexists with Live Chat.

Covers the customer side of ``/api/customer/support-tickets`` (create / list /
view-with-thread), cross-customer isolation, that a staff reply (admin service)
lands correctly in the customer's own thread AND raises the in-app notification,
and that these customer tickets are a separate system from the B2B merchant
threads in support_tickets.py (models_v2.User).

Isolated temp-file SQLite harness — no real DB, no external communication.
"""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import customer_deps
from app.database.session import get_db
from app.models_customer import (
    Base,
    Customer,
    CustomerNotification,
    CustomerSupportMessage,
    CustomerSupportTicket,
)
from app.routers import customer_account
from app.services import customer_communication_admin_service as comm

_TABLES = [Customer.__table__, CustomerSupportTicket.__table__,
           CustomerSupportMessage.__table__, CustomerNotification.__table__]
_ENGINES: list = []
_TMPFILES: list = []


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    while _ENGINES:
        _ENGINES.pop().dispose()
    while _TMPFILES:
        path = _TMPFILES.pop()
        try:
            os.unlink(path)
        except OSError:
            pass


def _engine():
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _TMPFILES.append(path)
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng, tables=_TABLES)
    _ENGINES.append(eng)
    return eng


def _maker(eng):
    return sessionmaker(bind=eng, expire_on_commit=False)


def _seed_customer(eng, cid):
    with _maker(eng)() as s:
        s.add(Customer(customer_id=cid, customer_code=f"CUST{cid:04d}", full_name=f"Person{cid}",
                       email=f"p{cid}@example.test", mobile=f"90000000{cid:02d}"))
        s.commit()


def _client(eng, cid):
    """A client authenticated as customer `cid` (the overridden
    get_current_customer the ticket routes depend on)."""
    app = FastAPI()
    app.include_router(customer_account.router)
    session = _maker(eng)()

    def _as_customer():
        return session.get(Customer, cid)

    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[customer_deps.get_current_customer] = _as_customer
    return TestClient(app, raise_server_exceptions=False)


# --- create / list / view ----------------------------------------------------
def test_customer_creates_lists_and_views_ticket_with_its_thread():
    eng = _engine()
    _seed_customer(eng, 1)
    client = _client(eng, 1)

    created = client.post("/api/customer/support-tickets",
                          json={"subject": "Booking question", "description": "When is check-in?",
                                "priority": "high"})
    assert created.status_code == 201, created.text
    tid = created.json()["ticket_id"] if "ticket_id" in created.json() else created.json().get("id")
    body = created.json()
    assert body["subject"] == "Booking question" and body["priority"] == "high"
    # the description seeds the thread's first (customer) message
    assert any(m["message"] == "When is check-in?" and m["is_staff"] is False for m in body["messages"])

    listed = client.get("/api/customer/support-tickets")
    assert listed.status_code == 200 and len(listed.json()) == 1

    detail = client.get(f"/api/customer/support-tickets/{tid}")
    assert detail.status_code == 200
    assert detail.json()["subject"] == "Booking question"
    assert len(detail.json()["messages"]) == 1


# --- isolation ----------------------------------------------------------------
def test_customer_cannot_see_or_read_another_customers_ticket():
    eng = _engine()
    _seed_customer(eng, 1)
    _seed_customer(eng, 2)
    # customer 2 raises a ticket
    other = _client(eng, 2).post("/api/customer/support-tickets",
                                 json={"subject": "Private", "description": "Only mine."})
    assert other.status_code == 201
    other_tid = other.json().get("ticket_id") or other.json().get("id")

    c1 = _client(eng, 1)
    # customer 1's list is empty; the detail of customer 2's ticket is 404, not 403-leak
    assert c1.get("/api/customer/support-tickets").json() == []
    assert c1.get(f"/api/customer/support-tickets/{other_tid}").status_code == 404


# --- customer + staff messages stay associated; reply reaches the customer ----
def test_staff_reply_appears_in_the_customers_thread_and_notifies():
    eng = _engine()
    _seed_customer(eng, 1)
    created = _client(eng, 1).post("/api/customer/support-tickets",
                                   json={"subject": "Refund", "description": "Where is my refund?"})
    tid = created.json().get("ticket_id") or created.json().get("id")

    # staff replies through the admin service (same path the admin endpoint uses)
    with _maker(eng)() as s:
        assert comm.reply_ticket(s, tid, author_name="Agent Smith", message="Processed today.") is not None
        s.commit()

    detail = _client(eng, 1).get(f"/api/customer/support-tickets/{tid}")
    assert detail.status_code == 200
    msgs = detail.json()["messages"]
    # both the customer's opening message and the staff reply, correctly associated
    assert any(m["is_staff"] is False and m["message"] == "Where is my refund?" for m in msgs)
    assert any(m["is_staff"] is True and m["message"] == "Processed today." for m in msgs)
    # exactly one in-app notification for this customer, linked to the ticket
    with _maker(eng)() as s:
        notes = s.query(CustomerNotification).filter_by(customer_id=1).all()
        assert len(notes) == 1 and notes[0].related_ref == f"ticket:{tid}"


# --- separation from the B2B merchant support system --------------------------
def test_b2c_tickets_are_a_separate_system_from_b2b_merchant_threads():
    # B2C customer tickets are rooted at the customer Base and keyed by customer_id.
    assert CustomerSupportTicket.__tablename__ == "customer_support_tickets"
    assert "customer_id" in CustomerSupportTicket.__table__.columns
    # The B2B merchant-support thread system lives on models_v2 (a different
    # declarative Base) and is keyed by the staff/merchant User, not a customer —
    # a distinct table, so the two systems cannot be confused or share rows.
    from app.models_v2 import Base as B2BBase  # noqa: PLC0415
    assert CustomerSupportTicket.__table__ not in B2BBase.metadata.tables.values()
    assert "customer_support_tickets" not in B2BBase.metadata.tables
