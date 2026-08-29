"""M9 — the checks that guard the suite itself, and the migration path.

NO SERVER NEEDED. Everything here is about the repository and the schema.

WHY A MILESTONE NEEDS TESTS ABOUT ITS OWN TESTS
M9 found three milestones — M6, M7 and M8 — with complete, passing verification
scripts that **`run_all.py` did not list**. Every one of them was green and none
of them ran. A regression suite that silently omits a third of itself is worse
than a smaller honest one, because the summary line says "all passed".

So the first section asserts the thing that failure would have shown: every
`verify_*.py` on disk is registered in the suite. It is cheap, and it is the
only check here that would have caught a real, already-shipped mistake.

THE MIGRATION PATH, MEASURED
`docs/BOOKING_OPS_MILESTONES.md` M9 asks for a clean migration from empty to
head, and M10 for up *and* down exercised. Both were run for real against a
throwaway database (`jpw_m9_clean`, created and dropped):

* **empty -> head: clean**, all 37 migrations.
* **head -> 0023 -> head: clean**, all 14 modern migrations, twice.
* **head -> base: FAILS at 0022**, which references `partner_users` — a legacy
  table `0023_nine_table_redesign` drops and does not restore. Recorded as a
  known limitation rather than fixed: rolling back below 0023 would destroy the
  entire current schema, so it is not a path anybody can take in production, and
  "fixing" it would mean writing a restore for a 43-table design that no longer
  exists.

Those runs are not repeated here — creating and dropping databases inside the
regression suite is not something a suite should do on someone's machine. What
*is* asserted is everything about the migration set that can be checked cheaply
and that would break the same paths: a single head, no gaps, and a docstring on
every revision explaining why it exists.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

from alembic.config import Config as AlembicConfig  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

from config import Checker  # noqa: E402

check = Checker()

VERSIONS = BACKEND / "alembic" / "versions"


# ===========================================================================
print("\n== the suite lists every script it has ==")
# ===========================================================================
on_disk = {p.name for p in HERE.glob("verify_*.py")}
registered = set(re.findall(r'\("(verify_[a-z0-9_]+\.py)"', (HERE / "run_all.py").read_text(encoding="utf-8")))

missing = sorted(on_disk - registered)
check(
    f"every verify_*.py on disk is registered in run_all.py ({len(on_disk)} scripts)",
    not missing,
    "NOT IN THE SUITE, so it never runs: " + ", ".join(missing),
)

phantom = sorted(registered - on_disk)
check("...and every registered script exists", not phantom, "listed but absent: " + ", ".join(phantom))

check("the suite is not trivially small", len(registered) >= 18, f"{len(registered)} scripts")

# M8 exhausts the auth rate limit deliberately; anything after it fails on login.
order = re.findall(r'\("(verify_[a-z0-9_]+\.py)"', (HERE / "run_all.py").read_text(encoding="utf-8"))
check("verify_m8.py runs last — it burns the auth rate-limit budget on purpose",
      order[-1] == "verify_m8.py", f"last is {order[-1]}")


# ===========================================================================
print("\n== the migration set ==")
# ===========================================================================
# ASKED OF ALEMBIC, NOT OF A REGEX. This block used to pull `down_revision`
# out of every file with one pattern that matched a quoted id or None and
# nothing else — so a MERGE migration, whose down_revision is a *tuple* of the
# two revisions it rejoins, parsed as having no parent at all. 0057 then
# counted as a second base, the two revisions it merges counted as heads
# because nothing claimed them, and the linear walk stopped dead at the first
# legitimate branchpoint. Three heads and two bases, reported against a chain
# `alembic heads` calls single-headed. A merge point is this project’s
# convention for rejoining a fork, so the parser has to understand one — and
# the safest parser is the one that runs `alembic upgrade head` on deploy.
_cfg = AlembicConfig()
_cfg.set_main_option("script_location", str(VERSIONS.parent))
script = ScriptDirectory.from_config(_cfg)

heads = set(script.get_heads())
check("there is exactly one head — no accidental branch", len(heads) == 1, str(sorted(heads)))

bases = list(script.get_bases())
check("there is exactly one base", len(bases) == 1, str(bases))

# Everything alembic can actually reach walking base -> head. A migration on
# disk that is missing from this set is one nobody can apply: an orphan, or a
# down_revision naming an id that does not exist. Stronger than the old
# single-successor walk, which could not cross a branchpoint at all, and it
# resolves the ids instead of trusting how they are spelled.
reachable = {r.revision for r in script.walk_revisions("base", "heads")}
on_disk_revs = set()
for path in VERSIONS.glob("*.py"):
    rev = re.search(r'^revision:\s*str\s*=\s*["\']([^"\']+)', path.read_text(encoding="utf-8"), re.M)
    if rev:
        on_disk_revs.add(rev.group(1))

check(f"every migration declares a revision id ({len(on_disk_revs)} found)",
      len(on_disk_revs) >= 37, str(len(on_disk_revs)))
check("the revision graph reaches every migration on disk",
      reachable == on_disk_revs,
      f"unreachable: {sorted(on_disk_revs - reachable)} / not on disk: {sorted(reachable - on_disk_revs)}")

undocumented = []
for path in VERSIONS.glob("*.py"):
    source = path.read_text(encoding="utf-8")
    doc = re.match(r'\s*"""(.*?)"""', source, re.S)
    if not doc or len(doc.group(1).strip()) < 40:
        undocumented.append(path.name)
check("every migration carries a docstring explaining why it exists",
      not undocumented, "thin or missing: " + ", ".join(sorted(undocumented)[:5]))


# ===========================================================================
print("\n== the live database matches the migration head ==")
# ===========================================================================
db = SessionLocal()
applied = db.scalar(text("SELECT version_num FROM alembic_version"))
check("the database is at the migration head", applied in heads, f"{applied} vs head {heads}")

# The tables this programme added, all present. A missing one means a migration
# ran on a database it had already been applied to by hand.
for table in ("request_documents", "request_notes", "wallet_transactions",
              "wallet_topups", "payment_accounts"):
    check(f"{table} exists",
          db.scalar(text("SELECT to_regclass(:t) IS NOT NULL"), {"t": f"public.{table}"}))

# The guarantees the money path rests on, asserted at the schema level so a
# future migration cannot quietly drop one.
for index in ("uq_wallet_transactions_booking_debit", "uq_wallet_transactions_topup",
              "uq_wallet_topups_utr"):
    check(f"{index} is still enforced",
          db.scalar(text("SELECT count(*) FROM pg_indexes WHERE indexname=:i"), {"i": index}) == 1)

for constraint in ("ck_wallet_transactions_balance_math", "ck_wallet_transactions_one_direction"):
    check(f"{constraint} is still enforced",
          db.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname=:c"),
                    {"c": constraint}) == 1)

check("the wallet's non-negative constraint is still gone (CR-4a)",
      db.scalar(text("SELECT count(*) FROM pg_constraint "
                     "WHERE conname='ck_merchants_wallet_non_negative'")) == 0)


# ===========================================================================
print("\n== no money has drifted, platform-wide ==")
# ===========================================================================
drift = db.execute(text("""
    SELECT count(*) FROM merchants m WHERE m.wallet_balance <> COALESCE(
        (SELECT SUM(w.credit - w.debit) FROM wallet_transactions w
         WHERE w.merchant_id = m.merchant_id), 0)
