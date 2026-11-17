import base64
import binascii
import hashlib
import hmac
import io
import math
import struct
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

import qrcode
from qrcode.image.pure import PyPNGImage

from .models import SessionState

QR_VERSION = 1
QR_PAYLOAD = struct.Struct("!B16s16sQQ")
EARTH_RADIUS_M = 6_371_008.8


@dataclass(frozen=True)
class QrProof:
    session_id: UUID
    version: UUID
    issued_us: int
    expires_us: int


def to_micros(value: datetime) -> int:
    return round(value.timestamp() * 1_000_000)


def sign_qr(proof: QrProof, key: str) -> str:
    payload = QR_PAYLOAD.pack(
        QR_VERSION, proof.session_id.bytes, proof.version.bytes, proof.issued_us, proof.expires_us
    )
    signature = hmac.digest(key.encode(), payload, hashlib.sha256)
    return base64.urlsafe_b64encode(payload + signature).decode().rstrip("=")


def read_qr(token: str, key: str) -> QrProof:
    try:
        raw = base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid QR encoding") from exc
    if len(raw) != QR_PAYLOAD.size + hashlib.sha256().digest_size:
        raise ValueError("Invalid QR length")
    payload, signature = raw[:QR_PAYLOAD.size], raw[QR_PAYLOAD.size:]
    if not hmac.compare_digest(signature, hmac.digest(key.encode(), payload, hashlib.sha256)):
        raise ValueError("Invalid QR signature")
    version, session_id, qr_version, issued_us, expires_us = QR_PAYLOAD.unpack(payload)
    if version != QR_VERSION or issued_us >= expires_us:
        raise ValueError("Invalid QR payload")
    return QrProof(UUID(bytes=session_id), UUID(bytes=qr_version), issued_us, expires_us)


def qr_image(token: str) -> str:
    stream = io.BytesIO()
    qrcode.make(token, image_factory=PyPNGImage, box_size=8).save(stream)
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()


def session_state(closed_at: datetime | None, expires_at: datetime, now: datetime) -> SessionState:
    if closed_at is not None:
        return "CLOSED"
    return "ACTIVE" if now < expires_at else "EXPIRED"


def distance_m(lat: float, lon: float, target_lat: float, target_lon: float) -> float:
    phi, target_phi = math.radians(lat), math.radians(target_lat)
    delta_lon = math.radians(target_lon - lon)
    a = math.sin((target_phi - phi) / 2) ** 2
    a += math.cos(phi) * math.cos(target_phi) * math.sin(delta_lon / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(max(0.0, min(1.0, a))))
