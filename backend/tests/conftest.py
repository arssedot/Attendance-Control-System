import os

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict

from attendance.app import create_app
from attendance.config import Settings
from attendance.manage import migrate, seed_demo

PASSWORD = "test-only-fixture-password"
QR_KEY = "q" * 64


@pytest.fixture(scope="session")
def database():
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL is required for PostgreSQL integration tests")
    if not conninfo_to_dict(dsn).get("dbname", "").endswith("_test"):
        pytest.fail("TEST_DATABASE_URL must point to a dedicated *_test database")
    with psycopg.connect(dsn) as conn:
        migrate(conn)
    return dsn


@pytest.fixture
def seeded_database(database):
    with psycopg.connect(database) as conn:
        conn.execute("TRUNCATE auth_sessions, attendance, sessions, schedule, buildings, users, groups")
        seed_demo(conn, PASSWORD)
        conn.execute(
            """
            UPDATE schedule SET starts_at = greatest(date_trunc('day', now(), 'Europe/Moscow'), now() - interval '2 minutes'),
                                ends_at = now() + interval '88 minutes'
            WHERE subject LIKE 'Объектно%'
            """
        )
    return database


@pytest.fixture
def client(seeded_database):
    settings = Settings(seeded_database, "a" * 64, QR_KEY, secure_cookies=True)
    with TestClient(create_app(settings), base_url="https://attendance.test") as client:
        yield client
