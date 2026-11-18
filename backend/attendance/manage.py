import argparse
import hashlib
import os
from pathlib import Path
from uuid import UUID

import psycopg

from .auth import hasher

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_LOCK = 203807243
DEMO_GROUP = UUID("10000000-0000-0000-0000-000000000001")
OTHER_GROUP = UUID("10000000-0000-0000-0000-000000000002")


def migrate(conn: psycopg.Connection, down: bool = False):
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY,
            checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    applied = dict(conn.execute("SELECT version, checksum FROM schema_migrations").fetchall())
    migrations = sorted((ROOT / "migrations").glob("*.up.sql"))
    versions = {path.name.removesuffix(".up.sql"): path for path in migrations}
    for version, expected in applied.items():
        path = versions.get(version)
        if path is None or checksum(path) != expected:
            raise RuntimeError(f"Applied migration is missing or changed: {version}")

    if down:
        if applied:
            version = max(applied)
            path = versions[version].with_name(f"{version}.down.sql")
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("DELETE FROM schema_migrations WHERE version = %s", (version,))
        return

    for version, path in versions.items():
        if version not in applied:
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)", (version, checksum(path)))


def checksum(path: Path) -> str:
    return hashlib.sha256(path.read_text(encoding="utf-8").encode()).hexdigest()


def seed_demo(conn: psycopg.Connection, password: str):
    if not 12 <= len(password) <= 256:
        raise ValueError("DEMO_PASSWORD must be between 12 and 256 characters")
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
    conn.execute((ROOT / "fixtures" / "demo_reference.sql").read_text(encoding="utf-8"))
    accounts = [
        ("20000000-0000-0000-0000-000000000001", "teacher", "Анна Морозова", "ROLE_TEACHER", None),
        ("20000000-0000-0000-0000-000000000002", "student", "Илья Соколов", "ROLE_STUDENT", DEMO_GROUP),
        ("20000000-0000-0000-0000-000000000003", "student2", "Мария Новикова", "ROLE_STUDENT", DEMO_GROUP),
        ("20000000-0000-0000-0000-000000000004", "other", "Олег Волков", "ROLE_STUDENT", OTHER_GROUP),
    ]
    with conn.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO users (id, login, display_name, role, group_id, password_hash)
            VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING
            """,
            [(*account, hasher.hash(password)) for account in accounts],
        )
    conn.execute((ROOT / "fixtures" / "demo_schedule.sql").read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Manage the Attendance database")
    parser.add_argument("command", choices=("migrate", "downgrade", "seed-demo"))
    args = parser.parse_args()
    with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=5) as conn:
        if args.command == "seed-demo":
            seed_demo(conn, os.environ["DEMO_PASSWORD"])
        else:
            migrate(conn, down=args.command == "downgrade")


if __name__ == "__main__":
    main()
