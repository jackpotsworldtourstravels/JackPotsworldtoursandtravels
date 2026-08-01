"""End-to-end demonstration of the whole payment workflow, on real endpoints.

    python tests/demo_payment_flow.py

Not a test — `verify_cr4a..d.py` are the tests. This drives one merchant through
every money event the platform has, in order, printing the wallet after each so
the arithmetic can be read down the page:

    admin configures where money is sent
      -> merchant claims a payment (moves nothing)
      -> admin verifies it            (wallet CREDITED)
      -> merchant books, manager approves, desk issues a ticket
                                      (wallet DEBITED, booking settled)
      -> merchant cancels             (wallet CREDITED, charge retained)
      -> admin posts a credit note    (wallet CREDITED)
      -> reconciliation proves the ledger and the balance still agree

It uses its own throwaway merchant so a demo run never moves a real balance.
"""
import sys
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, JPEG, MANAGER, MERCHANT, PDF, H, login  # noqa: E402

A = f"{BASE}/api/admin"
M = f"{BASE}/api/merchant"

atok = login(*ADMIN)
mtok = login(*MERCHANT)
gtok = login(*MANAGER)
MID = requests.get(f"{M}/wallet", headers=H(mtok)).json()["merchant_id"]
RUN = f"{int(__import__('time').time()) % 1_000_000:06d}"

WIDTH = 78
step_no = [0]


def rupees(v):
    """Indian grouping, from the API's decimal string — never parsed to a float."""
    s = str(v)
    neg = s.startswith("-")
    s = s.lstrip("-")
    whole, _, frac = s.partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        import re
        head = re.sub(r"\B(?=(\d{2})*(\d{3})$)", ",", head) if len(head) > 2 else head
        parts, rest = [], head
        while len(rest) > 2:
            parts.insert(0, rest[-2:]); rest = rest[:-2]
        if rest:
            parts.insert(0, rest)
        whole = ",".join(parts + [tail])
    return f"{'-' if neg else ''}Rs {whole}.{(frac or '00')[:2]}"


def wallet_state():
    db = SessionLocal()
    try:
        bal = db.scalar(select(Merchant.wallet_balance).where(Merchant.merchant_id == MID))
        ledger = db.scalar(text(
            "SELECT COALESCE(SUM(credit - debit),0) FROM wallet_transactions WHERE merchant_id=:m"
        ), {"m": MID})
        n = db.scalar(text(
            "SELECT count(*) FROM wallet_transactions WHERE merchant_id=:m"), {"m": MID})
        return D(str(bal)), D(str(ledger)), n
    finally:
        db.close()


def step(title, detail=""):
    step_no[0] += 1
    bal, ledger, n = wallet_state()
    agree = "OK" if bal == ledger else "*** DRIFT ***"
    print(f"\n{step_no[0]}. {title}")
    if detail:
        for line in detail.splitlines():
            print(f"     {line}")
    print(f"     {'-' * (WIDTH - 5)}")
    print(f"     wallet {rupees(bal):>18}   ledger {rupees(ledger):>18}   {agree}   ({n} txns)")


print("=" * WIDTH)
print("  JackPots World — payment workflow, end to end".center(WIDTH))
print("=" * WIDTH)
step("Starting position")

# --------------------------------------------------------------------------
r = requests.post(f"{A}/payment-accounts", headers=H(atok), json={
    "account_type": "bank", "label": f"Demo Bank {RUN}",
    "details": {"account_name": "JackPots World Tours", "account_number": "50200099887766",
                "ifsc": "HDFC0004321", "bank_name": "HDFC Bank", "branch": "Banjara Hills"}})
acct = r.json()["account_id"]
step("Admin publishes a bank account merchants can pay into",
     f"POST /api/admin/payment-accounts -> {r.status_code}\n"
     f"account #{acct}, active, now visible on the merchant's Add Money screen")

# --------------------------------------------------------------------------
utr = f"DEMO{RUN}"
r = requests.post(f"{M}/wallet/topups", headers=H(mtok),
                  files={"proof": ("neft.jpg", JPEG, "image/jpeg")},
                  data={"amount": "60000.00", "method": "bank_transfer",
                        "payment_account_id": str(acct), "utr": utr})
topup = r.json()
step("Merchant says it has sent Rs 60,000  — MOVES NO MONEY",
     f"POST /api/merchant/wallet/topups -> {r.status_code}   {topup['topup_number']}\n"
     f"UTR {utr}, screenshot attached, status '{topup['status']}'\n"
     f"the wallet is deliberately unchanged: a claim is not a credit")

# --------------------------------------------------------------------------
r = requests.post(f"{A}/wallet/topups/{topup['topup_id']}/verify", headers=H(atok),
                  json={"remarks": "Matched against the HDFC statement"})
v = r.json()
step("Admin verifies it  — WALLET CREDITED",
     f"POST /api/admin/wallet/topups/{{id}}/verify -> {r.status_code}\n"
     f"ledger entry {v['transaction_reference']}\n"
     f"{rupees(v['wallet_balance_before'])} + {rupees(topup['amount'])} = "
     f"{rupees(v['wallet_balance_after'])}")

# --------------------------------------------------------------------------
FARE = "24500.50"
booking = flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label=f"demo {RUN}")
requests.post(f"{BASE}/api/requests/{booking['id']}/documents", headers=H(atok),
              files={"file": ("eticket.pdf", PDF, "application/pdf")},
              data={"doc_type": "ticket"})
