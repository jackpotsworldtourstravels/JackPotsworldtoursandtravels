"""CR-4d — the staff wallet desk: payment accounts, verification, reconciliation.

WHAT THIS PROTECTS

1. **Verification is the only path that credits a wallet from a top-up**, and it
   credits it exactly once. This is the money-moving half of CR-4c, and the
   assertion that matters most is the concurrency one: six operators deciding
   one claim at the same instant must produce **one** credit, one success and
   five ordinary refusals — never a double credit, never a 500.
2. **A rejection moves nothing** and frees the UTR, so a mistyped reference can
   be corrected rather than locking a merchant out of its own bank transfer.
3. **An account a merchant cannot pay into is never shown to one.** An active
   bank row with no number, or an active QR with no image, is worse than no row
   at all — it is displayed with authority and the money goes nowhere.
4. **Reconciliation tells the truth.** `drift` is zero for every merchant or the
   report says so loudly; pending top-ups are reported beside balances and never
   inside them.

CR-4a's four invariants (`docs/WALLET_ARCHITECTURE.md` §7) are re-asserted after
every scenario rather than restated: cached balance == ledger, chain unbroken.
"""
import sys
import threading
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant, WalletTransaction  # noqa: E402

import flows  # noqa: E402
from config import (  # noqa: E402
    ADMIN, BASE, JPEG, MERCHANT, PDF, PNG, Checker, H, login,
)

check = Checker()
atok = login(*ADMIN)
mtok = login(*MERCHANT)

MID = requests.get(f"{BASE}/api/merchant/wallet", headers=H(mtok)).json()["merchant_id"]

#: A UTR is unique platform-wide and for ever (`uq_wallet_topups_utr` excludes
#: only rejected claims), so a fixed series would collide with the previous run
#: of this script rather than testing anything. Seeded per run.
_RUN = f"{int(__import__('time').time()) % 1_000_000:06d}"
_utr_seq = [0]

A = f"{BASE}/api/admin"
M = f"{BASE}/api/merchant"


def money(v):
    return D(str(v))


def wallet():
    db = SessionLocal()
    try:
        return money(db.scalar(select(Merchant.wallet_balance).where(Merchant.merchant_id == MID)))
    finally:
        db.close()


def ledger_balance():
    db = SessionLocal()
    try:
        return money(db.scalar(text(
            "SELECT COALESCE(SUM(credit - debit), 0) FROM wallet_transactions WHERE merchant_id = :m"
        ), {"m": MID}))
    finally:
        db.close()


def credits_for(topup_id):
    """Ledger rows linked to one claim. Must never exceed one."""
    db = SessionLocal()
    try:
        return list(db.scalars(
            select(WalletTransaction).where(WalletTransaction.topup_id == topup_id)
        ).all())
    finally:
        db.close()


def assert_invariants(where):
    check(f"{where}: cached balance still equals the ledger",
          wallet() == ledger_balance(), f"{wallet()} vs {ledger_balance()}")
    db = SessionLocal()
    broken = db.execute(text("""
        SELECT count(*) FROM (
            SELECT balance_before, LAG(balance_after) OVER (ORDER BY txn_id) AS prev
            FROM wallet_transactions WHERE merchant_id = :m
        ) c WHERE prev IS NOT NULL AND balance_before <> prev
    """), {"m": MID}).scalar()
    doubled = db.execute(text("""
        SELECT count(*) FROM (
            SELECT topup_id FROM wallet_transactions
            WHERE topup_id IS NOT NULL GROUP BY topup_id HAVING count(*) > 1
        ) x
    """)).scalar()
    db.close()
    check(f"{where}: the balance chain is unbroken", broken == 0, f"{broken} broken rows")
    check(f"{where}: no top-up credited more than once", doubled == 0, f"{doubled} doubled")




def submit(amount="10000.00", utr=None, account_id=None, proof=True):
    """A merchant claim, through the real CR-4c endpoint."""
    _utr_seq[0] += 1
    utr = utr or f"CR4D{_RUN}{_utr_seq[0]:03d}"
    files = {"proof": ("proof.jpg", JPEG, "image/jpeg")} if proof else None
    data = {"amount": amount, "method": "bank_transfer", "utr": utr}
    if account_id:
        data["payment_account_id"] = str(account_id)
    r = requests.post(f"{M}/wallet/topups", headers=H(mtok), files=files, data=data)
    assert r.status_code in (200, 201), f"submit failed: {r.status_code} {r.text[:250]}"
    return r.json()["topup_id"], utr


