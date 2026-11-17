import logging
from collections import OrderedDict
from contextlib import asynccontextmanager
from math import ceil
from time import monotonic
from uuid import uuid4

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from psycopg import OperationalError
from psycopg.errors import LockNotAvailable, QueryCanceled
from psycopg_pool import PoolTimeout, TooManyRequests
from starlette.exceptions import HTTPException

from . import auth, marks, sessions
from .config import Settings
from .db import Db, pool_for
from .errors import fail
from .models import ErrorResponse

log = logging.getLogger("attendance")
AUTH_REQUESTS_PER_MINUTE = 20


def error_response(request: Request, status: int, code: str, message: str, headers=None):
    return JSONResponse(
        {"code": code, "message": message, "request_id": request.state.request_id},
        status_code=status,
        headers=headers,
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pool = pool_for(settings.database_url)
        try:
            pool.open(wait=True, timeout=12)
            app.state.pool = pool
            yield
        finally:
            pool.close()

    app = FastAPI(title="Attendance API", version="1.0.0", lifespan=lifespan)
    app.state.settings = settings
    login_windows: OrderedDict[str, tuple[float, int]] = OrderedDict()

    @app.middleware("http")
    async def request_metadata(request: Request, call_next):
        request.state.request_id = uuid4().hex
        path = request.url.path
        if request.method == "POST" and path.rstrip("/") == "/api/v1/auth/login":
            address = request.client.host if request.client else "unknown"
            now = monotonic()
            until, used = login_windows.get(address, (now + 60, 0))
            if now >= until:
                until, used = now + 60, 0
            if used < AUTH_REQUESTS_PER_MINUTE:
                used += 1
                login_windows[address] = (until, used)
                login_windows.move_to_end(address)
                if len(login_windows) > 4096:
                    login_windows.popitem(last=False)
                response = await call_next(request)
            else:
                response = error_response(
                    request, 429, "RATE_LIMITED", "Слишком много попыток входа. Повторите позже.",
                    {"Retry-After": str(ceil(until - now))},
                )
            response.headers["RateLimit-Limit"] = str(AUTH_REQUESTS_PER_MINUTE)
            response.headers["RateLimit-Remaining"] = str(AUTH_REQUESTS_PER_MINUTE - used)
            response.headers["RateLimit-Reset"] = str(max(0, ceil(until - monotonic())))
        else:
            response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if path.startswith("/api/") or path in ("/", "/check-in"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        if isinstance(exc.detail, dict) and {"code", "message"} <= exc.detail.keys():
            return error_response(request, exc.status_code, exc.detail["code"], exc.detail["message"], exc.headers)
        return error_response(request, exc.status_code, "HTTP_ERROR", "Запрос не выполнен.", exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return error_response(request, 422, "VALIDATION_ERROR", "Проверьте поля запроса.")

    async def unavailable(request: Request, exc: Exception):
        log.warning("Database unavailable request_id=%s error=%s", request.state.request_id, type(exc).__name__)
        return error_response(
            request, 503, "TEMPORARILY_UNAVAILABLE", "Сервис временно недоступен. Повторите попытку.",
            {"Retry-After": "2"},
        )

    for error in (OperationalError, LockNotAvailable, QueryCanceled, PoolTimeout, TooManyRequests):
        app.add_exception_handler(error, unavailable)

    @app.get("/healthz", include_in_schema=False)
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    def ready(conn: Db) -> dict:
        row = conn.execute(
            """
            SELECT to_regclass('public.attendance') IS NOT NULL
                   AND to_regclass('public.attendance_geolocations') IS NOT NULL AS schema_exists
            """
        ).fetchone()
        if not row["schema_exists"]:
            fail(503, "SCHEMA_UNAVAILABLE", "База данных ещё не готова.")
        return {"status": "ready"}

    api = APIRouter(
        prefix="/api/v1",
        responses={status: {"model": ErrorResponse} for status in (401, 403, 404, 409, 422, 429, 503)},
    )
    for router in (auth.router, sessions.router, marks.router):
        api.include_router(router)
    app.include_router(api)

    if settings.static_dir:
        app.mount("/assets", StaticFiles(directory=settings.static_dir / "assets"), name="assets")

        @app.get("/", include_in_schema=False)
        @app.get("/check-in", include_in_schema=False)
        def frontend() -> FileResponse:
            return FileResponse(
                settings.static_dir / "index.html",
                headers={
                    "Content-Security-Policy": (
                        "default-src 'self'; img-src 'self' data:; style-src 'self'; "
                        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
                    )
                },
            )

    return app
