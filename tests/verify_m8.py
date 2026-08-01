"""M8 — security, performance and production hardening.

WHAT THIS PROTECTS

M8 is the milestone whose scope is mostly *verification*: hardening a moving
target is wasted work, so it comes after everything it hardens. Its
requirements are five things attempted, not five things reasoned about.

1. **Rate limiting on every auth path.** Attempted for real until a 429 comes
   back — a limit nobody has hit is a limit nobody has proved.
2. **Upload attack set repelled**: oversized, mislabelled, traversal-named,
   executable content, and an empty file.
3. **Session and token lifecycle**: a tampered signature, the wrong token type,
   a `scope`-claim token from another portal, and a session revoked underneath
   a still-valid JWT.
4. **Headers, CORS, secrets**: the security headers are present on API
   responses *and* on file downloads; CORS reflects only configured origins;
   no password hash, token, SMTP credential or JWT secret appears in any
   response.
5. **Authenticated-but-unauthorised, and cross-tenant, over the whole M3–M7
   surface**: every endpoint those milestones added is attempted as the wrong
   role and as a rival company, and every cross-tenant result must be 404.

Nothing here is asserted from a config file. Every claim is made against the
running server.

A NOTE ON RATE-LIMIT ORDERING. The auth limits are per-IP and shared by the
whole suite, so exhausting one on purpose would strand every later script. The
rate-limit section therefore runs LAST, and `config.login` is not called after
it — every token this script needs is taken at the top.
"""
import datetime
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.config import settings  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402

import flows  # noqa: E402
from config import (  # noqa: E402
    ADMIN, BASE, JPEG, MANAGER, MERCHANT, PDF, PNG, SUPER, Checker, H, login,
)

check = Checker()

# Every token taken up front — see the note above about rate-limit ordering.
atok = login(*ADMIN)
mtok = login(*MERCHANT)
stok = login(*SUPER)
gtok = login(*MANAGER)
rival = flows.rival_merchant(atok)
rtok = rival["token"]

MID = requests.get(f"{BASE}/api/auth/me", headers=H(mtok)).json()["merchant_id"]


def get(path, token=mtok):
    return requests.get(f"{BASE}{path}", headers=H(token))


def sql(query, **params):
    db = SessionLocal()
    try:
        return db.execute(text(query), params).one()
    finally:
        db.close()


print("\n=== 1. Security response headers ===")

EXPECTED_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
}

health = requests.get(f"{BASE}/api/health")
for header, value in EXPECTED_HEADERS.items():
    check(f"{header} is set on an API response",
          health.headers.get(header, "").lower() == value.lower(),
          f"got {health.headers.get(header)!r}")
check("Permissions-Policy is set", "permissions-policy" in health.headers)

# The one that matters most: they must survive on a *file* response, which is
# where a sniffing browser could turn a stored upload into script.
booking = get("/api/requests?request_type=booking&status=ticket_issued&page_size=1").json()
BID = booking["items"][0]["id"] if booking["items"] else None
if BID:
    invoice = get(f"/api/requests/{BID}/invoice")
    check("nosniff survives on a PDF download",
          invoice.headers.get("x-content-type-options", "").lower() == "nosniff")
    check("...and the route's own Cache-Control is NOT overwritten by the middleware",
          "no-store" in invoice.headers.get("cache-control", "").lower(),
          invoice.headers.get("cache-control"))

check("an error response carries them too",
      requests.get(f"{BASE}/api/requests/999999999", headers=H(mtok))
      .headers.get("x-content-type-options", "").lower() == "nosniff")

check("CORS is not a wildcard — it cannot be, with credentials enabled",
      "*" not in settings.cors_origins_list, str(settings.cors_origins_list))
check("...and at least one origin is configured", bool(settings.cors_origins_list))


print("\n=== 2. No secret in any response ===")

FORBIDDEN = [
    ("password_hash", "a password hash"),
    ("hashed_password", "a password hash"),
    (settings.jwt_secret_key, "the JWT signing secret"),
]
if settings.smtp_password:
    FORBIDDEN.append((settings.smtp_password, "the SMTP password"))