# ===========================================================================
print("\n== payment accounts ==")
# ===========================================================================
r = requests.post(f"{A}/payment-accounts", headers=H(atok), json={
    "account_type": "bank", "label": f"CR-4D Bank {_RUN}",
    "details": {"account_name": "JackPots", "account_number": "9001", "ifsc": "HDFC0009001",
                "bank_name": "HDFC", "junk_field": "should be dropped"},
})
check("create a bank account -> 201", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
bank_id = r.json()["account_id"]
check("...keeping only the fields that belong to the rail",
      "junk_field" not in r.json()["details"] and r.json()["details"]["ifsc"] == "HDFC0009001",
      str(r.json()["details"]))

r = requests.post(f"{A}/payment-accounts", headers=H(atok), json={
    "account_type": "bank", "label": "Incomplete", "details": {"account_name": "X"}})
check("an ACTIVE bank with no number/IFSC -> 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")
check("...naming what is missing",
      "account_number" in r.text and "ifsc" in r.text, r.text[:200])

r = requests.post(f"{A}/payment-accounts", headers=H(atok), json={
    "account_type": "upi", "label": "No id", "details": {}})
check("an ACTIVE UPI with no UPI ID -> 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")

r = requests.post(f"{A}/payment-accounts", headers=H(atok), json={
    "account_type": "qr", "label": f"CR-4D QR {_RUN}", "details": {"upi_id": "jp@bank"},
    "is_active": False})
check("a QR account may be created INACTIVE, before its image -> 201",
      r.status_code == 201, f"{r.status_code} {r.text[:200]}")
qr_id = r.json()["account_id"]

r = requests.put(f"{A}/payment-accounts/{qr_id}", headers=H(atok), json={"is_active": True})
check("...but cannot be activated without one -> 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")

r = requests.post(f"{A}/payment-accounts/{qr_id}/qr", headers=H(atok),
                  files={"file": ("qr.pdf", PDF, "application/pdf")})
check("a PDF as a QR image -> 415", r.status_code == 415, f"{r.status_code} {r.text[:150]}")
check("...saying it must be an image", "image" in r.text.lower(), r.text[:150])

r = requests.post(f"{A}/payment-accounts/{qr_id}/qr", headers=H(atok),
                  files={"file": ("qr.png", b"<html>not a png</html>", "image/png")})
check("bytes that do not match the declared image type -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:150]}")

r = requests.post(f"{A}/payment-accounts/{qr_id}/qr", headers=H(atok),
                  files={"file": ("qr.png", PNG, "image/png")})
check("a real PNG is accepted -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...and the response never leaks the stored path",
      "qr_image_path" not in r.text and r.json()["has_qr_image"] is True, r.text[:200])

r = requests.put(f"{A}/payment-accounts/{qr_id}", headers=H(atok), json={"is_active": True})
check("with an image attached it activates -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")

r = requests.get(f"{A}/payment-accounts/{qr_id}/qr", headers=H(atok))
check("staff can read the QR image -> 200", r.status_code == 200, str(r.status_code))
check("...and it is not cached in a shared cache",
      "no-store" in (r.headers.get("cache-control") or ""), r.headers.get("cache-control"))

r = requests.put(f"{A}/payment-accounts/{bank_id}", headers=H(atok),
                 json={"details": {"account_name": "JackPots"}})
check("emptying a LIVE account's number -> 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")

# --- the merchant only ever sees usable, active accounts -------------------
merchant_accounts = requests.get(f"{M}/wallet/payment-accounts", headers=H(mtok)).json()
labels = [a["label"] for a in merchant_accounts]
check("the merchant sees the active bank account", f"CR-4D Bank {_RUN}" in labels, str(labels))
check("...and the now-active QR account", f"CR-4D QR {_RUN}" in labels, str(labels))

r = requests.delete(f"{A}/payment-accounts/{qr_id}", headers=H(atok))
check("retiring an account -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
check("...deactivates rather than deleting it", r.json()["is_active"] is False, r.text[:150])
check("...and it is still visible to staff",
      any(a["account_id"] == qr_id for a in requests.get(f"{A}/payment-accounts", headers=H(atok)).json()))
check("...but gone from the merchant's Add Money screen",
      f"CR-4D QR {_RUN}" not in [a["label"] for a in
                                requests.get(f"{M}/wallet/payment-accounts", headers=H(mtok)).json()])

# ===========================================================================
print("\n== verification credits the wallet, exactly once ==")
# ===========================================================================
before = wallet()
tid, utr = submit("18000.00", account_id=bank_id)
check("submitting still moves no money (CR-4c's rule holds)", wallet() == before, str(wallet()))

r = requests.get(f"{A}/wallet/topups/{tid}", headers=H(atok))
check("the desk can open the claim -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...showing the balance BEFORE the decision",
      money(r.json()["wallet_balance"]) == before, r.text[:200])
check("...and which account the money went to",
      r.json()["topup"]["payment_account_label"] == f"CR-4D Bank {_RUN}", r.text[:250])

r = requests.get(f"{A}/wallet/topups/{tid}/proof", headers=H(atok))
check("the desk can download the proof -> 200", r.status_code == 200, str(r.status_code))
check("...as an attachment, never inline",
      "attachment" in (r.headers.get("content-disposition") or ""),
      r.headers.get("content-disposition"))
check("...and not cached", "no-store" in (r.headers.get("cache-control") or ""),
      r.headers.get("cache-control"))

r = requests.post(f"{A}/wallet/topups/{tid}/verify", headers=H(atok),
                  json={"remarks": "Seen on statement"})
check("verify -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
res = r.json()
check("...returning a WTX reference, not an internal id",
      (res["transaction_reference"] or "").startswith("WTX-"), str(res["transaction_reference"]))
check("...and the balance either side of it",
      money(res["wallet_balance_before"]) == before
      and money(res["wallet_balance_after"]) == before + D("18000.00"),
      f"{res['wallet_balance_before']} -> {res['wallet_balance_after']}")
check("the wallet actually moved by the claimed amount",
      wallet() - before == D("18000.00"), f"{before} -> {wallet()}")

rows = credits_for(tid)
check("exactly one ledger row was written for the claim", len(rows) == 1, str(len(rows)))
check("...as a wallet_recharge credit",
      rows and rows[0].txn_type.value == "wallet_recharge" and rows[0].credit == D("18000.00"),
      str(rows[:1]))
check("...naming the claim in its reason", rows and utr in (rows[0].reason or ""), str(rows[0].reason))

r = requests.post(f"{A}/wallet/topups/{tid}/verify", headers=H(atok), json={})
check("verifying the same claim twice -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
check("...and it does not claim a colleague did it, when it was the same operator",
      "another operator" not in r.text, r.text[:200])
check("...and wrote no second credit", len(credits_for(tid)) == 1)

r = requests.post(f"{A}/wallet/topups/{tid}/reject", headers=H(atok), json={"remarks": "too late"})
check("rejecting an already-verified claim -> 409", r.status_code == 409, f"{r.status_code} {r.text[:150]}")

assert_invariants("after a verification")

# ===========================================================================
print("\n== rejection moves nothing, and frees the reference ==")
# ===========================================================================
before = wallet()
tid2, utr2 = submit("7000.00")

r = requests.post(f"{A}/wallet/topups/{tid2}/reject", headers=H(atok), json={"remarks": ""})
check("rejecting with no reason -> 4xx", r.status_code in (400, 422), f"{r.status_code} {r.text[:150]}")

r = requests.post(f"{A}/wallet/topups/{tid2}/reject", headers=H(atok),
                  json={"remarks": "The screenshot shows a different amount."})
check("rejecting with a reason -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...moves no money", wallet() == before, f"{before} vs {wallet()}")
check("...writes no ledger row", not credits_for(tid2))
check("...and names no transaction, because none exists",
      r.json()["transaction_reference"] is None, str(r.json().get("transaction_reference")))

# A rejected UTR is one the merchant may legitimately resubmit.
tid3, _ = submit("7000.00", utr=utr2)
check("the rejected UTR can be claimed again", bool(tid3), "resubmission refused")
r = requests.post(f"{A}/wallet/topups/{tid3}/verify", headers=H(atok), json={})
check("...and verified -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...crediting the corrected claim", wallet() - before == D("7000.00"), f"{before} -> {wallet()}")

# ...but a live claim's UTR is not free.
r = requests.post(f"{M}/wallet/topups", headers=H(mtok),
                  files={"proof": ("p.jpg", JPEG, "image/jpeg")},
                  data={"amount": "1.00", "method": "bank_transfer", "utr": utr2})
check("a UTR on a VERIFIED claim cannot be reused -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")
check("...without revealing who holds it",
      "Demo" not in r.text and "merchant" not in r.text.lower(), r.text[:200])

assert_invariants("after a rejection")

# ===========================================================================
print("\n== six operators deciding one claim at once ==")
# ===========================================================================
# The assertion CR-4b's lesson demands. A sequential "verify twice" never
# reaches the race; only simultaneous callers do.
race_before = wallet()
race_id, _ = submit("5000.00")
results: list[int] = []
errors: list[str] = []
barrier = threading.Barrier(6)


def _decide(n):
    try:
        barrier.wait(timeout=25)
        r = requests.post(f"{A}/wallet/topups/{race_id}/verify", headers=H(atok), json={})
        results.append(r.status_code)
    except Exception as exc:                     # noqa: BLE001 — recorded, then asserted on
        errors.append(f"{type(exc).__name__}: {exc}")


threads = [threading.Thread(target=_decide, args=(n,)) for n in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("no request raised", not errors, "; ".join(errors[:2]))
check("exactly one operator wins", results.count(200) == 1, str(sorted(results)))
check("the losers get an ordinary refusal, never a 500",
      all(c in (200, 409) for c in results) and 500 not in results, str(sorted(results)))
check("the wallet moved exactly once", wallet() - race_before == D("5000.00"),
      f"{race_before} -> {wallet()}, expected +5000.00")
check("and exactly one ledger row exists for the claim",
      len(credits_for(race_id)) == 1, str(len(credits_for(race_id))))

assert_invariants("after six simultaneous verifications")

# ===========================================================================
print("\n== the queue ==")
# ===========================================================================
r = requests.get(f"{A}/wallet/topups/counts", headers=H(atok))
counts = r.json()
check("counts -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
check("...covering every bucket",
      all(k in counts for k in ("pending", "verified", "rejected", "all", "pending_amount")),
      str(counts))
check("...with all = pending + verified + rejected",
      counts["all"] == counts["pending"] + counts["verified"] + counts["rejected"], str(counts))
check("...and pending_amount as a decimal string, never a float",
      isinstance(counts["pending_amount"], str), repr(counts["pending_amount"]))

r = requests.get(f"{A}/wallet/topups?bucket=pending&page_size=5", headers=H(atok))
items = r.json()["items"]
check("the queue answers -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
check("...oldest first — it is a work queue, not a feed",
      [i["submitted_at"] for i in items] == sorted(i["submitted_at"] for i in items),
      str([i["submitted_at"] for i in items]))
check("...every row is actually pending", all(i["status"] == "submitted" for i in items))
check("...and carries the merchant it is from", all(i["merchant_name"] for i in items))
check("...never exposing a stored path", "proof_path" not in r.text)

r = requests.get(f"{A}/wallet/topups?bucket=verified&search={utr}", headers=H(atok))
check("search by UTR finds the verified claim",
      any(i["utr"] == utr for i in r.json()["items"]), r.text[:250])
check("...and shows the ledger entry it became",
      all((i["wallet_txn_number"] or "").startswith("WTX-") for i in r.json()["items"]
          if i["utr"] == utr), r.text[:250])

r = requests.get(f"{A}/wallet/topups?bucket=nonsense", headers=H(atok))
check("an unknown bucket -> 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")

r = requests.get(f"{A}/wallet/topups?bucket=pending&merchant_id={MID}", headers=H(atok))
check("filtering by merchant works",
      all(i["merchant_id"] == MID for i in r.json()["items"]), r.text[:200])

# ===========================================================================
print("\n== reconciliation ==")
# ===========================================================================
r = requests.get(f"{A}/wallet/reconciliation", headers=H(atok))
rec = r.json()
check("reconciliation -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
check("every merchant reconciles — drift is zero everywhere",
      rec["reconciled"] is True and rec["drifted_merchant_count"] == 0,
      f"{rec['drifted_merchant_count']} drifted")
check("...and each row proves it independently",
      all(money(m["wallet_balance"]) == money(m["ledger_balance"]) and money(m["drift"]) == 0
          for m in rec["merchants"]),
      str([(m["merchant_name"], m["drift"]) for m in rec["merchants"]][:3]))

mine = next(m for m in rec["merchants"] if m["merchant_id"] == MID)
check("the report's balance matches the database", money(mine["wallet_balance"]) == wallet(),
      f"{mine['wallet_balance']} vs {wallet()}")
check("pending top-ups are reported BESIDE the balance, not inside it",
      money(mine["wallet_balance"]) + money(mine["pending_topup_amount"])
      != money(mine["ledger_balance"]) or money(mine["pending_topup_amount"]) == 0,
      "a pending claim has been added into a balance")
check("outstanding is the debt, floored at zero",
      money(mine["outstanding"]) >= 0
      and (money(mine["outstanding"]) == 0 or money(mine["wallet_balance"]) < 0),
      f"balance {mine['wallet_balance']} outstanding {mine['outstanding']}")

# ===========================================================================
print("\n== the staff ledger is the merchant's ledger ==")
# ===========================================================================
staff = requests.get(f"{A}/merchants/{MID}/wallet/transactions?page_size=10", headers=H(atok)).json()
own = requests.get(f"{M}/wallet/transactions?page_size=10", headers=H(mtok)).json()
check("staff read the merchant's ledger -> 200", bool(staff.get("items")), str(staff)[:200])
check("...the same total the merchant sees", staff["total"] == own["total"],
      f"{staff['total']} vs {own['total']}")
check("...and the same balance", money(staff["wallet_balance"]) == wallet(),
      f"{staff['wallet_balance']} vs {wallet()}")

# ===========================================================================
print("\n== RBAC and cross-tenant ==")
# ===========================================================================
for label, path, method, body in [
    ("list the verification queue", f"{A}/wallet/topups", "get", None),
    ("read the queue counts", f"{A}/wallet/topups/counts", "get", None),
    ("read reconciliation", f"{A}/wallet/reconciliation", "get", None),
    ("list payment accounts", f"{A}/payment-accounts", "get", None),
]:
    r = getattr(requests, method)(path, headers=H(mtok)) if body is None else None
    check(f"a merchant cannot {label}", r.status_code in (401, 403, 404),
          f"{r.status_code} {r.text[:120]}")

r = requests.post(f"{A}/payment-accounts", headers=H(mtok),
                  json={"account_type": "bank", "label": "mine", "details": {}})
check("a merchant cannot create a payment account", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:120]}")

tid4, _ = submit("2000.00")
r = requests.post(f"{A}/wallet/topups/{tid4}/verify", headers=H(mtok), json={})
check("a merchant cannot verify its OWN top-up", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:120]}")
check("...and the wallet did not move", not credits_for(tid4))

rival = flows.rival_merchant(atok)
r = requests.get(f"{M}/wallet/topups/{tid4}/proof", headers=H(rival["token"]))
check("another merchant cannot read the proof -> 404", r.status_code == 404,
      f"{r.status_code} {r.text[:120]}")
r = requests.get(f"{A}/merchants/{MID}/wallet/transactions", headers=H(rival["token"]))
check("another merchant cannot read the ledger", r.status_code in (401, 403, 404),
      f"{r.status_code} {r.text[:120]}")

for path in (f"{A}/wallet/topups", f"{A}/wallet/reconciliation", f"{A}/payment-accounts"):
    r = requests.get(path)
    check(f"{path.rsplit('/', 1)[-1]} requires authentication",
          r.status_code in (401, 403), f"{r.status_code}")

assert_invariants("at the end")

raise SystemExit(check.report())
