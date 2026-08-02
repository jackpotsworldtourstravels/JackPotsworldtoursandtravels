"""The Merchant Portal is ONE interface for every merchant account.

WHAT THIS PROTECTS

The portal never had two codebases — it has always been ``frontend/merchant-classic/``
alone. It nonetheless rendered as two different products, and the mechanism is
worth stating because it is invisible from the frontend:

    every screen degrades on a 403, and the roles held different read codes.

``report.view`` was absent from Operator and Data Operator, so
``/api/analytics/bookings`` refused them; the Dashboard catches that to ``null``
and swaps both charts for "your booking history could not be loaded", leaving
six of its eight KPI tiles on "—". ``payment.view`` was absent from the same two
and took Wallet, Payment Management and the wallet-balance tile with it.
``chat.view`` was held by NO merchant sub-role at all, so the Support Center
answered 403 for every Manager, Supervisor, Operator and Finance user alive.

Nobody wrote a second dashboard. One permission table drifted and the product
split in half. This file is what stops it drifting back.

1. **Every merchant account holds the whole read floor.** Asserted against the
   table itself for all five sub-roles, the portal role and a merchant_user with
   no sub-role at all — not against one account that happens to be privileged.
2. **Sub-roles grant actions only.** A ``*.view`` code appearing in
   MERCHANT_ROLE_PERMISSIONS is the exact shape of the original bug: harmless on
   the role that has it, and an invitation to remove it from the role that does
   not. Refused here.
3. **The eleven shared screens answer identically down the wire.** Every
   endpoint the portal calls to RENDER a screen is requested with a Manager
   token and a Data Operator token and the two status codes must match. This is
   the property the user sees; 1 and 2 are how it is achieved.
4. **Actions still differ.** The read floor is not a grant of everything: a Data
   Operator is still refused the approval queue, and still holds neither
   ``payment.pay`` nor ``report.export``. A parity test that passed by handing
   everyone everything would be worse than no test.
"""
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE))

import minihttp as requests  # noqa: E402

from app.auth.rbac import (  # noqa: E402
    MERCHANT_ROLE_PERMISSIONS,
    ROLE_PERMISSIONS,
    _MERCHANT_READ,
    effective_permissions,
)
from app.models_v2 import MerchantRole, UserRole  # noqa: E402
from config import BASE, H, MERCHANT, Checker, forget_login, login  # noqa: E402

check = Checker()


# ---------------------------------------------------------------------------
# 1 + 2 — the table itself
# ---------------------------------------------------------------------------
print("\n== every merchant account holds the same read floor ==")

_PORTAL_FLOOR = ROLE_PERMISSIONS[UserRole.MERCHANT_USER]
check(
    "a merchant_user with NO sub-role already holds the whole read floor",
    _PORTAL_FLOOR.issuperset(_MERCHANT_READ),
    f"missing {sorted(_MERCHANT_READ - _PORTAL_FLOOR)}",
)
check(
    "merchant_admin holds the whole read floor",
    ROLE_PERMISSIONS[UserRole.MERCHANT_ADMIN].issuperset(_MERCHANT_READ),
    f"missing {sorted(_MERCHANT_READ - ROLE_PERMISSIONS[UserRole.MERCHANT_ADMIN])}",
)

for role in MerchantRole:
    held = _PORTAL_FLOOR | MERCHANT_ROLE_PERMISSIONS.get(role, frozenset())
    check(
        f"{role.value} holds the whole read floor",
        held.issuperset(_MERCHANT_READ),
        f"missing {sorted(_MERCHANT_READ - held)}",
    )

print("\n== a sub-role grants actions, never a screen ==")
for role, codes in MERCHANT_ROLE_PERMISSIONS.items():
    views = sorted(c for c in codes if c.endswith(".view"))
    check(
        f"{role.value} carries no *.view code of its own",
        not views,
        f"{views} — put it in _MERCHANT_READ, or it will be removed from some "
        f"other role later and split the portal again",
    )


# ---------------------------------------------------------------------------
# 3 — the same screens, down the wire
# ---------------------------------------------------------------------------
# Every endpoint the Classic portal calls to *render* one of the eleven shared
# screens. Grouped by screen so a failure names what the merchant would have
# seen break, rather than a bare path.
SHARED_SCREEN_READS = [
    ("Dashboard", "/api/merchant/dashboard"),
    ("Dashboard", "/api/merchant/finance/position"),
    ("Dashboard — the analytics graph", "/api/analytics/bookings"),
    ("Dashboard — service-request tiles", "/api/analytics/change-requests"),
    ("Booking Enquiry", "/api/enquiries?page_size=1"),
    ("Booking Request / My Requests", "/api/requests?page_size=1"),
    ("Booking History", "/api/requests?page_size=1&status=completed"),
    ("Service Requests", "/api/change-requests?page_size=1"),
    ("Service Requests — counts", "/api/change-requests/counts"),
    ("Wallet", "/api/merchant/wallet"),
    ("Wallet — ledger", "/api/merchant/wallet/transactions?page_size=1"),
    ("Payment Management", "/api/merchant/payment-requests?page_size=1"),
    ("Payment Management — counts", "/api/merchant/payment-requests/counts"),
    ("Reports", "/api/analytics/bookings"),
    ("Notifications", "/api/notifications?page_size=1"),
    ("Notifications — unread badge", "/api/notifications/unread-count"),
    ("Profile", "/api/profile"),
    ("Support Center", "/api/support/threads?page_size=1"),
    ("Support Center — unread badge", "/api/support/unread-count"),
]


