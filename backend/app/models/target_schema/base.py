from sqlalchemy.orm import DeclarativeBase


class TargetBase(DeclarativeBase):
    """A dedicated declarative base/registry for the target 9-table schema.

    Deliberately NOT the same Base as app.database.session.Base (the legacy
    models). Importing app.models.target_schema unavoidably triggers Python
    to first run app/models/__init__.py (parent-package import order), which
    registers the legacy User/Payment/ServiceRequest classes — sharing one
    Base's registry with this package would make those class names ambiguous
    to SQLAlchemy's string-based relationship resolution (confirmed via
    `configure_mappers()` raising InvalidRequestError during development).
    A separate registry keeps this package's name resolution fully isolated
    regardless of what else is loaded in the same process. Session/engine
    usage (backend/app/services/target_schema/*) is unaffected — a Session
    isn't tied to a particular declarative base.
    """


Base = TargetBase
