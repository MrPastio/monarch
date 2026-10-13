"""Bounded, purpose-separated runtime evidence. Reading never enrolls a key."""
from __future__ import annotations

from pathlib import Path
import json
import time

from .integrity import INTEGRITY_FIELD, HASH_ALGORITHM, IntegrityKeyError, read_existing_key, sign_payload, verify_payload
from .runtime_health import finite_number

MAX_TELEMETRY_BYTES = 256 * 1024
RUNTIME_PURPOSE = "security-runtime-heartbeat-v1"
BACKGROUND_PURPOSE = "security-background-heartbeat-v1"


def signed_telemetry(payload: dict, key: bytes, purpose: str) -> dict:
    result = {**payload, "telemetry_schema": 1}
    # Refuse to publish non-finite values even when Python's JSON encoder accepts them.
    json.dumps(result, allow_nan=False)
    result[INTEGRITY_FIELD] = sign_payload(result, key, purpose)
    return result


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("duplicate telemetry field")
        result[name] = value
    return result


def _invalid_constant(_value: str):
    raise ValueError("non-finite telemetry value")


def read_telemetry(path: Path, key_path: Path, purpose: str, *, expected_pid: int | None = None,
                   max_age: float = 35.0) -> tuple[dict | None, str | None]:
    try:
        with path.open("rb") as handle:
            raw = handle.read(MAX_TELEMETRY_BYTES + 1)
    except FileNotFoundError:
        return None, "telemetry-missing"
    except OSError:
        return None, "telemetry-unreadable"
    if len(raw) > MAX_TELEMETRY_BYTES:
        return None, "telemetry-too-large"
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
        if not isinstance(payload, dict):
            return None, "telemetry-invalid"
        metadata = payload.get(INTEGRITY_FIELD)
        if (type(payload.get("telemetry_schema")) is not int or payload["telemetry_schema"] != 1
                or not isinstance(metadata, dict) or metadata.get("purpose") != purpose
                or metadata.get("algorithm") != HASH_ALGORITHM):
            return None, "telemetry-unverified"
        key = read_existing_key(key_path)
        if not verify_payload(payload, key, purpose)[0]:
            return None, "telemetry-integrity-failed"
    except IntegrityKeyError:
        return None, "telemetry-key-unavailable"
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        return None, "telemetry-invalid"
    pid, updated = payload.get("pid"), payload.get("updated_at")
    if type(pid) is not int or pid <= 0 or (expected_pid is not None and pid != expected_pid):
        return None, "telemetry-pid-mismatch"
    if not finite_number(updated):
        return None, "telemetry-time-invalid"
    age = time.time() - updated
    if age < -5 or age > max_age:
        return None, "telemetry-stale"
    return payload, None
