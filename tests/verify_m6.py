"""M6 — analytics, reports and dashboard figures.

WHAT THIS PROTECTS

M6's stated requirement is that **every tile's number is reproducible by a
direct SQL query**, and that **an export matches the on-screen filtered set**.
Those are not properties you can eyeball; they are properties you re-derive.

So this script does not assert that a field is present and non-empty. For each
figure it runs its **own** SQL against the live database — written independently
of the service, not by importing it — and demands the API's answer equal it
exactly. Where the API offers two routes to one number (an aggregate endpoint
and a row-builder endpoint), it demands those two agree as well: two
computations arriving at the same figure is worth more than either matching a
third copy of the same code.

1. Booking analytics equal a hand-written aggregate, and `by_status` / `by_month`
   each partition the totals — every booking in exactly one bucket, columns
   summing back to the headline.
2. `date_field` is honoured: the range filter and the monthly series run on the
   column that was asked for, and the response says which. A prior phase shipped
   a filter on `travel_date` that every reader took for `created_at`.
3. `/api/reports/summary` counts exactly what `/api/reports/export` contains —
   asserted by parsing the CSV and counting its rows, not by trusting the number.
4. Money crosses the wire as decimal **strings**, and the paise survive.
5. Operations metrics are staff-only, and the queue figures match SQL.
6. Change-request money reconciles: settled + outstanding == due.
7. Scope: a merchant's analytics describe only that merchant, proven against a
   rival company's real rows rather than a bogus id.
8. RBAC: the operations endpoint refuses a merchant and refuses the Manager;
   nothing here is reachable unauthenticated.
"""
import csv
import datetime
import io
import sys
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MANAGER, MERCHANT, SUPER, Checker, H, login  # noqa: E402

check = Checker()
atok = login(*ADMIN)
mtok = login(*MERCHANT)
stok = login(*SUPER)
gtok = login(*MANAGER)

MID = requests.get(f"{BASE}/api/auth/me", headers=H(mtok)).json()["merchant_id"]


def sql(query, **params):
    """One row, straight from the database. Deliberately hand-written SQL rather
    than a call into the service — a test that reuses the implementation proves
    only that the implementation is self-consistent."""
    db = SessionLocal()
    try:
        return db.execute(text(query), params).one()
    finally:
        db.close()


def sql_all(query, **params):
    db = SessionLocal()
    try:
        return db.execute(text(query), params).all()
    finally:
        db.close()


def get(path, token=atok, **params):
    """``minihttp`` takes no ``params``, so the query string is built here.
    Appended with ``&`` when the path already carries one, so the
    unauthenticated sweep below can pass a fully-formed path."""
    if params:
        joiner = "&" if "?" in path else "?"
        path = f"{path}{joiner}{urlencode(params)}"
    return requests.get(f"{BASE}{path}", headers=H(token))


def D(value):
    return Decimal(str(value))


print("\n=== 1. Booking analytics against hand-written SQL ===")

a = get("/api/analytics/bookings").json()
row = sql("""
    SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS v
    FROM service_requests WHERE request_type = 'booking'
""")
check("platform booking count equals SQL", a["totals"]["bookings"] == row.n,
      f"api={a['totals']['bookings']} sql={row.n}")
check("platform booking value equals SQL",
      D(a["totals"]["value"]) == D(row.v).quantize(Decimal("0.01")),
      f"api={a['totals']['value']} sql={row.v}")

check("value is a decimal string, not a number", isinstance(a["totals"]["value"], str))
check("...and it carries paise", "." in a["totals"]["value"])
check("average is a decimal string too", isinstance(a["totals"]["average_value"], str))

# The partition property: every booking lands in exactly one bucket of each
# breakdown, so a column adds back up to the headline. This is what makes the
# chart above it and the tile beside it describe one population.
status_n = sum(s["count"] for s in a["by_status"])
status_v = sum((D(s["value"]) for s in a["by_status"]), Decimal("0"))
check("by_status counts sum to the total", status_n == a["totals"]["bookings"],
      f"{status_n} != {a['totals']['bookings']}")
check("by_status values sum to the total value", status_v == D(a["totals"]["value"]),
      f"{status_v} != {a['totals']['value']}")

