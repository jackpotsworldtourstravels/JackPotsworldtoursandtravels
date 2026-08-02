"""Admin-initiated payment requests — the desk asks, the manager pays (0041).

WHAT THIS PROTECTS

1. **Raising a request moves no money, and cannot be made to.** A request is
   created ``awaiting_payment``, and that is not a status the verification
   endpoints will act on. So there is no sequence of admin calls that credits a
   wallet without a manager having paid — this asserts the desk cannot approve
   its own request straight through.
2. **Approval still credits exactly once.** The whole reason this extends
   ``wallet_topups`` rather than adding a table is that the credit stays behind
   ``uq_wallet_transactions_topup``. Six operators approving one settled request
   at the same instant must produce one credit, one success and five ordinary
   refusals.
3. **Each method demands the proof it can actually be checked by.** A bank
   transfer without its UTR cannot be matched against the statement; cash and
   crypto have no UTR at all, and one typed into that box would take a slot in
   a namespace that exists to stop two claims on one transfer.
4. **A rejected request can be paid again**, the stale verdict is cleared, and
   the second approval credits once — not twice, and not zero times.
5. **A request is addressed to a manager of the named company**, re-checked
   server-side, so a merchant cannot be shown another merchant's demand.

CR-4a's invariants (`docs/WALLET_ARCHITECTURE.md` §7) are re-asserted after
every scenario: cached balance == ledger, for every merchant, always.
"""
import sys
import threading
import time
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant, WalletTransaction  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MERCHANT, PNG, Checker, H, login  # noqa: E402

check = Checker()
atok = login(*ADMIN)
mtok = login(*MERCHANT)

A = f"{BASE}/api/admin"
M = f"{BASE}/api/merchant"

MID = requests.get(f"{M}/wallet", headers=H(mtok)).json()["merchant_id"]

#: A UTR is unique platform-wide and for ever, so a fixed series would collide
#: with the previous run of this script rather than testing anything.
_RUN = f"{int(time.time()) % 1_000_000:06d}"
_utr_seq = [0]


def utr():
    _utr_seq[0] += 1
    return f"REQ{_RUN}{_utr_seq[0]:03d}"


def money(v):
    return D(str(v))


def balance():
    with SessionLocal() as db:
        return money(db.get(Merchant, MID).wallet_balance)


def credits_for(topup_id):
    """Every ledger row this request produced. Length is the assertion."""
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(WalletTransaction.txn_number)
                .where(WalletTransaction.topup_id == topup_id)
            ).all()
        )


def assert_invariants(where):
    """Cached balance == ledger balance, for every merchant. Invariant #1."""
    with SessionLocal() as db:
        rows = db.execute(
            select(
                Merchant.merchant_id,
                Merchant.wallet_balance,
                func.coalesce(
                    select(
                        func.sum(WalletTransaction.credit) - func.sum(WalletTransaction.debit)
                    )
                    .where(WalletTransaction.merchant_id == Merchant.merchant_id)
                    .scalar_subquery(),
                    0,
                ),
            )
        ).all()
    drifted = [(m, money(cached), money(led)) for m, cached, led in rows
               if money(cached) != money(led)]
    check(f"no wallet drift {where}", not drifted, f"drifted: {drifted[:3]}")


BANK = {"bank_name": "HDFC Bank", "account_number": "50100123456789",
        "ifsc": "HDFC0001234", "branch": "Andheri East"}
CASH = {"token_details": "Counter 3 / token 4471", "note_number": f"NOTE-{_RUN}"}
CRYPTO = {"wallet_address": "TXk9Qm4Zr2pLnV8sD1hGyU3wE6bC7aF5tR", "network": "TRC20"}


def managers():
    r = requests.get(f"{A}/merchants/{MID}/managers", headers=H(atok))
    return r


def raise_req(manager_id, amount, method, instructions, expect=201):
    r = requests.post(f"{A}/wallet/payment-requests", headers=H(atok), json={
        "merchant_id": MID, "manager_id": manager_id, "amount": amount,
        "method": method, "instructions": instructions,
    })
    if expect is not None:
        check(f"raise {method} {amount} -> {expect}", r.status_code == expect,
              f"{r.status_code} {r.text[:160]}")
    return r


