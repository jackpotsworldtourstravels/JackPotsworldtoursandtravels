"""Activity logging on the v2 ``system_logs`` table.

Replaces the legacy ``activity_logs`` table. Two legacy columns have no
dedicated home in the nine-table design and now live inside the
``extra_data`` JSONB blob:

* ``activity_type`` — a coarse grouping ("Login", "Booking", ...) that
  duplicated ``module``/``action`` in practice
* ``reference_id``  — the id of whatever row the action touched

Both are still queryable via ``extra_data ->> 'activity_type'``.
"""
import contextvars
import ipaddress
import re

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models_v2 import SystemLog, User

#: The connection the request currently being served came from, set once per
#: request by ``app.main.request_metadata`` and read by :func:`log_activity`
#: when its caller did not pass one.
#:
#: WHY A CONTEXTVAR AND NOT A PARAMETER. ``log_activity`` has about sixty call
#: sites and almost all of them are service functions two or three frames below
#: the router, with no ``Request`` in scope — which is why, before this, only
#: the four auth endpoints recorded an IP at all and every other row in System
#: Logs showed a blank Origin. Threading a Request through every service
#: signature to reach a log line would put HTTP in the service layer for no
#: other reason.
#:
#: Safe under FastAPI's two execution models: an async endpoint runs in the
#: task that the middleware set this in, and a sync endpoint runs through
#: ``run_in_threadpool``, which copies the context into the worker thread. A
#: background job or the completion sweep has no request and reads None, which
#: is the truth about them.
_REQUEST_META: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "jpw_request_meta", default=None
)


def bind_request(meta: dict | None) -> None:
    """Record the connection every subsequent log line in this request came from."""
    _REQUEST_META.set(meta)


def current_request_meta() -> dict:
    """The bound connection, or an empty dict outside a request."""
    return _REQUEST_META.get() or {}

#: Ordered: the first pattern that matches wins, so the more specific brand has
#: to come first. Every Chromium browser puts ``Chrome/`` in its UA, and Safari's
#: token appears in Chrome's too — matching "Chrome" before "Edg" would report
#: every Edge user as Chrome.
_BROWSER_PATTERNS = [
    ("Edge", re.compile(r"Edg(?:e|A|iOS)?/(\d+)")),
    ("Opera", re.compile(r"OPR/(\d+)|Opera[/ ](\d+)")),
    ("Samsung Internet", re.compile(r"SamsungBrowser/(\d+)")),
    ("Chrome", re.compile(r"(?:Chrome|CriOS)/(\d+)")),
    ("Firefox", re.compile(r"(?:Firefox|FxiOS)/(\d+)")),
    ("Safari", re.compile(r"Version/(\d+)[.\d]* (?:Mobile/\S+ )?Safari/")),
    ("Internet Explorer", re.compile(r"MSIE (\d+)|Trident/")),
]

#: ``(label, pattern, version-group)``. The version group is the capture that
#: holds a *marketing* version — Android and iOS put theirs in the UA, Windows
#: and macOS do not (see :func:`_os_from_user_agent`).
_OS_PATTERNS = [
    ("Windows", re.compile(r"Windows NT ([\d.]+)")),
    ("macOS", re.compile(r"Mac OS X ([\d_.]+)")),
    ("iPadOS", re.compile(r"iPad.*?OS ([\d_]+)")),
    ("iOS", re.compile(r"(?:iPhone|iPod).*?OS ([\d_]+)")),
    ("Android", re.compile(r"Android ([\d.]+)")),
    ("Linux", re.compile(r"Linux")),
]

#: ``Windows NT`` version -> the name a user would recognise.
#:
#: **10.0 IS DELIBERATELY ABSENT.** Windows 11 reports ``Windows NT 10.0`` too —
#: Microsoft never bumped it — so a UA saying 10.0 is genuinely ambiguous, and
#: mapping it to "Windows 10" would label every Windows 11 machine on the
#: platform with the wrong OS. That is a guess wearing a version number, which
#: is exactly what "no placeholder values" rules out. Unmapped falls through to
#: a bare "Windows", and only ``Sec-CH-UA-Platform-Version`` — which the browser
#: vouches for — can turn that into 10 or 11. See :func:`_os_name`.
_WINDOWS_NT = {"6.3": "Windows 8.1", "6.2": "Windows 8", "6.1": "Windows 7"}

