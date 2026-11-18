from fastapi import HTTPException


def fail(status: int, code: str, message: str, headers: dict[str, str] | None = None):
    raise HTTPException(status, detail={"code": code, "message": message}, headers=headers)


def unauthenticated():
    fail(401, "UNAUTHENTICATED", "Войдите в свой аккаунт.", {"WWW-Authenticate": "Bearer"})


def session_missing():
    fail(404, "SESSION_NOT_FOUND", "Сессия занятия недоступна.")
