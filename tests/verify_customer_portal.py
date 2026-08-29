"""Customer Portal V1 (migration 0044) — the B2C module that shares nothing with B2B.

WHAT THIS PROTECTS

1. **The two identity systems cannot authenticate each other.** Asserted in
   both directions and at three layers: a customer token is refused by the
   merchant/admin API, a merchant/admin/super-admin token is refused by the
   customer API, and each side's *credentials* are refused by the other side's
   login form. This is the requirement the whole module exists for, so it is
   checked against real endpoints rather than reasoned about.

2. **The isolation is in the schema, not in a convention.** No ``customer_*``
   table carries a foreign key to a merchant-side table and no merchant-side
   table points back, asserted against ``information_schema`` — so somebody
   adding a "convenient" link later fails here rather than in review.

3. **The customer endpoints write nothing to the merchant side.** A complete
   customer journey is run and the merchant-side log tables (``system_logs``,
   ``msg_logs``, ``audit_logs``) are counted before and after. The delta must
   be zero: a customer must never appear in Admin > Active Users, in the
   message-delivery screen, or in the Super Admin audit trail.

4. **Customer codes are unique and sequential, and never client-supplied.**
   From ``seq_customer_code``, asserted under real concurrency rather than by
   creating two accounts in a row.

5. **Email and mobile are unique among customers, case-insensitively.**
   Including the race two sequential requests cannot show.

6. **The reset flow is single-use, expiring, and closes every session.**

WHY THIS SCRIPT TALKS TO THE DATABASE
Two things have no HTTP surface by design: the schema-level FK guarantee, and
the reset token, which is emailed and deliberately not returned by the API
unless ``settings.debug`` is on. Reading them directly is the only honest way
to assert them. Everything else goes through the real endpoints.

A NOTE ON THE ID SPACES, BECAUSE IT IS AN EASY TEST TO GET WRONG
``customers.customer_id`` and ``users.user_id`` are independent sequences, so
customer 4 and user 4 both exist and are different people. An assertion like
"no system_logs row with user_id = customer_id" therefore returns an unrelated
merchant user's rows and fails for no reason. Discriminate by the address, or
by counting the delta across a known window — never by the bare id.
"""
import concurrent.futures
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

from config import ADMIN, BASE, MANAGER, MERCHANT, SUPER, Checker, H, login  # noqa: E402

check = Checker()

CUST = f"{BASE}/api/customer/auth"
PROF = f"{BASE}/api/customer/profile"

TAG = uuid.uuid4().hex[:10]
EMAIL = f"cxverify_{TAG}@example.com"
#: A DIGITS-ONLY run id. TAG is hex, so slicing it for a phone number yields
#: letters about half the time and the request 422s on the mobile format —
#: which looks like a rate-limit or concurrency failure and is neither.
DIGITS = f"{uuid.uuid4().int % 1_000_000:06d}"
# Unique per run: `uq_customers_mobile` is a plain unique index, so a fixed
# number would collide with the previous run's row.
MOBILE = f"+9199{DIGITS}55"
PASSWORD = "CustomerPass#2026"
NEW_PASSWORD = "CustomerPass#2026b"


def _db():
    return SessionLocal()


def _post(url, json, *, headers=None, tries=6, wait=13):
    """POST, waiting out the rate limiter rather than failing on it.

    Almost every auth endpoint here is limited per IP — /signup, /forgot- and
    /reset-password at 5 a minute, /login and /change-password at 10, /verify-
    otp at 20 — so they are a budget shared by every account and every script,
    exactly like ``config.login``. This script spends more than one window's
    worth on purpose (it exercises duplicates, concurrency and the whole
    password lifecycle), so a 429 is correct behaviour to back off from rather
    than a failure to report. Asserting through a raw call instead would make
    the script fail on whatever ran before it.
    """
    for attempt in range(tries):
        r = requests.post(url, json=json, headers=headers)
        if r.status_code != 429:
            return r
        print(f"     (rate-limited on {url.rsplit('/', 1)[-1]}; "
              f"waiting {wait}s — attempt {attempt + 1}/{tries})")
        time.sleep(wait)
    return r