#: Client-hint headers this platform asks browsers for. Chromium sends the
#: low-entropy three on every request; the two high-entropy ones arrive only
#: after the server has advertised ``Accept-CH`` (see app/main.py), which is
#: why the OS column reads "Windows" on a first visit and "Windows 11" after.
#: Firefox and Safari send none of them, and that is not a failure — the UA
#: fallback below is what those browsers are read from.
ACCEPT_CH = "Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Model"


def clean_ip(value: str | None) -> str | None:
    """Return ``value`` only if it parses as an IP address, else None.

    ``system_logs.ip_address`` is a PostgreSQL ``INET``, which rejects
    anything that isn't a real address — and the client host is not always
    one. Starlette's TestClient reports ``"testclient"``, and a spoofed or
    malformed ``X-Forwarded-For`` can be arbitrary text. Silently dropping an
    unparseable value keeps a bad header from failing the whole request.
    """
    if not value:
        return None
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return None
    return value


def _is_public(value: str) -> bool:
    """Is this a routable internet address rather than a LAN/loopback one?"""
    try:
        addr = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved)


def _forwarded_chain(request) -> list[str]:
    """Every address a proxy attributed to the client, client-first.

    ``X-Forwarded-For`` is written left-to-right as ``client, proxy1, proxy2``,
    so the leftmost entry is the origin of the request. Behind Caddy in
    production ``request.client.host`` is the *proxy*, which is why reading it
    alone logged one address for every merchant on the platform.

    The direct peer is deliberately NOT in here — see :func:`client_addresses`.
    """
    seen: list[str] = []
    for header in ("x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip"):
        for part in (request.headers.get(header) or "").split(","):
            candidate = clean_ip(part.strip().strip("[]"))
            if candidate and candidate not in seen:
                seen.append(candidate)
    return seen


def client_addresses(request) -> tuple[str | None, str | None]:
    """``(public_ip, local_ip)`` for this request.

    A header is not proof of anything — anyone can send ``X-Forwarded-For`` —
    but this is an admin activity log, not an access-control decision, and the
    alternative is logging the load balancer's own address on every row.

    ``local_ip`` is genuinely absent most of the time, and that is the honest
    answer rather than a gap: a private address only reaches us when a proxy
    forwarded the client's own LAN address, or when the client is on this
    machine or this network. It is returned as None so the UI can leave the line
    out instead of printing something untrue.

    **THE DIRECT PEER IS NEVER THE LOCAL IP WHEN A PROXY IS IN FRONT.** In
    production ``request.client.host`` is Caddy on the Docker bridge —
    ``172.18.0.x`` — which is private, so a naive "first private address wins"
    stamps every single row with the reverse proxy's own container address and
    calls it the user's LAN. The peer is therefore only consulted when no proxy
    reported anything at all, in which case it genuinely *is* who connected.
    """
    chain = _forwarded_chain(request)
    peer = clean_ip(request.client.host if request.client else None)
    public = next((ip for ip in chain if _is_public(ip)), None)
    local = next((ip for ip in chain if not _is_public(ip)), None)

    if public:
        return public, local
    # No proxy, or a proxy that only reported private addresses: fall back to
    # who actually opened the socket.
    if peer and _is_public(peer):
        return peer, local
    # Everything in sight is private — a LAN or localhost deployment. That
    # address IS where the request came from, so report it once, as the
    # connecting address, and leave the local line empty rather than repeat it.
    return local or peer, None


def _platform_hint(request) -> tuple[str | None, str | None, str | None, bool | None]:
    """``(platform, platform_version, model, mobile)`` from Chromium's UA hints."""
    def header(name: str) -> str | None:
        raw = request.headers.get(name)
        # Structured-header strings are quoted: `"Windows"`, `"15.0.0"`.
        return raw.strip().strip('"') if raw else None

    mobile_raw = request.headers.get("sec-ch-ua-mobile")
    mobile = None if mobile_raw is None else mobile_raw.strip() == "?1"
    return (
        header("sec-ch-ua-platform"),
        header("sec-ch-ua-platform-version"),
        header("sec-ch-ua-model") or None,
        mobile,
    )


