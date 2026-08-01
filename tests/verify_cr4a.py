"""CR-4a — the wallet ledger: schema, arithmetic, locking, backfill.

NO SERVER NEEDED, like verify_storage.py and verify_seed_race.py. CR-4a adds no
endpoint — it is a migration, a ledger table and the service that writes it — so
driving it over HTTP would only prove that a route which does not exist yet is
absent. The one endpoint whose *behaviour* CR-4a changes is the admin wallet
adjustment, and that is asserted over HTTP where it lives, in verify_m4.py.

WHAT THIS PROTECTS
1. The constraint that had to go is gone, and the constraints that replaced it
   are real database constraints rather than service-layer good intentions.
2. ``merchants.wallet_balance`` equals ``SUM(credit) - SUM(debit)`` — always,
   including after concurrent writes. A cached total that can drift from its
   ledger is the bug M4 exists to prevent, and CR-4 doubles the number of things
   that move the wallet.
3. The backfill lost nothing: every historical wallet movement has a ledger row.
4. Two simultaneous movements do not lose one. The pre-CR-4a implementation read
   the balance unlocked and would.

IT WORKS ON ITS OWN MERCHANT. A test that posted transactions against a real
merchant would leave permanent rows on a real ledger — the table is append-only
by design, so there is no tidy-up. The fixture merchant is created here, used,
and removed at the end.
"""
import os
import sys
import threading
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

from fastapi import HTTPException  # noqa: E402
from sqlalchemy import delete, func, select, text  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant, WalletTransaction, WalletTxnType  # noqa: E402
from app.services import wallet_service  # noqa: E402

from config import Checker  # noqa: E402  (after sys.path surgery)

check = Checker()

PREFIX = "CR4AV"
CODE = "CR4A-VERIFY"
EMAIL = "cr4a.verify@jackpotsworldtours.example"


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------
def _drop_fixture():
    db = SessionLocal()
    try:
        mid = db.scalar(select(Merchant.merchant_id).where(Merchant.merchant_code == CODE))
        if mid is not None:
            db.execute(delete(WalletTransaction).where(WalletTransaction.merchant_id == mid))
            db.execute(delete(Merchant).where(Merchant.merchant_id == mid))
            db.commit()
    finally:
        db.close()


def _make_fixture() -> int:
    db = SessionLocal()
    try:
        m = Merchant(
            merchant_code=CODE, merchant_name="CR-4a Verify",
            company_name="CR-4a Verification Co", email=EMAIL,
            reference_prefix=PREFIX, wallet_balance=D("0.00"), credit_limit=D("0.00"),
        )
        db.add(m)
        db.commit()
        return m.merchant_id
    finally:
        db.close()


def _balances(mid) -> tuple[D, D]:
    """(cached balance, ledger balance) — the pair that must never disagree."""
    db = SessionLocal()
    try:
        cached = wallet_service.q(
            db.scalar(select(Merchant.wallet_balance).where(Merchant.merchant_id == mid))
        )
        return cached, wallet_service.ledger_balance(db, mid)
    finally:
        db.close()


def _post(mid, amount, **kw):
    db = SessionLocal()
    try:
        merchant = db.get(Merchant, mid)
        txn = wallet_service.post(db, merchant, amount=amount, commit=True, **kw)
        return txn
    finally:
        db.close()


# ===========================================================================
print("\n== schema ==")
# ===========================================================================
db = SessionLocal()

check(
    "ck_merchants_wallet_non_negative is gone",
    db.scalar(text(
        "SELECT count(*) FROM pg_constraint WHERE conname='ck_merchants_wallet_non_negative'"
    )) == 0,
)

for table in ("wallet_transactions", "wallet_topups", "payment_accounts"):
    check(
        f"{table} exists",
        db.scalar(text("SELECT to_regclass(:t) IS NOT NULL"), {"t": f"public.{table}"}),
    )

for constraint in (
    "ck_wallet_transactions_one_direction",
    "ck_wallet_transactions_balance_math",
    "ck_wallet_transactions_debit_non_negative",
    "ck_wallet_transactions_credit_non_negative",
):
    check(
        f"{constraint} is enforced by the database",
        db.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname=:c"),
                  {"c": constraint}) == 1,
    )

for index in (
    "uq_wallet_transactions_booking_debit",
    "uq_wallet_topups_utr",
    "ix_wallet_transactions_merchant",
    "ix_wallet_transactions_merchant_date",
    "ix_wallet_topups_queue",
):
    check(
        f"{index} exists",
        db.scalar(text("SELECT count(*) FROM pg_indexes WHERE indexname=:i"),
                  {"i": index}) == 1,
    )