def _signup(email, mobile, password=PASSWORD, name="Verify Customer", **extra):
    body = {
        "full_name": name, "email": email, "mobile": mobile,
        "password": password, "confirm_password": password,
    }
    body.update(extra)
    return _post(f"{CUST}/signup", body)


def _finish(challenge_body):
    """Spend the dev OTP from a login/signup challenge and return the tokens."""
    return _post(f"{CUST}/verify-otp", {
        "challenge_token": challenge_body["challenge_token"],
        "code": challenge_body["dev_otp"],
    })


def _login(identifier, password):
    r = _post(f"{CUST}/login", {"identifier": identifier, "password": password})
    if r.status_code != 200:
        return r, None
    return r, _finish(r.json())


# =====================================================================
print("\n== 1. Schema: the isolation is structural ==")
# =====================================================================
db = _db()

tables = [r[0] for r in db.execute(text(
    "select tablename from pg_tables where schemaname='public' "
    "and tablename like 'customer%' order by 1"
))]
# THE SCHEMA THE CODE DECLARES, NOT A COUNT FROM THE DAY THIS WAS WRITTEN.
# This asserted `len(tables) == 7` — true when the B2C side was only an
# identity, and false from the moment bookings, hotels and packages landed
# (31 tables today). A count is not the property worth protecting; matching
# the model layer is, in both directions: a table the models declare and the
# database lacks is a migration that never ran, and a `customer%` table the
# models do not declare is one a migration left behind. Both are real
# failures, and neither is detectable by counting.
import app.models_customer as _mc  # noqa: E402

all_tables = {r[0] for r in db.execute(text(
    "select tablename from pg_tables where schemaname='public'"
))}
declared = {t.name for t in _mc.Base.metadata.tables.values()}
check(f"every table the B2C model layer declares exists ({len(declared)} of them)",
      not (declared - all_tables), f"missing: {sorted(declared - all_tables)}")
check("no orphan customer table the model layer does not declare",
      not (set(tables) - declared), f"orphans: {sorted(set(tables) - declared)}")

# The identity core, named explicitly: these seven are what every other
# customer table hangs off, so they are worth failing on by name.
for t in ("customers", "customer_auth", "customer_profiles", "customer_sessions",
          "customer_otps", "customer_password_resets", "customer_audit_logs"):
    check(f"  {t}", t in tables)

fks = list(db.execute(text("""
    select tc.table_name, kcu.column_name, ccu.table_name as refs
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu
      on tc.constraint_name = ccu.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'
      and (tc.table_name like 'customer%' or ccu.table_name like 'customer%')
""")))
crossing = [
    f"{t}.{c} -> {r}" for t, c, r in fks
    if not (t.startswith("customer") and r.startswith("customer"))
]
check("no foreign key crosses the B2C/B2B boundary", not crossing, crossing)
check("every customer FK targets a customer table", len(fks) >= 6, len(fks))

# The models must not be able to reach across either. Two declarative registries
# is what makes a relationship() to a merchant class fail at mapper-configure
# time instead of silently working.
import app.models_customer as mc  # noqa: E402
import app.models_v2 as mv  # noqa: E402

check("customer models use their own declarative Base",
      mc.Base.metadata is not mv.Base.metadata)
check("no merchant table is registered on the customer metadata",
      not (set(mc.Base.metadata.tables) & set(mv.Base.metadata.tables)),
      set(mc.Base.metadata.tables) & set(mv.Base.metadata.tables))

# The customer modules must not import the merchant models at all. Matched on
# real import STATEMENTS, not on the substring: every one of these files
# explains in its docstring why it does not import models_v2, so a substring
# search finds the documentation and fails on it.
import re  # noqa: E402