def _os_from_user_agent(user_agent: str) -> str | None:
    """The best OS name the raw UA string can support, with its version."""
    for label, pattern in _OS_PATTERNS:
        match = pattern.search(user_agent)
        if not match:
            continue
        version = (match.groups()[0] or "") if match.groups() else ""
        version = version.replace("_", ".")
        if label == "Windows":
            # NT 10.0 is Windows 10 *and* 11 — say the one we can prove.
            return _WINDOWS_NT.get(version, "Windows")
        if label == "macOS":
            # Every browser has reported 10.15(.7) since Big Sur regardless of
            # the real version, so printing it would date a 2026 Mac to 2019.
            # Say "macOS" and let the client hint fill in a version if the
            # browser sends one.
            major = ".".join(version.split(".")[:2])
            return "macOS" if major.startswith("10.15") or not major else f"macOS {major}"
        if version:
            return f"{label} {version.split('.')[0]}"
        return label
    return None


def _os_name(request, user_agent: str | None) -> str | None:
    """OS and version, preferring the client hint the browser vouches for."""
    platform, platform_version, model, _ = _platform_hint(request)
    major = (platform_version or "").split(".")[0]
    if platform == "Windows" and major.isdigit():
        # Microsoft's own mapping: NT 10.0 builds report platform-version 1-10
        # for Windows 10 and 13+ for Windows 11. There is no 11 or 12.
        return "Windows 11" if int(major) >= 13 else "Windows 10"
    if platform == "Android":
        # The model is what an operator actually recognises on a phone row.
        return f"Android {major}".strip() if major else "Android"
    if platform in ("macOS", "Chrome OS", "Chromium OS") and major:
        return f"{platform} {major}"
    if platform and platform not in ("Unknown", ""):
        derived = _os_from_user_agent(user_agent or "")
        # An unversioned hint tells us less than the UA already did.
        return derived if derived and derived.startswith(platform) else (
            f"{platform} {major}" if major else platform
        )
    derived = _os_from_user_agent(user_agent or "")
    if derived and model:
        return f"{derived} · {model}"
    return derived


def _browser_name(request, user_agent: str | None) -> str | None:
    """Browser and major version, e.g. ``Chrome 139``.

    Returns None — not ``"Other"`` — for a User-Agent none of the patterns
    recognise. "Other" is a placeholder dressed as a value: on screen it is
    indistinguishable from a browser actually called that, and the honest
    statement is that this request did not identify itself. The UI omits the
    line instead. (Rows written before 2026-08-06 carry the literal "Other"
    from the previous parser; the Admin screens treat it as absent.)
    """
    for label, pattern in _BROWSER_PATTERNS:
        match = pattern.search(user_agent or "")
        if not match:
            continue
        version = next((g for g in match.groups() if g), None)
        return f"{label} {version}" if version else label
    return None


def _device_type(request, user_agent: str | None) -> str | None:
    """``Desktop`` / ``Mobile`` / ``Tablet``.

    ``Sec-CH-UA-Mobile`` is the browser's own answer and beats sniffing, but it
    only distinguishes mobile from not-mobile — an iPad is ``?0``. So the tablet
    case still comes from the UA.
    """
    ua = user_agent or ""
    if "iPad" in ua or ("Android" in ua and "Mobi" not in ua) or "Tablet" in ua:
        return "Tablet"
    _, _, _, mobile = _platform_hint(request)
    if mobile is not None:
        return "Mobile" if mobile else "Desktop"
    if not ua:
        return None
    if "Mobi" in ua or "iPhone" in ua or "Android" in ua:
        return "Mobile"
    return "Desktop"


def request_context(request) -> dict:
    """Everything worth recording about where a request came from.

    Read once per logged action and stored on the row, because a log entry has
    to keep describing the connection it was written for — re-deriving it later
    from the user's *current* session would rewrite history.
    """
    user_agent = request.headers.get("user-agent")
    public_ip, local_ip = client_addresses(request)
    return {
        "ip_address": public_ip,
        "local_ip": local_ip,
        "browser": _browser_name(request, user_agent),
        "os": _os_name(request, user_agent),
        "device": _device_type(request, user_agent),
        "user_agent": user_agent,
    }


def parse_user_agent(user_agent: str | None) -> tuple[str | None, str | None, str | None]:
    """Best-effort ``(browser, os, device)`` from a raw User-Agent header alone.

    Kept for callers that have a UA string but no Request — the versioned
    :func:`request_context` above is what the portals log through. Deliberately
    lightweight (no dependency): good enough to populate an admin activity
    table, not a precise device-fingerprinting tool.
    """
    if not user_agent:
        return None, None, None
    browser = next((name for name, p in _BROWSER_PATTERNS if p.search(user_agent)), None)
    os_name = _os_from_user_agent(user_agent)
    if "iPad" in user_agent or "Tablet" in user_agent:
        device = "Tablet"
    elif "Mobi" in user_agent or "iPhone" in user_agent or "Android" in user_agent:
        device = "Mobile"
    else:
        device = "Desktop"
    return browser, os_name, device


