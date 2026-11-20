"""Fail-closed RECIPIENT SELECTION for ``POST /api/admin/notifications/broadcast``.

Regression for: an empty / missing / null ``merchant_ids`` used to mean "every
active merchant". The audience is now explicit (``send_to_all``) and anything
ambiguous or invalid is rejected BEFORE a single notification is created.

Unlike ``test_admin_broadcast_audit.py`` (which stubs ``communication_service.broadcast``),
these tests run the REAL ``broadcast`` recipient resolution against throwaway SQLite
copies of ``merchants`` / ``users`` / ``communication_settings`` — only the *delivery*
is replaced:

  * ``notification_service.create_notification`` is a recorder (no msg_logs row);
  * ``delivery_service.deliver`` and ``smtplib`` raise if anything reaches them, so no
    email / SMS / WhatsApp / push path can run — if one is ever wired in, the test fails
    loudly instead of sending.

All merchants/users are synthetic ``*.example.test`` rows. Nothing touches a real DB.
"""

from __future__ import annotations

import json
import smtplib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.rbac import P
from app.auth.security import create_access_token
from app.database.session import get_db
from app.models_v2 import (
    CommunicationSettings, Merchant, MerchantStatus, User, UserRole, UserStatus,
)
from app.routers import admin_ops
from app.schemas.admin_ops import BIGINT_MAX, BROADCAST_MAX_MERCHANTS, BroadcastRequest
from app.services import (
    activity_service, communication_service, delivery_service, notification_service,
)

BROADCAST = "/api/admin/notifications/broadcast"
_N = {"n": 700000}


def _id() -> int:
    _N["n"] += 1
    return _N["n"]


def _sqlite_copy(md: MetaData, engine, *models):
    for model in models:
        t = model.__table__.to_metadata(md)
        for con in list(t.constraints):
            if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
                t.constraints.discard(con)
        for idx in list(t.indexes):
            t.indexes.discard(idx)
        for col in t.columns:
            col.foreign_keys.clear()
            col.server_default = None
            if not col.primary_key:
                col.nullable = True
        t.create(engine)


class Env:
    def __init__(self, engine):
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        self.activity: list[dict] = []
        self.delivered: list[int] = []          # user_ids a notification was created for
        app = FastAPI()
        app.include_router(admin_ops.router)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.client = TestClient(app, raise_server_exceptions=False)

    def db(self):
        return self.Session()


@pytest.fixture()
def env(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    _sqlite_copy(MetaData(), engine, Merchant, User, CommunicationSettings)
    e = Env(engine)

    monkeypatch.setattr(
        activity_service, "log_activity",
        lambda db, user_id, action, ip=None, **kw: e.activity.append(
            {"user_id": user_id, "action": action, "ip": ip, **kw}),
    )

    # --- delivery is fully mocked -------------------------------------------------
    def _create_notification(db, user_id, title, message):
        e.delivered.append(user_id)

    monkeypatch.setattr(notification_service, "create_notification", _create_notification)

    def _no_external(*a, **k):
        raise AssertionError("an external delivery channel was reached during a test")

    monkeypatch.setattr(delivery_service, "deliver", _no_external)
    monkeypatch.setattr(smtplib, "SMTP", _no_external)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _no_external)
    yield e
    engine.dispose()


def _merchant(env, *, status=MerchantStatus.ACTIVE, notifications=True, users=2, tag="m"):
    """One synthetic merchant with ``users`` users; returns (merchant_id, [user_ids])."""
    db = env.db()
    mid = _id()
    db.add(Merchant(
        merchant_id=mid, merchant_code=f"{tag}{mid}", merchant_name=f"{tag} {mid}",
        company_name=f"{tag} co {mid}", email=f"{tag}{mid}@example.test",
        reference_prefix=f"R{mid}"[:8], status=status,
    ))
    db.add(CommunicationSettings(merchant_id=mid, notification_enabled=notifications))
    uids = []
    for i in range(users):
        uid = _id()
        uids.append(uid)
        db.add(User(user_id=uid, merchant_id=mid, full_name=f"U{i}", email=f"u{uid}@example.test",
                    password_hash="x", role=UserRole.MANAGER, status=UserStatus.ACTIVE,
                    permissions=[]))
    db.commit()
    db.close()
    return mid, uids


