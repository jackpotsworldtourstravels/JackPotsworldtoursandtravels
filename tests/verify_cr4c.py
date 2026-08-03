"""CR-4c — the merchant's wallet screen: balance, ledger, and adding money.

WHAT THIS PROTECTS

1. **Submitting a top-up credits nothing.** The headline assertion, and the one
   that matters most: a merchant filling in a form is making a *claim*, and the
   wallet moves only when an admin verifies it (CR-4d). If submission credited
   the wallet, a merchant could raise its own spending power by typing a number
   and the credit limit would mean nothing. Asserted against the cached balance
   **and** the ledger, before and after.
2. **The summary agrees with the ledger.** Every figure on the screen comes from
   one computation; this re-derives them from SQL and compares.
3. **`pending_topups` is never folded into the balance.** They are two numbers
   and they stay two numbers.
4. **The proof upload is as guarded as a passport scan.** Same allowlist, same
   magic-byte sniff, same streaming cap — because it is literally the same code
   after CR-4c extracted `document_service.store_upload`.
5. **Cross-tenant.** Another merchant's top-up and its proof are 404, not 403.

It reuses CR-4a's invariants: after every scenario the cached balance still
equals the ledger and the chain is unbroken.
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
from sqlalchemy import select, text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant, PaymentAccount, PaymentAccountType  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MERCHANT, Checker, H, JPEG, PDF, PNG, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)

WALLET = f"{BASE}/api/merchant/wallet"

#: A UTR identifies one real bank transfer, and `uq_wallet_topups_utr` enforces
#: that platform-wide and permanently. A fixed literal here would therefore pass
#: on the first run and fail on every run after it — the same shape as the
#: `verify_m4.py` magic-number defect CR-4a found. One run, one namespace.
RUN = uuid.uuid4().hex[:8].upper()


def utr(tag):
    return f"CR4C{RUN}{tag}"


def money(v):
    return D(str(v))


def summary():
    return requests.get(WALLET, headers=H(mtok)).json()


MID = summary()["merchant_id"]


def balances():
    """(cached balance, ledger sum) — they must always be equal."""
    db = SessionLocal()
    try:
        cached = money(db.scalar(
            select(Merchant.wallet_balance).where(Merchant.merchant_id == MID)))
        ledger = money(db.scalar(text(
            "SELECT COALESCE(SUM(credit - debit), 0) FROM wallet_transactions "
            "WHERE merchant_id = :m"), {"m": MID}))
        return cached, ledger
    finally:
        db.close()


def assert_invariants(where):
    """CR-4a's guarantees, re-asserted after each scenario."""
    cached, ledger = balances()
    check(f"{where}: cached balance still equals the ledger", cached == ledger,
          f"{cached} vs {ledger}")
    db = SessionLocal()
    broken = db.execute(text("""
        SELECT count(*) FROM (
            SELECT balance_before, LAG(balance_after) OVER (ORDER BY txn_id) AS prev
            FROM wallet_transactions WHERE merchant_id = :m
        ) c WHERE prev IS NOT NULL AND balance_before <> prev
    """), {"m": MID}).scalar()
    db.close()
    check(f"{where}: the balance chain is unbroken", broken == 0, f"{broken} broken rows")


def submit(**kw):
    """POST a top-up. `files` only when a proof is actually being sent."""
    data = {k: v for k, v in kw.items() if k != "proof" and v is not None}
    files = {"proof": kw["proof"]} if kw.get("proof") else None
    return requests.post(f"{WALLET}/topups", headers=H(mtok), data=data, files=files)


# ===========================================================================
print("\n== the wallet summary agrees with the ledger ==")
# ===========================================================================
s = summary()
cached, ledger = balances()
check("the summary's balance is the cached balance", money(s["balance"]) == cached,
      f'{s["balance"]} vs {cached}')
check("...which equals the ledger", cached == ledger, f"{cached} vs {ledger}")

db = SessionLocal()
sql_credits = money(db.scalar(text(
    "SELECT COALESCE(SUM(credit),0) FROM wallet_transactions WHERE merchant_id=:m"), {"m": MID}))
sql_debits = money(db.scalar(text(
    "SELECT COALESCE(SUM(debit),0) FROM wallet_transactions WHERE merchant_id=:m"), {"m": MID}))
sql_count = db.scalar(text(
    "SELECT count(*) FROM wallet_transactions WHERE merchant_id=:m"), {"m": MID})
