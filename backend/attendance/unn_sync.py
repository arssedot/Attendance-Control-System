import argparse
import logging
import os
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from time import sleep
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from .config import MOSCOW
from .unn_source import Lesson, SourceError, UnnSchedule, external_id, monday, normalized

LOG = logging.getLogger("attendance.unn")
NETWORK_ERRORS = (OSError, SourceError, UnicodeError)
REQUEST_PAUSE = 0.3


def building_key(name: str) -> str:
    return normalized(name).casefold()


def reconcile(
    conn: psycopg.Connection, group: dict, week: date, lessons: list[Lesson],
    teacher_events: dict[int, set[int]],
) -> tuple[int, int]:
    """Atomically reconcile one valid response, keeping established attendance sessions attached."""
    with conn.transaction():
        bound = conn.execute(
            "SELECT unn_id, unn_code FROM groups WHERE id = %s FOR UPDATE",
            (group["id"],),
        ).fetchone()
        if bound != {key: group[key] for key in ("unn_id", "unn_code")}:
            raise SourceError("Group binding changed during sync")

        owners: dict[int, list[UUID]] = defaultdict(list)
        for row in conn.execute("SELECT id, unn_id FROM users WHERE unn_id IS NOT NULL FOR SHARE"):
            for event_id in teacher_events.get(row["unn_id"], ()):
                owners[event_id].append(row["id"])
        buildings = {
            row["unn_name"]: row["id"]
            for row in conn.execute("SELECT id, unn_name FROM buildings WHERE unn_name IS NOT NULL")
        }
        start = datetime.combine(week, time.min, MOSCOW)
        end = start + timedelta(days=7)
        active_ids = {lesson.id for lesson in lessons}
        rows = conn.execute(
            """
            SELECT id, unn_event_id FROM schedule
            WHERE group_id = %s AND unn_event_id IS NOT NULL
              AND ((starts_at >= %s AND starts_at < %s) OR unn_event_id = ANY(%s))
            ORDER BY unn_event_id FOR UPDATE
            """,
            (group["id"], start, end, list(active_ids)),
        ).fetchall()
        protected = {
            row["schedule_id"] for row in conn.execute(
                "SELECT schedule_id FROM sessions WHERE schedule_id = ANY(%s)",
                ([row["id"] for row in rows],),
            )
        }
        existing = {row["unn_event_id"]: row["id"] for row in rows}
        changed = 0
        for lesson in lessons:
            if existing.get(lesson.id) in protected:
                continue
            teachers = owners[lesson.id]
            teacher = teachers[0] if len(teachers) == 1 else None
            changed += conn.execute(
                """
                INSERT INTO schedule
                    (id, group_id, unn_event_id, teacher_id, building_id, subject, room, starts_at, ends_at,
                     unn_teacher_name, unn_building_name)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (group_id, unn_event_id) DO UPDATE SET
                    teacher_id = excluded.teacher_id, building_id = excluded.building_id,
                    subject = excluded.subject, room = excluded.room, starts_at = excluded.starts_at,
                    ends_at = excluded.ends_at, unn_teacher_name = excluded.unn_teacher_name,
                    unn_building_name = excluded.unn_building_name, unn_cancelled = false
                WHERE (schedule.teacher_id, schedule.building_id, schedule.subject, schedule.room,
                       schedule.starts_at, schedule.ends_at, schedule.unn_teacher_name,
                       schedule.unn_building_name, schedule.unn_cancelled) IS DISTINCT FROM
                      (excluded.teacher_id, excluded.building_id, excluded.subject, excluded.room,
                       excluded.starts_at, excluded.ends_at, excluded.unn_teacher_name,
                       excluded.unn_building_name, false)
                """,
                (
                    uuid4(), group["id"], lesson.id, teacher, buildings.get(building_key(lesson.building)),
                    lesson.subject, lesson.room, lesson.starts_at, lesson.ends_at, lesson.teacher, lesson.building,
                ),
            ).rowcount
        missing = [row["id"] for row in rows if row["unn_event_id"] not in active_ids and row["id"] not in protected]
        cancelled = conn.execute(
            "UPDATE schedule SET unn_cancelled = true WHERE id = ANY(%s) AND NOT unn_cancelled", (missing,),
        ).rowcount
        return changed, cancelled


def bound_groups(conn: psycopg.Connection) -> list[dict]:
    return conn.execute(
        "SELECT id, unn_id, unn_code FROM groups WHERE unn_id IS NOT NULL ORDER BY unn_id",
    ).fetchall()