month_n = sum(m["count"] for m in a["by_month"])
month_v = sum((D(m["value"]) for m in a["by_month"]), Decimal("0"))
check("by_month counts sum to the total", month_n == a["totals"]["bookings"],
      f"{month_n} != {a['totals']['bookings']}")
check("by_month values sum to the total value", month_v == D(a["totals"]["value"]),
      f"{month_v} != {a['totals']['value']}")

sql_status = {s: (n, D(v)) for s, n, v in sql_all("""
    SELECT status::text, COUNT(*), COALESCE(SUM(total_amount), 0)
    FROM service_requests WHERE request_type = 'booking' GROUP BY status
""")}
mismatched = [
    s["status"] for s in a["by_status"]
    if sql_status.get(s["status"], (None, None))[0] != s["count"]
    or sql_status.get(s["status"], (None, Decimal("0")))[1].quantize(Decimal("0.01")) != D(s["value"])
]
check("every by_status bucket matches SQL, count and value", not mismatched, str(mismatched))

check("top_routes is capped at 10", len(a["top_routes"]) <= 10)
check("top_routes is ordered by volume, descending",
      all(a["top_routes"][i]["count"] >= a["top_routes"][i + 1]["count"]
          for i in range(len(a["top_routes"]) - 1)))


print("\n=== 2. date_field is honoured, and named ===")

check("default date_field is travel_date", a["date_field"] == "travel_date")

by_created = get("/api/analytics/bookings", date_field="created_at").json()
check("date_field=created_at is echoed back", by_created["date_field"] == "created_at")
check("both groupings see the same population (no filter was applied)",
      by_created["totals"]["bookings"] == a["totals"]["bookings"])
check("...but the monthly series genuinely differs by column",
      [m["month"] for m in by_created["by_month"]] != [m["month"] for m in a["by_month"]],
      "grouping on created_at produced the same months as travel_date")

# A range filter must bite on the named column and nothing else.
window_from = datetime.date.today() - datetime.timedelta(days=30)
ranged = get("/api/analytics/bookings", date_field="created_at",
             date_from=window_from.isoformat()).json()
sql_ranged = sql("""
    SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS v
    FROM service_requests
    WHERE request_type = 'booking' AND created_at >= :d
""", d=window_from)
check("a created_at range filters on created_at", ranged["totals"]["bookings"] == sql_ranged.n,
      f"api={ranged['totals']['bookings']} sql={sql_ranged.n}")
check("...and its value matches too",
      D(ranged["totals"]["value"]) == D(sql_ranged.v).quantize(Decimal("0.01")))
check("the filtered series still partitions its own total",
      sum(m["count"] for m in ranged["by_month"]) == ranged["totals"]["bookings"])

travel_ranged = get("/api/analytics/bookings", date_field="travel_date",
                    date_from=window_from.isoformat()).json()
sql_travel = sql("""
    SELECT COUNT(*) AS n FROM service_requests
    WHERE request_type = 'booking' AND travel_date >= :d
""", d=window_from)
check("a travel_date range filters on travel_date",
      travel_ranged["totals"]["bookings"] == sql_travel.n,
      f"api={travel_ranged['totals']['bookings']} sql={sql_travel.n}")

# The two columns must be shown to be genuinely different, and a *lower bound*
# cannot do it here: every booking in this database was raised recently AND
# travels in the future, so "since 30 days ago" matches everything on either
# column. An upper bound of today separates them cleanly — a booking already
# raised has not yet flown.
today = datetime.date.today()
upto_created = get("/api/analytics/bookings", date_field="created_at",
                   date_to=today.isoformat()).json()["totals"]["bookings"]
upto_travel = get("/api/analytics/bookings", date_field="travel_date",
                  date_to=today.isoformat()).json()["totals"]["bookings"]
# Aliased `by_created` / `by_travel`, not `c` / `t`: SQLAlchemy's Row exposes
# `.t` as a synonym for `.tuple()`, so a column called `t` is shadowed by the
# ORM and reads back as the whole row.
sql_upto = sql("""
    SELECT COUNT(*) FILTER (WHERE created_at < :tomorrow) AS by_created,
           COUNT(*) FILTER (WHERE travel_date <= :today)  AS by_travel
    FROM service_requests WHERE request_type = 'booking'
""", tomorrow=today + datetime.timedelta(days=1), today=today)
check("'up to today' on created_at equals SQL", upto_created == sql_upto.by_created,
      f"api={upto_created} sql={sql_upto.by_created}")