def settle(topup_id, token=None, utr_value=None, with_proof=True, expect=200):
    files = {"proof": ("proof.png", PNG, "image/png")} if with_proof else None
    data = {"utr": utr_value} if utr_value else {}
    r = requests.post(
        f"{M}/payment-requests/{topup_id}/settle",
        headers=H(token or mtok),
        data=data if (data or files) else None,
        files=files,
    )
    if expect is not None:
        check(f"settle #{topup_id} -> {expect}", r.status_code == expect,
              f"{r.status_code} {r.text[:160]}")
    return r


print("\n=== 1. Who a request may be addressed to ===")
r = managers()
check("admin can list a merchant's managers", r.status_code == 200,
      f"{r.status_code} {r.text[:120]}")
mgrs = r.json()
check("...and there is at least one", len(mgrs) >= 1, f"{len(mgrs)} returned")
MANAGER_ID = mgrs[0]["user_id"] if mgrs else None

with SessionLocal() as db:
    from app.models_v2 import MerchantRole, User, UserStatus
    expected = set(db.scalars(
        select(User.user_id).where(
            User.merchant_id == MID,
            User.merchant_role == MerchantRole.MANAGER,
            User.status == UserStatus.ACTIVE,
        )
    ).all())
check("the list is exactly that merchant's active managers",
      {m["user_id"] for m in mgrs} == expected,
      f"api={len(mgrs)} db={len(expected)}")

r = requests.get(f"{A}/merchants/{MID}/managers", headers=H(mtok))
check("a merchant cannot list managers through the admin route",
      r.status_code in (401, 403), f"{r.status_code}")

print("\n=== 2. Raising a request moves no money ===")
before = balance()
r = raise_req(MANAGER_ID, "5000.00", "bank_transfer", BANK)
BANK_ID = r.json()["topup_id"]
check("...status is awaiting_payment", r.json()["status"] == "awaiting_payment",
      r.json()["status"])
check("...it is marked admin-initiated", r.json()["admin_initiated"] is True)
check("...the instructions come back intact",
      r.json()["instructions"]["ifsc"] == BANK["ifsc"], r.json()["instructions"])
check("...the named manager is recorded",
      r.json()["assigned_manager_id"] == MANAGER_ID)
check("...the wallet did not move", balance() == before, f"{before} -> {balance()}")
check("...and no ledger row was written", not credits_for(BANK_ID))
assert_invariants("after raising a request")

print("\n=== 3. An unpaid request cannot be approved ===")
r = requests.post(f"{A}/wallet/topups/{BANK_ID}/verify", headers=H(atok), json={})
check("approving an unpaid request -> 409", r.status_code == 409,
      f"{r.status_code} {r.text[:160]}")
check("...and STILL no credit exists", not credits_for(BANK_ID))
check("...and the wallet still has not moved", balance() == before)

print("\n=== 4. Validation at the point of raising ===")
raise_req(MANAGER_ID, "100.00", "bank_transfer", {"bank_name": "X"}, expect=400)
raise_req(MANAGER_ID, "100.00", "crypto",
          {"wallet_address": "abc", "network": "SOLANA"}, expect=400)
raise_req(MANAGER_ID, "0", "bank_transfer", BANK, expect=422)
raise_req(MANAGER_ID, "100.00", "upi", BANK, expect=422)

rival = flows.rival_merchant(atok)
rival_users = requests.get(
    f"{A}/merchants/{rival['merchant_id']}/users?page_size=50", headers=H(atok)
).json()["items"]
outsider = next((u["id"] for u in rival_users), None)
if outsider:
    raise_req(outsider, "100.00", "bank_transfer", BANK, expect=400)
    check("a manager from another company is refused", True)

print("\n=== 5. The merchant sees it, and settling moves no money ===")
r = requests.get(f"{M}/payment-requests?bucket=requests", headers=H(mtok))
check("merchant can list raised requests", r.status_code == 200, f"{r.status_code}")
check("...the new request is in the 'requests' bucket",
      any(i["topup_id"] == BANK_ID for i in r.json()["items"]))

counts = requests.get(f"{M}/payment-requests/counts", headers=H(mtok)).json()
check("counts report it as a request, not as pending", counts["requests"] >= 1, counts)

settle(BANK_ID, with_proof=True, expect=400)          # bank transfer needs its UTR
BANK_UTR = utr()
r = settle(BANK_ID, utr_value=BANK_UTR, with_proof=True, expect=200)
check("...status becomes submitted", r.json()["status"] == "submitted", r.json()["status"])
check("...settling moved no money", balance() == before, f"{before} -> {balance()}")
check("...and wrote no ledger row", not credits_for(BANK_ID))
assert_invariants("after settling")

