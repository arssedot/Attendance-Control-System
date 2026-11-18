import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import MOSCOW

URL = "https://rasp.unn.ru/"
MAX_RESPONSE_BYTES = 2_000_000
EVENTS = re.compile(r"(?m)^\s*events\s*:\s*")
WEEK_START = re.compile(r"\bdefaultDate\s*:\s*['\"](\d{4}-\d{2}-\d{2})['\"]")
EMPTY_WEEK = re.compile(r"<h5\b[^>]*>\s*Нет расписания\s*</h5>", re.IGNORECASE)
TIME_RANGE = re.compile(r"\d{2}:\d{2}(?::\d{2})?\s*[-–]\s*\d{2}:\d{2}(?::\d{2})?")


class SourceError(ValueError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def normalized(text: str) -> str:
    return " ".join(text.split())


def external_id(value: str | int) -> int:
    if not isinstance(value, (str, int)) or not re.fullmatch(r"[1-9][0-9]{0,17}", str(value)):
        raise SourceError("Invalid UNN identifier")
    return int(value)


class SelectOptions(HTMLParser):
    def __init__(self, select_id: str):
        super().__init__(convert_charrefs=True)
        self.select_id = select_id
        self.selected = False
        self.option: str | None = None
        self.label: list[str] = []
        self.options: dict[int, str] = {}

    def handle_starttag(self, tag, attrs):
        if tag == "select":
            self.selected = dict(attrs).get("id") == self.select_id
        if tag == "option" and self.selected:
            self.option = dict(attrs).get("value")
            self.label = []

    def handle_endtag(self, tag):
        if tag == "option" and self.selected:
            if self.option:
                self.options[external_id(self.option)] = normalized("".join(self.label))
            self.option = None
        if tag == "select":
            self.selected = False

    def handle_data(self, data):
        if self.option:
            self.label.append(data)


class TooltipLines(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines: list[list[str]] = [[]]

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.lines.append([])

    def handle_data(self, data):
        self.lines[-1].append(data)


@dataclass(frozen=True)
class Lesson:
    id: int
    subject: str
    teacher: str
    building: str
    room: str
    starts_at: datetime
    ends_at: datetime


def parse_week(html: str, week: date, group_code: str | None = None) -> list[Lesson]:
    match = EVENTS.search(html)
    if not match:
        if EMPTY_WEEK.search(html):
            return []
        raise SourceError("Schedule response has no events")
    date_match = WEEK_START.search(html)
    if not date_match or date_match[1] != week.isoformat():
        raise SourceError("Schedule response has a different week")
    try:
        events, _ = json.JSONDecoder().raw_decode(html, match.end())
        if not isinstance(events, list):
            raise SourceError("Schedule events must be an array")
        return parse_events(events, week, group_code)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise SourceError("Unexpected event format in UNN schedule") from exc


def local_datetime(value: str) -> datetime:
    result = datetime.fromisoformat(value)
    return result.replace(tzinfo=MOSCOW) if result.tzinfo is None else result.astimezone(MOSCOW)


def parse_events(events: list[dict], week: date, group_code: str | None) -> list[Lesson]:
    lessons: dict[int, Lesson] = {}
    for event in events:
        resource = event["resourceId"]
        # Single-group responses can omit the resource label for some classes.
        if resource is not None and not isinstance(resource, str):
            raise SourceError("Unexpected event resource")
        if group_code and resource and group_code not in {normalized(name) for name in resource.split(",")}:
            raise SourceError("Schedule event does not belong to the requested group")
        start, end = local_datetime(event["start"]), local_datetime(event["end"])
        if not week <= start.date() < week + timedelta(days=7) or end <= start:
            raise SourceError("Schedule event is outside the requested week or has invalid times")
        tooltip = TooltipLines()
        tooltip.feed(event["tooltip"])
        lines = [normalized("".join(line)) for line in tooltip.lines]
        if len(lines) < 4 or not lines[0] or not TIME_RANGE.fullmatch(lines[-1]):
            raise SourceError("Schedule event tooltip is incomplete")
        building, separator, room = lines[-2].partition(",")
        identifier = external_id(event["id"])
        lesson = Lesson(
            identifier, lines[0], ", ".join(filter(None, lines[1:-2])),
            normalized(building), normalized(room) if separator and room.strip() else "—", start, end,
        )
        if identifier in lessons and lessons[identifier] != lesson:
            raise SourceError("Conflicting events with the same identifier")
        lessons[identifier] = lesson
    return list(lessons.values())


class UnnSchedule:
    def __init__(self):
        self.http = build_opener(NoRedirect)

    def post(self, endpoint: str, day: date, mode: int, **params) -> str:
        body = urlencode({
            "date": day.isoformat(), "type": 2, "view": 2, "typemenu": mode, "lang": 0, "wid": 1280,
            **params,
        }).encode()
        request = Request(URL + endpoint, data=body, headers={"User-Agent": "Attendance/1.0 (UNN schedule sync)"})
        with self.http.open(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise SourceError("UNN response is too large")
        return raw.decode("utf-8-sig")

    def catalog(self, kind: str, day: date) -> dict[int, str]:
        select_id, mode = ("group", 1) if kind == "group" else ("lector", 2)
        parser = SelectOptions(select_id)
        parser.feed(self.post("getmenu.php", day, mode))
        if not parser.options:
            raise SourceError("UNN catalog is unavailable")
        return parser.options

    def group_week(self, week: date, identifier: int, code: str) -> list[Lesson]:
        return parse_week(self.post("schedule.php", week, 1, gr=identifier), week, code)

    def teacher_week(self, week: date, identifier: int) -> set[int]:
        return {lesson.id for lesson in parse_week(self.post("schedule.php", week, 2, lec=identifier), week)}