check("'up to today' on travel_date equals SQL", upto_travel == sql_upto.by_travel,
      f"api={upto_travel} sql={sql_upto.by_travel}")
check("the two columns are not interchangeable", upto_created != upto_travel,
      f"created_at={upto_created} travel_date={upto_travel} — indistinguishable in this data")

check("an unknown date_field is refused",
      get("/api/analytics/bookings", date_field="updated_at").status_code == 422)


print("\n=== 3. The report summary counts exactly what the export contains ===")

for report_type in ("bookings", "service_requests", "payments"):
    summary = get("/api/reports/summary", type=report_type).json()
    export = get("/api/reports/export", type=report_type, format="csv")
    check(f"{report_type}: export downloads", export.status_code == 200, export.text[:200])

    body = export.content.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(body)))
    check(f"{report_type}: summary row count == rows in the CSV",
          summary["rows"] == len(rows), f"summary={summary['rows']} csv={len(rows)}")

    if summary["total_value"] is not None:
        amount_col = "Amount"
        csv_total = sum((Decimal(r[amount_col] or "0") for r in rows), Decimal("0"))
        check(f"{report_type}: summary value == the CSV's own Amount column",
              D(summary["total_value"]) == csv_total.quantize(Decimal("0.01")),
              f"summary={summary['total_value']} csv={csv_total}")
        check(f"{report_type}: total_value is a decimal string",
              isinstance(summary["total_value"], str))
    else:
        check(f"{report_type}: carries no money column, and reports none rather than 0",
              report_type == "service_requests")

    check(f"{report_type}: names the column its dates filter on",
          summary["date_field"] in ("travel_date", "created_at"))
    check(f"{report_type}: reports the cap it would truncate at", summary["row_cap"] > 0)
    check(f"{report_type}: truncated agrees with the row count",
          summary["truncated"] == (summary["rows"] >= summary["row_cap"]))

# The filters must reach both sides identically — this is the classic reporting
# bug: a screen filtered one way and a file filtered another. `summary` above is
# the loop variable and holds the LAST report type, so the unfiltered booking
# figure is fetched again by name rather than reused by accident.
unfiltered_bookings = get("/api/reports/summary", type="bookings").json()["rows"]
cutoff = datetime.date.today() - datetime.timedelta(days=1)
filtered_summary = get("/api/reports/summary", type="bookings",
                       date_to=cutoff.isoformat()).json()
filtered_csv = list(csv.DictReader(io.StringIO(
    get("/api/reports/export", type="bookings", format="csv",
        date_to=cutoff.isoformat()).content.decode("utf-8-sig"))))
check("a filtered summary still equals its filtered export",
      filtered_summary["rows"] == len(filtered_csv),
      f"summary={filtered_summary['rows']} csv={len(filtered_csv)}")
check("...and the filter actually removed rows, so the check means something",
      filtered_summary["rows"] < unfiltered_bookings,
      f"filtered={filtered_summary['rows']} unfiltered={unfiltered_bookings}")

status_summary = get("/api/reports/summary", type="bookings", status="cancelled").json()
sql_cancelled = sql("""
    SELECT COUNT(*) AS n FROM service_requests
    WHERE request_type = 'booking' AND status = 'cancelled'
""")
check("a status filter on the summary matches SQL",
      status_summary["rows"] == sql_cancelled.n,
      f"api={status_summary['rows']} sql={sql_cancelled.n}")

check("an unknown report type is refused",
      get("/api/reports/summary", type="widgets").status_code == 422)
check("an unknown export format is refused",
      get("/api/reports/export", type="bookings", format="docx").status_code == 422)

for fmt in ("csv", "xlsx", "pdf"):
    r = get("/api/reports/export", type="bookings", format=fmt)
    check(f"export as {fmt} returns a file", r.status_code == 200 and len(r.content) > 100)
    check(f"export as {fmt} is served as an attachment",
          "attachment" in r.headers.get("content-disposition", "").lower())


print("\n=== 4. The payments report's closing day is not silently dropped ===")

# A timestamp column compared against a bare date lands on midnight, so
# `created_at <= date_to` excludes everything that happened during the closing
# day. Found in M6 when the totals endpoint disagreed with the rows.
last_payment_day = sql("SELECT MAX(created_at)::date AS d FROM payments").d
if last_payment_day is None:
    check("no payments in the database — closing-day check skipped", True)
