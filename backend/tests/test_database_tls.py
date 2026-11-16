import pytest

from app.database.session import _database_connect_args


def test_local_sqlite_does_not_enable_tls():
    assert _database_connect_args(
        "sqlite:///./test.db",
        deployed=False,
    ) == {}


def test_deployed_postgres_requires_verified_tls(tmp_path):
    ca_bundle = tmp_path / "global-bundle.pem"
    ca_bundle.write_text("test certificate placeholder")

    result = _database_connect_args(
        "postgresql+psycopg2://user:password@example.test:5432/database",
        deployed=True,
        ca_bundle_path=str(ca_bundle),
    )

    assert result == {
        "sslmode": "verify-full",
        "sslrootcert": str(ca_bundle),
    }


def test_deployed_postgres_fails_if_ca_bundle_is_missing(tmp_path):
    missing_bundle = tmp_path / "missing.pem"

    with pytest.raises(RuntimeError, match="CA bundle is missing"):
        _database_connect_args(
            "postgresql+psycopg2://user:password@example.test:5432/database",
            deployed=True,
            ca_bundle_path=str(missing_bundle),
        )


def test_deployed_non_postgres_database_is_rejected():
    with pytest.raises(RuntimeError, match="must use PostgreSQL"):
        _database_connect_args(
            "sqlite:///./test.db",
            deployed=True,
        )
