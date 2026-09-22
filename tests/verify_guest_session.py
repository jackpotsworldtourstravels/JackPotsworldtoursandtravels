"""Continue as guest — a real session, isolated from every other one, and keepable.

WHAT CHANGED, AND WHY IT NEEDED CHANGING

"Continue as guest" closed the sign-in dialog and did nothing else. The
traveller who chose it had no identity, so nothing they did could belong to
them: a wishlist had nowhere to go, a booking would have had no owner, and the
header still offered them a login they had just declined.

A guest is now a CUSTOMER ROW with no credentials — `is_guest`, no
`customer_auth`, no password, no verified address, nothing to sign into — and
it is handed the same access/refresh pair a sign-in produces. That one decision
is what makes the rest free: every Account Center endpoint is already scoped to
`get_current_customer`, so the wishlist, bookings, notifications, reviews,
support threads and payment history all work for a guest through the SAME code
that serves an account, and Guest A cannot see Guest B for exactly the reason
one account cannot see another.

WHAT THIS SCRIPT PROTECTS

1. **A guest session is issued by the SERVER.** The browser asks and is given a
   signed token; it never says who it is. A `guest_session_id` invented in
   JavaScript and trusted by the API would be a login with no password, and
   this asserts the API does not accept one.

2. **Every profile screen answers for a guest.** Not "403, please sign in" —
   the eight destinations in the profile menu are the ones the brief lists, and
   each has to return that guest's own (initially empty) data.

3. **A guest's own data comes back to it.** Something saved to the wishlist is
   there on the next request, under the same session.

4. **ISOLATION, WHICH IS THE ONE RULE THAT MATTERS.** Guest B must never see
   Guest A's wishlist, bookings, notifications or payments. This is asserted
   with two live guest sessions, not by reading the code.

5. **The placeholder address never escapes.** A guest row carries
   `guest-<hex>@guest.invalid` to satisfy NOT NULL. If that ever appears in an
   API response it will appear on the profile screen next, and then in
   something that emails it.

6. **A guest has no credentials, and the credential screens say so.** Changing
   a password returns 409 and names the way forward, rather than 500ing on a
   missing auth row.

7. **Signing in keeps what the guest did.** The claim endpoint moves the rows
   rather than copying them: one wishlist item before, one after, on the
   account. An expired or foreign token is `claimed: false` and never an error,
   because it runs after a sign-in that has already succeeded.

RUN IT AGAINST A LIVE SERVER, with migration 0079 applied:

    JPW_BASE=http://127.0.0.1:8000 python tests/verify_guest_session.py
"""
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))

import minihttp as requests  # noqa: E402

from config import BASE, Checker  # noqa: E402

check = Checker()
CUST = f"{BASE}/api/customer"
AUTH = f"{CUST}/auth"

#: The eight destinations in the profile menu, as the endpoints behind them.
#: "My Profile" is /auth/me; Settings reads the same row.
PROFILE_MENU = [
    ("My Profile", "GET", f"{AUTH}/me"),
    ("My Bookings", "GET", f"{CUST}/bookings"),
    ("Wishlist", "GET", f"{CUST}/wishlist"),
    ("Payment History", "GET", f"{CUST}/payments/history"),
    ("Notifications", "GET", f"{CUST}/notifications"),
    ("Support Tickets", "GET", f"{CUST}/support-tickets"),
    ("Reviews", "GET", f"{CUST}/reviews/mine"),
]


def guest():
    """A fresh guest session: (access token, customer dict)."""
    r = requests.post(f"{AUTH}/guest", json={})
    if r.status_code != 201:
        return None, {"_status": r.status_code, "_body": r.text[:200]}
    d = r.json()
    return d.get("access_token"), (d.get("customer") or {})


def H(token):
    return {"Authorization": f"Bearer {token}"}


print(f"\nBASE={BASE}")

# ---------------------------------------------------------------------------
print("\n== 1. The server issues the session; the browser does not ==")
# ---------------------------------------------------------------------------
token_a, guest_a = guest()
check("POST /auth/guest starts a session", bool(token_a), str(guest_a)[:200])
if not token_a:
    sys.exit(check.report())

