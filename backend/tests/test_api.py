from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from uuid import UUID, uuid4

import psycopg
import pytest
from conftest import PASSWORD, QR_KEY
from fastapi.testclient import TestClient

from attendance.auth import hasher
from attendance.config import MOSCOW
from attendance.domain import QrProof, sign_qr, to_micros
from attendance.manage import DEMO_GROUP

PREFIX = "/api/v1"
GEO = {"latitude": 56.2955, "longitude": 43.9833, "horizontal_accuracy": 8}


def login(client, name, user_type):
    response = client.post(f"{PREFIX}/auth/login", json={"login": name, "password": PASSWORD, "client": user_type})
    assert response.status_code == 200, response.text
    return response.json(), response


def headers(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def current_lesson(client, teacher):
    current = client.get(f"{PREFIX}/schedule", headers=teacher, params={"date": datetime.now(MOSCOW).date()})
    assert current.status_code == 200, current.text
    return next(lesson for lesson in current.json() if lesson["subject"].startswith("Объектно"))


def open_lesson(client, teacher, lesson_id, **values):
    response = client.post(f"{PREFIX}/sessions", json={"schedule_id": lesson_id, **values}, headers=teacher)
    assert response.status_code == 201, response.text
    return response.json()


def qr_token(dsn, session):
    with psycopg.connect(dsn) as conn:
        version = conn.execute("SELECT qr_version FROM sessions WHERE id = %s", (session["id"],)).fetchone()[0]
    return sign_qr(
        QrProof(UUID(session["id"]), version, *(to_micros(datetime.fromisoformat(session[key]))
                                               for key in ("issued_at", "expires_at"))),
        QR_KEY,
    )


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["code"] == code
    assert response.json()["request_id"] == response.headers["x-request-id"]


def test_qr_flow_is_idempotent_and_private(client, seeded_database):
    teacher = headers(login(client, "teacher", "web")[0])
    student = headers(login(client, "student", "mobile")[0])
    outsider = headers(login(client, "other", "mobile")[0])
    lesson = current_lesson(client, teacher)
    session = open_lesson(client, teacher, lesson["id"])
    assert session["qr_image"].startswith("data:image/png;base64,")
    repeated = client.post(f"{PREFIX}/sessions", headers=teacher, json={"schedule_id": lesson["id"]})
    assert repeated.status_code == 200
    assert repeated.json()["id"] == session["id"]
    token = qr_token(seeded_database, session)
    route = f"{PREFIX}/attendance/qr"
    payload = {"token": token, **GEO}
    assert_error(client.post(route, json=payload, headers=outsider), 404, "SESSION_NOT_FOUND")
    assert_error(client.post(route, json=payload, headers=teacher), 403, "ROLE_FORBIDDEN")
    assert_error(client.post(route, json={"token": token}, headers=student), 422, "VALIDATION_ERROR")
    assert_error(client.post(route, json={**payload, "student_id": str(uuid4())}, headers=student), 422, "VALIDATION_ERROR")
    assert_error(client.post(route, json={**payload, "latitude": 56.30}, headers=student), 422, "GEO_OUTSIDE")
    preview = client.post(route + "/preview", json={"token": token}, headers=student)
    assert preview.status_code == 200
    assert preview.json()["student_name"] == "Илья Соколов"
    assert preview.json()["mark"] is None
    assert client.get(f"{PREFIX}/student/attendance", headers=student).json() == []
    first = client.post(route, json=payload, headers=student)
    second = client.post(route, json=payload, headers=student)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["status"] == "PRESENT"
    roster = f"{PREFIX}/sessions/{session['id']}/attendance"
    assert_error(client.get(roster, headers=student), 403, "ROLE_FORBIDDEN")
    row, = client.get(roster, headers=teacher).json()
    assert row["student_name"] == "Илья Соколов"
    assert row["has_location"] is False
    assert_error(client.get(f"{roster}/{row['student_id']}/location", headers=teacher), 404, "LOCATION_NOT_FOUND")
    assert client.get(f"{PREFIX}/student/attendance", headers=student).json()[0]["method"] == "QR"
    assert client.get(f"{PREFIX}/student/attendance", headers=outsider).json() == []
    assert current_lesson(client, student)["marked"] is True
    assert current_lesson(client, teacher)["marked"] is False


def test_geo_and_late_cutoff(client, seeded_database):
    teacher = headers(login(client, "teacher", "web")[0])
    student = headers(login(client, "student", "mobile")[0])
    lesson = current_lesson(client, teacher)
    session = open_lesson(client, teacher, lesson["id"], late_after_minutes=0)
    route = f"{PREFIX}/attendance/geo"
    values = {**GEO, "schedule_id": lesson["id"]}
    assert_error(client.post(route, json={**values, "horizontal_accuracy": 60}, headers=student), 422, "GEO_INACCURATE")
    assert_error(client.post(route, json={**values, "latitude": 56.30}, headers=student), 422, "GEO_OUTSIDE")
    assert_error(client.post(route, json={**values, "latitude": 94}, headers=student), 422, "VALIDATION_ERROR")
    result = client.post(route, json=values, headers=student)
    assert result.status_code == 200
    assert result.json()["status"] == "LATE"
    assert result.json()["method"] == "GEO"
    repeated = client.post(route, json={**values, "horizontal_accuracy": 12}, headers=student)
    assert repeated.json() == result.json()
    roster = f"{PREFIX}/sessions/{session['id']}/attendance"
    row, = client.get(roster, headers=teacher).json()
    assert row["has_location"] is True
    assert "latitude" not in row
    assert "latitude" not in client.get(f"{PREFIX}/student/attendance", headers=student).json()[0]
    location = f"{roster}/{row['student_id']}/location"
    assert_error(client.get(location, headers=student), 403, "ROLE_FORBIDDEN")
    assert client.patch(f"{PREFIX}/sessions/{session['id']}", json={"close": True}, headers=teacher).status_code == 200
    stored = client.get(location, headers=teacher)
    assert stored.status_code == 200
    assert stored.headers["cache-control"] == "no-store"
    assert stored.json() == {**GEO, "building_name": "Учебный корпус 1"}
    with psycopg.connect(seeded_database) as conn:
        columns = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance'"
        ).fetchall()
        conn.execute("DELETE FROM attendance_geolocations")  # Legacy marks have no saved coordinates.
    assert {column[0] for column in columns} == {"session_id", "student_id", "created_at", "method", "status"}
    assert client.get(roster, headers=teacher).json()[0]["has_location"] is False
    assert_error(client.get(location, headers=teacher), 404, "LOCATION_NOT_FOUND")