def _colleague(mtok, *, merchant_role, label):
    """Sign in as a team member with this sub-role, creating them once.

    ONE ACCOUNT PER ROLE, REUSED — not a fresh timestamped pair each run. There
    is no endpoint that deletes a merchant user, so a script that creates one
    per run grows the demo merchant's team forever. That is not merely untidy:
    ``verify_manager_approval`` looked its fixture up in the first 100 team
    members, and the run that pushed the team past 100 rows broke it. This
    script had already left ten accounts behind before that was noticed.
    """
    email = f"parity.{label}@demotravel.example"
    # `search`, not paging — the same trap that broke verify_manager_approval.
    team = requests.get(
        f"{BASE}/api/merchant/team?page_size=100&search={email}", headers=H(mtok)
    ).json()
    existing = next((u for u in team.get("items", []) if u["email"] == email), None)

    if existing:
        # The password is returned only at creation, so take a fresh one.
        r = requests.post(
            f"{BASE}/api/merchant/team/{existing['id']}/reset-password", headers=H(mtok)
        )
        assert r.status_code == 200, f"reset {label}: {r.status_code} {r.text[:300]}"
        password = r.json()["temporary_password"]
        # A reset moves force_logout_at to now and a JWT's `iat` is whole
        # seconds, so a token minted in the same second reads as already ended.
        time.sleep(1.1)
    else:
        password = "Parity#2026x"
        r = requests.post(
            f"{BASE}/api/merchant/team", headers=H(mtok),
            json={
                "full_name": f"Parity {label.title()}",
                "email": email,
                "role": "merchant_user",
                "merchant_role": merchant_role,
                "password": password,
            },
        )
        assert r.status_code == 201, f"create {label}: {r.status_code} {r.text[:300]}"

    forget_login(email, "merchant")
    return login(email, password, "merchant")


def main() -> int:
    mtok = login(*MERCHANT)

    # The two ends of the merchant hierarchy: the one that may do everything its
    # company allows, and the one that may do the least. If these two render the
    # same portal, everything between them does.
    manager = _colleague(mtok, merchant_role="manager", label="manager")
    operator = _colleague(mtok, merchant_role="data_operator", label="dataop")

    print("\n== the eleven shared screens answer identically for both ==")
    for screen, path in SHARED_SCREEN_READS:
        a = requests.get(f"{BASE}{path}", headers=H(manager))
        b = requests.get(f"{BASE}{path}", headers=H(operator))
        check(
            f"{screen} — same answer for Manager and Data Operator",
            a.status_code == b.status_code,
            f"manager {a.status_code} vs data operator {b.status_code} on {path}",
        )
        # A matched pair of 403s would satisfy "identical" while showing the
        # merchant two identically broken screens, so the code is pinned too.
        check(
            f"{screen} — and that answer is 200",
            a.status_code == 200,
            f"{a.status_code} {a.text[:160]}",
        )

    # ------------------------------------------------------------------
    # 4 — reading everything is not doing everything
    # ------------------------------------------------------------------
    print("\n== the actions still differ ==")
    me = requests.get(f"{BASE}/api/auth/me", headers=H(operator)).json()
    held = set(me.get("permissions") or [])

    for code in sorted(_MERCHANT_READ):
        check(f"a Data Operator's session carries {code}", code in held,
              f"held: {sorted(held)}")

    for code in ("payment.pay", "report.export", "servicerequest.approve",
                 "booking.merchant_approve", "merchant_user.manage"):
        check(f"but NOT {code}", code not in held, f"held: {sorted(held)}")

    r = requests.get(f"{BASE}/api/merchant/approvals", headers=H(operator))
    check("and the approval queue is still refused -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:160]}")

    r = requests.get(f"{BASE}/api/merchant/approvals", headers=H(manager))
    check("while the Manager's own queue still opens -> 200", r.status_code == 200,
          f"{r.status_code} {r.text[:160]}")

    # The floor is scoped, not open: it must not have handed a merchant anything
    # belonging to the platform or to another company.
    r = requests.get(f"{BASE}/api/admin/dashboard", headers=H(operator))
    check("the read floor grants no ADMIN dashboard -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:160]}")
    r = requests.get(f"{BASE}/api/admin/merchants?page_size=1", headers=H(operator))
    check("nor the merchant directory -> 403", r.status_code in (401, 403, 404),
          f"{r.status_code} {r.text[:160]}")

    # effective_permissions is the single function every endpoint's require()
    # consults, so the floor is asserted through it rather than by re-adding the
    # sets by hand.
    class _FakeUser:
        role = UserRole.MERCHANT_USER
        merchant_role = MerchantRole.DATA_OPERATOR
        permissions = None

    check(
        "effective_permissions() agrees for a bare Data Operator",
        effective_permissions(_FakeUser()).issuperset(_MERCHANT_READ),
        str(sorted(_MERCHANT_READ - effective_permissions(_FakeUser()))),
    )

    return check.report()


if __name__ == "__main__":
    raise SystemExit(main())