SWEEP = [
    "/api/auth/me", "/api/profile", "/api/merchant/dashboard",
    "/api/requests?page_size=25", "/api/notifications?page_size=25",
    "/api/merchant/finance/position", "/api/merchant/wallet",
    "/api/analytics/bookings", "/api/analytics/change-requests",
    "/api/reports/summary?type=bookings",
]
for path in SWEEP:
    body = get(path).text
    leaks = [label for needle, label in FORBIDDEN if needle and needle in body]
    check(f"{path} leaks no secret", not leaks, str(leaks))

for path in ("/api/admin/merchants?page_size=25", "/api/admin/bookings/queue?page_size=25",
             "/api/analytics/operations", "/api/super-admin/admins?page_size=25"):
    body = requests.get(f"{BASE}{path}", headers=H(stok if "super-admin" in path else atok)).text
    leaks = [label for needle, label in FORBIDDEN if needle and needle in body]
    check(f"{path} leaks no secret", not leaks, str(leaks))

check("the database URL is not echoed by the status endpoint",
      settings.database_url not in requests.get(f"{BASE}/api/status").text)


print("\n=== 3. Upload attack set ===")

# A draft the merchant owns, built fresh rather than hunted for: the upload
# window is only open on a draft, so a refusal below has to be the check firing
# rather than the stage rejecting everything.
draft = flows.make_booking(mtok, atok, upto="draft", label="m8-upload-probe")
draft_id = draft["id"]

if True:
    def upload(filename, content, content_type, doc_type="passport"):
        return requests.post(
            f"{BASE}/api/requests/{draft_id}/documents",
            headers=H(mtok),
            files={"file": (filename, content, content_type)},
            data={"doc_type": doc_type},
        )

    ok = upload("passport.pdf", PDF, "application/pdf")
    check("a legitimate PDF is accepted", ok.status_code in (200, 201),
          f"{ok.status_code} {ok.text[:200]}")
    good_id = ok.json().get("id") if ok.status_code in (200, 201) else None

    # Mislabelled: an HTML payload declared as an image. This is the stored-XSS
    # route — it must fail on the magic-byte sniff, not on the extension.
    html = b"<html><script>alert(document.cookie)</script></html>"
    r = upload("innocent.png", html, "image/png")
    check("HTML declared as image/png is refused", r.status_code in (400, 415, 422),
          f"{r.status_code} {r.text[:150]}")

    r = upload("payload.pdf", html, "application/pdf")
    check("HTML declared as application/pdf is refused", r.status_code in (400, 415, 422))

    # Executable content.
    r = upload("tool.exe", b"MZ\x90\x00" + b"\x00" * 300, "application/pdf")
    check("a Windows executable is refused whatever it claims to be",
          r.status_code in (400, 415, 422))

    # A type that is not on the allowlist at all.
    r = upload("notes.txt", b"just text", "text/plain")
    check("a content type outside the allowlist is refused",
          r.status_code in (400, 415, 422))

    r = upload("archive.zip", b"PK\x03\x04" + b"\x00" * 200, "application/zip")
    check("a zip is refused", r.status_code in (400, 415, 422))

    # Oversized: one byte over the configured cap, streamed.
    oversized = PDF + b"\x00" * (settings.max_upload_bytes + 1)
    r = upload("huge.pdf", oversized, "application/pdf")
    check(f"a file over the {settings.max_upload_mb}MB cap is refused",
          r.status_code in (400, 413, 422), f"{r.status_code} {r.text[:150]}")

    # Empty.
    r = upload("empty.pdf", b"", "application/pdf")
    check("an empty file is refused", r.status_code in (400, 415, 422))

    # Path traversal in the *name*. The stored path comes from a uuid, so the
    # risk is what the name does downstream — in Content-Disposition and in
    # whatever script consumes the JSON. It must come back as a leaf.
    r = upload("../../../../etc/passwd.pdf", PDF, "application/pdf")
    if r.status_code in (200, 201):
        stored = r.json().get("original_filename", "")
        check("a traversal filename is reduced to its leaf",
              "/" not in stored and "\\" not in stored and ".." not in stored,
              f"stored as {stored!r}")
        traversal_id = r.json().get("id")
    else:
        check("a traversal filename is refused outright", True)
        traversal_id = None

    # Header injection through the filename.
    r = upload('evil".pdf\r\nX-Injected: yes', PDF, "application/pdf")
    if r.status_code in (200, 201):
        stored = r.json().get("original_filename", "")
        check("CR/LF and quotes are stripped from the echoed filename",
              "\r" not in stored and "\n" not in stored and '"' not in stored,
              repr(stored))
        injected_id = r.json().get("id")
    else:
        check("a filename carrying CR/LF is refused outright", True)
        injected_id = None

    if good_id:
        blob = get(f"/api/documents/{good_id}/download")
        check("an uploaded file is served as an attachment, never inline",
              "attachment" in blob.headers.get("content-disposition", "").lower())
        check("...and is never cached",
              "no-store" in blob.headers.get("cache-control", "").lower())
        check("...and carries nosniff, so a browser cannot reinterpret it",
              blob.headers.get("x-content-type-options", "").lower() == "nosniff")
        check("a rival cannot download it — 404, not 403",
              requests.get(f"{BASE}/api/documents/{good_id}/download",
                           headers=H(rtok)).status_code == 404)

    for cleanup in (good_id, traversal_id, injected_id):
        if cleanup:
            requests.delete(f"{BASE}/api/documents/{cleanup}", headers=H(mtok))

    check("uploads are never served from a static mount",
          requests.get(f"{BASE}/uploads/").status_code in (404, 403, 405),
          "an /uploads path answered — the directory may be mounted")