for seq in ("seq_wallet_txn_number", "seq_wallet_topup_number"):
    check(
        f"{seq} exists",
        db.scalar(text("SELECT count(*) FROM pg_class WHERE relkind='S' AND relname=:s"),
                  {"s": seq}) == 1,
    )

# ===========================================================================
print("\n== backfill ==")
# ===========================================================================
# Every wallet movement ever made went through finance_service.adjust_wallet,
# which always wrote a payments row carrying discount_meta->>'wallet_direction'.
# That set is the whole history, so it is exactly what the ledger must cover.
legacy = db.scalar(text(
    "SELECT count(*) FROM payments WHERE discount_meta->>'wallet_direction' IS NOT NULL"
))
linked = db.scalar(text("""
    SELECT count(*) FROM payments p
    WHERE p.discount_meta->>'wallet_direction' IS NOT NULL
      AND EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.payment_id = p.payment_id)
"""))
check(
    f"every legacy wallet payment has a ledger row ({linked}/{legacy})",
    legacy == linked, f"{legacy} legacy rows, {linked} linked",
)

mismatched = db.execute(text("""
    SELECT p.payment_id, p.amount, p.discount_meta->>'wallet_direction', w.debit, w.credit
    FROM payments p JOIN wallet_transactions w ON w.payment_id = p.payment_id
    WHERE p.discount_meta->>'wallet_direction' IS NOT NULL
      AND ((p.discount_meta->>'wallet_direction' = 'credit' AND w.credit <> p.amount)
        OR (p.discount_meta->>'wallet_direction' = 'debit'  AND w.debit  <> p.amount))
""")).all()
check("...with the same amount and direction", not mismatched, str(mismatched[:3]))

drifted = db.execute(text("""
    SELECT m.merchant_id, m.company_name, m.wallet_balance,
           COALESCE((SELECT SUM(w.credit - w.debit) FROM wallet_transactions w
                     WHERE w.merchant_id = m.merchant_id), 0) AS ledger
    FROM merchants m
    WHERE m.wallet_balance <> COALESCE(
        (SELECT SUM(w.credit - w.debit) FROM wallet_transactions w
         WHERE w.merchant_id = m.merchant_id), 0)
""")).all()
check(
    "every merchant's cached balance equals its ledger",
    not drifted, "; ".join(f"{r[1]}: cached {r[2]} vs ledger {r[3]}" for r in drifted[:3]),
)

# The chain is what makes a statement readable line by line: each row's opening
# balance is the previous row's closing balance, per merchant, in order.
broken = db.execute(text("""
    SELECT txn_number, balance_before, prev_after FROM (
        SELECT txn_number, balance_before,
               LAG(balance_after) OVER (PARTITION BY merchant_id
                                        ORDER BY txn_id) AS prev_after
        FROM wallet_transactions
    ) chain
    WHERE prev_after IS NOT NULL AND balance_before <> prev_after
""")).all()
check("the balance chain is continuous for every merchant", not broken, str(broken[:3]))

db.close()

# ===========================================================================
print("\n== arithmetic ==")
# ===========================================================================
_drop_fixture()
MID = _make_fixture()

t1 = _post(MID, D("20000.00"), txn_type=WalletTxnType.WALLET_RECHARGE, reason="first top-up")
check("a credit is stored as a credit", t1.credit == D("20000.00") and t1.debit == D("0.00"),
      f"debit={t1.debit} credit={t1.credit}")
check("...opening at zero and closing at the amount",
      t1.balance_before == D("0.00") and t1.balance_after == D("20000.00"),
      f"{t1.balance_before} -> {t1.balance_after}")
check("...numbered from the sequence", t1.txn_number.startswith("WTX-"), t1.txn_number)

t2 = _post(MID, D("-15000.00"), txn_type=WalletTxnType.BOOKING_DEBIT, reason="booking")
check("a debit is stored as a debit", t2.debit == D("15000.00") and t2.credit == D("0.00"),
      f"debit={t2.debit} credit={t2.credit}")
check("...chained onto the previous closing balance",
      t2.balance_before == D("20000.00") and t2.balance_after == D("5000.00"),
      f"{t2.balance_before} -> {t2.balance_after}")

# The case the old constraint made illegal, and the reason CR-4 exists.
t3 = _post(MID, D("-20000.00"), txn_type=WalletTxnType.BOOKING_DEBIT, reason="over")
check("a debit may now take the wallet negative", t3.balance_after == D("-15000.00"),
      f"{t3.balance_before} -> {t3.balance_after}")

cached, ledger = _balances(MID)
check("the cached balance is negative too, not clamped", cached == D("-15000.00"), str(cached))
check("cached balance still equals the ledger", cached == ledger, f"{cached} vs {ledger}")

