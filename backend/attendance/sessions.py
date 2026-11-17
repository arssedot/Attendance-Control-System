from datetime import date, datetime, time, timedelta
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response

from .auth import CurrentUser, Teacher
from .config import MOSCOW
from .db import Db, database_time
from .domain import QrProof, qr_image, session_state, sign_qr, to_micros
from .errors import fail, session_missing
from .models import Lesson, RosterMark, SessionCreate, SessionPatch, SessionView

router = APIRouter()
SESSION_COLUMNS = "id, schedule_id, issued_at, expires_at, late_at, closed_at, qr_version"


def pagination(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> tuple[int, int]:
    return limit, offset


Page = Annotated[tuple[int, int], Depends(pagination)]


def render_session(request: Request, row: dict, now: datetime) -> SessionView:
    state = session_state(row["closed_at"], row["expires_at"], now)
    image = None
    if state == "ACTIVE":
        proof = QrProof(row["id"], row["qr_version"], to_micros(row["issued_at"]), to_micros(row["expires_at"]))
        image = qr_image(sign_qr(proof, request.app.state.settings.qr_key))
    return SessionView.model_validate({**row, "state": state, "qr_image": image, "server_time": now})


@router.get("/schedule", tags=["schedule"])
def schedule(
    conn: Db, user: CurrentUser, page: Page,
    day: Annotated[date | None, Query(alias="date")] = None,
) -> list[Lesson]:
    day = day or datetime.now(MOSCOW).date()
    if not 1970 <= day.year <= 9998:
        fail(422, "INVALID_DATE", "Дата выходит за допустимые границы.")
    start = datetime.combine(day, time.min, MOSCOW)
    end = start + timedelta(days=1)
    owner_column = "sc.teacher_id" if user["role"] == "ROLE_TEACHER" else "sc.group_id"
    owner_id = user["id"] if user["role"] == "ROLE_TEACHER" else user["group_id"]
    now = database_time(conn)
    rows = conn.execute(
        f"""
        SELECT sc.id, sc.subject, sc.room, sc.starts_at, sc.ends_at,
               b.name AS building_name, g.name AS group_name, u.display_name AS teacher_name,
               se.id AS session_id, se.expires_at, se.closed_at, a.student_id IS NOT NULL AS marked
        FROM schedule sc
        JOIN buildings b ON b.id = sc.building_id
        JOIN groups g ON g.id = sc.group_id
        JOIN users u ON u.id = sc.teacher_id
        LEFT JOIN sessions se ON se.schedule_id = sc.id
        LEFT JOIN attendance a ON a.session_id = se.id AND a.student_id = %s
        WHERE {owner_column} = %s AND sc.starts_at >= %s AND sc.starts_at < %s
        ORDER BY sc.starts_at, sc.id LIMIT %s OFFSET %s
        """,
        (user["id"], owner_id, start, end, *page),
    ).fetchall()
    for row in rows:
        row["session_state"] = (
            session_state(row["closed_at"], row["expires_at"], now) if row["session_id"] else None
        )
    return [Lesson.model_validate(row) for row in rows]


@router.post("/sessions", tags=["sessions"], status_code=201, responses={200: {"model": SessionView}})
def open_session(
    payload: SessionCreate, user: Teacher, conn: Db, request: Request, response: Response,
) -> SessionView:
    lesson = conn.execute(
        "SELECT starts_at, ends_at FROM schedule WHERE id = %s AND teacher_id = %s FOR UPDATE",
        (payload.schedule_id, user["id"]),
    ).fetchone()
    if lesson is None:
        fail(404, "SCHEDULE_NOT_FOUND", "Занятие недоступно.")
    existing = conn.execute(
        f"SELECT {SESSION_COLUMNS} FROM sessions WHERE schedule_id = %s", (payload.schedule_id,),
    ).fetchone()
    now = database_time(conn)
    if existing:
        response.status_code = 200
        return render_session(request, existing, now)
    if not lesson["starts_at"] <= now < lesson["ends_at"]:
        fail(409, "OUTSIDE_LESSON", "Регистрацию можно открыть во время занятия.")
    row = conn.execute(
        f"""
        INSERT INTO sessions (id, schedule_id, issued_at, expires_at, late_at, qr_version)
        VALUES (%s, %s, %s, %s, %s, %s) RETURNING {SESSION_COLUMNS}
        """,
        (
            uuid4(), payload.schedule_id, now,
            min(now + timedelta(minutes=payload.ttl_minutes), lesson["ends_at"]),
            lesson["starts_at"] + timedelta(minutes=payload.late_after_minutes), uuid4(),
        ),
    ).fetchone()
    return render_session(request, row, now)


def owned_session(session_id: UUID, teacher_id: UUID, conn: Db, write: bool = False) -> dict:
    lock = "FOR UPDATE OF se" if write else ""
    row = conn.execute(
        f"""
        SELECT se.id, se.schedule_id, se.issued_at, se.expires_at, se.late_at,
               se.closed_at, se.qr_version, sc.starts_at, sc.ends_at
        FROM sessions se JOIN schedule sc ON sc.id = se.schedule_id
        WHERE se.id = %s AND sc.teacher_id = %s {lock}
        """,
        (session_id, teacher_id),
    ).fetchone()
    if row is None:
        session_missing()
    return row


@router.get("/sessions/{session_id}", tags=["sessions"])
def get_session(session_id: UUID, user: Teacher, conn: Db, request: Request) -> SessionView:
    row = owned_session(session_id, user["id"], conn)
    return render_session(request, row, database_time(conn))


@router.patch("/sessions/{session_id}", tags=["sessions"])
def update_session(
    session_id: UUID, payload: SessionPatch, user: Teacher, conn: Db, request: Request,
) -> SessionView:
    row = owned_session(session_id, user["id"], conn, write=True)
    now = database_time(conn)
    if payload.close:
        row = conn.execute(
            f"UPDATE sessions SET closed_at = COALESCE(closed_at, %s) WHERE id = %s RETURNING {SESSION_COLUMNS}",
            (now, session_id),
        ).fetchone()
        return render_session(request, row, now)
    if row["closed_at"] or now >= row["ends_at"]:
        fail(409, "SESSION_CLOSED", "Регистрация завершена.")
    expires_at = row["expires_at"]
    if payload.ttl_minutes is not None:
        expires_at = min(now + timedelta(minutes=payload.ttl_minutes), row["ends_at"])
    if expires_at <= now:
        fail(409, "SESSION_EXPIRED", "Срок истёк. Укажите новый интервал регистрации.")
    late_at = row["late_at"]
    if payload.late_after_minutes is not None:
        late_at = row["starts_at"] + timedelta(minutes=payload.late_after_minutes)
    row = conn.execute(
        f"""
        UPDATE sessions SET issued_at = %s, expires_at = %s, late_at = %s, qr_version = %s
        WHERE id = %s RETURNING {SESSION_COLUMNS}
        """,
        (now, expires_at, late_at, uuid4(), session_id),
    ).fetchone()
    return render_session(request, row, now)


@router.get("/sessions/{session_id}/attendance", tags=["sessions"])
def roster(session_id: UUID, user: Teacher, conn: Db, page: Page) -> list[RosterMark]:
    owned_session(session_id, user["id"], conn)
    rows = conn.execute(
        """
        SELECT a.session_id, se.schedule_id, a.created_at, a.method, a.status, u.display_name AS student_name
        FROM attendance a JOIN users u ON u.id = a.student_id JOIN sessions se ON se.id = a.session_id
        WHERE a.session_id = %s ORDER BY a.created_at, a.student_id LIMIT %s OFFSET %s
        """,
        (session_id, *page),
    ).fetchall()
    return [RosterMark.model_validate(row) for row in rows]