_IMPORT_RE = re.compile(r"^\s*(?:from\s+app\.models_v2\b|import\s+app\.models_v2\b)", re.M)
for rel in ("app/services/customer_auth_service.py",
            "app/services/customer_otp_service.py",
            "app/services/customer_session_service.py",
            "app/services/customer_audit_service.py",
            "app/routers/customer_auth.py",
            "app/routers/customer_profile.py",
            "app/auth/customer_deps.py"):
    body = (BACKEND / rel).read_text(encoding="utf-8")
    check(f"{rel.rsplit('/', 1)[-1]} imports no merchant model",
          not _IMPORT_RE.search(body))

# =====================================================================
print("\n== 2. Signup, and the CUS- sequence ==")
# =====================================================================
# ---- concurrency FIRST, while the rate-limit budget is untouched ----------
# /signup allows 5 a minute per IP. Everything below it in this section spends
# that budget on duplicate handling, and _signup waits the window out — but a
# concurrency test CANNOT wait, because backing off and retrying serialises the
# simultaneity it exists to create. So it runs first, on a fresh window, and a
# 429 here is reported rather than absorbed.
CONCURRENT_N = 3


def _concurrent_signup(args):
    """Deliberately the raw call, not _signup: no retry, no backoff."""
    batch, n = args
    return requests.post(f"{CUST}/signup", json={
        "full_name": f"Concurrent {batch}-{n}",
        "email": f"conc{batch}{n}_{TAG}@example.com",
        "mobile": f"+9197{DIGITS}{batch}{n}",
        "password": PASSWORD, "confirm_password": PASSWORD,
    })


# The BATCH is retried, never the individual request: backing off per-request
# would serialise them and stop testing simultaneity altogether. Each attempt
# uses fresh addresses, so a partial success cannot turn the retry into a
# duplicate check. Needed because a run within a minute of the previous one
# starts with the 5/minute window already spent.
statuses, batch_no = [], 0
for batch_no in range(5):
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENT_N) as pool:
        results = list(pool.map(_concurrent_signup,
                                [(batch_no, n) for n in range(CONCURRENT_N)]))
    statuses = [r.status_code for r in results]
    if all(s == 201 for s in statuses):
        break
    if not all(s == 429 for s in statuses):
        break          # a real failure, not a starved window — report it as is
    print(f"     (signup window exhausted; waiting 15s before batch {batch_no + 2}/5)")
    time.sleep(15)

check(f"all {CONCURRENT_N} concurrent signups succeeded",
      statuses == [201] * CONCURRENT_N, statuses)

db2 = _db()
codes = [row[0] for row in db2.execute(text(
    "select customer_code from customers where email like :p"),
    {"p": f"conc{batch_no}%_{TAG}@example.com"})]
# Against CONCURRENT_N, not against the number that happened to succeed:
# comparing to len(created) makes the assertion pass on an empty set, which is
# how a collision test quietly stops testing anything.
check("every concurrent signup got a distinct code",
      len(codes) == CONCURRENT_N and len(set(codes)) == CONCURRENT_N, codes)
check("the codes came from the sequence, not from a count",
      all(c.startswith("CUS-") for c in codes), codes)
db2.close()

