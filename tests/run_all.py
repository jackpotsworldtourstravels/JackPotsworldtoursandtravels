"""Run the whole verification suite, in order, against a live backend.

    python tests/run_all.py

Order matters: the broad API sweep runs first because a failure there explains
most milestone failures downstream, and a milestone script is only meaningful
once the surface it builds on is known good.

Each script is a separate process. One failing script does **not** stop the run —
a partial picture of what broke is more useful than the first error, and the
exit code is non-zero if any script failed.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

#: (filename, what it covers). Add a milestone's script here when it lands.
#: ASCII only — the Windows console this is run on renders an em dash as a
#: replacement character, which makes the section headers unreadable.
SUITE = [
    # First because it needs no server: if the storage layer under the document
    # endpoints is broken, every document failure downstream is a symptom.
    ("verify_storage.py", "Storage: local and S3 backends, key validation"),
    ("verify_storage_s3.py", "Storage: the S3 backend against real boto3 (needs moto)"),
    # Also serverless, and before the HTTP scripts: it tests the startup hook
    # that every one of those scripts needs to have already succeeded.
    ("verify_seed_race.py", "Startup: concurrent admin seeding across gunicorn workers"),
    # Also serverless — CR-4a is a migration, a ledger table and the service that
    # writes it, with no endpoint of its own. It runs before the HTTP scripts
    # because a wallet whose ledger does not reconcile explains every money
    # failure downstream.
    ("verify_cr4a.py", "CR-4a: wallet ledger, locking, credit limit, backfill"),
    # Also serverless. Runs early because it guards the suite itself: it fails
    # if any verify_*.py on disk is missing from this list, which is how M6, M7
    # and M8 sat green and unrun. It also asserts the schema guarantees the
    # money paths rest on, so a dropped index is caught before anything spends.
    ("verify_m9.py", "M9: suite completeness, migration chain, schema guarantees, no money drift"),
    ("verify_api.py", "Phases 1-3: enquiry, booking, documents, admin verification"),
    ("verify_m1.py", "M1: queue, assignment, references, internal notes"),
    ("verify_m1_concurrency.py", "M1: simultaneous assignment and note writes"),
    ("verify_m2.py", "M2: ticket upload, invoice/confirmation PDFs, delivery"),
    ("verify_m3.py", "M3: cancellation & reschedule, money bounds, cross-tenant, concurrency"),
    # After M3: it builds on the same change requests and asserts the stage that
    # now sits in front of every one of them.
    ("verify_manager_approval.py", "Manager approval: the merchant's sign-off before ours"),
    ("verify_m4.py", "M4: ledger arithmetic, wallet, credit limit, refunds, payment concurrency"),
    ("verify_cr5.py", "CR-5: binding quotation on the enquiry answer, form rules, credit gates"),
    ("verify_cr2.py", "CR-2: manager approval, payment bypass, ticket delivery, RBAC, concurrency"),
    # Directly after CR-2, because it changes where the track CR-2 defines
    # STOPS: issuance now ends at Ticket Issued and Completed arrives on a timer
    # once the journey is behind us. It runs before the analytics and history
    # scripts, which read the status counts this decides.
    ("verify_booking_completion.py",
     "Completion: Ticket Issued is not Completed, the travel-date sweep, no manual completion"),
    # Straight after CR-2 and CR-5, because it is the second way onto the track
    # those two define: a booking raised with no enquiry in front of it. It
    # fails for a different reason than either of them — the completeness rules
    # and the Manager queue now key off a track marker rather than a parent row,
    # and a direct booking has no parent at all.
    ("verify_direct_booking.py",
     "Book Directly: unquoted booking, inherited validators, submit rules, manager queue, fare at issuance"),
    # Immediately after it, because it builds its fixtures with direct bookings.
    # Mostly a tenant-isolation script: the lookup answers a guessable key with
    # a named person's date of birth, so "scoped to the caller's merchant" is
    # the whole endpoint and is asserted against a second real merchant.
    ("verify_passenger_lookup.py",
     "Passenger auto-fill: passport lookup, newest record wins, writes nothing, cross-tenant scope"),
    ("verify_cr3.py", "CR-3: merchant approves its own bookings, scoping, self-approval, concurrency"),
    ("verify_cr4b.py", "CR-4b: wallet debit at Ticket Issued, credit limit, refunds, credit notes"),
    ("verify_cr4c.py", "CR-4c: merchant wallet screen, ledger, top-ups, payment accounts, proofs"),
    ("verify_m5.py", "M5: email + in-app delivery, opt-out, msg_logs status, failure surfacing"),
    ("verify_cr4d.py", "CR-4d: payment accounts, top-up verification, wallet credit, reconciliation"),
    # Immediately after CR-4d: it reuses that desk's approve/reject endpoints
    # for the other direction (0041), so a failure there explains a failure here.
    ("verify_payment_requests.py",
     "Payment requests: admin-initiated bank/cash/crypto, settlement, approval credits once"),
    # Last of the money-and-workflow scripts: M6 re-derives their figures from
    # its own SQL, so it is only meaningful once they are known good.
    ("verify_m6.py", "M6: analytics against direct SQL, export/summary parity, ops metrics, scope"),
    ("verify_m7.py", "M7: booking history filters/pagination/search, downloads, staff-only absence, cross-tenant"),
    # After the document scripts: the Support Center reuses document_service's
    # upload path, so a failure there explains an attachment failure here.
    ("verify_support_center.py",
     "Support Center: categories, priority, attachments, search, receipts, notes, triage, reopen"),
    # After every screen it probes. This one asserts that a Manager and a Data
    # Operator get the SAME answer from all of them, so it can only be read as
    # "the portal is one UI" once each of those endpoints is independently known
    # good — otherwise a matched pair of failures would pass as parity.
    ("verify_merchant_ui_parity.py",
     "Merchant Portal: one UI for every role — read floor, action-only sub-roles, screen parity"),
    # After the booking scripts: this issues real tickets to build its totals,
    # so a broken issuance path explains a provider failure rather than the
    # other way round.
    ("verify_providers.py",
     "Providers: codes, people, derived totals, issuance attribution, exports, no-login guarantee"),
    # The only script that opens a browser, and the only one asserting anything
    # about layout. It signs in three times, so it sits after the API scripts
    # (their failures explain its failures, never the reverse) and before M8,
    # which spends what is left of the rate-limit budget. Skips with exit 0
    # when Playwright or a served frontend is absent.
    ("verify_responsive.py",
     "Responsive: every portal screen at phone sizes - no sideways scroll, no iOS-zoom inputs"),
    # LAST, always. Section 9 exhausts the auth rate-limit budget on purpose,
    # so any script running after it would fail on login rather than on its
    # own subject — the failure would look like a regression and would not be one.
    ("verify_m8.py", "M8: headers, uploads, sessions, cross-tenant probe, EXPLAIN, rate limits"),
]


def main() -> int:
    results = []
    for script, description in SUITE:
        path = os.path.join(HERE, script)
        if not os.path.exists(path):
            print(f"\n!! {script} is listed in SUITE but does not exist — skipping")
            results.append((script, None))
            continue

        print(f"\n{'=' * 72}\n{script}  -  {description}\n{'=' * 72}")
        # Flushed, or this header is still sitting in the parent's buffer while
        # the child writes straight to the terminal — every banner then lands
        # at the end of the run, attached to the wrong script.
        sys.stdout.flush()
        code = subprocess.call([sys.executable, path], cwd=HERE)
        results.append((script, code))

    print(f"\n{'=' * 72}\nSUITE SUMMARY\n{'=' * 72}")
    failed = 0
    for script, code in results:
        if code is None:
            label = "MISSING"
        elif code == 0:
            label = "PASS"
        else:
            label = f"FAIL (exit {code})"
            failed += 1
        print(f"  {label:<16} {script}")

    print(f"\n{len(results) - failed}/{len(results)} scripts passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