else:
    same_day = get("/api/reports/summary", type="payments",
                   date_from=last_payment_day.isoformat(),
                   date_to=last_payment_day.isoformat()).json()
    sql_same_day = sql("""
        SELECT COUNT(*) AS n FROM payments WHERE created_at::date = :d
    """, d=last_payment_day)
    check("a single-day payments range includes that whole day",
          same_day["rows"] == sql_same_day.n,
          f"api={same_day['rows']} sql={sql_same_day.n} on {last_payment_day}")
    check("...and it is not zero, so the check means something", sql_same_day.n > 0)


print("\n=== 5. Operations metrics ===")

ops = get("/api/analytics/operations").json()
sql_queue = {s: n for s, n in sql_all("""
    SELECT status::text, COUNT(*) FROM service_requests
    WHERE request_type = 'booking'
      AND status IN ('approved', 'payment_pending', 'paid', 'ticket_issued')
    GROUP BY status
""")}
for stage in ("approved", "payment_pending", "paid", "ticket_issued"):
    check(f"queue.{stage} equals SQL", ops["queue"][stage] == sql_queue.get(stage, 0),
          f"api={ops['queue'][stage]} sql={sql_queue.get(stage, 0)}")
check("queue.total is the sum of its stages",
      ops["queue"]["total"] == sum(sql_queue.values()))

sql_unassigned = sql("""
    SELECT COUNT(*) AS n FROM service_requests
    WHERE request_type = 'booking'
      AND status IN ('approved', 'payment_pending', 'paid', 'ticket_issued')
      AND assigned_admin IS NULL
""")
check("queue.unassigned equals SQL", ops["queue"]["unassigned"] == sql_unassigned.n,
      f"api={ops['queue']['unassigned']} sql={sql_unassigned.n}")

check("ageing excludes ticket_issued — it is not waiting for anything",
      "ticket_issued" not in ops["waiting"]["stages"])
sql_waiting = sql("""
    SELECT COUNT(*) AS n FROM service_requests
    WHERE request_type = 'booking' AND status IN ('approved', 'payment_pending', 'paid')
""")
check("waiting.count equals SQL over those three stages",
      ops["waiting"]["count"] == sql_waiting.n,
      f"api={ops['waiting']['count']} sql={sql_waiting.n}")
check("age buckets partition the waiting set",
      sum(ops["waiting"]["buckets"].values()) == ops["waiting"]["count"],
      f"{ops['waiting']['buckets']} vs {ops['waiting']['count']}")
check("the SLA breach count is the over-threshold bucket, not a second figure",
      ops["sla"]["breached"] == ops["waiting"]["buckets"]["over_72h"])
check("the SLA threshold is stated, not implied", ops["sla"]["threshold_hours"] > 0)
check("median wait is not greater than the oldest wait",
      ops["waiting"]["median_hours"] <= ops["waiting"]["oldest_hours"] + 0.01)

sql_load = {u: n for u, n in sql_all("""
    SELECT assigned_admin, COUNT(*) FROM service_requests
    WHERE request_type = 'booking' AND status IN ('approved', 'payment_pending', 'paid')
      AND assigned_admin IS NOT NULL
    GROUP BY assigned_admin
""")}
bad_load = [o["full_name"] for o in ops["operators"]
            if o["active_load"] != sql_load.get(o["user_id"], 0)]
check("every operator's active load equals SQL", not bad_load, str(bad_load))
check("operators are listed heaviest-loaded first",
      all(ops["operators"][i]["active_load"] >= ops["operators"][i + 1]["active_load"]
          for i in range(len(ops["operators"]) - 1)))

tti = ops["time_to_issue"]
check("time to issue states its window", tti["window_days"] > 0)
check("time to issue states its sample size", isinstance(tti["sample"], int))
check("median time to issue is not above the 90th percentile",
      tti["median_hours"] <= tti["p90_hours"] + 0.01,
      f"median={tti['median_hours']} p90={tti['p90_hours']}")


print("\n=== 6. Change-request money reconciles ===")

cr = get("/api/analytics/change-requests").json()
check("by_type totals sum to the headline",
      sum(t["total"] for t in cr["by_type"]) == cr["totals"]["requests"])
