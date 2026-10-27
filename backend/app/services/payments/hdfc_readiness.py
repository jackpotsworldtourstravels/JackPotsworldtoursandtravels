"""Is this deployment ready to take REAL money through HDFC SmartGateway?

A read-only checklist over configuration. It opens no connection, writes
nothing, and -- the point of the module -- NEVER prints a secret: a check names
the setting it is about (``HDFC_SG_API_KEY``) and says set / unset / too short,
nothing more. Hosts and URLs are public values and may appear; keys, passwords
and the response key may not. ``tests/test_hdfc_production.py`` pins that.

It is used twice: by ``scripts/check_hdfc_production.py`` (run on the server
before switching traffic) and by the startup log (a live host announces its
own gaps on every boot).

It does not decide anything the adapter does not already enforce. Every
``block`` here is something the adapter would refuse at construction, or the
mode logic would override; the checklist exists so the operator sees ALL the
gaps at once instead of one per restart. A ``warn`` is a gap that does not stop
money being collected correctly but that an operator should close.
"""
from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

import app.config
from app.services.payments.base import PaymentProviderError
from app.services.payments.hdfc_provider import (
    LIVE_MIN_WEBHOOK_PASSWORD,
    PRODUCTION_HOSTS,
    UAT_CLIENT_ID,
    UAT_HOSTS,
    _is_local_host,
)

PASS = "pass"
WARN = "warn"
BLOCK = "block"

RETURN_PATH = "/api/payments/hdfc/return"

#: Required in every environment (the adapter refuses to start without them).
_REQUIRED = (
    "HDFC_SG_BASE_URL",
    "HDFC_SG_MERCHANT_ID",
    "HDFC_SG_API_KEY",
    "HDFC_SG_WEBHOOK_USERNAME",
    "HDFC_SG_WEBHOOK_PASSWORD",
)


@dataclass(frozen=True)
class Check:
    name: str
    level: str           # PASS | WARN | BLOCK
    detail: str


def _get(settings, attr: str) -> str:
    return str(getattr(settings, attr, "") or "").strip()


