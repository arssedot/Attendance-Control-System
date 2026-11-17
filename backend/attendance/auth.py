import os
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID, uuid4

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .db import Db
from .errors import fail, unauthenticated
from .models import Client, Login, Refresh, Tokens, User

router = APIRouter(prefix="/auth", tags=["auth"])
hasher = PasswordHasher(memory_cost=32768, time_cost=3, parallelism=2)
DUMMY_HASH = hasher.hash(os.urandom(32))
ACCESS_LIFETIME = timedelta(minutes=15)
REFRESH_LIFETIME = timedelta(days=7)
COOKIE_NAME = "attendance_refresh"
COOKIE_PATH = "/api/v1/auth"
ISSUER = "attendance"
AUTH_ROW = """
    SELECT a.id AS auth_id, a.refresh_id, a.client, a.expires_at,
           u.id, u.login, u.display_name, u.role, u.group_id
    FROM auth_sessions a JOIN users u ON u.id = a.user_id
    WHERE a.id = %s AND a.user_id = %s AND a.expires_at > clock_timestamp()
"""


def token_claims(request: Request, encoded: str, kind: str) -> dict:
    try:
        claims = jwt.decode(
            encoded, request.app.state.settings.auth_key, algorithms=["HS256"],
            issuer=ISSUER, audience=f"attendance:{kind}",
            options={"require": ["sub", "sid", "jti", "iat", "exp"]},
        )
        return {name: UUID(claims[name]) for name in ("sub", "sid", "jti")}
    except (jwt.InvalidTokenError, ValueError, TypeError):
        unauthenticated()


def encode_token(key: str, row: dict, kind: str, identifier: UUID, now: datetime, expiry: datetime):
    return jwt.encode(
        {
            "iss": ISSUER, "aud": f"attendance:{kind}",
            "sub": str(row["id"]), "sid": str(row["auth_id"]), "jti": str(identifier),
            "iat": now, "exp": expiry,
        },
        key, algorithm="HS256",
    )


def issue_tokens(request: Request, response: Response, row: dict, now: datetime) -> Tokens:
    settings = request.app.state.settings
    access_until = min(row["expires_at"], now + ACCESS_LIFETIME)
    access = encode_token(settings.auth_key, row, "access", uuid4(), now, access_until)
    refresh = encode_token(settings.auth_key, row, "refresh", row["refresh_id"], now, row["expires_at"])
    if row["client"] == "web":
        response.set_cookie(
            COOKIE_NAME, refresh, max_age=int((row["expires_at"] - now).total_seconds()),
            path=COOKIE_PATH, secure=settings.secure_cookies, httponly=True, samesite="strict",
        )
        refresh = None
    return Tokens(
        user=User.model_validate(row), access_token=access,
        expires_in=int((access_until - now).total_seconds()), refresh_token=refresh,
    )


def incoming_refresh(request: Request, payload: Refresh) -> tuple[str | None, Client]:
    if payload.refresh_token is not None:
        return payload.refresh_token, "mobile"
    return request.cookies.get(COOKIE_NAME), "web"


def current_user(
    request: Request, conn: Db,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))],
) -> dict:
    if credentials is None:
        unauthenticated()
    claims = token_claims(request, credentials.credentials, "access")
    row = conn.execute(AUTH_ROW, (claims["sid"], claims["sub"])).fetchone()
    if row is None:
        unauthenticated()
    return row


def teacher(user: Annotated[dict, Depends(current_user)]) -> dict:
    if user["role"] != "ROLE_TEACHER":
        fail(403, "ROLE_FORBIDDEN", "Действие доступно преподавателю.")
    return user


def student(user: Annotated[dict, Depends(current_user)]) -> dict:
    if user["role"] != "ROLE_STUDENT":
        fail(403, "ROLE_FORBIDDEN", "Действие доступно студенту.")
    return user


CurrentUser = Annotated[dict, Depends(current_user)]
Teacher = Annotated[dict, Depends(teacher)]
Student = Annotated[dict, Depends(student)]


@router.post("/login", response_model_exclude_none=True)
def login(payload: Login, request: Request, response: Response, conn: Db) -> Tokens:
    row = conn.execute(
        "SELECT id, login, display_name, role, password_hash FROM users WHERE login = %s",
        (payload.login.strip().lower(),),
    ).fetchone()
    try:
        hasher.verify(row["password_hash"] if row else DUMMY_HASH, payload.password)
    except VerifyMismatchError:
        row = None
    if row is None:
        fail(401, "INVALID_CREDENTIALS", "Проверьте логин и пароль.")
    if (payload.client == "web") != (row["role"] == "ROLE_TEACHER"):
        fail(403, "CLIENT_FORBIDDEN", "Преподаватель входит через веб, студент — через приложение.")
    now = datetime.now(UTC)
    conn.execute("DELETE FROM auth_sessions WHERE expires_at <= %s", (now,))
    row.update(auth_id=uuid4(), refresh_id=uuid4(), client=payload.client, expires_at=now + REFRESH_LIFETIME)
    conn.execute(
        "INSERT INTO auth_sessions (id, user_id, refresh_id, client, expires_at) VALUES (%s, %s, %s, %s, %s)",
        (row["auth_id"], row["id"], row["refresh_id"], row["client"], row["expires_at"]),
    )
    return issue_tokens(request, response, row, now)


@router.post("/refresh", response_model_exclude_none=True)
def refresh(payload: Refresh, request: Request, response: Response, conn: Db) -> Tokens:
    encoded, client = incoming_refresh(request, payload)
    if not encoded:
        unauthenticated()
    claims = token_claims(request, encoded, "refresh")
    row = conn.execute(AUTH_ROW + " FOR UPDATE OF a", (claims["sid"], claims["sub"])).fetchone()
    if row is None or row["refresh_id"] != claims["jti"] or row["client"] != client:
        unauthenticated()
    row["refresh_id"] = uuid4()
    conn.execute("UPDATE auth_sessions SET refresh_id = %s WHERE id = %s", (row["refresh_id"], row["auth_id"]))
    return issue_tokens(request, response, row, datetime.now(UTC))


@router.post("/logout", status_code=204)
def logout(payload: Refresh, request: Request, conn: Db) -> Response:
    encoded, client = incoming_refresh(request, payload)
    if encoded:
        try:
            claims = token_claims(request, encoded, "refresh")
        except HTTPException as exc:
            if exc.status_code != 401:
                raise
        else:
            conn.execute(
                "DELETE FROM auth_sessions WHERE id = %s AND user_id = %s AND client = %s",
                (claims["sid"], claims["sub"], client),
            )
    response = Response(status_code=204)
    response.delete_cookie(
        COOKIE_NAME, path=COOKIE_PATH, secure=request.app.state.settings.secure_cookies,
        httponly=True, samesite="strict",
    )
    return response
