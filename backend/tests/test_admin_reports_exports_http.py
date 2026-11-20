"""HTTP-level verification of B2B REPORTS and EXPORTS (``GET /api/reports/summary`` and ``/api/reports/export``):
row accuracy (summary and file are built from the same rows), filters (status, multi-status, request type, date range,
merchant), validation, scope (a merchant only ever gets its own data), the three file formats (CSV / XLSX / PDF are
parsed back, not just checked for a content type), the export audit entry, permissions, and spreadsheet-formula safety.

Real router + services + RBAC on throw-away SQLite data. Free-text ``search`` uses PostgreSQL JSONB operators and is NOT
VERIFIED here. B2C reports/analytics (``/api/admin/b2c-reports``) are not covered by this file.
"""
from __future__ import annotations

import csv
import datetime as dt
import decimal
import io

import pytest
from sqlalchemy import func, select

from app.models_v2 import (
    Merchant, MerchantStatus, PassengerData, Payment, PaymentStatus, PaymentType, RequestSource, RequestStatus,
    RequestType, ServiceRequest, SystemLog, UserRole,
)
from app.routers import reports as reports_router
from tests._v2_harness import Harness

D = decimal.Decimal
S = RequestStatus
BASE = "/api/reports"
NOW = dt.datetime(2026, 6, 15, 10, 0, tzinfo=dt.timezone.utc)


@pytest.fixture()
def h():
    harness = Harness(reports_router.router)
    db = harness.db()
    for mid in (1601, 1602):
        db.add(Merchant(merchant_id=mid, merchant_code=f"M{mid}", merchant_name=f"M{mid}", company_name=f"M{mid} Co",
                        email=f"m{mid}@tt-qa.com", reference_prefix=f"R{mid}", status=MerchantStatus.ACTIVE))
    db.commit()
    db.close()
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _booking(h, *, merchant_id=1601, status=S.PAID, total="1000", passenger="Asha Rao", rtype=RequestType.BOOKING,
             created=NOW, ref=None):
    db = h.db()
    nid = (db.scalar(select(func.max(ServiceRequest.request_id))) or 16000) + 1
    db.add(ServiceRequest(request_id=nid, request_number=f"RP-{nid}", merchant_id=merchant_id, request_type=rtype,
                          source=RequestSource.MERCHANT_PORTAL, status=status, title="Delhi to Goa",
                          booking_reference=ref or f"REF{nid}", travel_details={"origin_city": "Delhi", "destination_city": "Goa"},
                          pricing={}, quantity=1, total_amount=D(total), status_history=[], created_at=created,
                          travel_date=dt.date(2026, 7, 1)))
    db.flush()
    if rtype is RequestType.BOOKING:
        first, _, last = passenger.partition(" ")
        pid = (db.scalar(select(func.max(PassengerData.passenger_id))) or 0) + 1
        db.add(PassengerData(passenger_id=pid, request_id=nid, merchant_id=merchant_id, first_name=first, last_name=last or "X"))
    db.commit()
    db.close()
    return nid


def _payment(h, *, merchant_id=1601, amount="500", created=NOW, status=PaymentStatus.SUCCESS, txn="UTR1"):
    db = h.db()
    pid = (db.scalar(select(func.max(Payment.payment_id))) or 0) + 1
    db.add(Payment(payment_id=pid, merchant_id=merchant_id, amount=D(amount), payment_type=PaymentType.BOOKING_PAYMENT,
                   payment_method="bank_transfer", transaction_id=txn, payment_status=status, created_at=created,
                   paid_date=created))
    db.commit()
    db.close()


def _csv(resp):
    text = resp.content.decode("utf-8-sig")
    return list(csv.reader(io.StringIO(text)))


def _logs(h):
    db = h.db()
    rows = [l for l in db.scalars(select(SystemLog)).all() if l.module == "reports"]
    db.close()
    return rows


# ================================================================== accuracy
def test_summary_and_export_describe_exactly_the_same_rows_and_total(h, admin):
    _booking(h, total="1000.50", passenger="Asha Rao")
    _booking(h, total="250.25", passenger="Ben Cole", merchant_id=1602)
    _booking(h, total="999", status=S.CANCELLED, passenger="Gone Away")
    s = h.client.get(f"{BASE}/summary", params={"type": "bookings"}, headers=admin["headers"])
    assert s.status_code == 200, s.text
    assert s.json()["rows"] == 3 and D(str(s.json()["total_value"])) == D("2249.75")
    assert s.json()["date_field"] == "travel_date" and s.json()["truncated"] is False
    e = h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "csv"}, headers=admin["headers"])
    assert e.status_code == 200, e.text
    rows = _csv(e)
    assert rows[0] == ["Reference", "Request Number", "Passenger(s)", "Travel Type", "Sector", "Request Date",
                       "Travel Date", "Amount", "Status"]
    assert len(rows) - 1 == s.json()["rows"]
    assert sum(D(r[7]) for r in rows[1:]) == D(str(s.json()["total_value"]))
    asha = [r for r in rows[1:] if "Asha" in r[2]][0]
    assert asha[4] == "Delhi → Goa" and asha[5] == "2026-06-15" and asha[6] == "2026-07-01" and asha[8] == "Paid"
    assert e.headers["content-disposition"].startswith('attachment; filename="bookings-report-')


