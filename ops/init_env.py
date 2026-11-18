"""Generate a local configuration without displaying secret values."""

import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECRET_FIELDS = {"POSTGRES_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "AUTH_KEY", "QR_KEY", "DEMO_PASSWORD"}


def main():
    template = (ROOT / ".env.example").read_text(encoding="utf-8").splitlines()
    lines = []
    for line in template:
        name, _, value = line.partition("=")
        lines.append(f"{name}={secrets.token_hex(32) if name in SECRET_FIELDS else value}")
    target = ROOT / ".env"
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print(".env already exists")
        return
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write("\n".join(lines) + "\n")
    print(".env created")


if __name__ == "__main__":
    main()
