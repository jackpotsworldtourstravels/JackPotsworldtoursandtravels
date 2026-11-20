"""HTTP-level verification of Admin BOOKING OPERATIONS (``/api/admin/bookings``): the processing
queue, operator assignment, airline PNR / ticket-number references and staff-only internal notes.

Real router + services + RBAC on throw-away SQLite data (``tests/_v2_harness.py``). No supplier or
airline is contacted — references are just text the desk records. PostgreSQL row locking and the
``uq_sr_ticket_number`` index are not exercised (the application-level duplicate check is).
"""
from __future__ import annotations

import decimal

import pytest
from sqlalchemy import select

from app.models_v2 import (
    Merchant, MerchantStatus, RequestNote, RequestSource, RequestStatus, RequestType, ServiceRequest,
    SystemLog, UserRole, UserStatus, User,
)
from app.routers import booking_ops as booking_ops_router
from tests._v2_harness import Harness

D = decimal.Decimal
BASE = "/api/admin/bookings"


@pytest.fixture()
def h():
    harness = Harness(booking_ops_router.router)
    db = harness.db()
    db.add(Merchant(merchant_id=701, merchant_code="M701", merchant_name="Mer", company_name="Mer Co",
                    email="m701@tt-qa.com", reference_prefix="BO", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


_R = {"n": 7100}


def _booking(h, *, status=RequestStatus.APPROVED, rtype=RequestType.BOOKING, pnr=None, ticket=None, title="Delhi to Goa"):
    _R["n"] += 1
    db = h.db()
    db.add(ServiceRequest(
        request_id=_R["n"], request_number=f"BO-{_R['n']}", merchant_id=701, request_type=rtype,
        source=RequestSource.MERCHANT_PORTAL, status=status, title=title, travel_details={}, pricing={},
        quantity=1, total_amount=D("1000"), pnr=pnr, ticket_number=ticket))
    db.commit()
    db.close()
    return _R["n"]


def _req(h, rid):
    db = h.db()
    r = db.get(ServiceRequest, rid)
    db.close()
    return r


def _logs(h, action=None):
    db = h.db()
    rows = db.scalars(select(SystemLog)).all()
    db.close()
    return [l for l in rows if action is None or l.action == action]


def _notes(h, rid):
    db = h.db()
    rows = db.scalars(select(RequestNote).where(RequestNote.request_id == rid)).all()
    db.close()
    return rows


# --------------------------------------------------------------------- queue
def test_queue_lists_only_post_approval_bookings_oldest_first_and_counts(h, admin):
    early = _booking(h, status=RequestStatus.APPROVED)
    paid = _booking(h, status=RequestStatus.PAID)
    _booking(h, status=RequestStatus.PENDING_APPROVAL)      # not in the desk's world
    _booking(h, status=RequestStatus.REJECTED)
    _booking(h, rtype=RequestType.CATALOG_ITEM, status=RequestStatus.APPROVED)
    r = h.client.get(f"{BASE}/queue", headers=admin["headers"])
    assert r.status_code == 200, r.text
    ids = [i["id"] for i in r.json()["items"]]
    assert ids == [early, paid] and r.json()["total"] == 2
    c = h.client.get(f"{BASE}/queue/counts", headers=admin["headers"])
    assert c.status_code == 200, c.text


def test_queue_filters_validate_the_stage_and_page_size(h, admin):
    assert h.client.get(f"{BASE}/queue", params={"stage": "pending_approval"}, headers=admin["headers"]).status_code == 400
    assert h.client.get(f"{BASE}/queue", params={"stage": "nonsense"}, headers=admin["headers"]).status_code == 422
    assert h.client.get(f"{BASE}/queue", params={"page_size": 101}, headers=admin["headers"]).status_code == 422
    rid = _booking(h, status=RequestStatus.PAID, title="Mumbai Dubai")
    _booking(h, status=RequestStatus.APPROVED, title="Other trip")
    got = h.client.get(f"{BASE}/queue", params={"stage": "paid"}, headers=admin["headers"]).json()
    assert [i["id"] for i in got["items"]] == [rid]
    got = h.client.get(f"{BASE}/queue", params={"search": "dubai"}, headers=admin["headers"]).json()
    assert [i["id"] for i in got["items"]] == [rid]


# ------------------------------------------------------------------- assign
def test_assign_and_unassign_persist_and_are_audited(h, admin):
    rid = _booking(h)
    op = h.user(UserRole.ADMIN, name="Olive Operator")
    r = h.client.post(f"{BASE}/{rid}/assign", json={"operator_id": op["id"]}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    assert _req(h, rid).assigned_admin == op["id"]
    la = _logs(h, "Booking assigned")
    assert len(la) == 1 and la[0].user_id == admin["id"]
    mine = h.client.get(f"{BASE}/queue", params={"assigned_to": op["id"]}, headers=admin["headers"]).json()
    assert [i["id"] for i in mine["items"]] == [rid]
    un = h.client.post(f"{BASE}/{rid}/assign", json={"operator_id": None}, headers=admin["headers"])
    assert un.status_code == 200 and _req(h, rid).assigned_admin is None
    assert len(_logs(h, "Booking unassigned")) == 1


def test_assign_refuses_operators_who_cannot_work_bookings(h, admin):
    rid = _booking(h)
    merchant_user = h.user(UserRole.MERCHANT_USER, merchant_id=701, name="Merchant Person")
    manager = h.user(UserRole.MANAGER, name="Mo Manager")                 # no ticket.approve
    inactive = h.user(UserRole.ADMIN, name="Ina Inactive")
    db = h.db()
    db.get(User, inactive["id"]).status = UserStatus.INACTIVE
    db.commit()
    db.close()
    for who in (merchant_user, manager, inactive, {"id": 424242}):
        r = h.client.post(f"{BASE}/{rid}/assign", json={"operator_id": who["id"]}, headers=admin["headers"])
        assert r.status_code == 400, (who, r.text)
    assert _req(h, rid).assigned_admin is None
    assert _logs(h, "Booking assigned") == []


def test_assign_unknown_booking_and_catalogue_rows_are_404(h, admin):
    op = h.user(UserRole.ADMIN, name="Olive Operator")
    assert h.client.post(f"{BASE}/99999999/assign", json={"operator_id": op["id"]}, headers=admin["headers"]).status_code == 404
    cat = _booking(h, rtype=RequestType.CATALOG_ITEM)
    assert h.client.post(f"{BASE}/{cat}/assign", json={"operator_id": op["id"]}, headers=admin["headers"]).status_code == 404


# --------------------------------------------------------------- references
def test_references_need_a_confirmed_booking_and_are_normalised(h, admin):
    early = _booking(h, status=RequestStatus.PENDING_APPROVAL)
    r = h.client.put(f"{BASE}/{early}/references", json={"pnr": "abc123"}, headers=admin["headers"])
    assert r.status_code == 400 and "not confirmed" in r.json()["detail"]
    assert _req(h, early).pnr is None and _logs(h, "Booking references updated") == []

    rid = _booking(h, status=RequestStatus.TICKET_ISSUED, pnr="SYNTH1", ticket="TKT-OLD")
    r = h.client.put(f"{BASE}/{rid}/references", json={"pnr": " h4x9pq "}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    row = _req(h, rid)
    assert row.pnr == "H4X9PQ" and row.ticket_number == "TKT-OLD", "a PNR-only update must not blank the ticket number"
    log = _logs(h, "Booking references updated")
    assert len(log) == 1 and log[0].user_id == admin["id"]
    assert log[0].extra_data["changes"]["pnr"] == {"from": "SYNTH1", "to": "H4X9PQ"}


def test_references_reject_blanks_and_duplicate_ticket_numbers_without_changes(h, admin):
    a = _booking(h, status=RequestStatus.TICKET_ISSUED, pnr="AAA111", ticket="TKT-1")
    b = _booking(h, status=RequestStatus.TICKET_ISSUED, pnr="BBB222", ticket="TKT-2")
    for body in ({"pnr": "   "}, {"ticket_number": "  "}):
        assert h.client.put(f"{BASE}/{b}/references", json=body, headers=admin["headers"]).status_code == 400
    dup = h.client.put(f"{BASE}/{b}/references", json={"ticket_number": "TKT-1"}, headers=admin["headers"])
    assert dup.status_code == 409 and _req(h, a).request_number in dup.json()["detail"]
    assert h.client.put(f"{BASE}/{b}/references", json={"pnr": "X" * 21}, headers=admin["headers"]).status_code == 422
    row = _req(h, b)
    assert (row.pnr, row.ticket_number) == ("BBB222", "TKT-2")
    assert _logs(h, "Booking references updated") == []
    same = h.client.put(f"{BASE}/{b}/references", json={"ticket_number": "TKT-2"}, headers=admin["headers"])
    assert same.status_code == 200, "re-saving its own ticket number is not a clash"


# -------------------------------------------------------------------- notes
def test_note_lifecycle_author_rules_and_content_free_audit(h, admin):
    rid = _booking(h)
    secret = "PASSPORT-NUMBER-ZX9-DO-NOT-LOG"
    r = h.client.post(f"{BASE}/{rid}/notes", json={"body": f"  {secret}  "}, headers=admin["headers"])
    assert r.status_code == 201, r.text
    nid = r.json()["id"]
    assert r.json()["body"] == secret and r.json()["can_edit"] is True
    assert [n.body for n in _notes(h, rid)] == [secret]
    added = _logs(h, "Internal note added")
    assert len(added) == 1 and secret not in repr(added[0].description) + repr(added[0].extra_data)

    lst = h.client.get(f"{BASE}/{rid}/notes", headers=admin["headers"]).json()
    assert [n["id"] for n in lst] == [nid]

    other = h.user(UserRole.ADMIN, name="Bo Other")
    assert h.client.put(f"{BASE}/notes/{nid}", json={"body": "hijack"}, headers=other["headers"]).status_code == 403
    assert h.client.delete(f"{BASE}/notes/{nid}", headers=other["headers"]).status_code == 403
    assert _notes(h, rid)[0].body == secret

    ed = h.client.put(f"{BASE}/notes/{nid}", json={"body": "Updated text"}, headers=admin["headers"])
    assert ed.status_code == 200 and ed.json()["edited_at"] is not None
    assert _notes(h, rid)[0].body == "Updated text"

    assert h.client.delete(f"{BASE}/notes/{nid}", headers=admin["headers"]).status_code == 204
    assert _notes(h, rid) == [] and len(_logs(h, "Internal note deleted")) == 1
    assert h.client.delete(f"{BASE}/notes/{nid}", headers=admin["headers"]).status_code == 404


def test_note_edits_are_audited(h, admin):
    """DEFECT-5: add and delete were audited, but editing an internal note rewrote history silently."""
    rid = _booking(h)
    nid = h.client.post(f"{BASE}/{rid}/notes", json={"body": "first"}, headers=admin["headers"]).json()["id"]
    assert h.client.put(f"{BASE}/notes/{nid}", json={"body": "SECRET-EDIT-BODY"}, headers=admin["headers"]).status_code == 200
    edits = _logs(h, "Internal note edited")
    assert len(edits) == 1 and edits[0].user_id == admin["id"]
    assert "SECRET-EDIT-BODY" not in repr(edits[0].description) + repr(edits[0].extra_data), "audit stays content-free"


@pytest.mark.parametrize("body", [{}, {"body": ""}, {"body": "   "}, {"body": "x" * 4001}],
                         ids=["missing", "empty", "blank", "too-long"])
def test_invalid_notes_are_rejected_and_nothing_is_stored(h, admin, body):
    rid = _booking(h)
    r = h.client.post(f"{BASE}/{rid}/notes", json=body, headers=admin["headers"])
    assert r.status_code in (400, 422), r.text
    assert _notes(h, rid) == [] and _logs(h, "Internal note added") == []


def test_notes_on_missing_booking_are_404(h, admin):
    assert h.client.post(f"{BASE}/99999999/notes", json={"body": "x"}, headers=admin["headers"]).status_code == 404
    assert h.client.get(f"{BASE}/99999999/notes", headers=admin["headers"]).status_code == 404


# -------------------------------------------------------------- permissions
def test_anonymous_gets_401_everywhere(h):
    rid = _booking(h)
    calls = [("get", f"{BASE}/queue", None), ("get", f"{BASE}/queue/counts", None),
             ("post", f"{BASE}/{rid}/assign", {"operator_id": None}),
             ("put", f"{BASE}/{rid}/references", {"pnr": "AAA111"}),
             ("get", f"{BASE}/{rid}/notes", None), ("post", f"{BASE}/{rid}/notes", {"body": "x"}),
             ("put", f"{BASE}/notes/1", {"body": "x"}), ("delete", f"{BASE}/notes/1", None)]
    for m, u, b in calls:
        kw = {"json": b} if b is not None else {}
        assert getattr(h.client, m)(u, **kw).status_code == 401, (m, u)


def test_merchants_and_unprivileged_staff_are_refused_and_nothing_changes(h, admin):
    rid = _booking(h, status=RequestStatus.TICKET_ISSUED, pnr="AAA111")
    nid = h.client.post(f"{BASE}/{rid}/notes", json={"body": "staff only"}, headers=admin["headers"]).json()["id"]
    merchant = h.user(UserRole.MERCHANT_ADMIN, merchant_id=701, name="Mer Admin")
    manager = h.user(UserRole.MANAGER, name="Mo Manager")
    for who in (merchant, manager):
        for m, u, b in [("get", f"{BASE}/{rid}/notes", None),
                        ("post", f"{BASE}/{rid}/notes", {"body": "intrusion"}),
                        ("post", f"{BASE}/{rid}/assign", {"operator_id": None}),
                        ("put", f"{BASE}/{rid}/references", {"pnr": "HACK99"}),
                        ("put", f"{BASE}/notes/{nid}", {"body": "hack"}),
                        ("delete", f"{BASE}/notes/{nid}", None)]:
            kw = {"json": b} if b is not None else {}
            assert getattr(h.client, m)(u, headers=who["headers"], **kw).status_code == 403, (who, m, u)
    assert _req(h, rid).pnr == "AAA111" and [n.body for n in _notes(h, rid)] == ["staff only"]
    assert _logs(h, "Booking references updated") == []
