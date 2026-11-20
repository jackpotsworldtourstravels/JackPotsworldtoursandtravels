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
    ca_bundle_path: str = RDS_CA_BUNDLE_PATH,
) -> dict:
    """Require verified TLS for deployed PostgreSQL connections."""
    if not deployed:
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