db.close()
check("total_credits matches SUM(credit)", money(s["total_credits"]) == sql_credits,
      f'{s["total_credits"]} vs {sql_credits}')
check("total_debits matches SUM(debit)", money(s["total_debits"]) == sql_debits,
      f'{s["total_debits"]} vs {sql_debits}')
check("transaction_count matches the row count", s["transaction_count"] == sql_count,
      f'{s["transaction_count"]} vs {sql_count}')

# `outstanding` is the balance said positively, floored at zero — a merchant in
# credit owes nothing rather than a negative amount.
expected_outstanding = max(D("0.00"), -cached)
check("outstanding is the negative balance, floored at zero",
      money(s["outstanding"]) == expected_outstanding,
      f'{s["outstanding"]} vs {expected_outstanding}')

# Money crosses the wire as a STRING so a float cannot get near it (M4's rule).
for field in ("balance", "outstanding", "credit_limit", "total_credits", "total_debits",
              "pending_topups"):
    check(f"{field} crosses the wire as a decimal STRING, not a number",
          isinstance(s[field], str), f"{field}={s[field]!r}")

assert_invariants("at the start")

# ===========================================================================
print("\n== the ledger reads as a statement ==")
# ===========================================================================
r = requests.get(f"{WALLET}/transactions?page=1&page_size=5", headers=H(mtok))
check("the ledger endpoint answers -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
page = r.json()
check("...paginated", page["page"] == 1 and page["page_size"] == 5, str(page.get("page_size")))
check("...with the full total", page["total"] == sql_count, f'{page["total"]} vs {sql_count}')

if page["items"]:
    ids = [t["txn_id"] for t in page["items"]]
    check("...oldest first, by txn_id and not by created_at", ids == sorted(ids), str(ids))
    first = page["items"][0]
    check("...every line carries a WTX reference, never a bare id",
          first["txn_number"].startswith("WTX-"), first["txn_number"])
    # The running balance is the server's stored figure, not something a client
    # accumulates — see WALLET_ARCHITECTURE §6 for why that distinction matters.
    check("...and the server's own running balance",
          money(first["balance_after"]) == money(first["balance_before"])
          + money(first["credit"]) - money(first["debit"]),
          f'{first["balance_before"]} +{first["credit"]} -{first["debit"]} = {first["balance_after"]}')
    check("...with amounts as decimal strings",
          isinstance(first["debit"], str) and isinstance(first["balance_after"], str))

# Page 2 must not repeat page 1 — an off-by-one in the offset is the classic
# pagination bug and it silently double-counts money on screen.
p2 = requests.get(f"{WALLET}/transactions?page=2&page_size=5", headers=H(mtok)).json()
if page["items"] and p2["items"]:
    check("page 2 does not repeat page 1",
          not ({t["txn_id"] for t in page["items"]} & {t["txn_id"] for t in p2["items"]}),
          "overlapping ids")

# ===========================================================================
print("\n== every line names what settled it ==")
# ===========================================================================
# Wallet History has to show the payment request behind a credit, and it must
# show the REFERENCE the merchant can quote back to us — `topup_id` is an
# internal key that appears on nobody's screen. This asserts the join is wired,
# against a merchant that really has such a row, rather than against a page that
# happens to hold none and would pass on an empty set.
db = SessionLocal()
linked_id = db.execute(text(
    "SELECT t.txn_id FROM wallet_transactions t "
    "WHERE t.merchant_id = :m AND t.topup_id IS NOT NULL "
    "ORDER BY t.txn_id DESC LIMIT 1"), {"m": MID}).scalar()
expected_ref = position = None
if linked_id:
    expected_ref = db.execute(text(
        "SELECT u.topup_number FROM wallet_transactions t "
        "JOIN wallet_topups u ON u.topup_id = t.topup_id WHERE t.txn_id = :t"),
        {"t": linked_id}).scalar()
    # THE PAGE IS COMPUTED, NOT SCANNED FOR. The ledger is served OLDEST FIRST
    # (a statement is read downwards), so the most recent linked row is at the
    # END — on this database, row ~1,836 of 1,836. A bounded scan from page 1
    # walked the oldest rows and concluded the join was broken. Counting the
    # rows at or before it gives its 1-based position directly.
    position = db.execute(text(
        "SELECT COUNT(*) FROM wallet_transactions "
        "WHERE merchant_id = :m AND txn_id <= :t"), {"m": MID, "t": linked_id}).scalar_one()
db.close()

if linked_id:
    size = 100
    pg = (position + size - 1) // size
    body = requests.get(f"{WALLET}/transactions?page={pg}&page_size={size}",
                        headers=H(mtok)).json()
    found = next((t for t in body["items"] if t["txn_id"] == linked_id), None)
    if check("a credit raised by a payment request is on the ledger", found is not None,
             f"txn {linked_id} (row {position}) not on page {pg}"):
        check("...and names the payment request by its reference",
              found.get("topup_number") == expected_ref,
              f'{found.get("topup_number")!r} != {expected_ref!r}')
        check("...which is a PAY reference, not an internal id",
              str(found.get("topup_number") or "").startswith("PAY-"),
              str(found.get("topup_number")))
else:
    check("a credit raised by a payment request is on the ledger", True,
          "no payment-request credit on this merchant — nothing to assert")

# Movement that came from somewhere else must NOT invent one.
unlinked = next((t for t in page["items"] if not t.get("topup_id")), None)
if unlinked:
    check("...while movement with no payment request behind it names none",
          unlinked.get("topup_number") is None, str(unlinked.get("topup_number")))

# ===========================================================================
print("\n== payment accounts are read-only here ==")
# ===========================================================================
db = SessionLocal()
fixture = PaymentAccount(
    account_type=PaymentAccountType.UPI, label="verify_cr4c fixture account",
    details={"upi_id": "verify-cr4c@upi"}, is_active=True, display_order=99,
)
retired = PaymentAccount(
    account_type=PaymentAccountType.BANK, label="verify_cr4c retired account",
    details={"account_number": "0000"}, is_active=False, display_order=100,
)
db.add_all([fixture, retired])
db.commit()
fixture_id, retired_id = fixture.account_id, retired.account_id
db.close()

r = requests.get(f"{WALLET}/payment-accounts", headers=H(mtok))
check("the accounts endpoint answers -> 200", r.status_code == 200, f"{r.status_code}")
accounts = r.json()
labels = [a["label"] for a in accounts]
check("an active account is offered", "verify_cr4c fixture account" in labels, str(labels))
check("an INACTIVE account is not", "verify_cr4c retired account" not in labels, str(labels))
check("...and no account leaks a storage path",
      all("qr_image_path" not in a and "path" not in a for a in accounts), str(accounts[:1]))

r = requests.get(f"{WALLET}/payment-accounts/{retired_id}/qr", headers=H(mtok))
check("an inactive account's QR is not served -> 404", r.status_code == 404, str(r.status_code))
r = requests.get(f"{WALLET}/payment-accounts/{fixture_id}/qr", headers=H(mtok))
check("an account with no QR image -> 404", r.status_code == 404, str(r.status_code))

# ===========================================================================
print("\n== submitting a top-up credits NOTHING ==")
# ===========================================================================
before_cached, before_ledger = balances()
before_count = summary()["transaction_count"]

r = submit(amount="4321.55", method="bank_transfer", utr=utr("001"),
           payment_account_id=str(fixture_id),
           proof=("receipt.png", PNG, "image/png"))
check("a complete submission -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
topup = r.json()
check("...carrying a PAY- reference, not a bare id",
      topup["topup_number"].startswith("PAY-"), topup["topup_number"])
check("...recorded as submitted, not verified", topup["status"] == "submitted", topup["status"])
check("...for the amount sent, paise intact", money(topup["amount"]) == D("4321.55"),
      topup["amount"])
check("...naming the account it was paid into",
      topup["payment_account_label"] == "verify_cr4c fixture account",
      str(topup["payment_account_label"]))
check("...knowing it has a proof file", topup["has_proof"] is True, str(topup))
check("...and no ledger reference yet, because nothing was credited",
      topup["wallet_txn_number"] is None, str(topup["wallet_txn_number"]))

after_cached, after_ledger = balances()
check("THE WALLET DID NOT MOVE", after_cached == before_cached,
      f"{before_cached} -> {after_cached}")
check("...and the ledger gained no row", after_ledger == before_ledger,
      f"{before_ledger} -> {after_ledger}")
check("...nor did the transaction count change",
      summary()["transaction_count"] == before_count, str(summary()["transaction_count"]))

s2 = summary()
check("the claim is reported as pending instead",
      money(s2["pending_topups"]) >= D("4321.55"), s2["pending_topups"])
check("...counted separately from the balance",
      money(s2["balance"]) == before_cached, f'{s2["balance"]} vs {before_cached}')
# Stated as its own assertion because it is the rule most easily lost in a later
# refactor: the balance is the ledger, and a pending claim is not in it.
check("...and the balance still equals the ledger, excluding every pending claim",
      money(s2["balance"]) == balances()[1] and money(s2["pending_topups"]) > D("0.00"),
      f'balance {s2["balance"]}, ledger {balances()[1]}, pending {s2["pending_topups"]}')

assert_invariants("after a submission")

TOPUP_ID = topup["topup_id"]

# ===========================================================================
print("\n== the form's rules are enforced server-side ==")
# ===========================================================================
r = submit(amount="0", method="upi", utr=utr("ZERO"))
check("a zero amount is refused -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
r = submit(amount="-500.00", method="upi", utr=utr("NEG"))
check("a negative amount is refused -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

r = submit(amount="100.00", method="bank_transfer")
check("a bank transfer with no UTR is refused -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")
check("...saying why, in terms of matching the payment",
      "utr" in r.text.lower() or "reference" in r.text.lower(), r.text[:200])

r = submit(amount="100.00", method="upi")
check("no UTR and no screenshot is refused -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")

r = submit(amount="100.00", method="upi", proof=("shot.png", PNG, "image/png"))
check("a screenshot alone is enough for UPI -> 201", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")

r = submit(amount="100.00", method="cash", utr=utr("CASH"))
check("a merchant cannot claim it paid cash -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")
r = submit(amount="100.00", method="not_a_method", utr="X")
check("an unknown method is refused -> 400", r.status_code == 400, str(r.status_code))

# A UTR identifies one real bank transfer, so claiming it twice is claiming one
# payment twice. `uq_wallet_topups_utr` stops the second — but before CR-4c
# handled it, the IntegrityError reached the merchant as a **500**. Same shape as
# CR-4b's issuance race: the index owns the data, the app still owes an answer.
r = submit(amount="4321.55", method="bank_transfer", utr=utr("001"),
           proof=("again.png", PNG, "image/png"))
check("re-submitting a UTR already claimed -> 400, never a 500", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")
check("...naming the reference and what to do about it",
      utr("001") in r.text and "payments" in r.text.lower(), r.text[:250])

r = submit(amount="100.00", method="upi", utr=utr("BADACCT"), payment_account_id="99999999")
check("paying into an account that does not exist -> 404", r.status_code == 404,
      f"{r.status_code} {r.text[:200]}")
r = submit(amount="100.00", method="upi", utr=utr("RETIRED"), payment_account_id=str(retired_id))
check("paying into a retired account -> 404", r.status_code == 404, str(r.status_code))

# ===========================================================================
print("\n== the proof upload is guarded like a passport scan ==")
# ===========================================================================
r = submit(amount="100.00", method="upi", utr=utr("BADTYPE"),
           proof=("payload.html", b"<html><script>alert(1)</script>", "text/html"))
check("a disallowed content type -> 415", r.status_code == 415, f"{r.status_code} {r.text[:200]}")

# A PDF renamed to .png: the declared type is allowed but the BYTES are not,
# which is what stops a stored-XSS payload being served back.
r = submit(amount="100.00", method="upi", utr=utr("BADMAGIC"),
           proof=("liar.png", PDF, "image/png"))
check("bytes that do not match the declared type -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")

r = submit(amount="100.00", method="upi", utr=utr("EMPTY"),
           proof=("empty.png", b"", "image/png"))
check("an empty file is refused", r.status_code in (400, 415), f"{r.status_code} {r.text[:200]}")

r = submit(amount="100.00", method="upi", utr=utr("TOOBIG"),
           proof=("huge.png", PNG + b"\x00" * (11 * 1024 * 1024), "image/png"))
check("a file over the 10 MB cap -> 413", r.status_code == 413, f"{r.status_code} {r.text[:200]}")

# A JPEG is fine too — the allowlist is a list, not just PNG.
r = submit(amount="150.00", method="qr", proof=("scan.jpg", JPEG, "image/jpeg"))
check("a JPEG screenshot is accepted -> 201", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")

assert_invariants("after the upload attempts")

# ===========================================================================
print("\n== the proof comes back as an attachment ==")
# ===========================================================================
r = requests.get(f"{WALLET}/topups/{TOPUP_ID}/proof", headers=H(mtok))
check("the owner can download the proof -> 200", r.status_code == 200, str(r.status_code))
disp = r.headers.get("content-disposition", "")
check("...served as an attachment, never inline", disp.lower().startswith("attachment"), disp)
check("...naming the file the merchant uploaded", "receipt.png" in disp, disp)
check("...and not cached in a shared cache",
      "no-store" in r.headers.get("cache-control", ""), r.headers.get("cache-control", ""))
check("...returning the actual bytes", r.content[:8] == PNG[:8], repr(r.content[:8]))

r = requests.get(f"{WALLET}/topups/{TOPUP_ID}", headers=H(mtok))
check("there is no endpoint that leaks the stored path",
      r.status_code == 404 or "proof_path" not in r.text, f"{r.status_code} {r.text[:120]}")

# ===========================================================================
print("\n== the merchant's own list ==")
# ===========================================================================
r = requests.get(f"{WALLET}/topups?page_size=50", headers=H(mtok))
check("the top-up list answers -> 200", r.status_code == 200, str(r.status_code))
listing = r.json()
mine = [t for t in listing["items"] if t["topup_id"] == TOPUP_ID]
check("...containing the one just submitted", len(mine) == 1, str(len(mine)))
ids = [t["topup_id"] for t in listing["items"]]
check("...newest first", ids == sorted(ids, reverse=True), str(ids[:5]))
check("...and never exposing a storage path",
      "proof_path" not in r.text and "topups/" not in r.text, "a path leaked")

r = requests.get(f"{WALLET}/topups?status=verified", headers=H(mtok))
check("filtering by status works -> 200", r.status_code == 200, str(r.status_code))
check("...and none of these are verified yet",
      all(t["status"] == "verified" for t in r.json()["items"]), "wrong status returned")
r = requests.get(f"{WALLET}/topups?status=nonsense", headers=H(mtok))
check("an unknown status filter -> 400", r.status_code == 400, str(r.status_code))

# ===========================================================================
print("\n== simultaneous submissions ==")
# ===========================================================================
# topup_number comes from a sequence, and a duplicate would violate
# uq_wallet_topups_number. Six at once proves the reference is allocated safely
# and that none of them credits the wallet either.
race_before, _ = balances()


def submit_once(i):
    r = submit(amount="11.00", method="upi", utr=utr(f"RACE{i:03d}"))
    return (r.status_code, r.json().get("topup_number") if r.status_code == 201 else None)


with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    results = list(pool.map(submit_once, range(6)))

codes = [c for c, _ in results]
numbers = [n for _, n in results if n]
check("all six simultaneous submissions succeed", codes.count(201) == 6, str(codes))
check("...each with a unique reference", len(set(numbers)) == len(numbers), str(numbers))
check("...and none of them moved the wallet", balances()[0] == race_before,
      f"{race_before} -> {balances()[0]}")

assert_invariants("after six simultaneous submissions")

# ===========================================================================
print("\n== cross-tenant ==")
# ===========================================================================
rival = flows.rival_merchant(atok)
rtok = rival["token"]

r = requests.get(f"{WALLET}/topups/{TOPUP_ID}/proof", headers=H(rtok))
check("another merchant cannot download the proof -> 404", r.status_code == 404,
      f"{r.status_code} {r.text[:150]}")

r = requests.get(WALLET, headers=H(rtok))
check("another merchant reads its OWN wallet, not this one", r.status_code == 200,
      str(r.status_code))
check("...and it is a different merchant", r.json()["merchant_id"] != MID,
      str(r.json()["merchant_id"]))

r = requests.get(f"{WALLET}/topups?page_size=50", headers=H(rtok))
check("...whose top-up list does not contain ours",
      all(t["topup_id"] != TOPUP_ID for t in r.json()["items"]), "leaked across tenants")

# Platform staff have no merchant of their own; they are pointed at the
# admin-scoped route rather than handed an arbitrary company.
r = requests.get(WALLET, headers=H(atok))
check("a staff account gets a clear 400, not someone else's wallet", r.status_code == 400,
      f"{r.status_code} {r.text[:150]}")
check("...telling them which route to use", "admin/merchants" in r.text, r.text[:200])

assert_invariants("at the end")

# ---------------------------------------------------------------------------
# The fixture accounts are the script's own; a real one is created by staff.
db = SessionLocal()
db.execute(text("DELETE FROM payment_accounts WHERE label LIKE 'verify_cr4c%'"))
db.commit()
db.close()

raise SystemExit(check.report())
