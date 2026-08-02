"""Provider Management (0039) — the suppliers the desk buys tickets FROM.

WHAT THIS PROTECTS

1. **Provider codes are unique and sequential, and never client-supplied.**
   Allocated from ``seq_provider_code``, so two concurrent creates cannot
   collide. Asserted under real concurrency, not by creating two in a row.
2. **Nothing here is a login.** The response for a provider user carries no
   password, token, role, permission or session field, and there is no auth
   endpoint that will accept one. This is the constraint the whole module rests
   on, so it is asserted rather than assumed.
3. **Every total is derived from bookings.** Provider totals equal the sum of
   the bookings assigned to that provider, provider-user totals equal the sum of
   theirs, and both are re-derived here from SQL and compared. No stored
   counter, so no drift — and no double counting, which is checked by issuing
   several tickets against one provider and adding them up independently.
4. **A provider user cannot be attributed to the wrong provider.** Issuing with
   a person who works somewhere else is refused, and the booking is left
   untouched — no ticket number burned, no status moved.
5. **Backward compatibility.** Issuing a ticket with no provider at all still
   works exactly as it did, because every caller written before this module
   sends neither field.
6. **Deactivation replaces deletion.** There is no delete route, an inactive
   provider disappears from the issuance dropdown, and its historical bookings
   stay attributable.
"""
import concurrent.futures
import sys
import uuid
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MANAGER, MERCHANT, Checker, H, PDF, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)
gtok = login(*MANAGER)

API = f"{BASE}/api/admin/providers"

#: Unique per run: provider_name is unique case-insensitively and permanently,
#: so a fixed literal would pass once and 409 on every run after it.
TAG = uuid.uuid4().hex[:8]

#: THIS SCRIPT LEAVES THE DEMO MERCHANT'S WALLET AS IT FOUND IT.
#:
#: Proving that provider totals are derived from real bookings means issuing
#: real tickets, and on the enquiry-led track issuing a ticket debits the
#: merchant's wallet (CR-4b). Six tickets is roughly -85,000, and the balance
#: persists between runs against this shared development database.
#:
#: That matters to a script this one never touches. ``verify_m4`` builds its
#: overdraw fixture as ``f"-{wallet + 50000}"``, which is only a negative number
#: while the wallet is above -50,000; below that it sends the literal
#: ``"--24051.00"`` and gets a 422. It runs *before* this script, so it cannot be
#: affected within one run — but it would be on the next one, and a suite that
#: fails every second time is worse than one that fails every time, because
#: nobody believes the failure.
#:
#: So the balance is recorded here and restored at the end. The underlying
#: fragility in that fixture is real and pre-existing; this simply declines to
#: make it fire.
MERCHANT_ID = requests.get(
    f"{BASE}/api/merchant/finance/position", headers=H(mtok)
).json()["merchant_id"]


def wallet_balance():
    db = SessionLocal()
    try:
        return D(str(db.execute(text(
            "SELECT wallet_balance FROM merchants WHERE merchant_id = :m"
        ), {"m": MERCHANT_ID}).scalar()))
    finally:
        db.close()


WALLET_AT_START = wallet_balance()


def money(v):
    return D(str(v))


def sql_totals(provider_id):
    """Re-derive a provider's totals straight from SQL, independently of the API."""
    db = SessionLocal()
    try:
        row = db.execute(text(
            "SELECT COUNT(*), COALESCE(SUM(total_amount), 0) FROM service_requests "
            "WHERE provider_id = :p AND request_type = 'booking'"
        ), {"p": provider_id}).one()
        return int(row[0]), money(row[1])
    finally:
        db.close()


def sql_user_totals(provider_user_id):
    db = SessionLocal()
    try:
        row = db.execute(text(
            "SELECT COUNT(*), COALESCE(SUM(total_amount), 0) FROM service_requests "
            "WHERE provider_user_id = :p AND request_type = 'booking'"
        ), {"p": provider_user_id}).one()
        return int(row[0]), money(row[1])
    finally:
        db.close()


