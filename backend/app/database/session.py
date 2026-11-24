from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

RDS_CA_BUNDLE_PATH = "/etc/ssl/certs/rds-global-bundle.pem"


def _database_connect_args(
    database_url: str,
    *,
    deployed: bool,
    require_ssl: bool = True,
    ca_bundle_path: str = RDS_CA_BUNDLE_PATH,
) -> dict:
    """Require verified TLS for deployed PostgreSQL connections.

    ``require_ssl`` (settings.database_require_ssl) defaults to True so a deployed
    host — production, on RDS — keeps verify-full. It is turned off only for a
    deployed stack whose database is a trusted, network-isolated Postgres with no
    TLS (the staging compose stack), where enforced TLS would fail the connection
    and adds nothing: the container publishes no host port.
    """
    if not deployed or not require_ssl:
        return {}

    if make_url(database_url).get_backend_name() != "postgresql":
        raise RuntimeError(
            "Deployed database connections must use PostgreSQL with verified TLS."
        )

    ca_bundle = Path(ca_bundle_path)
    if not ca_bundle.is_file():
        raise RuntimeError(f"Required RDS CA bundle is missing: {ca_bundle}")

    return {
        "sslmode": "verify-full",
        "sslrootcert": str(ca_bundle),
    }


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    connect_args=_database_connect_args(
        settings.database_url,
        deployed=settings.deployed,
        require_ssl=settings.database_require_ssl,
    ),
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
