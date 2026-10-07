"""Customer notifications: written once per event, counted, and per-customer."""
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerNotification
from app.services import customer_account_service as acct
from tests.conftest import _next_id


def _make_table(db: Session):
    CustomerNotification.__table__.create(db.get_bind(), checkfirst=True)


def _other_customer(db):
    c = Customer(customer_id=_next_id(), customer_code="CUST0002", full_name="Other",
                 email="other@example.test", mobile="9000000001")
    db.add(c)
    db.flush()
    return c




def test_notify_is_idempotent_per_event(db, customer, monkeypatch):
    _make_table(db)
    # SQLite has no identity sequence for BigInteger PKs: supply the id.
    orig = CustomerNotification.__init__

    def init(self, **kw):
        kw.setdefault("customer_notification_id", _next_id())
        orig(self, **kw)
    monkeypatch.setattr(CustomerNotification, "__init__", init)

    for _ in range(3):
        acct.notify(db, customer.customer_id, "booking_payment", "Payment recorded",
                    "msg", related_ref="JPB000024")
    acct.notify(db, customer.customer_id, "booking_created", "Booking received",
                "msg", related_ref="JPB000024")
    acct.notify(db, customer.customer_id, "general", "Welcome", "hi")
    acct.notify(db, customer.customer_id, "general", "Welcome", "hi")
    assert len(acct.list_notifications(db, customer)) == 3


def test_unread_count_mark_read_and_isolation(db, customer, monkeypatch):
    _make_table(db)
    orig = CustomerNotification.__init__

    def init(self, **kw):
        kw.setdefault("customer_notification_id", _next_id())
        orig(self, **kw)
    monkeypatch.setattr(CustomerNotification, "__init__", init)

    other = _other_customer(db)
    a = acct.notify(db, customer.customer_id, "general", "One", "m", related_ref="R1")
    acct.notify(db, customer.customer_id, "general", "Two", "m", related_ref="R2")
    acct.notify(db, other.customer_id, "general", "Theirs", "m", related_ref="R3")

    assert acct.unread_notification_count(db, customer) == 2
    assert acct.unread_notification_count(db, other) == 1

    # Another customer cannot even look up this one's notification.
    assert acct.get_owned_notification(db, other, a.customer_notification_id) is None

    acct.mark_read(db, acct.get_owned_notification(db, customer, a.customer_notification_id))
    assert acct.unread_notification_count(db, customer) == 1
    acct.mark_all_read(db, customer)
    assert acct.unread_notification_count(db, customer) == 0
    assert acct.unread_notification_count(db, other) == 1