# ===========================================================================
print("\n== creating providers ==")
# ===========================================================================
r = requests.post(API, headers=H(atok), json={"provider_name": f"Sky Travels {TAG}"})
check("create a provider -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
sky = r.json()
check("...it was given a code", bool(sky.get("provider_code")), str(sky))
check("...in the PRDnnn format", sky["provider_code"].startswith("PRD")
      and sky["provider_code"][3:].isdigit(), sky.get("provider_code"))
check("...and starts Active", sky["status"] == "active", str(sky.get("status")))
check("...with no tickets yet", sky["total_tickets"] == 0, str(sky))

r = requests.post(API, headers=H(atok), json={"provider_name": f"Cruise Co {TAG}"})
check("a second provider -> 201", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
cruise = r.json()
check("...gets a different code", cruise["provider_code"] != sky["provider_code"],
      f"{sky['provider_code']} vs {cruise['provider_code']}")

# A client cannot choose its own code — the field is not on the create schema,
# so an attempt is ignored rather than honoured.
r = requests.post(API, headers=H(atok),
                  json={"provider_name": f"Sneaky {TAG}", "provider_code": "PRD999"})
check("a client-supplied provider_code is not honoured",
      r.status_code == 201 and r.json()["provider_code"] != "PRD999",
      f"{r.status_code} {r.text[:200]}")

r = requests.post(API, headers=H(atok), json={"provider_name": f"sky travels {TAG}"})
check("a duplicate name (different case) -> 409", r.status_code == 409,
      f"{r.status_code} {r.text[:200]}")

r = requests.post(API, headers=H(atok), json={"provider_name": "x"})
check("a one-character name -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

# --------------------------------------------------------------- concurrency
print("\n== codes stay unique under concurrent creates ==")
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    results = list(pool.map(
        lambda i: requests.post(API, headers=H(atok),
                                json={"provider_name": f"Race {TAG} {i}"}),
        range(6),
    ))
made = [x.json() for x in results if x.status_code == 201]
codes = [m["provider_code"] for m in made]
check("all six concurrent creates succeeded", len(made) == 6,
      str([x.status_code for x in results]))
check("...and every code is unique", len(set(codes)) == len(codes), str(codes))

# ===========================================================================
print("\n== provider users are people, not logins ==")
# ===========================================================================
PU = f"{API}/{sky['id']}/users"
r = requests.post(PU, headers=H(atok),
                  json={"user_name": "John", "email": f"john.{TAG}@skytravels.example"})
check("add a provider user -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
john = r.json()

leaky = {"password", "password_hash", "token", "access_token", "role", "permissions",
         "username", "session", "otp"}
check("...the response carries NO credential or role field",
      not (leaky & set(john.keys())), str(sorted(set(john.keys()) & leaky)))

r = requests.post(PU, headers=H(atok),
                  json={"user_name": "David", "email": f"david.{TAG}@skytravels.example",
                        "phone_number": "+91 98200 11122"})
check("a second person -> 201", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
david = r.json()

r = requests.post(PU, headers=H(atok),
                  json={"user_name": "john", "email": f"other.{TAG}@skytravels.example"})
check("a duplicate name at the SAME provider -> 409", r.status_code == 409,
      f"{r.status_code} {r.text[:200]}")

# ...but the same name at a DIFFERENT provider is fine: two suppliers may each
# employ a John, and refusing the second would be a platform-wide unique name.
r = requests.post(f"{API}/{cruise['id']}/users", headers=H(atok),
                  json={"user_name": "John", "email": f"john.{TAG}@cruiseco.example"})
check("the same name at a DIFFERENT provider -> 201", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")
other_john = r.json()

r = requests.post(PU, headers=H(atok), json={"user_name": "Bad", "email": "not-an-email"})
check("a malformed email -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

r = requests.post(f"{API}/99999999/users", headers=H(atok),
                  json={"user_name": "Ghost", "email": f"ghost.{TAG}@x.example"})
check("a user under a provider that does not exist -> 404", r.status_code == 404,
      f"{r.status_code} {r.text[:200]}")

# ===========================================================================
print("\n== issuing a ticket records who it was bought from ==")
# ===========================================================================
FARE_A = D("18000.00")
b1 = flows.make_booking(mtok, atok, gtok=gtok, upto="approved",
                        fare=str(FARE_A), label=f"provider {TAG} A")
requests.post(f"{BASE}/api/requests/{b1['id']}/documents", headers=H(atok),
              files={"file": ("t.pdf", flows.PDF if hasattr(flows, "PDF") else b"%PDF-1.4\n%%EOF\n",
                              "application/pdf")},
              data={"doc_type": "ticket"})
r = requests.post(f"{BASE}/api/admin/requests/{b1['id']}/issue-ticket", headers=H(atok),
                  json={"fare_amount": str(FARE_A), "provider_id": sky["id"],
                        "provider_user_id": john["id"]})
check("issue with a provider and provider user -> 200", r.status_code == 200,
      f"{r.status_code} {r.text[:300]}")
issued = r.json()["request"]
check("...the booking reports the provider", issued.get("provider_id") == sky["id"],
      str(issued.get("provider_id")))
check("...and names it", issued.get("provider_name") == sky["provider_name"],
      str(issued.get("provider_name")))
check("...and names the person", issued.get("provider_user_name") == "John",
      str(issued.get("provider_user_name")))

# ------------------------------------------------ the coherence rule
print("\n== a person cannot be attributed to the wrong provider ==")
b2 = flows.make_booking(mtok, atok, gtok=gtok, upto="approved",
                        fare="9000.00", label=f"provider {TAG} mismatch")
requests.post(f"{BASE}/api/requests/{b2['id']}/documents", headers=H(atok),
              files={"file": ("t.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
              data={"doc_type": "ticket"})
ISSUE2 = f"{BASE}/api/admin/requests/{b2['id']}/issue-ticket"

r = requests.post(ISSUE2, headers=H(atok),
                  json={"fare_amount": "9000.00", "provider_id": sky["id"],
                        "provider_user_id": other_john["id"]})
check("a person from another provider -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:250]}")
check("...and the refusal says so", "does not work at" in r.text, r.text[:250])

state = requests.get(f"{BASE}/api/requests/{b2['id']}", headers=H(atok)).json()["request"]
check("...the refused booking did NOT move", state["status"] != "ticket_issued", state["status"])
check("...and burned no ticket number", not state.get("ticket_number"),
      str(state.get("ticket_number")))

r = requests.post(ISSUE2, headers=H(atok),
                  json={"fare_amount": "9000.00", "provider_user_id": john["id"]})
check("a person with no provider -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

r = requests.post(ISSUE2, headers=H(atok),
                  json={"fare_amount": "9000.00", "provider_id": 99999999})
check("an unknown provider -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

# ------------------------------------------------ backward compatibility
print("\n== issuing with NO provider still works (backward compatibility) ==")
r = requests.post(ISSUE2, headers=H(atok), json={"fare_amount": "9000.00"})
check("issue with no provider fields at all -> 200", r.status_code == 200,
      f"{r.status_code} {r.text[:300]}")
plain = r.json()["request"]
check("...and it really issued", plain["status"] == "ticket_issued", plain["status"])
check("...carrying no provider", plain.get("provider_id") is None, str(plain.get("provider_id")))

# ===========================================================================
print("\n== totals are derived from bookings, and never double counted ==")
# ===========================================================================
# Two more tickets against Sky: one for John, one for David. Sky's total must be
# the sum of all three; John's must be his two.
FARE_B = D("21000.00")
FARE_C = D("12500.00")
for fare, person in ((FARE_B, john), (FARE_C, david)):
    b = flows.make_booking(mtok, atok, gtok=gtok, upto="approved",
                           fare=str(fare), label=f"provider {TAG} {person['user_name']}")
    requests.post(f"{BASE}/api/requests/{b['id']}/documents", headers=H(atok),
                  files={"file": ("t.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
                  data={"doc_type": "ticket"})
    rr = requests.post(f"{BASE}/api/admin/requests/{b['id']}/issue-ticket", headers=H(atok),
                       json={"fare_amount": str(fare), "provider_id": sky["id"],
                             "provider_user_id": person["id"]})
    check(f"issue {fare} via {person['user_name']} -> 200", rr.status_code == 200,
          f"{rr.status_code} {rr.text[:250]}")

detail = requests.get(f"{API}/{sky['id']}", headers=H(atok)).json()
stats = detail["stats"]
db_tickets, db_amount = sql_totals(sky["id"])

check("the API's ticket count equals the database's",
      stats["total_tickets"] == db_tickets, f"{stats['total_tickets']} vs {db_tickets}")
check("the API's amount equals the database's",
      money(stats["total_amount"]) == db_amount, f"{stats['total_amount']} vs {db_amount}")
check("three tickets were counted, not more", db_tickets == 3, str(db_tickets))
check("the amount is exactly their sum",
      db_amount == FARE_A + FARE_B + FARE_C, f"{db_amount} vs {FARE_A + FARE_B + FARE_C}")
check("average ticket value is the server's own division",
      money(stats["average_ticket_value"]) == (db_amount / 3).quantize(D("0.01")),
      f"{stats['average_ticket_value']} vs {(db_amount / 3).quantize(D('0.01'))}")
check("the user count is right", stats["provider_user_count"] == 2,
      str(stats["provider_user_count"]))

by_id = {u["id"]: u for u in detail["users"]}
j_tickets, j_amount = sql_user_totals(john["id"])
check("John's tickets match the database", by_id[john["id"]]["tickets_booked"] == j_tickets,
      f"{by_id[john['id']]['tickets_booked']} vs {j_tickets}")
check("John's amount matches the database",
      money(by_id[john["id"]]["total_amount"]) == j_amount,
      f"{by_id[john['id']]['total_amount']} vs {j_amount}")
check("John booked exactly two", j_tickets == 2, str(j_tickets))
check("David booked exactly one", by_id[david["id"]]["tickets_booked"] == 1,
      str(by_id[david["id"]]["tickets_booked"]))
check("the users' tickets sum to the provider's",
      sum(u["tickets_booked"] for u in detail["users"]) == stats["total_tickets"],
      f"{sum(u['tickets_booked'] for u in detail['users'])} vs {stats['total_tickets']}")
check("the users' amounts sum to the provider's",
      sum((money(u["total_amount"]) for u in detail["users"]), D("0"))
      == money(stats["total_amount"]),
      str([u["total_amount"] for u in detail["users"]]))

check("the other provider was not credited with any of it", sql_totals(cruise["id"])[0] == 0,
      str(sql_totals(cruise["id"])))

check("recent bookings are listed", len(detail["recent_bookings"]) == 3,
      str(len(detail["recent_bookings"])))
first = detail["recent_bookings"][0]
for field in ("request_number", "amount", "provider_user_name", "ticket_number"):
    check(f"...a booking row carries {field}", first.get(field) is not None, str(first))

# ===========================================================================
print("\n== deactivating replaces deleting ==")
# ===========================================================================
r = requests.delete(f"{API}/{sky['id']}", headers=H(atok))
check("there is no DELETE route -> 404/405", r.status_code in (404, 405),
      f"{r.status_code} {r.text[:200]}")

opts = requests.get(f"{API}/options", headers=H(atok)).json()["items"]
check("an active provider is offered for issuance",
      any(o["id"] == sky["id"] for o in opts), str(len(opts)))
sky_opt = next(o for o in opts if o["id"] == sky["id"])
check("...with its people already attached", len(sky_opt["users"]) == 2, str(sky_opt))

r = requests.patch(f"{API}/{sky['id']}", headers=H(atok), json={"status": "inactive"})
check("deactivate a provider -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

opts = requests.get(f"{API}/options", headers=H(atok)).json()["items"]
check("...it is no longer offered for issuance",
      not any(o["id"] == sky["id"] for o in opts), str(len(opts)))

b3 = flows.make_booking(mtok, atok, gtok=gtok, upto="approved",
                        fare="5000.00", label=f"provider {TAG} inactive")
requests.post(f"{BASE}/api/requests/{b3['id']}/documents", headers=H(atok),
              files={"file": ("t.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
              data={"doc_type": "ticket"})
r = requests.post(f"{BASE}/api/admin/requests/{b3['id']}/issue-ticket", headers=H(atok),
                  json={"fare_amount": "5000.00", "provider_id": sky["id"],
                        "provider_user_id": john["id"]})
check("issuing against an inactive provider -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:250]}")

check("...but its historical bookings are still attributed", sql_totals(sky["id"])[0] == 3,
      str(sql_totals(sky["id"])))

r = requests.patch(f"{API}/{sky['id']}", headers=H(atok), json={"status": "active"})
check("reactivate -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

# ===========================================================================
print("\n== editing ==")
# ===========================================================================
r = requests.patch(f"{API}/{cruise['id']}", headers=H(atok),
                   json={"provider_name": f"Cruise Company {TAG}"})
check("rename a provider -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...the code did not change", r.json()["provider_code"] == cruise["provider_code"],
      f"{r.json()['provider_code']} vs {cruise['provider_code']}")

r = requests.patch(f"{API}/{cruise['id']}", headers=H(atok),
                   json={"provider_name": f"Sky Travels {TAG}"})
check("renaming onto another provider's name -> 409", r.status_code == 409,
      f"{r.status_code} {r.text[:200]}")

r = requests.patch(f"{API}/{cruise['id']}", headers=H(atok), json={})
check("a PATCH that changes nothing -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

r = requests.patch(f"{BASE}/api/admin/provider-users/{david['id']}", headers=H(atok),
                   json={"phone_number": "+91 90000 00000", "status": "inactive"})
check("edit a provider user -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...the change took", r.json()["status"] == "inactive", str(r.json().get("status")))

opts = requests.get(f"{API}/options", headers=H(atok)).json()["items"]
sky_opt = next(o for o in opts if o["id"] == sky["id"])
check("an inactive person is not offered for issuance",
      all(u["id"] != david["id"] for u in sky_opt["users"]), str(sky_opt))
check("...but David's past booking still counts", sql_user_totals(david["id"])[0] == 1,
      str(sql_user_totals(david["id"])))

# ===========================================================================
print("\n== search, filters and paging ==")
# ===========================================================================
r = requests.get(f"{API}?search={TAG}&page_size=100", headers=H(atok))
check("search by the run tag finds our providers -> 200", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")
check("...and finds all of them", r.json()["total"] >= 9, str(r.json()["total"]))

r = requests.get(f"{API}?search=john.{TAG}%40skytravels.example", headers=H(atok))
check("searching a PROVIDER USER's email finds their provider",
      any(i["id"] == sky["id"] for i in r.json()["items"]), r.text[:250])

r = requests.get(f"{API}?status=inactive&page_size=100", headers=H(atok))
check("filter by status -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...returns only inactive rows",
      all(i["status"] == "inactive" for i in r.json()["items"]), r.text[:250])

r = requests.get(f"{API}?page_size=101", headers=H(atok))
check("page_size over the cap -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

r = requests.get(f"{API}?sort=created_at&direction=desc&page_size=5", headers=H(atok))
check("sorting -> 200 and honours page_size", r.status_code == 200
      and len(r.json()["items"]) <= 5, f"{r.status_code} {len(r.json().get('items', []))}")

# ===========================================================================
print("\n== exports ==")
# ===========================================================================
for kind in ("providers", "provider_users", "booking_summary"):
    for fmt in ("csv", "xlsx"):
        r = requests.get(f"{API}/export?kind={kind}&format={fmt}", headers=H(atok))
        check(f"export {kind} as {fmt} -> 200", r.status_code == 200,
              f"{r.status_code} {r.text[:160]}")
        check(f"...{kind}/{fmt} is an attachment",
              "attachment" in (r.headers.get("content-disposition") or ""),
              str(r.headers.get("content-disposition")))

r = requests.get(f"{API}/export?kind=booking_summary&format=csv&provider_id={sky['id']}", headers=H(atok))
body = r.content.decode("utf-8", "replace")
check("a per-provider booking export is scoped to it",
      body.count(sky["provider_code"]) == 3, str(body.count(sky["provider_code"])))
check("...and does not leak the other provider",
      cruise["provider_code"] not in body, cruise["provider_code"])

r = requests.get(f"{API}/export?kind=nonsense", headers=H(atok))
check("an unknown export kind -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

# ===========================================================================
print("\n== RBAC and tenancy ==")
# ===========================================================================
r = requests.get(API, headers=H(mtok))
check("a merchant cannot list providers -> 403", r.status_code == 403,
      f"{r.status_code} {r.text[:200]}")
r = requests.post(API, headers=H(mtok), json={"provider_name": f"Merchant Made {TAG}"})
check("a merchant cannot create one -> 403", r.status_code == 403,
      f"{r.status_code} {r.text[:200]}")
r = requests.get(f"{API}/{sky['id']}", headers=H(gtok))
check("the platform Manager holds no provider code -> 403", r.status_code == 403,
      f"{r.status_code} {r.text[:200]}")
r = requests.get(API)
check("no token -> 401/403", r.status_code in (401, 403), f"{r.status_code} {r.text[:200]}")

r = requests.get(f"{API}/99999999", headers=H(atok))
check("an unknown provider -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")

# ===========================================================================
print("\n== no provider row is a login ==")
# ===========================================================================
db = SessionLocal()
try:
    cols = {r[0] for r in db.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name IN ('providers', 'provider_users')"
    )).all()}
finally:
    db.close()
forbidden = {"password", "password_hash", "username", "role", "permissions",
             "otp_code_hash", "session_token", "is_active_session"}
check("neither table has a credential column", not (cols & forbidden),
      str(sorted(cols & forbidden)))

r = requests.post(f"{BASE}/api/auth/login", json={
    "email": f"john.{TAG}@skytravels.example", "password": "anything", "portal": "merchant"})
check("a provider user cannot sign in -> 401/422", r.status_code in (401, 422),
      f"{r.status_code} {r.text[:200]}")

# ===========================================================================
print("\n== leaving the shared wallet as we found it ==")
# ===========================================================================
# See WALLET_AT_START. Not a teardown of anything this script owns — the
# providers and bookings it created are deliberately left in place, because
# they are what the screens are then read against. Only the borrowed money
# goes back.
spent = WALLET_AT_START - wallet_balance()
if spent > 0:
    r = requests.post(f"{BASE}/api/admin/merchants/{MERCHANT_ID}/wallet", headers=H(atok),
                      json={"amount": str(spent),
                            "reason": f"verify_providers {TAG}: restoring the test wallet"})
    check("the wallet spent on test tickets is credited back", r.status_code == 200,
          f"{r.status_code} {r.text[:200]}")
check("...and the balance is back where it started",
      wallet_balance() == WALLET_AT_START,
      f"{WALLET_AT_START} vs {wallet_balance()}")

sys.exit(check.report())