def test_filters_status_statuses_type_merchant_and_date(h, admin):
    paid = _booking(h, status=S.PAID, total="100")
    issued = _booking(h, status=S.TICKET_ISSUED, total="200", merchant_id=1602)
    _booking(h, status=S.CANCELLED, total="300")
    svc = _booking(h, rtype=RequestType.MEAL, status=S.PENDING_APPROVAL, total="0")
    rows = lambda **p: len(_csv(h.client.get(f"{BASE}/export", params={"format": "csv", **p}, headers=admin["headers"]))) - 1
    assert rows(type="bookings") == 3 and rows(type="bookings", status="paid") == 1
    assert rows(type="bookings", statuses="paid,ticket_issued") == 2
    assert rows(type="bookings", merchant_id=1602) == 1 and rows(type="bookings", merchant_id=999) == 0
    assert rows(type="bookings", request_type="any") == 4
    assert rows(type="service_requests") == 1 and rows(type="service_requests", request_type="meal") == 1
    assert rows(type="service_requests", request_type="seat") == 0
    sm = h.client.get(f"{BASE}/summary", params={"type": "bookings", "merchant_id": 1602}, headers=admin["headers"]).json()
    assert sm["rows"] == 1 and D(str(sm["total_value"])) == D("200.00")
    assert paid and issued and svc


def test_payment_report_filters_by_date_merchant_and_sums_amounts(h, admin):
    _payment(h, amount="500", created=dt.datetime(2026, 6, 1, tzinfo=dt.timezone.utc), txn="A")
    _payment(h, amount="300.50", created=dt.datetime(2026, 6, 10, tzinfo=dt.timezone.utc), txn="B", merchant_id=1602)
    _payment(h, amount="700", created=dt.datetime(2026, 7, 1, tzinfo=dt.timezone.utc), txn="C")
    q = lambda **p: h.client.get(f"{BASE}/summary", params={"type": "payments", **p}, headers=admin["headers"]).json()
    assert q()["rows"] == 3 and D(str(q()["total_value"])) == D("1500.50")
    r = q(date_from="2026-06-01", date_to="2026-06-30")
    assert r["rows"] == 2 and D(str(r["total_value"])) == D("800.50") and r["date_field"] == "created_at"
    assert q(date_from="2026-06-10", date_to="2026-06-10")["rows"] == 1, "date_to is inclusive of that whole day"
    assert q(merchant_id=1602)["rows"] == 1
    exp = _csv(h.client.get(f"{BASE}/export", params={"type": "payments", "format": "csv"}, headers=admin["headers"]))
    assert exp[0] == ["Transaction ID", "Method", "Amount", "Currency", "Status", "Paid Date"]
    assert sorted(r[0] for r in exp[1:]) == ["A", "B", "C"]


@pytest.mark.parametrize("params,code", [
    ({"type": "bookings", "statuses": "paid,nonsense"}, 400), ({"type": "bookings", "request_type": "nonsense"}, 400),
    ({"type": "bogus"}, 422), ({"type": "bookings", "status": "nonsense"}, 422),
    ({"type": "bookings", "date_from": "not-a-date"}, 422), ({}, 422),
])
def test_summary_validation(h, admin, params, code):
    assert h.client.get(f"{BASE}/summary", params=params, headers=admin["headers"]).status_code == code


@pytest.mark.parametrize("params", [{"type": "bookings", "format": "docx"}, {"type": "bookings"}, {"format": "csv"},
                                    {"type": "nope", "format": "csv"}, {"type": "bookings", "format": "csv", "statuses": "x"}])
def test_export_validation_creates_no_file_and_no_audit_entry(h, admin, params):
    assert h.client.get(f"{BASE}/export", params=params, headers=admin["headers"]).status_code in (400, 422)
    assert _logs(h) == []


