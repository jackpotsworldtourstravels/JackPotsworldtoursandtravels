"""Merchant onboarding — created is active, and there is nothing left to approve.

WHAT CHANGED, AND WHY IT NEEDED CHANGING

An Admin created a merchant, and then an Admin approved it. Those were the same
person: there is no separate approver on this platform, no vetting desk, no
second pair of eyes the step was protecting. What the step actually did was
leave a real company at "Pending Approval" — unable to sign in, its staff told
to wait for an administrator — until somebody clicked a button that had never
once said no.

So the workflow is gone. A merchant is ACTIVE from the moment it is saved, and
a company that should not trade is suspended or made inactive: a state somebody
chose, rather than one it was born in.

WHAT THIS SCRIPT PROTECTS

1. **Saving a merchant produces an active merchant.** Not pending, not a draft
   — active, in the creation response and in the row that comes back from the
   list afterwards. This is the change; a regression here is the wait coming
   back.

2. **Its first login works immediately.** The approval gate lived in the login
   path (``auth._assert_merchant_tradeable``), so "active on paper" and "can
   actually sign in" were two different questions. The new merchant's own
   admin user signs in here, with the password the creation call returned once.

3. **The approve endpoint is gone, not hidden.** ``POST /merchants/{id}/approve``
   must 404 or 405 — an endpoint left in place behind a removed button is the
   workflow still being there, waiting for anyone with a URL.

4. **No merchant waits in the approvals queue.** New companies used to appear
   there as "New merchant" rows. The queue is for decisions somebody other than
   the creator makes, and a merchant is no longer one of those.

5. **Suspension still works, and still bites.** Removing an approval gate must
   not remove the gate that matters: a suspended company's staff are refused at
   sign-in. This is the check that proves the login path was trimmed and not
   gutted.

6. **Existing merchants are unharmed.** Every merchant on file is readable and
   none is left at ``pending_approval`` — migration 0078 released the ones that
   were stranded when the only way out of that state was deleted.

RUN IT AGAINST A LIVE SERVER, with migration 0078 applied:

    JPW_BASE=http://127.0.0.1:8000 python tests/verify_merchant_no_approval.py

It creates one real merchant (named for the run) and leaves it suspended, so
the suite can be run repeatedly without an approval desk full of test rows.
"""
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))

import minihttp as requests  # noqa: E402

from config import ADMIN, BASE, Checker, login  # noqa: E402

check = Checker()

print(f"\nBASE={BASE}")
admin = login(*ADMIN)
H = {"Authorization": f"Bearer {admin}"}

stamp = uuid.uuid4().hex[:8]
company = f"Approval-Free Travels {stamp}"

# ---------------------------------------------------------------------------
print("\n== 1. Saving a merchant creates an ACTIVE merchant ==")
# ---------------------------------------------------------------------------
payload = {
    "company_name": company,
    "merchant_name": f"AFT {stamp}",
    "company_type": "travel_agency",
    "email": f"desk+{stamp}@approvalfree-demo.com",
    "phone": "+919000000001",
    "contact_person": f"Test Contact {stamp}",
    "contact_email": f"contact+{stamp}@approvalfree-demo.com",
    "city": "Hyderabad",
    "country": "India",
    "country_code": "IN",
}
r = requests.post(f"{BASE}/api/admin/merchants", json=payload, headers=H)
check("the merchant is created", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
if r.status_code != 201:
    sys.exit(check.report())

created = r.json()
merchant = created["merchant"] if "merchant" in created else created
merchant_id = merchant.get("merchant_id") or merchant.get("id")
check("  and it is ACTIVE in the creation response",
      merchant.get("status") == "active", str(merchant.get("status")))
check("  not pending approval",
      merchant.get("status") != "pending_approval", str(merchant.get("status")))

first_user = created.get("first_user") or {}
temp_password = created.get("temporary_password")
check("  the first login is returned with it",
      bool(first_user.get("email") and temp_password), str(sorted(created)))

# The row the Merchant Management table actually draws.
r = requests.get(f"{BASE}/api/admin/merchants?search={stamp}", headers=H)
rows = (r.json() or {}).get("items", [])
# The list serialises the key as `id`; the creation response as `merchant_id`.
row = next((m for m in rows if (m.get("id") or m.get("merchant_id")) == merchant_id), None)
check("  and the table row says Active too",
      row is not None and row.get("status") == "active",
      str(row and row.get("status")))

# ---------------------------------------------------------------------------
print("\n== 2. Its first login works at once ==")
# ---------------------------------------------------------------------------
# The gate that used to refuse this lived in the login path, not in the UI, so
# this is the check that proves the workflow is gone rather than hidden.
r = requests.post(f"{BASE}/api/auth/login", json={
    "email": first_user.get("email"), "password": temp_password, "portal": "merchant",
})
check("the new merchant's admin can sign in immediately",
      r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("  and is not told to wait for an administrator",
      "awaiting approval" not in r.text.lower(), r.text[:160])

# ---------------------------------------------------------------------------
print("\n== 3. The approve endpoint is gone, not hidden ==")
# ---------------------------------------------------------------------------
r = requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/approve", json={}, headers=H)
check("POST /merchants/{id}/approve no longer exists",
      r.status_code in (404, 405), f"{r.status_code} {r.text[:160]}")

# ---------------------------------------------------------------------------
print("\n== 4. No merchant waits in the approvals queue ==")
# ---------------------------------------------------------------------------
r = requests.get(f"{BASE}/api/admin/approval-queue?page=1&page_size=100", headers=H)
items = (r.json() or {}).get("items", []) if r.status_code == 200 else []
check("the approval queue answers", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
check("  and holds no merchant rows",
      not [i for i in items if i.get("kind") == "merchant"],
      str([i.get("title") for i in items if i.get("kind") == "merchant"][:3]))

# ---------------------------------------------------------------------------
print("\n== 5. Suspension still refuses a sign-in ==")
# ---------------------------------------------------------------------------
# The point of trimming the login path was to drop ONE branch. If the rest went
# with it, a suspended company would still be able to trade, which is worse
# than the problem this change set out to fix.
r = requests.patch(f"{BASE}/api/admin/merchants/{merchant_id}/status",
                   json={"status": "suspended"}, headers=H)
check("a merchant can still be suspended", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
time.sleep(0.3)
r = requests.post(f"{BASE}/api/auth/login", json={
    "email": first_user.get("email"), "password": temp_password, "portal": "merchant",
})
check("  and its staff are then refused at sign-in",
      r.status_code == 403, f"{r.status_code} {r.text[:160]}")
check("  with the reason, not a generic error",
      "suspended" in r.text.lower(), r.text[:160])

# ---------------------------------------------------------------------------
print("\n== 6. Existing merchants are unharmed ==")
# ---------------------------------------------------------------------------
r = requests.get(f"{BASE}/api/admin/merchants?page=1&page_size=100", headers=H)
everyone = (r.json() or {}).get("items", [])
check("the merchant list still loads", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
check("  and nobody is stranded at pending_approval",
      not [m for m in everyone if m.get("status") == "pending_approval"],
      str([m.get("company_name") for m in everyone
           if m.get("status") == "pending_approval"][:3]))
check("  the status filter no longer offers it either",
      requests.get(f"{BASE}/api/admin/merchants?status=pending_approval",
                   headers=H).status_code in (200, 422),
      "a filter value the enum still carries must not 500")

sys.exit(check.report())
