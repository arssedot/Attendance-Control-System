from collections.abc import Iterator
from datetime import datetime
from typing import Annotated

from fastapi import Depends, Request
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def pool_for(database_url: str) -> ConnectionPool:
    return ConnectionPool(
        database_url,
        open=False,
        min_size=2,
        max_size=12,
        max_waiting=100,
        timeout=5,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 5,
            "options": "-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=5000",
        },
    )


def connection(request: Request) -> Iterator[Connection]:
    with request.app.state.pool.connection() as conn:
        yield conn


Db = Annotated[Connection, Depends(connection, scope="function")]


def database_time(conn: Connection) -> datetime:
    return conn.execute("SELECT clock_timestamp() AS now").fetchone()["now"]