check("approved/rejected/pending never exceed the type's own total",
      all(t["approved"] + t["rejected"] + t["pending"] <= t["total"] for t in cr["by_type"]))

money = cr["money"]
check("settled + outstanding == due — the whole point of the outstanding figure",
      D(money["refunds_settled"]) + D(money["refunds_outstanding"]) == D(money["refunds_due"]),
      f"{money['refunds_settled']} + {money['refunds_outstanding']} != {money['refunds_due']}")
check("the recorded shortfall is a subset of what is outstanding, not a second debt",
      D(money["refunds_short_settled"]) <= D(money["refunds_outstanding"]),
      f"short={money['refunds_short_settled']} outstanding={money['refunds_outstanding']}")
check("every money figure is a decimal string",
      all(isinstance(money[k], str) for k in
          ("cancellation_charges", "refunds_due", "refunds_settled",
           "refunds_outstanding", "refunds_short_settled", "fare_differences")))
check("the basis of the money block is stated on the response",
      "approved" in money["basis"])

sql_charges = sql("""
    SELECT COALESCE(SUM(NULLIF(pricing->>'cancellation_charge', '')::numeric), 0) AS v
    FROM service_requests
    WHERE request_type IN ('cancellation','date_change','refund','passenger_modification',
                           'extra_baggage','meal','seat')
      AND status IN ('approved','completed','cancelled')
""")
check("cancellation charges equal SQL over approved requests",
      D(money["cancellation_charges"]) == D(sql_charges.v).quantize(Decimal("0.01")),
      f"api={money['cancellation_charges']} sql={sql_charges.v}")

sql_rejected_charges = sql("""
    SELECT COALESCE(SUM(NULLIF(pricing->>'cancellation_charge', '')::numeric), 0) AS v
    FROM service_requests
    WHERE request_type IN ('cancellation','date_change') AND status = 'rejected'
""")
check("a rejected request's charge is excluded — money that never moved",
      D(money["cancellation_charges"]) < D(sql_charges.v) + D(sql_rejected_charges.v)
      or D(sql_rejected_charges.v) == 0)


print("\n=== 7. Scope: a merchant sees only its own ===")

mine = get("/api/analytics/bookings", token=mtok).json()
check("a merchant's analytics are labelled merchant-scoped", mine["scope"] == "merchant")
check("a platform read is labelled platform-scoped", a["scope"] == "platform")

sql_mine = sql("""
    SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS v
    FROM service_requests WHERE request_type = 'booking' AND merchant_id = :m
""", m=MID)
check("the merchant's count equals SQL for that merchant alone",
      mine["totals"]["bookings"] == sql_mine.n,
      f"api={mine['totals']['bookings']} sql={sql_mine.n}")
check("the merchant's value equals SQL for that merchant alone",
      D(mine["totals"]["value"]) == D(sql_mine.v).quantize(Decimal("0.01")))

rival = flows.rival_merchant(atok)
rival_view = get("/api/analytics/bookings", token=rival["token"]).json()
sql_rival = sql("""
    SELECT COUNT(*) AS n FROM service_requests
    WHERE request_type = 'booking' AND merchant_id = :m
""", m=rival["merchant_id"])
check("a rival merchant sees its own count, not ours",
      rival_view["totals"]["bookings"] == sql_rival.n,
      f"api={rival_view['totals']['bookings']} sql={sql_rival.n}")
check("...and that is genuinely a different number from ours",
      rival_view["totals"]["bookings"] != mine["totals"]["bookings"]
      or sql_rival.n == sql_mine.n)

# merchant_id is a staff-only narrowing. A merchant passing someone else's id
# must not widen or redirect its own scope.
spoofed = get("/api/analytics/bookings", token=mtok,
              merchant_id=rival["merchant_id"]).json()
check("a merchant cannot point merchant_id at another company",
      spoofed["totals"]["bookings"] == mine["totals"]["bookings"],
      f"spoofed={spoofed['totals']['bookings']} own={mine['totals']['bookings']}")
check("...and the response reports its real scope",
      spoofed["merchant_id"] == MID)

staff_narrowed = get("/api/analytics/bookings", merchant_id=MID).json()
check("staff CAN narrow by merchant_id, and get the merchant's own figure",
      staff_narrowed["totals"]["bookings"] == mine["totals"]["bookings"],
      f"staff={staff_narrowed['totals']['bookings']} merchant={mine['totals']['bookings']}")