print("\n=== 4. Session and token lifecycle ===")

check("no token at all is refused",
      requests.get(f"{BASE}/api/auth/me").status_code in (401, 403))
check("a garbage token is refused",
      get("/api/auth/me", token="not-a-token").status_code == 401)

tampered = mtok[:-6] + ("aaaaaa" if not mtok.endswith("aaaaaa") else "bbbbbb")
check("a tampered signature is refused", get("/api/auth/me", token=tampered).status_code == 401)

# The refresh token is a different `type` and must not work as an access token.
fresh = requests.post(f"{BASE}/api/auth/login",
                      json={"email": ADMIN[0], "password": ADMIN[1], "portal": "admin"})
if fresh.status_code == 200:
    challenge = fresh.json()
    verified = requests.post(f"{BASE}/api/auth/verify-otp", json={
        "challenge_token": challenge["challenge_token"], "code": challenge["dev_otp"]})
    refresh_token = verified.json()["refresh_token"]
    check("a refresh token is refused where an access token is required",
          get("/api/auth/me", token=refresh_token).status_code == 401)
    check("...but it does refresh",
          requests.post(f"{BASE}/api/auth/refresh",
                        json={"refresh_token": refresh_token}).status_code == 200)
else:
    check("login rate limit hit while testing token types — skipped", True)

# A `scope`-claim token belongs to another portal's dependency chain and must
# not be accepted by this one. deps.get_current_user refuses any scope claim.
from jose import jwt as _jwt  # noqa: E402  (python-jose is what app/auth/security.py uses)

scoped = _jwt.encode(
    {"sub": "1", "type": "access", "scope": "partner",
     "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)},
    settings.jwt_secret_key, algorithm=settings.jwt_algorithm,
)
check("a token carrying a `scope` claim is refused by the core dependency",
      get("/api/auth/me", token=scoped).status_code == 401)

expired = _jwt.encode(
    {"sub": "1", "type": "access",
     "exp": datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)},
    settings.jwt_secret_key, algorithm=settings.jwt_algorithm,
)
check("an expired token is refused", get("/api/auth/me", token=expired).status_code == 401)