t4 = _post(MID, D("20000.00"), txn_type=WalletTxnType.WALLET_RECHARGE, reason="settle up")
check("a recharge lifts a negative balance back through zero",
      t4.balance_before == D("-15000.00") and t4.balance_after == D("5000.00"),
      f"{t4.balance_before} -> {t4.balance_after}")

check("paise survive the round trip",
      _post(MID, D("0.50"), txn_type=WalletTxnType.CREDIT_NOTE,
            reason="paise").balance_after == D("5000.50"))

try:
    _post(MID, D("0"), txn_type=WalletTxnType.MANUAL_ADJUSTMENT, reason="nothing")
    check("a zero transaction is refused", False, "it was accepted")
except HTTPException as exc:
    check("a zero transaction is refused", exc.status_code == 400, str(exc.detail)[:120])

# ===========================================================================
print("\n== the database refuses a malformed row ==")
# ===========================================================================
def _raw_insert(**cols):
    """Bypass the service deliberately — these assert the *database* refuses."""
    db = SessionLocal()
    try:
        db.add(WalletTransaction(merchant_id=MID, txn_type=WalletTxnType.MANUAL_ADJUSTMENT, **cols))
        db.commit()
        return None
    except IntegrityError as exc:
        db.rollback()
        return str(exc.orig)
    finally:
        db.close()


err = _raw_insert(txn_number="WTX-BAD-1", debit=D("10"), credit=D("10"),
                  balance_before=D("0"), balance_after=D("0"))
check("a row that is both a debit and a credit is refused",
      err is not None and "one_direction" in err, str(err)[:120])

err = _raw_insert(txn_number="WTX-BAD-2", debit=D("0"), credit=D("0"),
                  balance_before=D("0"), balance_after=D("0"))
check("a row that moves nothing is refused",
      err is not None and "one_direction" in err, str(err)[:120])

err = _raw_insert(txn_number="WTX-BAD-3", debit=D("0"), credit=D("100"),
                  balance_before=D("0"), balance_after=D("999"))
check("a row whose arithmetic does not add up is refused",
      err is not None and "balance_math" in err, str(err)[:120])

# ===========================================================================
print("\n== booking debits are idempotent ==")
# ===========================================================================
# CR-4b bills a booking when it reaches Ticket Issued. A replayed transition must
# not bill twice, and that guarantee belongs in the schema.
db = SessionLocal()
some_request = db.scalar(text("SELECT request_id FROM service_requests ORDER BY request_id LIMIT 1"))
db.close()

if some_request is None:
    check("SKIP: no service_requests row to test the idempotency index against", True)
else:
    first = _post(MID, D("-100.00"), txn_type=WalletTxnType.BOOKING_DEBIT,
                  request_id=some_request, reason="first billing")
    check("a booking debit records its request", first.request_id == some_request)
    try:
        _post(MID, D("-100.00"), txn_type=WalletTxnType.BOOKING_DEBIT,
              request_id=some_request, reason="replayed billing")
        check("a second booking debit for the same booking is refused", False, "it was accepted")
    except IntegrityError as exc:
        check("a second booking debit for the same booking is refused",
              "booking_debit" in str(exc.orig), str(exc.orig)[:120])

    # The index is partial on purpose: other types may reference the same booking.
    other = _post(MID, D("50.00"), txn_type=WalletTxnType.REFUND_CREDIT,
                  request_id=some_request, reason="refund on the same booking")
    check("...but another transaction type against that booking is allowed",
          other.request_id == some_request)

# ===========================================================================
print("\n== credit limit ==")
# ===========================================================================
db = SessionLocal()
m = db.get(Merchant, MID)
check("no limit configured means unlimited, not zero",
      wallet_service.has_credit_limit(m) is False
      and wallet_service.available_credit(m) is None,
      f"limit={m.credit_limit}")
db.close()

# Flatten the balance to zero first, so the limit arithmetic below is readable
# and does not depend on what the sections above happened to leave behind.
standing = _balances(MID)[0]
if standing != D("0.00"):
    _post(MID, -standing, txn_type=WalletTxnType.MANUAL_ADJUSTMENT,
          reason="reset to zero for the credit-limit fixture", enforce_limit=False)
check("the fixture starts the limit tests at zero", _balances(MID)[0] == D("0.00"),
      str(_balances(MID)[0]))

db = SessionLocal()
m = db.get(Merchant, MID)
m.credit_limit = D("1000.00")
db.commit()
check("available credit is the limit plus the (signed) balance",
      wallet_service.available_credit(m) == D("1000.00"),
      f"balance {m.wallet_balance}, limit {m.credit_limit}")