def _staff(env, role, *, permissions=None):
    db = env.db()
    uid = _id()
    db.add(User(user_id=uid, full_name="Staff", email=f"s{uid}@example.test", password_hash="x",
                role=role, status=UserStatus.ACTIVE, permissions=permissions or []))
    db.commit()
    db.close()
    return {"headers": {"Authorization": f"Bearer {create_access_token(uid)}"}, "user_id": uid}


@pytest.fixture()
def admin(env):
    return _staff(env, UserRole.ADMIN, permissions=[P.NOTIFICATION_SEND])


@pytest.fixture()
def viewer(env):
    # View-only: can see notifications but holds no notification.send. Not role
    # ADMIN: effective permissions = role defaults + explicit grants, and the ADMIN
    # role default already includes notification.send.
    return _staff(env, UserRole.MANAGER, permissions=[P.NOTIFICATION_VIEW])


def _post(env, admin, **body):
    body.setdefault("title", "T")
    body.setdefault("message", "M")
    return env.client.post(BROADCAST, json=body, headers=admin["headers"])


def _assert_nothing_happened(env):
    assert env.delivered == [], "no notification may be created for a rejected request"
    assert env.activity == [], "a rejected request must not write a broadcast audit entry"


# ---------------------------------------------------------------- explicit all
def test_send_to_all_reaches_only_active_merchants(env, admin):
    a, a_users = _merchant(env, tag="a")
    b, b_users = _merchant(env, tag="b")
    _, inactive_users = _merchant(env, status=MerchantStatus.INACTIVE, tag="x")
    r = _post(env, admin, send_to_all=True)
    assert r.status_code == 200, r.text
    assert sorted(env.delivered) == sorted(a_users + b_users)
    assert not set(inactive_users) & set(env.delivered)
    assert r.json()["sent"] == 4
    assert env.activity[0]["details"]["recipient_scope"] == "all"


def test_send_to_all_with_merchant_ids_is_rejected(env, admin):
    m, _ = _merchant(env)
    r = _post(env, admin, send_to_all=True, merchant_ids=[m])
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)


def test_send_to_all_with_empty_list_is_rejected(env, admin):
    _merchant(env)
    r = _post(env, admin, send_to_all=True, merchant_ids=[])
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)


# ------------------------------- empty / missing / null never mean "everyone"
@pytest.mark.parametrize("body", [
    {"send_to_all": False, "merchant_ids": []},          # the original defect
    {"send_to_all": False, "merchant_ids": None},
    {"send_to_all": False},
    {"merchant_ids": []},                                  # send_to_all omitted
    {"merchant_ids": None},
    {},                                                    # nothing but title/message
], ids=["empty-list", "null", "omitted-ids", "no-flag-empty", "no-flag-null", "no-audience"])
def test_ambiguous_audience_is_rejected_and_sends_nothing(env, admin, body):
    _merchant(env, tag="a")
    _merchant(env, tag="b")
    r = _post(env, admin, **body)
    assert r.status_code in (400, 422), r.text
    _assert_nothing_happened(env)


# ------------------------------------------------------------ exact targeting
def test_selected_merchant_targets_exactly_that_merchants_users(env, admin):
    a, a_users = _merchant(env, tag="a", users=3)
    _, b_users = _merchant(env, tag="b")
    _, c_users = _merchant(env, tag="c")
    r = _post(env, admin, send_to_all=False, merchant_ids=[a])
    assert r.status_code == 200, r.text
    assert sorted(env.delivered) == sorted(a_users)
    assert not set(b_users + c_users) & set(env.delivered)
    assert r.json() == {"sent": 3, "skipped": 0, "failed": 0, "message": "Broadcast queued."}
    d = env.activity[0]["details"]
    assert d["recipient_scope"] == "selected" and d["merchant_count"] == 1


