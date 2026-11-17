"""Back up the Compose database or verify a dump in a new database."""

import argparse
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

COMPOSE = ["docker", "compose", "exec", "-T", "db"]
ROOT = Path(__file__).resolve().parents[1]


def backup(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = directory / f"attendance-{stamp}-{uuid4().hex[:8]}.dump"
    partial = target.with_suffix(".pending")
    try:
        with open(partial, "xb") as output:
            subprocess.run(
                [*COMPOSE, "pg_dump", "-U", "postgres", "-Fc", "--no-owner", "--no-acl", "attendance"],
                cwd=ROOT, stdout=output, check=True,
            )
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def verify(dump: Path):
    name = f"attendance_restore_{uuid4().hex[:12]}"
    with open(dump, "rb") as source:
        subprocess.run([*COMPOSE, "createdb", "-U", "postgres", "-O", "attendance", name], cwd=ROOT, check=True)
        subprocess.run(
            [*COMPOSE, "pg_restore", "-U", "postgres", "--role=attendance", "--no-owner", "--no-acl",
             "--exit-on-error", "--single-transaction", "-d", name],
            stdin=source, cwd=ROOT, check=True,
        )
    query = """
        SELECT (SELECT count(*) FROM users) AS users,
               (SELECT count(*) FROM schedule) AS lessons,
               (SELECT count(*) FROM attendance) AS marks,
               (SELECT count(*) FROM pg_constraint
                WHERE conrelid = 'attendance'::regclass AND contype = 'p') AS attendance_primary_keys
    """
    subprocess.run(
        [*COMPOSE, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-d", name, "-c", query],
        cwd=ROOT, check=True,
    )
    print(f"Restored into {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--directory", type=Path, default=ROOT / "backups")
    restore = commands.add_parser("verify")
    restore.add_argument("dump", type=Path)
    args = parser.parse_args()
    if args.command == "create":
        print(backup(args.directory))
    else:
        verify(args.dump)


if __name__ == "__main__":
    main()