def test_rotation_close_expiry_and_foreign_teacher(client, seeded_database):
    with psycopg.connect(seeded_database) as conn:
        conn.execute(
            "INSERT INTO users (id, login, display_name, password_hash, role) VALUES (%s, %s, %s, %s, 'ROLE_TEACHER')",
            (uuid4(), "other_teacher", "Преподаватель другой группы", hasher.hash(PASSWORD)),
        )
    teacher = headers(login(client, "teacher", "web")[0])
    other_teacher = headers(login(client, "other_teacher", "web")[0])
    student = headers(login(client, "student", "mobile")[0])
    lesson = current_lesson(client, teacher)
    assert_error(client.post(f"{PREFIX}/sessions", headers=other_teacher, json={"schedule_id": lesson["id"]}),
                 404, "SCHEDULE_NOT_FOUND")
    session = open_lesson(client, teacher, lesson["id"], ttl_minutes=1)
    path = f"{PREFIX}/sessions/{session['id']}"
    assert_error(client.get(path, headers=other_teacher), 404, "SESSION_NOT_FOUND")
    assert_error(client.get(path + "/attendance", headers=other_teacher), 404, "SESSION_NOT_FOUND")
    assert_error(
        client.get(path + f"/attendance/{uuid4()}/location", headers=other_teacher), 404, "SESSION_NOT_FOUND"
    )
    assert_error(client.patch(path, json={"close": True}, headers=other_teacher), 404, "SESSION_NOT_FOUND")
    original = qr_token(seeded_database, session)
    updated = client.patch(path, json={"ttl_minutes": 30, "late_after_minutes": 7}, headers=teacher)
    assert updated.status_code == 200
    assert updated.json()["qr_image"] != session["qr_image"]
    assert datetime.fromisoformat(updated.json()["expires_at"]) > datetime.fromisoformat(session["expires_at"])
    route = f"{PREFIX}/attendance/qr"
    assert_error(client.post(route, json={"token": original, **GEO}, headers=student), 422, "QR_EXPIRED")
    assert_error(client.post(route, json={"token": "invalid", **GEO}, headers=student), 422, "INVALID_QR")
    with psycopg.connect(seeded_database) as conn:
        conn.execute(
            "UPDATE sessions SET issued_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE id = %s",
            (session["id"],),
        )
    assert client.get(path, headers=teacher).json()["state"] == "EXPIRED"
    assert_error(client.post(route, json={"token": original, **GEO}, headers=student), 409, "SESSION_EXPIRED")
    assert client.patch(path, json={"ttl_minutes": 5}, headers=teacher).json()["state"] == "ACTIVE"
    assert client.patch(path, json={"close": True}, headers=teacher).json()["state"] == "CLOSED"
    assert_error(client.post(route, json={"token": original, **GEO}, headers=student), 409, "SESSION_CLOSED")
    assert_error(client.patch(path, json={"ttl_minutes": 10}, headers=teacher), 409, "SESSION_CLOSED")
    assert client.get(path + "/attendance", headers=teacher).json() == []