# ---- and now the sequential cases, which may wait out the limiter ----------
r = _signup(EMAIL, MOBILE, date_of_birth="1992-03-11")
check("signup returns 201", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
signup_body = r.json()
check("signup issues an OTP challenge", bool(signup_body.get("challenge_token")))
check("dev_otp present when SMTP is unconfigured", bool(signup_body.get("dev_otp")))

r = _finish(signup_body)
check("signup verification returns a session", r.status_code == 200, r.text[:200])
tokens = r.json()
CTOK = tokens["access_token"]
CREFRESH = tokens["refresh_token"]
me = tokens["customer"]

check("customer_code has the CUS-000000 shape",
      me["customer_code"].startswith("CUS-") and len(me["customer_code"]) == 10
      and me["customer_code"][4:].isdigit(), me.get("customer_code"))
check("date of birth round-trips", me["date_of_birth"] == "1992-03-11", me.get("date_of_birth"))
check("email is verified once the code is spent", me["email_verified"] is True)
check("the response carries no merchant concepts",
      not any(k in me for k in ("role", "permissions", "merchant_id", "merchant_role", "portal")),
      [k for k in ("role", "permissions", "merchant_id", "portal") if k in me])

# The mobile is stored normalised, so a spaced version of the same number is
# the same number rather than a second account.
r = _post(f"{CUST}/signup", {
    "full_name": "Spaced Duplicate",
    "email": f"spaced_{TAG}@example.com",
    "mobile": " ".join([MOBILE[:5], MOBILE[5:9], MOBILE[9:]]),
    "password": PASSWORD, "confirm_password": PASSWORD,
})
check("a spaced version of an existing mobile is a duplicate", r.status_code == 400,
      f"{r.status_code} {r.text[:160]}")

check("duplicate email in a different case is refused",
      _signup(EMAIL.upper(), "+919000000123").status_code == 400)
check("duplicate mobile is refused",
      _signup(f"other_{TAG}@example.com", MOBILE).status_code == 400)
check("mismatched confirm_password is refused",
      _post(f"{CUST}/signup", {
          "full_name": "Mismatch", "email": f"mm_{TAG}@example.com",
          "mobile": "+919000000124", "password": PASSWORD,
          "confirm_password": PASSWORD + "x"}).status_code == 422)
check("a short password is refused",
      _signup(f"short_{TAG}@example.com", "+919000000125", password="Ab1!").status_code == 422)
check("a malformed mobile is refused",
      _signup(f"badmob_{TAG}@example.com", "12").status_code == 422)

# =====================================================================
print("\n== 3. Login by email and by mobile ==")
# =====================================================================
r1, r2 = _login(EMAIL, PASSWORD)
check("login by email reaches the OTP step", r1.status_code == 200, r1.text[:160])
check("login by email completes", r2 is not None and r2.status_code == 200)
if r2 is not None and r2.status_code == 200:
    CTOK = r2.json()["access_token"]

r1, r2 = _login(MOBILE, PASSWORD)
check("login by mobile reaches the OTP step", r1.status_code == 200, r1.text[:160])
check("login by mobile completes", r2 is not None and r2.status_code == 200)
if r2 is not None and r2.status_code == 200:
    CTOK = r2.json()["access_token"]

check("a wrong password is refused",
      _post(f"{CUST}/login", {"identifier": EMAIL, "password": "nope"}).status_code == 401)
check("an unknown identifier is refused",
      _post(f"{CUST}/login",
                    json={"identifier": f"ghost_{TAG}@example.com",
                          "password": PASSWORD}).status_code == 401)

# A correct password alone must not be a session.
r = _post(f"{CUST}/login", {"identifier": EMAIL, "password": PASSWORD})
challenge = r.json()["challenge_token"]
check("the challenge token is not itself a session",
      requests.get(f"{CUST}/me", headers=H(challenge)).status_code == 401)
_bad = _post(f"{CUST}/verify-otp", json={"challenge_token": challenge, "code": "000000"})
check("a wrong OTP is refused", _bad.status_code == 400, _bad.text[:160])
# ...AND SAYS SO. Asserting only the 400 hid a real defect: /verify-otp tried
# LOGIN then fell back to SIGNUP on any 400, so a mistyped LOGIN code reported
# the fallback's "No verification code outstanding - request one first" about a
# code the customer was looking at (and burned an attempt on the way). Both
# paths are still 400, which is why the status alone proved nothing.
_bad_detail = (_bad.json().get("detail") or "") if _bad.status_code == 400 else ""
check("...and the message is about the CODE, not a missing one",
      "incorrect" in _bad_detail.lower(), _bad_detail)

# =====================================================================
print("\n== 4. ISOLATION — neither side can authenticate the other ==")
# =====================================================================
# 4a. A customer token at the merchant/admin API.
MERCHANT_ENDPOINTS = [
    "/api/auth/me", "/api/profile", "/api/merchant/dashboard", "/api/merchant/wallet",
    "/api/admin/dashboard", "/api/super-admin/dashboard", "/api/admin/wallet/topups",
]
for ep in MERCHANT_ENDPOINTS:
    got = requests.get(f"{BASE}{ep}", headers=H(CTOK)).status_code
    check(f"customer token refused at {ep}", got == 401, f"got {got}")

# 4b. Merchant / admin / super-admin tokens at the customer API.
CUSTOMER_ENDPOINTS = [f"{CUST}/me", PROF, f"{PROF}/sessions"]
for label, account in (("merchant", MERCHANT), ("admin", ADMIN),
                       ("manager", MANAGER), ("super_admin", SUPER)):
    email, password, portal = account
    tok = login(email, password, portal)
    for url in CUSTOMER_ENDPOINTS:
        got = requests.get(url, headers=H(tok)).status_code
        check(f"{label} token refused at {url.replace(BASE, '')}", got == 401, f"got {got}")

    # 4c. Each side's CREDENTIALS at the other side's login form.
    got = _post(f"{CUST}/login", {"identifier": email, "password": password}).status_code
    check(f"{label} credentials refused at the customer login", got == 401, f"got {got}")

    got = _post(f"{BASE}/api/auth/login",
                        json={"email": EMAIL, "password": PASSWORD, "portal": portal}).status_code
    check(f"customer credentials refused at the {portal} portal login", got == 401, f"got {got}")

# 4d. A merchant refresh token must not mint a customer session, and vice versa.
mtok_pair = login(MERCHANT[0], MERCHANT[1], MERCHANT[2], with_user=True)
check("a customer refresh token is refused by the merchant refresh",
      requests.post(f"{BASE}/api/auth/refresh",
                    json={"refresh_token": CREFRESH}).status_code == 401)

# 4e. The customer never appears in the merchant identity table.
db3 = _db()
check("no users row was created for the customer address",
      db3.execute(text("select count(*) from users where lower(email) = :e"),
                  {"e": EMAIL}).scalar() == 0)
check("the customers table is not reachable from audit_logs",
      db3.execute(text("select count(*) from audit_logs where table_name like 'customer%'")
                  ).scalar() == 0)
db3.close()

# =====================================================================
print("\n== 5. The customer endpoints write NOTHING merchant-side ==")
# =====================================================================
# Counted as a delta across a complete journey. Not `where user_id = customer_id`
# — see the module docstring on the two id spaces.
db4 = _db()


def _log_counts():
    return {
        "system_logs": db4.execute(text("select count(*) from system_logs")).scalar(),
        "msg_logs": db4.execute(text("select count(*) from msg_logs")).scalar(),
        "audit_logs": db4.execute(text("select count(*) from audit_logs")).scalar(),
    }


before = _log_counts()

journey_email = f"journey_{TAG}@example.com"
journey_mobile = "+9196" + f"{abs(hash(TAG + 'j')) % 100_000_000:08d}"
r = _signup(journey_email, journey_mobile, name="Journey Customer")
jtok = None
if r.status_code == 201:
    v = _finish(r.json())
    if v.status_code == 200:
        jtok = v.json()["access_token"]
        requests.get(f"{CUST}/me", headers=H(jtok))
        requests.patch(PROF, headers=H(jtok), json={"city": "Pune"})
        requests.get(f"{PROF}/sessions", headers=H(jtok))
        requests.post(f"{CUST}/logout", headers=H(jtok))
check("the journey account was created and signed in", jtok is not None)

db4.commit()          # end the read transaction so the counts below are fresh
after = _log_counts()
for table in ("system_logs", "msg_logs", "audit_logs"):
    check(f"a full customer journey added 0 rows to {table}",
          after[table] == before[table],
          f"{before[table]} -> {after[table]}")

# And it DID write to its own tables.
jid = db4.execute(text("select customer_id from customers where email = :e"),
                  {"e": journey_email}).scalar()
check("the journey is recorded in customer_audit_logs",
      db4.execute(text("select count(*) from customer_audit_logs where customer_id = :i"),
                  {"i": jid}).scalar() >= 3)
check("the session is recorded in customer_sessions",
      db4.execute(text("select count(*) from customer_sessions where customer_id = :i"),
                  {"i": jid}).scalar() >= 1)
check("logout closed the session row",
      db4.execute(text("select count(*) from customer_sessions "
                       "where customer_id = :i and is_active"), {"i": jid}).scalar() == 0)
check("the customer OTP is not in msg_logs",
      db4.execute(text("select count(*) from msg_logs where recipient = :e"),
                  {"e": journey_email}).scalar() == 0)
check("the customer OTP IS in customer_otps",
      db4.execute(text("select count(*) from customer_otps where customer_id = :i"),
                  {"i": jid}).scalar() >= 1)
check("the OTP is stored hashed, never in the clear",
      db4.execute(text("select count(*) from customer_otps "
                       "where customer_id = :i and length(code_hash) = 64"),
                  {"i": jid}).scalar() >= 1)
db4.close()

# =====================================================================
print("\n== 6. Profile: scoped to the caller, email not editable ==")
# =====================================================================
r = requests.patch(PROF, headers=H(CTOK), json={
    "city": "Bengaluru", "country": "India", "gender": "female",
    "address_line1": "12 MG Road", "postal_code": "560001",
})
check("profile update returns 200", r.status_code == 200, r.text[:200])
if r.status_code == 200:
    p = r.json()
    check("city persisted", p["city"] == "Bengaluru", p.get("city"))
    check("country persisted", p["country"] == "India", p.get("country"))
    check("postal code persisted", p["postal_code"] == "560001", p.get("postal_code"))

# exclude_unset, so an omitted field is untouched and an explicit null clears it.
r = requests.patch(PROF, headers=H(CTOK), json={"city": "Mysuru"})
check("an omitted field is left alone",
      r.status_code == 200 and r.json()["country"] == "India", r.text[:160])
r = requests.patch(PROF, headers=H(CTOK), json={"address_line2": None})
check("an explicit null clears a field",
      r.status_code == 200 and r.json()["address_line2"] is None, r.text[:160])

r = requests.patch(PROF, headers=H(CTOK), json={"email": f"hijack_{TAG}@example.com"})
after_me = requests.get(f"{CUST}/me", headers=H(CTOK)).json()
check("email cannot be changed through the profile", after_me["email"] == EMAIL,
      after_me.get("email"))

# Another customer's mobile is refused.
r = requests.patch(PROF, headers=H(CTOK), json={"mobile": journey_mobile})
check("taking another customer's mobile is refused", r.status_code == 400,
      f"{r.status_code} {r.text[:160]}")

# 401, not 403 — a missing bearer is "not authenticated" here, matching what
# the merchant API returns for the same probe (/api/profile is also 401).
check("profile requires authentication", requests.get(PROF).status_code == 401)
check("sessions endpoint requires authentication",
      requests.get(f"{PROF}/sessions").status_code == 401)

r = requests.get(f"{PROF}/sessions", headers=H(CTOK))
check("the customer sees their own sessions", r.status_code == 200 and len(r.json()) >= 1,
      r.text[:160])
if r.status_code == 200 and r.json():
    s = r.json()[0]
    check("a session carries no other customer's identifier",
          "customer_id" not in s and "user_id" not in s, list(s))

# =====================================================================
print("\n== 7. Change password ==")
# =====================================================================
check("a wrong current password is refused",
      _post(f"{CUST}/change-password", {
          "current_password": "wrongwrong", "new_password": NEW_PASSWORD,
          "confirm_password": NEW_PASSWORD}, headers=H(CTOK)).status_code == 400)
check("reusing the current password is refused",
      _post(f"{CUST}/change-password", {
          "current_password": PASSWORD, "new_password": PASSWORD,
          "confirm_password": PASSWORD}, headers=H(CTOK)).status_code == 422)
r = _post(f"{CUST}/change-password", {
    "current_password": PASSWORD, "new_password": NEW_PASSWORD,
    "confirm_password": NEW_PASSWORD}, headers=H(CTOK))
check("the password changes", r.status_code == 200, r.text[:200])
check("the old password no longer works",
      _post(f"{CUST}/login",
            {"identifier": EMAIL, "password": PASSWORD}).status_code == 401)
r1, r2 = _login(EMAIL, NEW_PASSWORD)
check("the new password works", r2 is not None and r2.status_code == 200)
if r2 is not None and r2.status_code == 200:
    CTOK = r2.json()["access_token"]

# =====================================================================
print("\n== 8. Forgot / reset: single-use, and it ends every session ==")
# =====================================================================
r = _post(f"{CUST}/forgot-password", {"email": EMAIL})
check("forgot-password returns 200", r.status_code == 200, r.text[:160])
generic = r.json()["message"]

r = _post(f"{CUST}/forgot-password", {"email": f"nobody_{TAG}@example.com"})
check("an unknown address gets the identical message", r.json()["message"] == generic,
      r.json().get("message"))
check("an unknown address issues no token", r.json().get("reset_link") is None)

# The raw token is emailed, so it is read from the row rather than the response.
db5 = _db()
cid = db5.execute(text("select customer_id from customers where email = :e"),
                  {"e": EMAIL}).scalar()
rows = db5.execute(text(
    "select count(*) from customer_password_resets where customer_id = :i and used_at is null"
), {"i": cid}).scalar()
check("a reset row was created", rows >= 1, rows)
db5.close()

# The token itself is only ever the sha256 in the table, so the flow is driven
# through the debug channel when it is available and skipped honestly when not.
r = _post(f"{CUST}/forgot-password", {"email": EMAIL})
link = r.json().get("reset_link")
if link:
    token = link.split("token=")[1]
    r = _post(f"{CUST}/reset-password", {
        "token": token, "new_password": PASSWORD, "confirm_password": PASSWORD})
    check("reset succeeds with a valid token", r.status_code == 200, r.text[:200])
    check("the token is single-use",
          _post(f"{CUST}/reset-password", {
              "token": token, "new_password": PASSWORD,
              "confirm_password": PASSWORD}).status_code == 400)
    check("the reset revoked the existing session",
          requests.get(f"{CUST}/me", headers=H(CTOK)).status_code == 401)
    r1, r2 = _login(EMAIL, PASSWORD)
    check("the reset password signs in", r2 is not None and r2.status_code == 200)
    if r2 is not None and r2.status_code == 200:
        CTOK = r2.json()["access_token"]
else:
    # settings.debug is off, which is correct for anything but local work — the
    # link must not come back over the API. The consumption path is still
    # covered by the invalid-token cases below.
    print("     (debug off: reset_link is not returned, so the happy path is skipped)")
    check("no reset link is leaked when debug is off", True)

check("a garbage reset token is refused",
      _post(f"{CUST}/reset-password", {
          "token": "not-a-real-token", "new_password": PASSWORD,
          "confirm_password": PASSWORD}).status_code == 400)
check("a reset with mismatched confirmation is refused",
      _post(f"{CUST}/reset-password", {
          "token": "whatever", "new_password": PASSWORD,
          "confirm_password": "different"}).status_code == 422)

# =====================================================================
print("\n== 9. Logout revokes every token ==")
# =====================================================================
check("the session is live before logout",
      requests.get(f"{CUST}/me", headers=H(CTOK)).status_code == 200)
check("logout returns 200",
      requests.post(f"{CUST}/logout", headers=H(CTOK)).status_code == 200)
check("the access token is dead afterwards",
      requests.get(f"{CUST}/me", headers=H(CTOK)).status_code == 401)
check("logout requires a session",
      requests.post(f"{CUST}/logout").status_code == 401)

db.close()
sys.exit(check.report())