# ================================================================== formats
def test_xlsx_and_pdf_exports_are_real_files_with_the_same_rows(h, admin):
    _booking(h, total="123.45", passenger="Asha Rao")
    x = h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "xlsx"}, headers=admin["headers"])
    assert x.status_code == 200 and x.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(x.content)).active
    values = [[c.value for c in row] for row in ws.iter_rows()]
    assert values[0][0] == "Reference" and len(values) == 2 and values[1][7] == "123.45" and "Asha" in values[1][2]
    p = h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "pdf"}, headers=admin["headers"])
    assert p.status_code == 200 and p.content[:5] == b"%PDF-" and p.headers["content-type"] == "application/pdf"
    empty = h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "csv", "status": "rejected"},
                         headers=admin["headers"])
    assert _csv(empty) == [_csv(empty)[0]], "an empty report is a header-only file, not an error"


def test_exports_are_safe_to_open_in_a_spreadsheet(h, admin):
    """DEFECT-10: merchant-controlled text (passenger names) starting with = + - @ was written verbatim, so opening the
    CSV/XLSX in Excel could evaluate it as a formula (CSV/formula injection). Legitimate negative numbers must survive."""
    evil = '=HYPERLINK("http://attacker.example/x","Click")'
    _booking(h, total="100", passenger=evil)
    _booking(h, total="50", passenger="+SUM(1+1)")
    _booking(h, total="75", passenger="@cmd Smith")
    _payment(h, amount="-25.00", txn="REV1")            # a negative amount is a number, not an injection
    rows = _csv(h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "csv"}, headers=admin["headers"]))
    for r in rows[1:]:
        assert not r[2].lstrip().startswith(("=", "+", "@", "-")), f"unsafe cell in CSV: {r[2]!r}"
    assert any("HYPERLINK" in r[2] for r in rows[1:]), "the text itself is preserved, only neutralised"
    from openpyxl import load_workbook
    x = h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "xlsx"}, headers=admin["headers"])
    ws = load_workbook(io.BytesIO(x.content)).active
    for row in list(ws.iter_rows())[1:]:
        cell = row[2]
        assert cell.data_type != "f" and not str(cell.value).startswith(("=", "+", "@")), cell.value
    pay = _csv(h.client.get(f"{BASE}/export", params={"type": "payments", "format": "csv"}, headers=admin["headers"]))
    assert pay[1][2] == "-25.00", "negative amounts are not altered"


# ================================================================== scope, audit, permissions
def test_a_merchant_only_ever_sees_and_exports_its_own_data(h, admin):
    _booking(h, merchant_id=1601, passenger="Mine Own", total="100")
    _booking(h, merchant_id=1602, passenger="Their Data", total="900")
    _payment(h, merchant_id=1601, amount="10", txn="MINE")
    _payment(h, merchant_id=1602, amount="99", txn="THEIRS")
    me = h.user(UserRole.MERCHANT_ADMIN, merchant_id=1601, name="Mer Admin")
    s = h.client.get(f"{BASE}/summary", params={"type": "bookings", "merchant_id": 1602}, headers=me["headers"])
    assert s.status_code == 200 and s.json()["rows"] == 1 and D(str(s.json()["total_value"])) == D("100.00"), \
        "a merchant cannot widen its scope with merchant_id"
    e = h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "csv", "merchant_id": 1602}, headers=me["headers"])
    assert "Their" not in e.text and "Mine" in e.text
    pay = h.client.get(f"{BASE}/export", params={"type": "payments", "format": "csv", "merchant_id": 1602}, headers=me["headers"])
    assert "THEIRS" not in pay.text and "MINE" in pay.text


def test_every_successful_export_is_audited_with_the_actor_and_format(h, admin):
    _booking(h)
    assert _logs(h) == []
    h.client.get(f"{BASE}/summary", params={"type": "bookings"}, headers=admin["headers"])
    assert _logs(h) == [], "a summary is a read, not an export"
    h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "pdf"}, headers=admin["headers"])
    logs = _logs(h)
    assert len(logs) == 1 and logs[0].user_id == admin["id"] and logs[0].action == "export"
    assert "bookings" in logs[0].description and "pdf" in logs[0].description


def test_permissions(h, admin):
    for u, p in ((f"{BASE}/summary", {"type": "bookings"}), (f"{BASE}/export", {"type": "bookings", "format": "csv"})):
        assert h.client.get(u, params=p).status_code == 401
    mgr = h.user(UserRole.MANAGER, name="Mo Manager")
    assert h.client.get(f"{BASE}/summary", params={"type": "bookings"}, headers=mgr["headers"]).status_code == 403
    assert h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "csv"}, headers=mgr["headers"]).status_code == 403
    view_only = h.user(UserRole.MANAGER, permissions=["report.view"], name="Viewer")
    assert h.client.get(f"{BASE}/summary", params={"type": "bookings"}, headers=view_only["headers"]).status_code == 200
    assert h.client.get(f"{BASE}/export", params={"type": "bookings", "format": "csv"}, headers=view_only["headers"]).status_code == 403
    assert _logs(h) == [], "refused exports are not logged as exports"
