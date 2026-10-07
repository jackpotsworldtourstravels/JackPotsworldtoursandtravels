"""E-ticket tokens: signed, per booking, unforgeable, and the public view is minimal."""
import datetime as dt
from types import SimpleNamespace

from jose import jwt

from app.config import settings
from app.services import eticket_service as et


def _booking(ref="JPB000027", status="confirmed", days_ahead=10):
    return SimpleNamespace(
        booking_ref=ref, status=status,
        travel_date=dt.date.today() + dt.timedelta(days=days_ahead),
        created_at=dt.datetime.now(dt.timezone.utc),
        airline="Akasa Air", flight_number="QP 1405",
        origin_code="HYD", origin_city="Hyderabad", destination_code="DEL", destination_city="Delhi",
        departure_time="06:00", arrival_time="08:15",
        passengers=[SimpleNamespace(first_name="Nikki", last_name="Ki", passport_number="P1234567",
                                    email="x@y.z", mobile="9000000000")],
    )


def test_token_round_trips_to_its_own_booking_only():
    a, b = _booking("JPB000027"), _booking("JPB000024")
    ta, tb = et.make_token(a), et.make_token(b)
    assert et.read_token(ta) == "JPB000027"
    assert et.read_token(tb) == "JPB000024"
    assert ta != tb


def test_token_is_stable_for_a_booking():
    assert et.make_token(_booking()) == et.make_token(_booking())


def test_forged_tampered_and_foreign_tokens_are_rejected():
    t = et.make_token(_booking())
    assert et.read_token(t[:-3] + "AAA") is None
    assert et.read_token("JPB000027") is None                       # a bare reference opens nothing
    other = jwt.encode({"typ": "eticket", "ref": "JPB000001", "exp": 4102444800}, "not-the-secret",
                       algorithm=settings.jwt_algorithm)
    assert et.read_token(other) is None
    login = jwt.encode({"sub": "1", "type": "access", "scope": "customer", "exp": 4102444800},
                       settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    assert et.read_token(login) is None                             # a session token is not a ticket


def test_expired_token_is_rejected():
    expired = jwt.encode({"typ": "eticket", "ref": "JPB000027", "exp": 1}, settings.jwt_secret_key,
                         algorithm=settings.jwt_algorithm)
    assert et.read_token(expired) is None


def test_public_view_has_no_payment_document_or_contact_data():
    v = et.public_view(_booking())
    assert v["valid"] is True and v["passengers"] == ["Nikki Ki"]
    flat = repr(v)
    assert "P1234567" not in flat and "x@y.z" not in flat and "9000000000" not in flat
    assert et.public_view(_booking(status="cancelled"))["valid"] is False


def test_qr_is_an_svg_carrying_the_verify_link():
    url = et.verify_url("https://jackpotsworldtours.com/", et.make_token(_booking()))
    assert url.startswith("https://jackpotsworldtours.com/ticket/verify/")
    svg = et.qr_svg(url)
    assert svg.lstrip().startswith("<?xml") and "<path" in svg


def test_qr_base_url_never_local_on_a_deployed_host(monkeypatch):
    from types import SimpleNamespace as NS
    from app.routers import eticket as router
    req = NS(base_url="http://127.0.0.1:8000/")
    monkeypatch.setattr(settings, "deployed", True)
    for bad in ("", "http://localhost:8420", "https://localhost", "http://jackpotsworldtours.com", "https://127.0.0.1:8000"):
        monkeypatch.setattr(settings, "frontend_base_url", bad)
        assert router._public_base(req) is None, bad          # no QR rather than a dead one
    monkeypatch.setattr(settings, "frontend_base_url", "https://jackpotsworldtours.com")
    assert router._public_base(req) == "https://jackpotsworldtours.com"
    monkeypatch.setattr(settings, "deployed", False)          # dev: falls back to the request host
    monkeypatch.setattr(settings, "frontend_base_url", "http://localhost:8420")
    assert router._public_base(req) == "http://127.0.0.1:8000/"