check("staff and merchant read an identical value for the same company",
      staff_narrowed["totals"]["value"] == mine["totals"]["value"])

mine_cr = get("/api/analytics/change-requests", token=mtok).json()
check("change-request analytics are merchant-scoped too", mine_cr["scope"] == "merchant")
check("...and describe fewer requests than the platform's",
      mine_cr["totals"]["requests"] <= cr["totals"]["requests"])

mine_summary = get("/api/reports/summary", token=mtok, type="bookings").json()
# `rows` IS THE CAPPED COUNT, ON PURPOSE — it is what the EXPORT would contain,
# not what SQL holds. The row builders run at `page_size=row_cap` so the header
# on the screen and the file the user downloads can never describe different
# sets, which routers/reports.py calls out as the bug this endpoint exists to
# avoid. Asserting `rows == sql_mine.n` was therefore only ever true while this
# merchant had fewer than row_cap bookings; test data crossed 5,000 and the
# check began failing on correct behaviour. Compare against the capped figure,
# and assert the flag that reports the cap rather than ignoring it.
cap = mine_summary["row_cap"]
expected_rows = min(sql_mine.n, cap)
check("the merchant's report summary is scoped as well",
      mine_summary["rows"] == expected_rows,
      f"api={mine_summary['rows']} expected={expected_rows} sql={sql_mine.n} cap={cap}")
# The API computes this as `len(rows) >= cap`, which cannot tell "exactly cap"
# from "cap and more" without a second query — so at exactly the cap it warns
# rather than staying silent. That is the safe direction, and this mirrors it.
check("...and the summary says so when the cap bit",
      mine_summary["truncated"] == (sql_mine.n >= cap),
      f"truncated={mine_summary['truncated']} sql={sql_mine.n} cap={cap}")


print("\n=== 8. RBAC and authentication ===")

check("operations metrics refuse a merchant",
      get("/api/analytics/operations", token=mtok).status_code == 403)
check("operations metrics refuse the Manager, who holds no ticket codes",
      get("/api/analytics/operations", token=gtok).status_code == 403)
check("operations metrics refuse the Super Admin, whose domain this is not",
      get("/api/analytics/operations", token=stok).status_code == 403)
check("an admin may read operations metrics", get("/api/analytics/operations").status_code == 200)

check("the Super Admin may read booking analytics (it holds report.view)",
      get("/api/analytics/bookings", token=stok).status_code == 200)
check("the Manager may not — it holds no report code",
      get("/api/analytics/bookings", token=gtok).status_code == 403)

for path in ("/api/analytics/bookings", "/api/analytics/change-requests",
             "/api/analytics/operations", "/api/reports/summary?type=bookings"):
    r = requests.get(f"{BASE}{path}")
    check(f"{path} requires authentication", r.status_code in (401, 403), str(r.status_code))


print("\n=== 9. The Super Admin's global rollup carries its own totals ===")

g = get("/api/super-admin/reports/summary", token=stok).json()
check("the rollup returns a totals block", "totals" in g)
rows = g["merchants"]
check("totals.merchants counts the rows", g["totals"]["merchants"] == len(rows))
check("totals.total_requests equals the rows' own sum",
      g["totals"]["total_requests"] == sum(m["total_requests"] for m in rows))
revenue = sum((D(m["total_revenue"]) for m in rows), Decimal("0"))
check("totals.total_revenue equals the rows' own sum, to the paisa",
      D(g["totals"]["total_revenue"]) == revenue,
      f"totals={g['totals']['total_revenue']} rows={revenue}")
check("revenue crosses the wire as a decimal string",
      isinstance(g["totals"]["total_revenue"], str))
sql_revenue = sql("""
    SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE payment_status = 'success'
""")
check("...and equals SQL over successful payments",
      D(g["totals"]["total_revenue"]) == D(sql_revenue.v),
      f"api={g['totals']['total_revenue']} sql={sql_revenue.v}")


print("\n=== 10. Pagination and caps hold ===")

check("the export row cap is reported, so a screen can say the file is capped",
      get("/api/reports/summary", type="bookings").json()["row_cap"] >= 1000)
big = get("/api/admin/bookings/queue", page_size=500)
check("a list endpoint still refuses an oversized page_size", big.status_code == 422)

sys.exit(check.report())