def log_activity(
    db: Session,
    user_id: int | None,
    action: str,
    ip_address: str | None = None,
    *,
    activity_type: str | None = None,
    module: str | None = None,
    description: str | None = None,
    reference_id: int | None = None,
    browser: str | None = None,
    device: str | None = None,
    status: str = "success",
    merchant_id: int | None = None,
    details: dict | None = None,
    os: str | None = None,
    local_ip: str | None = None,
) -> None:
    """Write one activity/audit entry.

    ``details`` merges caller-specific facts into ``extra_data`` — used by the
    enquiry workflow to record ``from_status``/``to_status`` alongside the
    actor. The DB-level ``audit_logs`` trigger captures the full before/after
    row but cannot know *which user* made the change (it has no session
    context), so the actor-attributed trail lives here.

    ``os`` and ``local_ip`` land in ``extra_data`` rather than in columns of
    their own. ``system_logs`` has ``ip_address``/``browser``/``device`` and
    nothing else about the connection, and adding two columns to a table this
    hot would be a migration for two nullable strings that are never filtered
    or joined on — the JSONB blob already carries ``activity_type`` and
    ``reference_id`` for exactly this reason. ``session_service`` has stored
    the OS there since the v2 redesign, so this is the existing shape, not a
    new one.

    Both are keyword-only and default to None, so the ~60 existing call sites
    are unchanged — and they still get a fully populated connection, because
    anything not passed falls back to :data:`_REQUEST_META`, which the HTTP
    middleware bound at the start of the request. An explicit argument always
    wins: a caller that has already read the Request is describing the same
    connection, and one that deliberately logs something else must not have it
    silently overwritten.
    """
    bound = current_request_meta()
    ip_address = ip_address or bound.get("ip_address")
    browser = browser or bound.get("browser")
    device = device or bound.get("device")
    os = os or bound.get("os")
    local_ip = local_ip or bound.get("local_ip")

    extra: dict = {}
    if activity_type:
        extra["activity_type"] = activity_type
    if reference_id is not None:
        extra["reference_id"] = reference_id
    if os:
        extra["os"] = os
    if local_ip and clean_ip(local_ip):
        extra["local_ip"] = clean_ip(local_ip)
    if details:
        extra.update(details)

    db.add(
        SystemLog(
            user_id=user_id,
            merchant_id=merchant_id,
            module=module or "General",
            action=action,
            description=description or action,
            ip_address=clean_ip(ip_address),
            browser=browser,
            device=device,
            status=status,
            extra_data=extra,
        )
    )
    db.commit()


def _filtered_stmt(search: str | None, action: str | None, module: str | None = None):
    stmt = select(SystemLog, User.email, User.full_name).join(
        User, SystemLog.user_id == User.user_id, isouter=True
    )
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(SystemLog.action.ilike(pattern), User.email.ilike(pattern)))
    if action:
        stmt = stmt.where(SystemLog.action == action)
    if module:
        stmt = stmt.where(SystemLog.module == module)
    return stmt


def list_activity_logs_paginated(
    db: Session,
    page: int,
    page_size: int,
    search: str | None = None,
    action: str | None = None,
    module: str | None = None,
):
    total = (
        db.scalar(
            select(func.count()).select_from(_filtered_stmt(search, action, module).subquery())
        )
        or 0
    )
    stmt = (
        _filtered_stmt(search, action, module)
        .order_by(SystemLog.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total


def list_distinct_actions(db: Session) -> list[str]:
    return sorted(db.scalars(select(SystemLog.action).distinct()).all())


def list_distinct_modules(db: Session) -> list[str]:
    return sorted(m for m in db.scalars(select(SystemLog.module).distinct()).all() if m)


def list_recent_activity(db: Session, limit: int = 20):
    stmt = (
        select(SystemLog, User.email, User.full_name)
        .join(User, SystemLog.user_id == User.user_id, isouter=True)
        .order_by(SystemLog.created_at.desc())
        .limit(limit)
    )
    return db.execute(stmt).all()
