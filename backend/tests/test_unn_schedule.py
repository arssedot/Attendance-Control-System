import json
from dataclasses import replace
from datetime import date, datetime, timedelta
from urllib.error import URLError

import psycopg
import pytest
from psycopg.rows import dict_row
from test_api import GEO, PREFIX, headers, login

from attendance.config import MOSCOW
from attendance.manage import DEMO_GROUP
from attendance.unn_source import Lesson, SourceError, monday, parse_week
from attendance.unn_sync import bind_group, bound_groups, building_key, reconcile, sync

OFFICIAL_ID = 281474976700010
CODE = "ТЕСТ-01"
PROVIDER_WEEK = date(2026, 11, 16)


def test_university_parser_reads_json_and_moscow_times():
    events = [{
        "id": "5146",
        "resourceId": f"{CODE}, ТЕСТ-02",
        "tooltip": "Проект [A]<br>Иванов И. И.<br>Корпус № 4, зал, 2 этаж<br>09:00:00-10:30:00",
        "start": "2026-11-18T09:00:00",
        "end": "2026-11-18T10:30:00",
    }]
    html = "<script>\ndefaultDate: '2026-11-16',\nevents: " + json.dumps(events) + ",\n</script>"
    lesson, = parse_week(html, PROVIDER_WEEK, CODE)
    assert (lesson.id, lesson.subject, lesson.building, lesson.room) == (5146, "Проект [A]", "Корпус № 4", "зал, 2 этаж")
    assert lesson.starts_at.isoformat() == "2026-11-18T09:00:00+03:00"
    assert parse_week(html.replace(json.dumps(events[0]["resourceId"]), "null"), PROVIDER_WEEK, CODE) == [lesson]
    assert parse_week("<div><h5>Нет расписания</h5></div>", PROVIDER_WEEK, CODE) == []
    for malformed in (html.replace("2026-11-16", "2026-11-23"), html.replace("5146", "0"), "<html>502</html>"):
        with pytest.raises(SourceError):
            parse_week(malformed, PROVIDER_WEEK, CODE)
    with pytest.raises(SourceError):
        parse_week(html, PROVIDER_WEEK, "ДРУГАЯ")


def test_unn_sync_maps_verified_owners_and_preserves_sessions(client, seeded_database):
    now = datetime.now(MOSCOW)
    week = monday(now.date())
    lesson = Lesson(901, "Университетская пара", "Преподаватель ННГУ", "Корпус № 99", "402", now, now + timedelta(minutes=50))
    removed = replace(lesson, id=902, subject="Переносимая пара")
    teacher = headers(login(client, "teacher", "web")[0])
    student = headers(login(client, "student", "mobile")[0])

    with psycopg.connect(seeded_database, row_factory=dict_row, autocommit=True) as conn:
        local_name = conn.execute("SELECT name FROM groups WHERE id = %s", (DEMO_GROUP,)).fetchone()["name"]
        bind_group(conn, OFFICIAL_ID, CODE, local_name)
        group, = bound_groups(conn)
        assert reconcile(conn, group, week, [lesson, removed], {}) == (2, 0)
        assert reconcile(conn, group, week, [lesson, removed], {}) == (0, 0)
        rows = client.get(f"{PREFIX}/schedule", headers=student).json()
        assert {item["source"] for item in rows} == {"UNN"}
        first = next(item for item in rows if item["subject"] == lesson.subject)
        assert first["teacher_name"] == lesson.teacher
        assert first["building_name"] == lesson.building
        assert first["geozone_configured"] is False
        assert client.get(f"{PREFIX}/schedule", headers=teacher).json() == []

        conn.execute("UPDATE users SET unn_id = 601 WHERE login = 'teacher'")
        owners = {601: {901, 902}}
        assert reconcile(conn, group, week, [lesson, removed], owners) == (2, 0)
        result = client.post(f"{PREFIX}/sessions", json={"schedule_id": first["id"]}, headers=teacher)
        assert result.status_code == 409
        assert result.json()["code"] == "GEOZONE_UNCONFIGURED"

        conn.execute("UPDATE buildings SET unn_name = %s", (building_key(lesson.building),))
        assert reconcile(conn, group, week, [lesson, removed], owners) == (2, 0)
        result = client.post(f"{PREFIX}/sessions", json={"schedule_id": first["id"]}, headers=teacher)
        assert result.status_code == 201, result.text
        marked = client.post(
            f"{PREFIX}/attendance/geo", json={"schedule_id": first["id"], **GEO}, headers=student
        )
        assert marked.status_code == 200, marked.text

        class UnavailableUnn:
            def teacher_week(self, *_):
                return {901, 902}

            def group_week(self, *_):
                raise URLError("UNN not available")

        assert not sync(conn, UnavailableUnn(), week, 1)
        assert len(client.get(f"{PREFIX}/schedule", headers=student).json()) == 2
        assert reconcile(conn, group, week, [], owners) == (0, 1)
        history, = client.get(f"{PREFIX}/schedule", headers=student).json()
        assert history["id"] == first["id"]
        assert history["session_id"] == result.json()["id"]
        assert history["marked"] is True