def test_two_selected_of_three_merchants(env, admin):
    a, a_users = _merchant(env, tag="a")
    b, b_users = _merchant(env, tag="b")
    _, c_users = _merchant(env, tag="c")
    r = _post(env, admin, merchant_ids=[a, b])           # send_to_all defaults to false
    assert r.status_code == 200, r.text
    assert sorted(env.delivered) == sorted(a_users + b_users)
    assert not set(c_users) & set(env.delivered)
    assert env.activity[0]["details"]["merchant_count"] == 2


def test_selected_merchant_with_notifications_off_is_skipped_not_forced(env, admin):
    a, a_users = _merchant(env, tag="a", notifications=False)
    r = _post(env, admin, merchant_ids=[a])
    assert r.status_code == 200, r.text
    assert env.delivered == []
    assert r.json()["skipped"] == len(a_users) and r.json()["sent"] == 0


# ------------------------------------- invalid / unknown / inactive / mixed ids
def test_nonexistent_merchant_id_is_rejected_not_silently_dropped(env, admin):
    _merchant(env, tag="a")
    r = _post(env, admin, merchant_ids=[999999991])
    assert r.status_code == 400, r.text
    assert "999999991" in r.json()["detail"]
    _assert_nothing_happened(env)


def test_inactive_merchant_id_is_rejected(env, admin):
    m, _ = _merchant(env, status=MerchantStatus.INACTIVE)
    r = _post(env, admin, merchant_ids=[m])
    assert r.status_code == 400, r.text
    _assert_nothing_happened(env)


def test_mixed_valid_and_invalid_ids_send_to_nobody(env, admin):
    good, good_users = _merchant(env, tag="good")
    bad, _ = _merchant(env, status=MerchantStatus.INACTIVE, tag="bad")
    r = _post(env, admin, merchant_ids=[good, bad, 999999992])
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert str(bad) in detail and "999999992" in detail and str(good) not in detail
    _assert_nothing_happened(env)       # NOT a partial send to the valid one


@pytest.mark.parametrize("ids", [[0], [-1], [1, 0], [1, -5]], ids=["zero", "negative", "has-zero", "has-neg"])
def test_non_positive_ids_rejected(env, admin, ids):
    _merchant(env)
    r = _post(env, admin, merchant_ids=ids)
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)


@pytest.mark.parametrize("ids", [["abc"], [1.5], [None], "7", {"a": 1}], ids=["str", "float", "null-item", "scalar", "object"])
def test_non_integer_ids_rejected(env, admin, ids):
    _merchant(env)
    r = _post(env, admin, merchant_ids=ids)
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)


def test_duplicate_ids_rejected(env, admin):
    m, _ = _merchant(env)
    r = _post(env, admin, merchant_ids=[m, m])
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)


def test_list_size_limit(env, admin):
    ok = list(range(1, BROADCAST_MAX_MERCHANTS + 1))
    over = list(range(1, BROADCAST_MAX_MERCHANTS + 2))
    # Over the cap is refused by validation, before any lookup or delivery.
    r = _post(env, admin, merchant_ids=over)
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)
    # At the cap the schema accepts it (ids don't exist -> service says 400, still nothing sent).
    BroadcastRequest(merchant_ids=ok, title="T", message="M")
    r = _post(env, admin, merchant_ids=ok)
    assert r.status_code == 400, r.text
    _assert_nothing_happened(env)


# --------------------------------------------------------------- permissions
def test_view_only_user_is_refused_even_with_a_valid_audience(env, viewer):
    m, _ = _merchant(env)
    r = _post(env, viewer, merchant_ids=[m])
    assert r.status_code == 403, r.text
    _assert_nothing_happened(env)


def test_user_without_permission_cannot_send_to_all(env):
    manager = _staff(env, UserRole.MANAGER)
    _merchant(env)
    r = _post(env, manager, send_to_all=True)
    assert r.status_code == 403, r.text
    _assert_nothing_happened(env)


def test_anonymous_is_refused(env):
    _merchant(env)
    r = env.client.post(BROADCAST, json={"send_to_all": True, "title": "T", "message": "M"})
    assert r.status_code in (401, 403), r.text
    _assert_nothing_happened(env)