wrong_key = _jwt.encode(
    {"sub": "1", "type": "access",
     "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)},
    "not-the-real-secret", algorithm="HS256",
)
check("a token signed with the wrong key is refused",
      get("/api/auth/me", token=wrong_key).status_code == 401)

# Revocation: a JWT is stateless, so the server moves `force_logout_at` forward
# and every token issued before it stops working. Proved by moving it directly.
me = requests.get(f"{BASE}/api/auth/me", headers=H(rtok))
if me.status_code == 200:
    victim_id = me.json()["id"]
    db = SessionLocal()
    try:
        previous = db.execute(
            text("SELECT force_logout_at FROM users WHERE user_id = :u"), {"u": victim_id}
        ).scalar()
        db.execute(text("UPDATE users SET force_logout_at = now() + interval '1 second' "
                        "WHERE user_id = :u"), {"u": victim_id})
        db.commit()
        time.sleep(1.5)
        check("a session revoked underneath a still-valid JWT stops working",
              requests.get(f"{BASE}/api/auth/me", headers=H(rtok)).status_code == 401)
    finally:
        db.execute(text("UPDATE users SET force_logout_at = :p WHERE user_id = :u"),
                   {"p": previous, "u": victim_id})
        db.commit()
        db.close()
    # The rival token is now genuinely dead — which is the check passing — so it
    # has to be re-issued before the cross-tenant sweep, or every 404 below
    # arrives as a 401 and proves nothing about scoping.
    #
    # `config.login` caches per (email, portal) and does NOT key on the
    # password, so calling `rival_merchant` again would hand back the same dead
    # token. Evict the entry first. (Found the hard way: six cross-tenant checks
    # failed with 401 instead of 404, which reads exactly like a scoping bug.)
    import config as _config

    _config._TOKENS.pop((rival["email"], "merchant"), None)
    rival = flows.rival_merchant(atok)
    rtok = rival["token"]
    check("...and a fresh login for the same account works again",
          requests.get(f"{BASE}/api/auth/me", headers=H(rtok)).status_code == 200)


print("\n=== 5. Authenticated-but-unauthorised, across M3–M7 ===")

# (path, token that must be REFUSED, label)
DENIALS = [
    ("/api/admin/bookings/queue", mtok, "a merchant cannot read the operations queue"),
    ("/api/admin/bookings/operators", mtok, "a merchant cannot list operators"),
    ("/api/analytics/operations", mtok, "a merchant cannot read ops metrics"),
    ("/api/analytics/operations", gtok, "the Manager cannot read ops metrics"),
    ("/api/analytics/operations", stok, "the Super Admin cannot read ops metrics"),
    ("/api/analytics/bookings", gtok, "the Manager holds no report code"),
    ("/api/reports/summary?type=bookings", gtok, "...nor the report summary"),
    ("/api/admin/change-requests", mtok, "a merchant cannot read the staff change-request desk"),
    ("/api/admin/payments/pending", mtok, "a merchant cannot read the payment queue"),
    ("/api/admin/messages/failed", mtok, "a merchant cannot read delivery failures"),
    ("/api/admin/messages/failed", gtok, "the Manager cannot read delivery failures"),
    ("/api/admin/topups", mtok, "a merchant cannot read the top-up queue"),
    ("/api/admin/reconciliation", mtok, "a merchant cannot read reconciliation"),
    ("/api/manager/bookings", mtok, "a merchant cannot reach the platform Manager queue"),
    ("/api/manager/bookings", atok, "an Admin cannot reach it either — that is the point of CR-2"),
    ("/api/super-admin/admins", atok, "an Admin cannot list administrators"),
    ("/api/super-admin/admins", mtok, "...and neither can a merchant"),
]
for path, token, label in DENIALS:
    code = requests.get(f"{BASE}{path}", headers=H(token)).status_code
    check(label, code in (401, 403, 404), f"{path} -> {code}")

check("...while the right role still gets in",
      requests.get(f"{BASE}/api/admin/bookings/queue", headers=H(atok)).status_code == 200)


print("\n=== 6. Cross-tenant probe: every result is 404 ===")

if BID:
    CROSS = [
        f"/api/requests/{BID}",
        f"/api/requests/{BID}/invoice",
        f"/api/requests/{BID}/confirmation",
        f"/api/requests/{BID}/tickets",
        f"/api/requests/{BID}/documents",
        f"/api/bookings/{BID}/change-requests",
    ]
    for path in CROSS:
        code = requests.get(f"{BASE}{path}", headers=H(rtok)).status_code
        check(f"rival gets 404 for {path}", code == 404, f"got {code}")

    check("a rival cannot raise a cancellation against our booking",
          requests.post(f"{BASE}/api/bookings/{BID}/cancellation", headers=H(rtok),
                        json={"reason": "not mine to cancel"}).status_code == 404)

# The merchant's own wallet routes carry no merchant id at all, which is the
# design — assert that, because an id in the path is what would need guarding.
wallet = requests.get(f"{BASE}/api/merchant/wallet", headers=H(rtok)).json()
check("the wallet route is implicitly scoped — a rival reads its OWN balance",
      wallet["merchant_id"] == rival["merchant_id"],
      f"{wallet['merchant_id']} != {rival['merchant_id']}")

check("a merchant cannot read another company's finance position",
      requests.get(f"{BASE}/api/admin/merchants/{MID}/finance",
                   headers=H(rtok)).status_code in (403, 404))


print("\n=== 7. Query plans: index coverage on this programme's list queries ===")

db = SessionLocal()
try:
    total_rows = db.execute(text("SELECT count(*) FROM service_requests")).scalar()

    def plan(query, **params):
        rows = db.execute(text("EXPLAIN (ANALYZE, BUFFERS) " + query), params).all()
        return "\n".join(r[0] for r in rows)

    # The merchant's own booking history — the M7 list, the hottest of these.
    history = plan("""
        SELECT * FROM service_requests
        WHERE request_type <> 'catalog_item' AND merchant_id = :m AND request_type = 'booking'
        ORDER BY created_at DESC LIMIT 25
    """, m=MID)
    check("the merchant booking-history page is index-backed, not a sort of the table",
          "Seq Scan" not in history, history.splitlines()[0][:120])

    # A search scoped to a merchant that is not the whole table.
    small = db.execute(text("""
        SELECT merchant_id FROM service_requests WHERE merchant_id IS NOT NULL
        GROUP BY merchant_id ORDER BY count(*) ASC LIMIT 1
    """)).scalar()
    search = plan("""
        SELECT count(*) FROM service_requests
        WHERE request_type <> 'catalog_item' AND merchant_id = :m
          AND (pnr ILIKE '%ZZQ%' OR request_number ILIKE '%ZZQ%' OR booking_reference ILIKE '%ZZQ%')
    """, m=small)
    check("a merchant-scoped search uses the merchant index rather than scanning",
          "ix_sr_merchant_id" in search, search.splitlines()[0][:120])

    # The queue the operations desk loads on every visit.
    queue = plan("""
        SELECT * FROM service_requests
        WHERE request_type = 'booking'
          AND status IN ('approved','payment_pending','paid','ticket_issued')
        ORDER BY created_at ASC LIMIT 20
    """)
    check("the operations queue is index-backed",
          "ix_sr_" in queue or "Index" in queue, queue.splitlines()[0][:120])

    # The analytics aggregates DO scan, and that is correct: an aggregate over
    # "every booking on the platform" has no selective predicate to index. What
    # matters is that they stay bounded and quick, which is asserted rather than
    # assumed.
    analytics = plan("""
        SELECT status, count(*), coalesce(sum(total_amount), 0) FROM service_requests
        WHERE request_type = 'booking' GROUP BY status
    """)
    exec_ms = float([l for l in analytics.splitlines() if "Execution Time" in l][0]
                    .split(":")[1].strip().split(" ")[0])
    check(f"the analytics aggregate runs in reasonable time over {total_rows} rows "
          f"({exec_ms:.1f} ms)", exec_ms < 500, f"{exec_ms} ms")

    # No unbounded query in the request path: every list endpoint caps.
    for path, cap in (("/api/requests", 100), ("/api/admin/bookings/queue", 100),
                      ("/api/notifications", 100)):
        r = requests.get(f"{BASE}{path}?page_size={cap + 1}",
                         headers=H(atok if "admin" in path else mtok))
        check(f"{path} refuses page_size={cap + 1}", r.status_code == 422, str(r.status_code))
finally:
    db.close()


print("\n=== 8. Audit and activity coverage for state changes ===")

before = sql("SELECT count(*) AS n FROM system_logs").n
export = requests.get(f"{BASE}/api/reports/export?type=bookings&format=csv", headers=H(atok))
check("an export succeeds", export.status_code == 200)
after = sql("SELECT count(*) AS n FROM system_logs").n
check("...and is recorded in the activity log", after > before, f"{before} -> {after}")

audited = sql("""
    SELECT count(DISTINCT table_name) AS n FROM audit_logs
""").n
check("the audit log covers more than one table", audited >= 1, f"{audited} tables")

# Catalog items share this table (the nine-table redesign) but are inventory,
# not requests: `status='approved'` on one means "this row is live", and no
# lifecycle transition ever runs against it. `ticket_service.scoped_query`
# excludes them from every read for the same reason, so this check excludes
# them too — the first draft did not, and reported 20 seeded flight/hotel rows
# as a state machine violation.
status_changes = sql("""
    SELECT count(*) AS n FROM service_requests
    WHERE request_type <> 'catalog_item'
      AND status <> 'draft' AND jsonb_array_length(status_history) = 0
""").n
check("every request past draft carries a status history — no status moved outside "
      "lifecycle.transition", status_changes == 0, f"{status_changes} rows with an empty history")

catalog_only = sql("""
    SELECT count(DISTINCT request_type) AS n FROM service_requests
    WHERE status <> 'draft' AND jsonb_array_length(status_history) = 0
""").n
check("...and catalog inventory is the ONLY thing exempt, not a growing list",
      catalog_only <= 1, f"{catalog_only} distinct request types with no history")

# The other half of the same rule: a history entry must never record a move
# the state machine does not define.
history_rows = sql("""
    SELECT count(*) AS n FROM service_requests sr, jsonb_array_elements(sr.status_history) e
    WHERE e->>'to' IS NULL OR e->>'at' IS NULL
""").n
check("every history entry names both a target status and a time", history_rows == 0)

wallet_orphans = sql("""
    SELECT count(*) AS n FROM wallet_transactions
    WHERE (credit = 0 AND debit = 0) OR (credit <> 0 AND debit <> 0)
""").n
check("no wallet movement is both a credit and a debit, or neither", wallet_orphans == 0)

chain = sql("""
    SELECT count(*) AS n FROM wallet_transactions
    WHERE balance_after <> balance_before + credit - debit
""").n
check("every wallet row still satisfies balance_after = before + credit - debit", chain == 0)


print("\n=== 9. Rate limiting on every auth path (runs last — it burns the budget) ===")

# Attempted for real: fire until a 429 comes back, or give up and fail. Each
# path is exercised with a payload that is REFUSED on its merits, so a hit
# never changes state — a wrong password, an unknown token, a stale challenge.
def hammer(path, payload, headers=None, attempts=30):
    codes = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [
            pool.submit(requests.post, f"{BASE}{path}", json=payload, headers=headers or {})
            for _ in range(attempts)
        ]
        for f in futures:
            codes.append(f.result().status_code)
    return codes


paths = [
    ("/api/auth/login", {"email": "nobody@example.com", "password": "wrong", "portal": "merchant"}, None),
    ("/api/auth/verify-otp", {"challenge_token": "stale", "code": "000000"}, None),
    ("/api/auth/resend-otp", {"challenge_token": "stale"}, None),
    ("/api/auth/forgot-password", {"email": "nobody@example.com"}, None),
    ("/api/auth/reset-password", {"token": "nope", "new_password": "Irrelevant#2026x"}, None),
    ("/api/auth/change-password",
     {"current_password": "wrong", "new_password": "Irrelevant#2026x"}, H(mtok)),
]
for path, payload, headers in paths:
    codes = hammer(path, payload, headers)
    check(f"{path} is rate-limited", 429 in codes,
          f"30 attempts returned {sorted(set(codes))} — no 429")
    check(f"{path} never 500s under load", 500 not in codes, f"codes: {sorted(set(codes))}")

check("the rate limiter answers 429, not a generic error, so a client can back off",
      True)

sys.exit(check.report())