def sync(conn: psycopg.Connection, source: UnnSchedule, first_week: date, weeks: int) -> bool:
    groups = bound_groups(conn)
    if not groups:
        LOG.info("No groups are linked to UNN")
        return True
    teachers = [row["unn_id"] for row in conn.execute("SELECT unn_id FROM users WHERE unn_id IS NOT NULL ORDER BY unn_id")]
    complete = True
    for offset in range(weeks):
        week = first_week + timedelta(weeks=offset)
        teacher_events = {}
        try:
            for identifier in teachers:
                teacher_events[identifier] = source.teacher_week(week, identifier)
                sleep(REQUEST_PAUSE)
        except NETWORK_ERRORS as error:
            LOG.warning("UNN teacher schedule unavailable week=%s error=%s", week, type(error).__name__)
            complete = False
            continue

        for group in groups:
            try:
                lessons = source.group_week(week, group["unn_id"], group["unn_code"])
                changed, cancelled = reconcile(conn, group, week, lessons, teacher_events)
                LOG.info(
                    "UNN group=%s week=%s lessons=%d updated=%d cancelled=%d",
                    group["unn_code"], week, len(lessons), changed, cancelled,
                )
            except (*NETWORK_ERRORS, psycopg.Error) as error:
                LOG.warning("UNN sync failed group=%s week=%s error=%s", group["unn_code"], week, type(error).__name__)
                complete = False
            finally:
                sleep(REQUEST_PAUSE)
    return complete


def bind_group(conn: psycopg.Connection, unn_id: int, code: str, local_name: str | None):
    name = normalized(local_name) if local_name else code
    if not name:
        raise SourceError("Local group name is empty")
    result = conn.execute(
        """
        INSERT INTO groups (id, name, unn_id, unn_code) VALUES (%s, %s, %s, %s)
        ON CONFLICT (name) DO UPDATE SET unn_id = excluded.unn_id, unn_code = excluded.unn_code
        WHERE groups.unn_id IS NULL OR groups.unn_id = excluded.unn_id
        """,
        (uuid4(), name, unn_id, code),
    )
    if not result.rowcount:
        raise SourceError("Local group is already linked to a different UNN group")


def configure(conn: psycopg.Connection, args, source: UnnSchedule, today: date):
    if args.command == "bind-group":
        code = source.catalog("group", today).get(args.identifier)
        if not code:
            raise SourceError("UNN group not found")
        bind_group(conn, args.identifier, code, args.local_name)
    elif args.command == "bind-teacher":
        if args.identifier not in source.catalog("teacher", today):
            raise SourceError("UNN teacher not found")
        updated = conn.execute(
            "UPDATE users SET unn_id = %s WHERE login = %s AND role = 'ROLE_TEACHER'",
            (args.identifier, args.login.lower()),
        )
        if not updated.rowcount:
            raise SourceError("Local teacher account not found")
    elif args.command == "bind-building":
        source_name = building_key(args.source_name)
        if not source_name:
            raise SourceError("Source building name is empty")
        updated = conn.execute(
            "UPDATE buildings SET unn_name = %s WHERE name = %s",
            (source_name, args.local_name),
        )
        if not updated.rowcount:
            raise SourceError("Local building not found")


def main():
    parser = argparse.ArgumentParser(description="Synchronize the official UNN schedule")
    commands = parser.add_subparsers(dest="command", required=True)
    catalog = commands.add_parser("catalog")
    catalog.add_argument("kind", choices=("group", "teacher"))
    catalog.add_argument("search")
    group = commands.add_parser("bind-group")
    group.add_argument("identifier", type=external_id)
    group.add_argument("--local-name")
    teacher = commands.add_parser("bind-teacher")
    teacher.add_argument("login")
    teacher.add_argument("identifier", type=external_id)
    building = commands.add_parser("bind-building")
    building.add_argument("local_name")
    building.add_argument("source_name")
    once = commands.add_parser("sync")
    once.add_argument("--date", type=date.fromisoformat)
    once.add_argument("--weeks", type=int, choices=range(1, 5), default=2)
    worker = commands.add_parser("worker")
    worker.add_argument("--interval", type=int, default=1800)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    source = UnnSchedule()
    today = datetime.now(MOSCOW).date()
    try:
        if args.command == "catalog":
            for identifier, label in source.catalog(args.kind, today).items():
                if args.search.casefold() in label.casefold():
                    print(f"{identifier}\t{label}")
            return
        dsn = os.environ["DATABASE_URL"]
        if args.command == "worker":
            if args.interval < 300:
                parser.error("worker interval must be at least 300 seconds")
            while True:
                try:
                    with psycopg.connect(dsn, row_factory=dict_row, autocommit=True, connect_timeout=5) as conn:
                        sync(conn, source, monday(datetime.now(MOSCOW).date()), 2)
                except psycopg.Error as error:
                    LOG.warning("UNN worker database failure error=%s", type(error).__name__)
                sleep(args.interval)
        else:
            with psycopg.connect(dsn, row_factory=dict_row, autocommit=True, connect_timeout=5) as conn:
                if args.command == "sync":
                    if not sync(conn, source, monday(args.date or today), args.weeks):
                        raise SystemExit(1)
                else:
                    configure(conn, args, source, today)
    except (*NETWORK_ERRORS, psycopg.Error) as error:
        LOG.error("UNN command failed: %s", error if isinstance(error, SourceError) else type(error).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
