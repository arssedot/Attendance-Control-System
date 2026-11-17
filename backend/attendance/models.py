from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Role = Literal["ROLE_TEACHER", "ROLE_STUDENT"]
Client = Literal["web", "mobile"]
SessionState = Literal["ACTIVE", "EXPIRED", "CLOSED"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Login(Input):
    login: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=256)
    client: Client = "web"


class Refresh(Input):
    refresh_token: str | None = Field(None, min_length=1, max_length=2048)


class User(BaseModel):
    id: UUID
    login: str
    display_name: str
    role: Role


class Tokens(BaseModel):
    user: User
    access_token: str
    expires_in: int
    refresh_token: str | None = None


class SessionCreate(Input):
    schedule_id: UUID
    ttl_minutes: int = Field(10, ge=1, le=120)
    late_after_minutes: int = Field(5, ge=0, le=30)


class SessionPatch(Input):
    ttl_minutes: int | None = Field(None, ge=1, le=120)
    late_after_minutes: int | None = Field(None, ge=0, le=30)
    close: Literal[True] | None = None

    @model_validator(mode="after")
    def validate_action(self):
        has_settings = self.ttl_minutes is not None or self.late_after_minutes is not None
        if bool(self.close) == has_settings:
            raise ValueError("Укажите срок или границу опоздания либо закройте сессию.")
        return self


class SessionView(BaseModel):
    id: UUID
    schedule_id: UUID
    state: SessionState
    issued_at: datetime
    expires_at: datetime
    late_at: datetime
    closed_at: datetime | None
    qr_image: str | None
    server_time: datetime


class Lesson(BaseModel):
    id: UUID
    subject: str
    group_name: str
    teacher_name: str
    building_name: str
    room: str
    starts_at: datetime
    ends_at: datetime
    session_id: UUID | None
    session_state: SessionState | None
    marked: bool


class QrMark(Input):
    token: str = Field(min_length=1, max_length=1024)


class GeoMark(Input):
    schedule_id: UUID
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    horizontal_accuracy: float = Field(gt=0, le=100_000)


class Mark(BaseModel):
    session_id: UUID
    schedule_id: UUID
    created_at: datetime
    method: Literal["QR", "GEO"]
    status: Literal["PRESENT", "LATE"]


class RosterMark(Mark):
    student_name: str


class HistoryMark(Mark):
    subject: str
    starts_at: datetime


class ErrorResponse(BaseModel):
    code: str
    message: str
    request_id: str