""")).scalar()
check("every merchant's cached balance equals its ledger", drift == 0, f"{drift} drifted")

broken = db.execute(text("""
    SELECT count(*) FROM (
        SELECT balance_before, LAG(balance_after) OVER (PARTITION BY merchant_id ORDER BY txn_id) prev
        FROM wallet_transactions
    ) c WHERE prev IS NOT NULL AND balance_before <> prev
""")).scalar()
check("every balance chain is unbroken", broken == 0, f"{broken} rows")

for label, sql in [
    ("no booking is billed twice",
     "SELECT count(*) FROM (SELECT request_id FROM wallet_transactions "
     "WHERE txn_type='booking_debit' AND request_id IS NOT NULL "
     "GROUP BY request_id HAVING count(*)>1) x"),
    ("no top-up is credited twice",
     "SELECT count(*) FROM (SELECT topup_id FROM wallet_transactions "
     "WHERE topup_id IS NOT NULL GROUP BY topup_id HAVING count(*)>1) x"),
    ("no ledger row is both a debit and a credit",
     "SELECT count(*) FROM wallet_transactions WHERE debit > 0 AND credit > 0"),
    ("no ledger row moves nothing",
     "SELECT count(*) FROM wallet_transactions WHERE debit = 0 AND credit = 0"),
]:
    check(label, db.scalar(text(sql)) == 0, str(db.scalar(text(sql))))

db.close()

raise SystemExit(check.report())
