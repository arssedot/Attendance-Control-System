from uuid import UUID

from fastapi import APIRouter, Request

from .auth import Student
from .db import Db, database_time
from .domain import QrProof, distance_m, read_qr, to_micros
from .errors import fail, session_missing
from .models import GeoMark, HistoryMark, Mark, QrMark
from .sessions import Page

router = APIRouter(tags=["attendance"])
MARK_COLUMNS = "session_id, created_at, method, status"


def existing_mark(conn: Db, session_id: UUID, student_id: UUID) -> dict | None:
    return conn.execute(
        f"SELECT {MARK_COLUMNS} FROM attendance WHERE session_id = %s AND student_id = %s",
        (session_id, student_id),
    ).fetchone()


def register(conn: Db, user: dict, *, qr: QrProof | None = None, geo: GeoMark | None = None) -> Mark:
    selector, target = ("se.id", qr.session_id) if qr else ("sc.id", geo.schedule_id)
    row = conn.execute(
        f"""
        SELECT se.id, se.schedule_id, se.issued_at, se.expires_at, se.late_at, se.closed_at, se.qr_version,
               sc.starts_at, sc.ends_at, b.latitude, b.longitude, b.radius_m, b.max_accuracy_m
        FROM sessions se
        JOIN schedule sc ON sc.id = se.schedule_id JOIN buildings b ON b.id = sc.building_id
        WHERE {selector} = %s AND sc.group_id = %s FOR SHARE OF se
        """,
        (target, user["group_id"]),
    ).fetchone()
    if row is None:
        session_missing()
    previous = existing_mark(conn, row["id"], user["id"])
    if previous:
        return Mark.model_validate({**previous, "schedule_id": row["schedule_id"]})
    now = database_time(conn)
    if row["closed_at"] is not None:
        fail(409, "SESSION_CLOSED", "Преподаватель завершил регистрацию.")
    if not row["starts_at"] <= now < min(row["expires_at"], row["ends_at"]):
        fail(409, "SESSION_EXPIRED", "Время регистрации истекло. Обратитесь к преподавателю.")
    if qr and (
        qr.version != row["qr_version"]
        or qr.issued_us != to_micros(row["issued_at"])
        or qr.expires_us != to_micros(row["expires_at"])
        or not qr.issued_us <= to_micros(now) < qr.expires_us
    ):
        fail(422, "QR_EXPIRED", "Сканируйте актуальный QR-код с экрана преподавателя.")
    if geo:
        if geo.horizontal_accuracy > row["max_accuracy_m"]:
            fail(422, "GEO_INACCURATE", "Точность геолокации слишком низкая. Повторите попытку у окна.")
        distance = distance_m(geo.latitude, geo.longitude, row["latitude"], row["longitude"])
        if distance + geo.horizontal_accuracy > row["radius_m"]:
            fail(422, "GEO_OUTSIDE", "Не удалось подтвердить ваше присутствие в геозоне корпуса.")
    inserted = conn.execute(
        f"""
        INSERT INTO attendance (session_id, student_id, created_at, method, status)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (session_id, student_id) DO NOTHING RETURNING {MARK_COLUMNS}
        """,
        (row["id"], user["id"], now, "QR" if qr else "GEO", "PRESENT" if now <= row["late_at"] else "LATE"),
    ).fetchone()
    if inserted and geo:
        conn.execute(
            """
            INSERT INTO attendance_geolocations (session_id, student_id, latitude, longitude, horizontal_accuracy)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (row["id"], user["id"], geo.latitude, geo.longitude, geo.horizontal_accuracy),
        )
    result = inserted or existing_mark(conn, row["id"], user["id"])
    return Mark.model_validate({**result, "schedule_id": row["schedule_id"]})


@router.post("/attendance/qr")
def mark_by_qr(payload: QrMark, request: Request, conn: Db, user: Student) -> Mark:
    try:
        proof = read_qr(payload.token, request.app.state.settings.qr_key)
    except ValueError:
        fail(422, "INVALID_QR", "Это не QR-код Attendance. Сканируйте код занятия.")
    return register(conn, user, qr=proof)


@router.post("/attendance/geo")
def mark_by_geo(payload: GeoMark, conn: Db, user: Student) -> Mark:
    return register(conn, user, geo=payload)


@router.get("/student/attendance")
def history(conn: Db, user: Student, page: Page) -> list[HistoryMark]:
    rows = conn.execute(
        """
        SELECT a.session_id, se.schedule_id, a.created_at, a.method, a.status, sc.subject, sc.starts_at
        FROM attendance a JOIN sessions se ON se.id = a.session_id JOIN schedule sc ON sc.id = se.schedule_id
        WHERE a.student_id = %s ORDER BY a.created_at DESC, a.session_id LIMIT %s OFFSET %s
        """,
        (user["id"], *page),
    ).fetchall()
    return [HistoryMark.model_validate(row) for row in rows]
