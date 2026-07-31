# `tests/` — verification suite

End-to-end verification scripts that drive the **live API** over HTTP. They are the regression
suite referenced by `docs/BOOKING_OPS_MILESTONES.md` §4: every milestone adds one, and all of
them must still pass before that milestone can be submitted for approval.

These are not unit tests and they do not mock. They sign in through the real two-step OTP flow,
create real rows, and assert on real responses — which is the only thing that has actually
caught bugs in this project.

## Running

Start the backend first (it must be reachable at `JPW_BASE`, default `http://127.0.0.1:8000`),
then:

```bash
python tests/run_all.py
```

Or one script at a time:

```bash
python tests/verify_m1.py
```

Every script exits `0` on success and `1` if any check failed, so they compose in CI.

## Configuration

`config.py` holds the base URL and the four accounts the suite signs in as. Every value is
overridable from the environment, so a run against another database needs no edit to a tracked
file:

```bash
JPW_BASE=http://127.0.0.1:8001 python tests/run_all.py
```

Variables: `JPW_BASE`, and `JPW_{MERCHANT,ADMIN,ADMIN2,SUPER}_{EMAIL,PASSWORD}`.

The defaults are the **seeded development accounts** created by the alembic seed migrations on
a local database — not production credentials, and already reproducible from
`backend/alembic/versions/`. Never commit a real credential here; export it instead.

## What is here

| File | Purpose |
| --- | --- |
| `config.py` | base URL, accounts, file fixtures, `login`/`H`/`Checker` helpers |
| `minihttp.py` | stdlib HTTP client (incl. multipart) — the suite has no third-party dependency |
| `pdftext.py` | minimal PDF text extraction, so a generated PDF can be asserted on by content |
| `flows.py` | builds a booking at any requested stage via the real enquiry → booking → pay → issue path |
| `run_all.py` | runs every script in order and prints a summary |
| `verify_api.py` | Phases 1–3: enquiry, draft conversion, passenger identity, document upload/validation/verification, submit rules |
| `verify_m1.py` | M1: processing queue, operator assignment, external references, internal notes, staff-only boundary |
| `verify_m1_concurrency.py` | M1: 8 simultaneous assignments and 10 simultaneous notes |
| `verify_m2.py` | M2: staff e-ticket upload window, invoice and confirmation PDFs, merchant delivery, reissue |

## Writing a new milestone script

- **Build your own data.** Use `flows.make_booking(...)` rather than searching for a suitable
  row. A suite that only passes when the database happens to hold the right record is not a
  regression suite — an earlier version of `verify_m2.py` ticketed the only candidate booking
  and left the next run with nothing.
- **Assert the refusals, not just the happy path.** Most of the value in this suite is in the
  400/403/404/409 checks.
- **Assert on raw JSON for anything security-relevant** (e.g. internal notes being absent from
  a merchant response), never on what the UI happens to render.
- Add the script to `SUITE` in `run_all.py` and to the table in
  `docs/BOOKING_OPS_MILESTONES.md` §4.

## Note

There is still no `pytest` unit-test layer in this project. That remains a genuine follow-up —
these scripts verify behaviour end to end, but they need a running backend and a seeded
database, so they are not a substitute for fast isolated tests.
