from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from attendance.domain import QrProof, distance_m, read_qr, session_state, sign_qr, to_micros


def test_qr_signature_and_distinct_versions():
    now = datetime.now(UTC)
    proof = QrProof(uuid4(), uuid4(), to_micros(now), to_micros(now + timedelta(minutes=5)))
    assert read_qr(sign_qr(proof, "local test key"), "local test key") == proof
    with pytest.raises(ValueError):
        read_qr(sign_qr(proof, "local test key"), "different key")
    with pytest.raises(ValueError):
        read_qr("https://example.org", "local test key")


def test_distance_at_antimeridian_and_antipodes():
    assert distance_m(56, 44, 56, 44) == 0
    assert distance_m(0, 179.999, 0, -179.999) == pytest.approx(222.39, abs=0.2)
    assert distance_m(0, 180, 0, 0) == pytest.approx(20_015_114, abs=1)


def test_session_expires_at_boundary():
    now = datetime.now(UTC)
    assert session_state(None, now + timedelta(microseconds=1), now) == "ACTIVE"
    assert session_state(None, now, now) == "EXPIRED"
    assert session_state(now, now + timedelta(seconds=1), now) == "CLOSED"
