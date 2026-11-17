import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")


@dataclass(frozen=True)
class Settings:
    database_url: str
    auth_key: str
    qr_key: str
    secure_cookies: bool = True
    static_dir: Path | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        auth_key = os.environ["AUTH_KEY"]
        qr_key = os.environ["QR_KEY"]
        if min(len(auth_key), len(qr_key)) < 32 or auth_key == qr_key:
            raise ValueError("AUTH_KEY and QR_KEY must be different and at least 32 characters")
        static_dir = os.getenv("STATIC_DIR")
        return cls(
            database_url=os.environ["DATABASE_URL"],
            auth_key=auth_key,
            qr_key=qr_key,
            secure_cookies=os.getenv("SECURE_COOKIES", "true").lower() != "false",
            static_dir=Path(static_dir) if static_dir else None,
        )