db.close()

try:
    _post(MID, D("-1000.01"), txn_type=WalletTxnType.BOOKING_DEBIT, reason="one paisa too far")
    check("a debit past the credit limit is refused", False, "it was accepted")
except HTTPException as exc:
    detail = str(exc.detail)
    check("a debit past the credit limit is refused", exc.status_code == 400, detail[:150])
    check("...and the message names the shortfall and the way out",
          "0.01" in detail and "credit limit" in detail.lower(), detail[:250])

ok = _post(MID, D("-1000.00"), txn_type=WalletTxnType.BOOKING_DEBIT, reason="exactly to the limit")
check("a debit exactly to the limit is allowed", ok.balance_after == D("-1000.00"),
      f"{ok.balance_before} -> {ok.balance_after}")

# Billing something already bought is an accounting entry, not a decision.
past = _post(MID, D("-5000.00"), txn_type=WalletTxnType.BOOKING_DEBIT,
             reason="already ticketed", enforce_limit=False)
check("a debit that has already happened is recorded even past the limit",
      past.balance_after == D("-6000.00"), str(past.balance_after))

check("a credit is never blocked by the credit limit",
      _post(MID, D("6000.00"), txn_type=WalletTxnType.WALLET_RECHARGE,
            reason="settle").balance_after == D("0.00"),
      "a merchant over its limit must always be able to pay")

cached, ledger = _balances(MID)
check("cached balance still equals the ledger after the limit tests",
      cached == ledger, f"{cached} vs {ledger}")

# ===========================================================================
print("\n== concurrency ==")
# ===========================================================================
# The pre-CR-4a implementation read merchant.wallet_balance off whatever the
# session had loaded and wrote back the sum, unlocked. Eight simultaneous
# movements would then land as fewer than eight.
db = SessionLocal()
m = db.get(Merchant, MID)
m.credit_limit = D("0.00")           # unlimited, so the limit is not what is under test
db.commit()
db.close()

WORKERS = 8
PER_WORKER = D("1000.00")
before_cached, _ = _balances(MID)
errors: list[str] = []
barrier = threading.Barrier(WORKERS)


def _worker(n):
    try:
        barrier.wait(timeout=20)
        _post(MID, PER_WORKER, txn_type=WalletTxnType.WALLET_RECHARGE,
              reason=f"concurrent top-up {n}")
    except Exception as exc:                      # noqa: BLE001 — recorded, then asserted on
        errors.append(f"{type(exc).__name__}: {exc}")


threads = [threading.Thread(target=_worker, args=(n,)) for n in range(WORKERS)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check(f"{WORKERS} simultaneous wallet movements all succeed", not errors, "; ".join(errors[:3]))

after_cached, after_ledger = _balances(MID)
check(f"all {WORKERS} landed — none lost to a race",
      after_cached - before_cached == PER_WORKER * WORKERS,
      f"{before_cached} -> {after_cached}, expected +{PER_WORKER * WORKERS}")
check("cached balance still equals the ledger after concurrent writes",
      after_cached == after_ledger, f"{after_cached} vs {after_ledger}")

db = SessionLocal()
broken = db.execute(text("""
    SELECT txn_number FROM (
        SELECT txn_number, balance_before,
               LAG(balance_after) OVER (ORDER BY txn_id) AS prev_after
        FROM wallet_transactions WHERE merchant_id = :m
    ) chain
    WHERE prev_after IS NOT NULL AND balance_before <> prev_after
"""), {"m": MID}).all()
check("the balance chain survived the concurrent writes intact", not broken, str(broken[:3]))

numbers = db.scalars(
    select(WalletTransaction.txn_number).where(WalletTransaction.merchant_id == MID)
).all()
check("every transaction number is unique", len(numbers) == len(set(numbers)),
      f"{len(numbers)} rows, {len(set(numbers))} distinct")
db.close()

# ===========================================================================
print("\n== a ledger outlives a tidy-up ==")
# ===========================================================================
db = SessionLocal()
try:
    db.execute(delete(Merchant).where(Merchant.merchant_id == MID))
    db.commit()
    check("deleting a merchant that still has a ledger is refused", False, "it was deleted")
except IntegrityError as exc:
    db.rollback()
    check("deleting a merchant that still has a ledger is refused",
          "wallet_transactions" in str(exc.orig), str(exc.orig)[:120])
finally:
    db.close()

_drop_fixture()
db = SessionLocal()
check("the fixture merchant is gone once its ledger is",
      db.scalar(select(func.count()).select_from(Merchant).where(Merchant.merchant_code == CODE)) == 0)
db.close()

raise SystemExit(check.report())