check("  it is named My Guest", guest_a.get("full_name") == "My Guest", str(guest_a.get("full_name")))
check("  and flagged as a guest", guest_a.get("is_guest") is True, str(guest_a.get("is_guest")))
check("  with a customer code of its own", bool(guest_a.get("customer_code")), str(guest_a))

# An id the browser made up is not a session. The API takes a signed token or
# nothing at all.
r = requests.get(f"{CUST}/wishlist", headers={"Authorization": "Bearer guest-12345"})
check("a made-up token is refused", r.status_code == 401, str(r.status_code))
r = requests.get(f"{CUST}/wishlist")
check("no token is refused", r.status_code in (401, 403), str(r.status_code))

# ---------------------------------------------------------------------------
print("\n== 2. Every item in the profile menu answers for a guest ==")
# ---------------------------------------------------------------------------
for label, method, url in PROFILE_MENU:
    r = requests.get(url, headers=H(token_a))
    check(f"{label} -> 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

# ---------------------------------------------------------------------------
print("\n== 3. What a guest saves belongs to that guest ==")
# ---------------------------------------------------------------------------
#: The wishlist is keyed by (type, id) — there is no free-text title on it, so
#: the id itself is what this follows through the migration.
item = {"item_type": "hotel", "item_id": 4242}
r = requests.post(f"{CUST}/wishlist", json=item, headers=H(token_a))
check("a guest can save to the wishlist", r.status_code in (200, 201), f"{r.status_code} {r.text[:180]}")
saved_ok = r.status_code in (200, 201)

r = requests.get(f"{CUST}/wishlist", headers=H(token_a))
mine = r.json() if r.status_code == 200 else []
check("  and it is there on the next request",
      any(w.get("item_id") == item["item_id"] for w in mine) if saved_ok else False,
      str(mine)[:200])

# ---------------------------------------------------------------------------
print("\n== 4. One guest cannot see another ==")
# ---------------------------------------------------------------------------
token_b, guest_b = guest()
check("a second guest session starts", bool(token_b), str(guest_b)[:160])
check("  and it is a different customer",
      guest_b.get("id") != guest_a.get("id"), f"{guest_a.get('id')} vs {guest_b.get('id')}")

if token_b:
    r = requests.get(f"{CUST}/wishlist", headers=H(token_b))
    theirs = r.json() if r.status_code == 200 else []
    check("Guest B's wishlist is empty, not Guest A's",
          isinstance(theirs, list) and not any(w.get("item_id") == item["item_id"] for w in theirs),
          str(theirs)[:200])
    for label, _m, url in PROFILE_MENU[1:]:
        r = requests.get(url, headers=H(token_b))
        body = r.json() if r.status_code == 200 else None
        rows = body if isinstance(body, list) else (body or {}).get("items", [])
        check(f"  Guest B's {label} is its own (empty)",
              isinstance(rows, list) and len(rows) == 0, f"{r.status_code} {str(body)[:120]}")

# ---------------------------------------------------------------------------
print("\n== 5. The placeholder address never leaves the server ==")
# ---------------------------------------------------------------------------
r = requests.get(f"{AUTH}/me", headers=H(token_a))
me = r.json() if r.status_code == 200 else {}
check("the profile returns no email for a guest", me.get("email") in (None, ""), str(me.get("email")))
check("  and no mobile", me.get("mobile") in (None, ""), str(me.get("mobile")))
check("  and 'guest.invalid' appears nowhere in the response",
      "guest.invalid" not in r.text, r.text[:200])
check("  while still saying it is a guest", me.get("is_guest") is True, str(me.get("is_guest")))

# ---------------------------------------------------------------------------
print("\n== 6. A guest has no credentials, and is told so ==")
# ---------------------------------------------------------------------------
r = requests.post(f"{AUTH}/change-password",
                  json={"current_password": "Whatever#1", "new_password": "Another#12",
                        "confirm_password": "Another#12"},
                  headers=H(token_a))
check("changing a password is refused with 409, not a 500",
      r.status_code == 409, f"{r.status_code} {r.text[:160]}")
check("  and the message says what to do instead",
      "account" in r.text.lower(), r.text[:160])

# ---------------------------------------------------------------------------
print("\n== 7. Signing in keeps what the guest did ==")
# ---------------------------------------------------------------------------
stamp = uuid.uuid4().hex[:10]
password = "GuestKeep#2026"
signup = requests.post(f"{AUTH}/signup", json={
    "full_name": "Guest Keeper",
    "email": f"keeper+{stamp}@example.com",
    "mobile": f"9{stamp[:9].translate(str.maketrans('abcdef', '123456'))}",
    "password": password, "confirm_password": password,
})
check("a real account can be created to claim into",
      signup.status_code in (200, 201), f"{signup.status_code} {signup.text[:200]}")

account_token = None
if signup.status_code in (200, 201):
    body = signup.json()
    account_token = body.get("access_token")
    if not account_token and body.get("challenge_token"):
        # SIGN-IN IS PASSWORDLESS HERE: signup answers with an OTP challenge
        # and the session is minted by /verify-otp. A host with OTP_DEV_ECHO on
        # returns the code; a deployed one does not, and this section is then
        # skipped rather than failed — the claim is what is under test, not
        # somebody's inbox.
        code = body.get("dev_otp")
        if code:
            v = requests.post(f"{AUTH}/verify-otp", json={
                "challenge_token": body["challenge_token"], "code": str(code),
            })
            account_token = (v.json() or {}).get("access_token") if v.status_code == 200 else None
            check("  the account signs in with its code", bool(account_token),
                  f"{v.status_code} {v.text[:160]}")
        else:
            print("  SKIP  no dev OTP on this host - the claim section needs one")

if account_token:
    before = requests.get(f"{CUST}/wishlist", headers=H(account_token))
    before_rows = before.json() if before.status_code == 200 else []
    check("  the new account starts with an empty wishlist", len(before_rows) == 0, str(before_rows)[:160])

    r = requests.post(f"{AUTH}/guest/claim", json={"guest_token": token_a}, headers=H(account_token))
    check("the guest session is claimed", r.status_code == 200 and r.json().get("claimed") is True,
          f"{r.status_code} {r.text[:200]}")
    moved = (r.json().get("moved") or {}) if r.status_code == 200 else {}
    check("  and the wishlist row moved with it",
          moved.get("customer_wishlist", 0) >= 1, str(moved))

    after = requests.get(f"{CUST}/wishlist", headers=H(account_token))
    after_rows = after.json() if after.status_code == 200 else []
    check("  the account now holds the guest's saved item",
          any(w.get("item_id") == item["item_id"] for w in after_rows), str(after_rows)[:200])
    check("  exactly once — moved, not copied",
          sum(1 for w in after_rows if w.get("item_id") == item["item_id"]) == 1, str(after_rows)[:200])

    # The claimed guest session is spent. Its token must not still be a way in.
    r = requests.get(f"{CUST}/wishlist", headers=H(token_a))
    check("  and the old guest token stops working",
          r.status_code in (401, 403), f"{r.status_code} {r.text[:120]}")

    # Claiming again, or claiming rubbish, is not an error — it runs after a
    # sign-in that already succeeded and must never undo it.
    r = requests.post(f"{AUTH}/guest/claim", json={"guest_token": token_a}, headers=H(account_token))
    check("claiming a spent session says so rather than failing",
          r.status_code == 200 and r.json().get("claimed") is False, f"{r.status_code} {r.text[:160]}")
    r = requests.post(f"{AUTH}/guest/claim", json={"guest_token": "not-a-token"}, headers=H(account_token))
    check("  and so does a token that is not one",
          r.status_code == 200 and r.json().get("claimed") is False, f"{r.status_code} {r.text[:160]}")
    r = requests.post(f"{AUTH}/guest/claim", json={"guest_token": token_b}, headers=H(token_b))
    check("a guest cannot claim a guest",
          r.status_code == 409, f"{r.status_code} {r.text[:160]}")

sys.exit(check.report())
