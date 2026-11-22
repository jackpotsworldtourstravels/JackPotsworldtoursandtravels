"""Tour Package enquiry admin queue, over HTTP (Phase 2 Bug 3).

Real router + service + RBAC on the shared V2 SQLite harness. Proves:
  * authorization — the admin routes require ``tour_package.enquiry.manage``;
    an ADMIN holds it, a SUPER_ADMIN (granular grant, same as the Gaming desk)
    does not, an explicit per-user grant does;
  * list pagination / status filter / search;
  * detail + 404;
  * PATCH status / assignment (auto-ASSIGN on a NEW row) / notes, and the
    actor-attributed audit row it writes, read back via /history;
  * the PUBLIC submission is untouched and still stores an enquiry.

Audit rows are written and read for real (system_logs is created by the
harness); nothing reaches SMTP or PostgreSQL.
"""
from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import select

from app.auth.rate_limit import limiter
from app.auth.rbac import P
from app.models_v2 import TourPackageEnquiry, UserRole
from app.routers import tour_package_enquiries as router_mod
from tests._v2_harness import Harness, next_id

PUB = "/api/customer/tour-package-enquiries"
ADM = "/api/admin/tour-package-enquiries"


@pytest.fixture()
def h(monkeypatch):
    harness = Harness(router_mod.router)
    # slowapi's decorator reads app.state.limiter; disable limiting for tests.
    harness.app.state.limiter = limiter
    monkeypatch.setattr(limiter, "enabled", False)
    yield harness
    harness.dispose()


def _seed(h, **over):
    db = h.db()
    row = TourPackageEnquiry(
        enquiry_reference=over.get("ref", f"TPE-TEST-{next_id()}"),
        customer_name=over.get("customer_name", "Asha Rao"),
        email=over.get("email", "asha@example.test"),
        mobile_number=over.get("mobile_number", "9000000012"),
        package_id=None,
        package_name=over.get("package_name", "Bali Escape"),
        preferred_travel_date=over.get("preferred_travel_date"),
        number_of_travellers=over.get("number_of_travellers", 2),
        message=over.get("message", "Please share December dates."),
        status=over.get("status", "NEW"),
        created_at=dt.datetime.now(dt.timezone.utc),
    )
    db.add(row)
    db.commit()
    rid = row.id
    db.close()
    return rid


# ------------------------------------------------------------- authorization
def test_admin_with_permission_can_list(h):
    admin = h.user(UserRole.ADMIN)
    r = h.client.get(ADM, headers=admin["headers"])
    assert r.status_code == 200
    assert "items" in r.json()


def test_super_admin_lacks_this_granular_grant(h):
    # SUPER_ADMIN manages admins, not the operational enquiry desk — the same
    # granular split the Gaming Tour queue uses.
    su = h.user(UserRole.SUPER_ADMIN)
    assert h.client.get(ADM, headers=su["headers"]).status_code == 403


def test_explicit_per_user_grant_is_enough(h):
    u = h.user(UserRole.MANAGER, permissions=[P.TOUR_PACKAGE_ENQUIRY_MANAGE])
    assert h.client.get(ADM, headers=u["headers"]).status_code == 200


def test_unauthenticated_is_refused(h):
    assert h.client.get(ADM).status_code in (401, 403)


# ------------------------------------------------------------- list / filter
def test_list_filters_by_status_and_paginates(h):
    for _ in range(3):
        _seed(h, status="NEW")
    _seed(h, status="CONTACTED")
    admin = h.user(UserRole.ADMIN)

    allrows = h.client.get(ADM, headers=admin["headers"], params={"page_size": 2}).json()
    assert allrows["total"] == 4 and len(allrows["items"]) == 2 and allrows["total_pages"] == 2

    contacted = h.client.get(ADM, headers=admin["headers"], params={"status": "CONTACTED"}).json()
    assert contacted["total"] == 1 and contacted["items"][0]["status"] == "CONTACTED"


def test_list_search_matches_reference_and_name(h):
    _seed(h, ref="TPE-FINDME-1", customer_name="Zephyr Singh")
    _seed(h, customer_name="Someone Else")
    admin = h.user(UserRole.ADMIN)
    by_ref = h.client.get(ADM, headers=admin["headers"], params={"search": "FINDME"}).json()
    assert by_ref["total"] == 1
    by_name = h.client.get(ADM, headers=admin["headers"], params={"search": "zephyr"}).json()
    assert by_name["total"] == 1


# ------------------------------------------------------------- detail
def test_detail_and_404(h):
    rid = _seed(h)
    admin = h.user(UserRole.ADMIN)
    ok = h.client.get(f"{ADM}/{rid}", headers=admin["headers"])
    assert ok.status_code == 200
    body = ok.json()
    assert body["message"] == "Please share December dates." and body["admin_notes"] is None
    assert h.client.get(f"{ADM}/999999", headers=admin["headers"]).status_code == 404


# ------------------------------------------------------------- patch + audit
def test_patch_status_and_notes(h):
    rid = _seed(h)
    admin = h.user(UserRole.ADMIN)
    r = h.client.patch(f"{ADM}/{rid}", headers=admin["headers"],
                       json={"status": "CONTACTED", "admin_notes": "Called, sending a quote."})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "CONTACTED" and body["admin_notes"] == "Called, sending a quote."


def test_assigning_a_new_enquiry_auto_moves_to_assigned(h):
    rid = _seed(h, status="NEW")
    admin = h.user(UserRole.ADMIN)
    r = h.client.patch(f"{ADM}/{rid}", headers=admin["headers"],
                       json={"assigned_admin_id": admin["id"]})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ASSIGNED" and body["assigned_admin_id"] == admin["id"]
    assert body["assigned_admin_name"]


def test_patch_rejects_unknown_status(h):
    rid = _seed(h)
    admin = h.user(UserRole.ADMIN)
    r = h.client.patch(f"{ADM}/{rid}", headers=admin["headers"], json={"status": "TELEPORTED"})
    assert r.status_code == 422


def test_history_records_the_status_transition(h):
    rid = _seed(h, status="NEW")
    admin = h.user(UserRole.ADMIN, name="Desk Ops")
    h.client.patch(f"{ADM}/{rid}", headers=admin["headers"], json={"status": "CONTACTED"})
    hist = h.client.get(f"{ADM}/{rid}/history", headers=admin["headers"])
    assert hist.status_code == 200
    entries = hist.json()
    assert len(entries) >= 1
    latest = entries[0]
    assert latest["from_status"] == "NEW" and latest["to_status"] == "CONTACTED"
    assert latest["actor_name"] == "Desk Ops"


# ------------------------------------------------------------- submission preserved
def test_public_submission_still_works(h, monkeypatch):
    # The desk email is a courtesy on top of the stored row; keep it off the wire.
    from app.services import email_service
    monkeypatch.setattr(email_service, "send_tour_package_enquiry_email", lambda *a, **k: True)

    r = h.client.post(PUB, json={
        "name": "New Customer", "email": "new@example.com", "mobile": "9000000099",
        "package_name": "Kerala Backwaters", "message": "What are the March dates?",
    })
    assert r.status_code == 201
    ref = r.json()["enquiry_reference"]
    assert ref.startswith("TPE-")

    db = h.db()
    stored = db.scalar(select(TourPackageEnquiry).where(TourPackageEnquiry.enquiry_reference == ref))
    assert stored is not None and stored.status == "NEW" and stored.customer_name == "New Customer"
    db.close()