def test_refresh_rotation_logout_and_rate_limit(client):
    web, response = login(client, "teacher", "web")
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert "refresh_token" not in web
    assert client.post(f"{PREFIX}/auth/refresh", json={}).status_code == 200
    mobile, _ = login(client, "student", "mobile")
    payload = {"refresh_token": mobile["refresh_token"]}
    rotated = client.post(f"{PREFIX}/auth/refresh", json=payload)
    assert rotated.status_code == 200
    assert rotated.json()["refresh_token"] != mobile["refresh_token"]
    assert_error(client.post(f"{PREFIX}/auth/refresh", json=payload), 401, "UNAUTHENTICATED")
    assert client.post(f"{PREFIX}/auth/logout", json={"refresh_token": rotated.json()["refresh_token"]}).status_code == 204
    assert_error(client.get(f"{PREFIX}/schedule", headers=headers(mobile)), 401, "UNAUTHENTICATED")
    for _ in range(18):
        assert_error(client.post(f"{PREFIX}/auth/login", json={}), 422, "VALIDATION_ERROR")
    limited = client.post(f"{PREFIX}/auth/login", json={})
    assert_error(limited, 429, "RATE_LIMITED")
    assert int(limited.headers["retry-after"]) > 0


@pytest.mark.parametrize("class_size", [24])
def test_concurrent_registration_preserves_all_distinct_students(client, seeded_database, class_size):
    names = [f"cohort{index:02}" for index in range(class_size)]
    password_hash = hasher.hash(PASSWORD)
    with psycopg.connect(seeded_database) as conn, conn.cursor() as cursor:
        cursor.executemany(
            """
                INSERT INTO users (id, login, display_name, password_hash, role, group_id)
                VALUES (%s, %s, %s, %s, 'ROLE_STUDENT', %s)
                """,
            [(uuid4(), name, name, password_hash, DEMO_GROUP) for name in names],
        )
    teacher = headers(login(client, "teacher", "web")[0])
    lesson = current_lesson(client, teacher)
    session = open_lesson(client, teacher, lesson["id"])
    token = qr_token(seeded_database, session)
    students = [
        headers(login(TestClient(client.app, client=(f"10.0.2.{index + 1}", 48123)), name, "mobile")[0])
        for index, name in enumerate(names)
    ]

    def mark(student):
        response = client.post(f"{PREFIX}/attendance/qr", json={"token": token, **GEO}, headers=student)
        assert response.status_code == 200, response.text
        return response.json()

    with ThreadPoolExecutor(max_workers=24) as workers:
        results = list(workers.map(mark, [students[0]] * 8 + students))
    assert results[:9] == [results[0]] * 9
    roster = client.get(f"{PREFIX}/sessions/{session['id']}/attendance?limit=100", headers=teacher).json()
    assert sorted(row["student_name"] for row in roster) == names