step("Merchant raises an enquiry-led booking; its manager approves it",
     f"{booking['request_number']} is Manager Approved and on the ops desk\n"
     "no money has moved — the fare is not known until the desk books it")

before_issue, _, _ = wallet_state()
r = requests.post(f"{BASE}{'/api'}/admin/requests/{booking['id']}/issue-ticket",
                  headers=H(atok), json={"fare_amount": FARE})
after_issue, _, _ = wallet_state()
billed = before_issue - after_issue

# What was actually billed, read back rather than assumed. It is NOT necessarily
# the fare_amount posted above: since CR-5 the enquiry answer is a binding
# quotation, so a quoted booking already carries an amount and
# `_capture_fare_for_wallet_billing` deliberately no-ops rather than overwriting
# what the merchant agreed to. Printing the figure we *sent* would have narrated
# a number the platform never charged.
quoted = D(str(requests.get(f"{BASE}/api/requests/{booking['id']}",
                            headers=H(atok)).json()["request"]["total_amount"]))
step(f"Desk issues the ticket  — WALLET DEBITED {rupees(billed)}",
     f"POST /api/admin/requests/{{id}}/issue-ticket -> {r.status_code}\n"
     f"booking total {rupees(quoted)} (the quotation the merchant accepted;\n"
     f"the posted fare_amount {rupees(FARE)} is ignored on an already-quoted\n"
     f"booking, which is CR-5 and CR-4b agreeing rather than fighting)\n"
     "the debit and the booking's settlement row are written in the same\n"
     "transaction, so the booking reads as settled and the debt lives\n"
     "in the wallet — one debt, one number")

# --------------------------------------------------------------------------
r = requests.post(f"{BASE}/api/bookings/{booking['id']}/cancellation", headers=H(mtok),
                  json={"reason": "Traveller cancelled"})
cr_id = r.json()["request"]["id"]
CHARGE = "3500.00"
before_cancel, _, _ = wallet_state()
r = requests.post(f"{A}/change-requests/{cr_id}/approve", headers=H(atok),
                  json={"cancellation_charge": CHARGE, "note": "Approved with charge"})
after_cancel, _, _ = wallet_state()
refunded = after_cancel - before_cancel
# Measured, not derived from the figures this script sent — the booking was
# billed its quotation, not the fare_amount posted above, so computing the
# refund from FARE would print a number that never moved.
step(f"Booking cancelled, {rupees(CHARGE)} charge retained  — WALLET CREDITED",
     f"POST /api/admin/change-requests/{{id}}/approve -> {r.status_code}\n"
     f"refunded {rupees(refunded)} of the {rupees(billed)} billed;\n"
     f"the {rupees(CHARGE)} charge stays debited — the merchant's net loss")

# --------------------------------------------------------------------------
r = requests.post(f"{A}/merchants/{MID}/wallet", headers=H(atok), json={
    "amount": "1500.00", "reason": "Goodwill for the delayed sector",
    "txn_type": "credit_note"})
step("Admin posts a credit note  — WALLET CREDITED",
     f"POST /api/admin/merchants/{{id}}/wallet -> {r.status_code}\n"
     f"ledger entry {r.json().get('transaction_reference')}, typed 'credit_note'\n"
     "not a refund: it reverses no particular payment, so it has its own type")

# --------------------------------------------------------------------------
print("\n" + "=" * WIDTH)
print("  The ledger, as both the merchant and the desk see it".center(WIDTH))
print("=" * WIDTH)
PAGE = 8
_total = requests.get(f"{A}/merchants/{MID}/wallet/transactions?page_size=1",
                      headers=H(atok)).json()["total"]
# The ledger is oldest-first, so the rows this run created are on the LAST page.
_last = max(1, -(-_total // PAGE))
rows = requests.get(
    f"{A}/merchants/{MID}/wallet/transactions?page_size={PAGE}&page={_last}",
    headers=H(atok)).json()
print(f"  {'reference':<24}{'type':<20}{'debit':>13}{'credit':>13}{'balance':>15}")
print("  " + "-" * (WIDTH - 4))
for t in rows["items"]:
    print(f"  {t['txn_number']:<24}{t['txn_type']:<20}"
          f"{(rupees(t['debit']) if D(t['debit']) else '-'):>13}"
          f"{(rupees(t['credit']) if D(t['credit']) else '-'):>13}"
          f"{rupees(t['balance_after']):>15}")

rec = requests.get(f"{A}/wallet/reconciliation", headers=H(atok)).json()
mine = next(m for m in rec["merchants"] if m["merchant_id"] == MID)
print("\n" + "=" * WIDTH)
print("  Reconciliation".center(WIDTH))
print("=" * WIDTH)
print(f"  wallet balance      {rupees(mine['wallet_balance']):>20}")
print(f"  recomputed ledger   {rupees(mine['ledger_balance']):>20}")
print(f"  drift               {rupees(mine['drift']):>20}   <- must be zero")
print(f"  outstanding         {rupees(mine['outstanding']):>20}")
print(f"  pending top-ups     {rupees(mine['pending_topup_amount']):>20}   "
      f"<- beside the balance, never inside it")
print(f"\n  platform-wide: {'RECONCILED' if rec['reconciled'] else 'DRIFT DETECTED'} "
      f"across {rec['merchant_count']} merchants "
      f"({rec['drifted_merchant_count']} drifted)")
print("=" * WIDTH)

raise SystemExit(0 if rec["reconciled"] and mine["drift"] == "0.00" else 1)