# --------------------------------------------------------------------- audit
def test_audit_entry_only_on_success_and_is_content_free(env, admin):
    m, _ = _merchant(env)
    secret = "SECRET-BODY-zz99"
    assert _post(env, admin, merchant_ids=[999999993], message=secret).status_code == 400
    assert env.activity == []                              # rejected -> nothing logged
    r = _post(env, admin, merchant_ids=[m], title="SECRET-TITLE-yy88", message=secret)
    assert r.status_code == 200, r.text
    assert len(env.activity) == 1
    blob = json.dumps(env.activity[0], default=str)
    assert secret not in blob and "SECRET-TITLE-yy88" not in blob
    assert env.activity[0]["user_id"] == admin["user_id"]


# ------------------------------------------------- service-level safeguard
@pytest.mark.parametrize("ids", [None, [], ()], ids=["none", "empty-list", "empty-tuple"])
def test_service_refuses_empty_audience_without_send_to_all(env, ids):
    _merchant(env)
    db = env.db()
    with pytest.raises(ValueError):
        communication_service.broadcast(db, False, ids, "T", "M")
    db.close()
    assert env.delivered == []


def test_service_refuses_conflicting_all_plus_ids(env):
    m, _ = _merchant(env)
    db = env.db()
    with pytest.raises(ValueError):
        communication_service.broadcast(db, True, [m], "T", "M")
    db.close()
    assert env.delivered == []


@pytest.mark.parametrize("ids", [[0], [-3], [True], ["5"], [1.0]], ids=["zero", "neg", "bool", "str", "float"])
def test_service_refuses_malformed_ids(env, ids):
    _merchant(env)
    db = env.db()
    with pytest.raises(ValueError):
        communication_service.broadcast(db, False, ids, "T", "M")
    db.close()
    assert env.delivered == []


def test_service_send_to_all_true_is_the_only_way_to_everyone(env):
    _, a_users = _merchant(env, tag="a")
    _, b_users = _merchant(env, tag="b")
    db = env.db()
    sent, skipped, failed = communication_service.broadcast(db, True, None, "T", "M")
    db.close()
    assert (sent, skipped, failed) == (4, 0, 0)
    assert sorted(env.delivered) == sorted(a_users + b_users)


# ------------------------------------------------------- schema (no DB needed)
def test_schema_defaults_never_mean_all():
    with pytest.raises(ValidationError):
        BroadcastRequest(title="T", message="M")
    assert BroadcastRequest(send_to_all=True, title="T", message="M").merchant_ids is None


# ----------------------------------------------- strict typing (Phase 1 hardening)
@pytest.mark.parametrize("ids", [[True], [False], ["5"], [1.0], [2.5], [BIGINT_MAX + 1], [2 ** 70]],
                         ids=["true", "false", "numeric-string", "float-1.0", "float", "bigint+1", "huge"])
def test_ids_must_be_real_integers_within_bigint(env, admin, ids):
    _merchant(env)
    r = _post(env, admin, merchant_ids=ids)
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)


def test_bigint_maximum_is_accepted_by_schema_then_refused_as_unknown(env, admin):
    BroadcastRequest(merchant_ids=[BIGINT_MAX], title="T", message="M")
    r = _post(env, admin, merchant_ids=[BIGINT_MAX])
    assert r.status_code == 400, r.text          # a valid id that simply is not a merchant
    _assert_nothing_happened(env)


@pytest.mark.parametrize("flag", ["yes", "true", "1", "on", 1, 0, "false", None, [], {}],
                         ids=["yes", "str-true", "str-1", "on", "int-1", "int-0", "str-false", "null", "list", "obj"])
def test_send_to_all_must_be_a_real_boolean(env, admin, flag):
    _merchant(env, tag="a")
    r = _post(env, admin, send_to_all=flag)
    assert r.status_code == 422, r.text
    _assert_nothing_happened(env)       # no loosely-typed value can switch on a mass send


def test_service_refuses_out_of_range_ids(env):
    db = env.db()
    for bad in ([BIGINT_MAX + 1], [0]):
        with pytest.raises(ValueError):
            communication_service.broadcast(db, False, bad, "T", "M")
    db.close()
    assert env.delivered == []