r = settle(BANK_ID, utr_value=utr(), expect=409)
check("settling twice is refused", True)

print("\n=== 6. Approval credits exactly once ===")
r = requests.post(f"{A}/wallet/topups/{BANK_ID}/verify", headers=H(atok), json={})
check("approve -> 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
check("the wallet gained exactly the requested amount",
      balance() == before + money("5000.00"), f"{before} -> {balance()}")
check("exactly one ledger row exists for it", len(credits_for(BANK_ID)) == 1,
      credits_for(BANK_ID))
assert_invariants("after approval")

r = requests.post(f"{A}/wallet/topups/{BANK_ID}/verify", headers=H(atok), json={})
check("approving again -> 409", r.status_code == 409, f"{r.status_code}")
check("...and there is still exactly one ledger row", len(credits_for(BANK_ID)) == 1)

print("\n=== 7. Cash: no UTR, proof mandatory ===")
before = balance()
CASH_ID = raise_req(MANAGER_ID, "1200.00", "cash", CASH).json()["topup_id"]
settle(CASH_ID, utr_value=utr(), expect=400)          # a note number is not a UTR
settle(CASH_ID, with_proof=False, expect=400)         # the image IS the proof
settle(CASH_ID, with_proof=True, expect=200)
requests.post(f"{A}/wallet/topups/{CASH_ID}/verify", headers=H(atok), json={})
check("cash approval credits the wallet once",
      balance() == before + money("1200.00") and len(credits_for(CASH_ID)) == 1,
      f"{before} -> {balance()}, rows={credits_for(CASH_ID)}")
assert_invariants("after cash")

print("\n=== 8. Crypto: network is an allowlist ===")
before = balance()
CRY_ID = raise_req(MANAGER_ID, "800.00", "crypto", CRYPTO).json()["topup_id"]
r = requests.get(f"{M}/payment-requests?bucket=requests", headers=H(mtok))
row = next(i for i in r.json()["items"] if i["topup_id"] == CRY_ID)
check("the merchant is told the address and the network",
      row["instructions"]["wallet_address"] == CRYPTO["wallet_address"]
      and row["instructions"]["network"] == "TRC20", row["instructions"])
settle(CRY_ID, utr_value=utr(), expect=400)
settle(CRY_ID, with_proof=True, expect=200)
requests.post(f"{A}/wallet/topups/{CRY_ID}/verify", headers=H(atok), json={})
check("crypto approval credits the wallet once",
      balance() == before + money("800.00") and len(credits_for(CRY_ID)) == 1,
      f"{before} -> {balance()}")
assert_invariants("after crypto")

print("\n=== 9. Reject, resubmit, approve ===")
before = balance()
RES_ID = raise_req(MANAGER_ID, "2500.00", "bank_transfer", BANK).json()["topup_id"]
first_utr = utr()
settle(RES_ID, utr_value=first_utr, expect=200)
r = requests.post(f"{A}/wallet/topups/{RES_ID}/reject", headers=H(atok),
                  json={"remarks": "UTR does not appear on our statement"})
check("reject -> 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
check("...rejection moved no money", balance() == before, f"{before} -> {balance()}")
check("...and wrote no ledger row", not credits_for(RES_ID))

r = settle(RES_ID, utr_value=utr(), expect=200)
check("a rejected request can be paid again", r.json()["status"] == "submitted")
check("...the resubmission is counted", r.json()["resubmission_count"] == 1,
      r.json()["resubmission_count"])
check("...and the stale rejection reason is cleared",
      not r.json().get("review_remarks"), r.json().get("review_remarks"))

requests.post(f"{A}/wallet/topups/{RES_ID}/verify", headers=H(atok), json={})
check("the resubmission credits once, not twice",
      balance() == before + money("2500.00") and len(credits_for(RES_ID)) == 1,
      f"{before} -> {balance()}, rows={credits_for(RES_ID)}")
assert_invariants("after resubmission")

print("\n=== 10. Withdrawing a request ===")
CAN_ID = raise_req(MANAGER_ID, "300.00", "bank_transfer", BANK).json()["topup_id"]
r = requests.post(f"{A}/wallet/payment-requests/{CAN_ID}/cancel", headers=H(atok),
                  json={"remarks": "raised against the wrong company"})
check("an unpaid request can be withdrawn", r.status_code == 200,
      f"{r.status_code} {r.text[:160]}")
check("...and it moved no money", not credits_for(CAN_ID))

PAID_ID = raise_req(MANAGER_ID, "400.00", "bank_transfer", BANK).json()["topup_id"]
settle(PAID_ID, utr_value=utr(), expect=200)
r = requests.post(f"{A}/wallet/payment-requests/{PAID_ID}/cancel", headers=H(atok),
                  json={"remarks": "changed my mind"})
check("a request the merchant has already PAID cannot be withdrawn -> 409",
      r.status_code == 409, f"{r.status_code} {r.text[:160]}")

print("\n=== 11. Concurrency: six approvals, one credit ===")
CON_ID = raise_req(MANAGER_ID, "900.00", "bank_transfer", BANK).json()["topup_id"]
settle(CON_ID, utr_value=utr(), expect=200)
before = balance()
results = []
lock = threading.Lock()


def approve():
    r = requests.post(f"{A}/wallet/topups/{CON_ID}/verify", headers=H(atok), json={})
    with lock:
        results.append(r.status_code)


threads = [threading.Thread(target=approve) for _ in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("exactly one approval succeeded", results.count(200) == 1, results)
check("...the others were refused cleanly, with no 500", 500 not in results, results)
check("...exactly one ledger row was written", len(credits_for(CON_ID)) == 1,
      credits_for(CON_ID))
check("...and the wallet gained the amount exactly once",
      balance() == before + money("900.00"), f"{before} -> {balance()}")
assert_invariants("after concurrent approval")

print("\n=== 12. Scope and authentication ===")
r = requests.get(f"{M}/payment-requests", headers=H(rival["token"]))
check("another merchant's list does not contain our request",
      r.status_code != 200 or all(i["topup_id"] != BANK_ID for i in r.json()["items"]),
      f"{r.status_code}")

OTHER_ID = raise_req(MANAGER_ID, "700.00", "bank_transfer", BANK).json()["topup_id"]
r = settle(OTHER_ID, token=rival["token"], utr_value=utr(), expect=None)
check("another merchant cannot settle our request -> 404",
      r.status_code == 404, f"{r.status_code} {r.text[:120]}")
check("...and it is still unpaid", not credits_for(OTHER_ID))

r = requests.post(f"{A}/wallet/payment-requests", headers=H(mtok), json={
    "merchant_id": MID, "manager_id": MANAGER_ID, "amount": "100.00",
    "method": "bank_transfer", "instructions": BANK,
})
check("a merchant cannot raise a payment request against itself",
      r.status_code in (401, 403), f"{r.status_code} {r.text[:120]}")

# The admin route is POST-only, and an unauthenticated GET to it lands on the
# static-frontend catch-all as a 404 — which says nothing about authentication.
# Probe it with the verb it actually has.
r = requests.post(f"{A}/wallet/payment-requests", json={})
check("raising a request requires authentication",
      r.status_code in (401, 403), f"{r.status_code}")

for path in (f"{M}/payment-requests", f"{M}/payment-requests/counts"):
    r = requests.get(path)
    check(f"{path.rsplit('/', 1)[-1]} requires authentication",
          r.status_code in (401, 403), f"{r.status_code}")

print("\n=== 13. The merchant's own Add Money path is untouched ===")
r = requests.post(f"{M}/wallet/topups", headers=H(mtok),
                  data={"amount": "150.00", "method": "bank_transfer", "utr": utr()},
                  files={"proof": ("p.png", PNG, "image/png")})
check("a merchant can still submit its own top-up", r.status_code == 201,
      f"{r.status_code} {r.text[:160]}")
if r.status_code == 201:
    own = r.json()
    check("...and it is NOT marked admin-initiated", own["admin_initiated"] is False)
    check("...and it starts at submitted, not awaiting_payment",
          own["status"] == "submitted", own["status"])
    r2 = requests.post(f"{M}/payment-requests/{own['topup_id']}/settle",
                       headers=H(mtok), data={"utr": utr()},
                       files={"proof": ("p.png", PNG, "image/png")})
    check("...and it cannot be settled through the request route -> 400",
          r2.status_code == 400, f"{r2.status_code} {r2.text[:120]}")

assert_invariants("at the end")

raise SystemExit(check.report())
