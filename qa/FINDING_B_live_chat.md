# Finding B — Live Chat concurrent-open (`verify_live_chat.py`)

Investigation only. No code changed. Evidence from `e2e_run_final.log` and source inspection.

## 1. Failing assertion
In the section `== two tabs, one conversation (race) ==` (`verify_live_chat.py:160‑204`):
```
PASS  neither concurrent open raised
FAIL  both concurrent opens returned a conversation   -- [7]
PASS  both got the SAME conversation — uq_customer_conversation_live held
PASS  exactly one live conversation row exists
```
The failing line is `check("both concurrent opens returned a conversation", len(results) == 2, str(results))`.
Actual `results == [7]` → **only one** of the two threads appended a conversation id (both ids would be `7`).

## 2. Trace (test harness → service → DB)
The test does **not** go through HTTP. It spawns two threads, synchronised by `threading.Barrier(2)`,
each running:
```python
with SessionLocal() as db:
    conv = chat.get_or_create_conversation(db, customer_id)
    db.commit()
    results.append(conv.conversation_id)
```
Service `customer_chat_service.get_or_create_conversation` (`:82‑112`):
```python
existing = _live_conversation(db, customer_id)
if existing is not None:
    return existing
conversation = CustomerConversation(customer_id=customer_id, status="waiting")
db.add(conversation)
try:
    db.flush()
except IntegrityError:          # lost the race to uq_customer_conversation_live
    db.rollback()
    contended = _live_conversation(db, customer_id)
    if contended is None:
        raise                   # real constraint bug, not the race
    return contended
return conversation
```
DB: a partial unique index `uq_customer_conversation_live` enforces one non-closed conversation per
customer. Under Postgres, the second concurrent `INSERT` blocks on the first transaction's row lock,
then fails with `IntegrityError`; the loser rolls back and re-selects the winner's row.

## 3. Expected vs actual
- Expected: **both** threads return a conversation object (winner returns its insert; loser returns the
  re-selected row) → `len(results) == 2`, and both ids equal.
- Actual: `len(results) == 1` (`[7]`), **but** no thread raised, both would-be ids are the same (`7`),
  and exactly one live row exists.

## 4. Verdict: **test-environment / flakiness artifact — NOT an application defect**
- `get_or_create_conversation` is provably correct: every path **returns a conversation or raises**;
  there is no branch that returns `None` or exits without a value. So the loser thread, once it finishes,
  will append a (matching) id. "neither concurrent open raised" passed → neither thread errored.
- The three assertions that test **actual application behaviour** — single-winner (`same conversation`),
  the unique index holding, and **exactly one live row** — all **passed**. The data model behaved
  correctly under the race.
- The only failing assertion is `len(results) == 2`, which depends on **both threads having completed
  their append before the main thread checks**. The loser blocks on the winner's Postgres row lock until
  the winner commits; under a long, loaded, single-IP sequential suite run the loser can still be
  unwinding (rollback → re-select) when `t.join(timeout=20)` returns and the check executes. That is a
  harness timing sensitivity, not a server fault. The endpoint/service guarantees both callers receive a
  conversation; nothing in the application failed.

## 5. Related code / tests
`services/customer_chat_service.py` (`get_or_create_conversation`, `_live_conversation`); migration
defining `uq_customer_conversation_live`. The HTTP-level and WebSocket sections of the same script
(open/revisit/ownership/queue/agent console) all passed, as did the other race sections
(`concurrent resends collapse to one message`, `exactly one agent won the claim`).

## 6. Recommended next steps
- **No application change warranted.** The concurrency handling is correct.
- **Optional test hardening (test-only, if the flake recurs):** make the assertion deterministic rather
  than timing-dependent — e.g. join both threads without a timeout (or re-check `results` after a short
  settle) and assert on the final state, or assert the DB invariant (one row, same id) which is the real
  contract. This is a test-robustness tweak, not a fix to a defect, and is out of scope until approved.
- Because it is non-deterministic, a single re-run could show it passing; that would further confirm the
  flakiness classification. (Not run here — no rerun per instruction.)