def evaluate(settings=None) -> list[Check]:
    """Every readiness check, in the order an operator should fix them."""
    settings = settings or app.config.settings
    out: list[Check] = []

    def add(name: str, ok: bool, detail_ok: str, detail_bad: str, *, bad=BLOCK) -> None:
        out.append(Check(name, PASS if ok else bad, detail_ok if ok else detail_bad))

    provider = _get(settings, "payment_provider").lower()
    env = (_get(settings, "payment_environment") or "test").lower()
    live = env in ("live", "production")
    deployed = bool(getattr(settings, "deployed", False))

    add("PAYMENT_PROVIDER", provider == "hdfc",
        "hdfc", f"is {provider or 'unset'!r}; set it to 'hdfc' to collect through HDFC.")
    add("PAYMENT_ENVIRONMENT", live,
        env, f"is {env!r}; live charges need 'live' (the adapter then insists on "
             "HDFC's production host).")
    add("DEPLOYED", deployed,
        "true", "false; compose sets it on the server. Demo checkout is only "
                "refused on a deployed or live host.", bad=WARN)

    # Which checkout the B2C screens would run. Demo here means a customer is
    # shown a fake success and no money moves -- never acceptable when live.
    from app.services import payments as payment_providers

    mode = payment_providers.payment_mode()
    add("PAYMENT_MODE", mode == "real",
        "real", "resolves to 'demo': customers would see a demo screen instead of "
                "HDFC. Set PAYMENT_ENVIRONMENT=live and DEPLOYED=true.")

    missing = [n for n in _REQUIRED if not _get(settings, n.lower())]
    add("required settings", not missing,
        "all present", "unset: " + ", ".join(missing))

    # --- hosts -----------------------------------------------------------
    base = _get(settings, "hdfc_sg_base_url")
    host = (urlsplit(base).hostname or "").lower() if base else ""
    if base:
        if urlsplit(base).scheme != "https":
            out.append(Check("HDFC_SG_BASE_URL", BLOCK, "must be https://"))
        elif host in UAT_HOSTS:
            out.append(Check("HDFC_SG_BASE_URL", BLOCK if live else WARN,
                             "is a HDFC UAT host; live charges need the production host "
                             "HDFC approved for this merchant."))
        elif host in PRODUCTION_HOSTS:
            out.append(Check("HDFC_SG_BASE_URL", PASS, f"production host {host}"))
        else:
            out.append(Check("HDFC_SG_BASE_URL", WARN,
                             f"{host} is neither HDFC's documented UAT nor production "
                             "host; confirm it is the base URL HDFC issued."))

    client = _get(settings, "hdfc_sg_client_id")
    add("HDFC_SG_CLIENT_ID", client.lower() != UAT_CLIENT_ID or not live,
        "empty or merchant-specific",
        f"is the UAT value {UAT_CLIENT_ID!r}; leave it empty in production.")

    # --- the customer-facing URLs -----------------------------------------
    frontend = _get(settings, "frontend_base_url")
    f_parts = urlsplit(frontend) if frontend else None
    f_ok = bool(f_parts and f_parts.scheme == "https" and f_parts.hostname
                and not _is_local_host(f_parts.hostname))
    add("FRONTEND_BASE_URL", f_ok,
        f"https://{f_parts.hostname if f_parts else ''}",
        "must be the public https:// site address; the customer is sent back to it "
        "after paying.", bad=BLOCK if live else WARN)

    ret = _get(settings, "hdfc_sg_return_url") or (
        f"{frontend.rstrip('/')}{RETURN_PATH}" if frontend else "")
    r_parts = urlsplit(ret) if ret else None
    r_ok = bool(r_parts and r_parts.scheme == "https" and r_parts.hostname
                and not r_parts.query and not r_parts.fragment
                and not _is_local_host(r_parts.hostname))
    add("HDFC_SG_RETURN_URL", r_ok,
        f"https://{r_parts.hostname if r_parts else ''}{r_parts.path if r_parts else ''}",
        "must be a public https:// domain URL with no query string (HDFC's rules).")
    if r_ok and f_ok and r_parts.hostname != f_parts.hostname:
        out.append(Check("return URL host", WARN,
                         "differs from FRONTEND_BASE_URL; the return route is served by "
                         "this app, so they are normally the same host."))
    if r_ok and r_parts.path.rstrip("/") != RETURN_PATH:
        out.append(Check("return URL path", WARN,
                         f"is not {RETURN_PATH}, the route this app serves."))

    # --- webhook and response key ------------------------------------------
    wh_pw = _get(settings, "hdfc_sg_webhook_password")
    add("HDFC_SG_WEBHOOK_PASSWORD", len(wh_pw) >= LIVE_MIN_WEBHOOK_PASSWORD,
        f"at least {LIVE_MIN_WEBHOOK_PASSWORD} characters",
        f"unset or shorter than {LIVE_MIN_WEBHOOK_PASSWORD} characters; the webhook "
        "is authenticated by it alone.", bad=BLOCK if live else WARN)
    add("HDFC_SG_RESPONSE_KEY", bool(_get(settings, "hdfc_sg_response_key")),
        "set (return URL signature is checked)",
        "unset: the return URL is unsigned. Still safe -- every payment is re-read "
        "from HDFC server-side -- but the signed response is HDFC's recommendation.",
        bad=WARN)

    # --- recovery ---------------------------------------------------------
    add("PAYMENT_SWEEP_ENABLED", bool(getattr(settings, "payment_sweep_enabled", True)),
        "on (pending payments are re-checked without the customer)",
        "off: a customer who pays and closes the tab is only settled by the "
        "webhook.", bad=WARN)

    # --- the adapter itself ------------------------------------------------
    # Constructed for real so any rule the adapter enforces that this list does
    # not repeat still surfaces. Its messages never contain a secret.
    try:
        payment_providers._build_hdfc()
    except PaymentProviderError as exc:
        out.append(Check("adapter", BLOCK, str(exc)))
    else:
        out.append(Check("adapter", PASS, "constructs with this configuration"))
    return out


def blockers(checks: list[Check]) -> list[Check]:
    return [c for c in checks if c.level == BLOCK]


def warnings(checks: list[Check]) -> list[Check]:
    return [c for c in checks if c.level == WARN]


def render(checks: list[Check]) -> str:
    marks = {PASS: "PASS ", WARN: "WARN ", BLOCK: "BLOCK"}
    lines = [f"[{marks[c.level]}] {c.name}: {c.detail}" for c in checks]
    nb, nw = len(blockers(checks)), len(warnings(checks))
    lines.append("")
    lines.append(
        "READY for live HDFC charges." if nb == 0 and nw == 0 else
        f"{'NOT READY' if nb else 'Ready with warnings'}: {nb} blocking, {nw} warning(s)."
    )
    return "\n".join(lines)
