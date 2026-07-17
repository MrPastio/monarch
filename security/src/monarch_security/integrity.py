from __future__ import annotations

from pathlib import Path
from typing import Any
import hashlib
import hmac
import json
import os
import secrets
import sys
import ctypes
import ctypes.wintypes


HASH_ALGORITHM = "hmac-sha256"
GENESIS_HASH = "0" * 64
INTEGRITY_FIELD = "_integrity"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_byte))]

def _dpapi_protect(data: bytes) -> bytes:
    if sys.platform != "win32":
        return data
    try:
        crypt32 = ctypes.windll.crypt32
        data_in = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_byte)))
        data_out = DATA_BLOB()
        if crypt32.CryptProtectData(ctypes.byref(data_in), None, None, None, None, 0x01, ctypes.byref(data_out)):
            out_bytes = ctypes.string_at(data_out.pbData, data_out.cbData)
            ctypes.windll.kernel32.LocalFree(data_out.pbData)
            return out_bytes
    except Exception:
        pass
    return data

def _dpapi_unprotect(data: bytes) -> bytes:
    if sys.platform != "win32":
        return data
    try:
        crypt32 = ctypes.windll.crypt32
        data_in = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_byte)))
        data_out = DATA_BLOB()
        if crypt32.CryptUnprotectData(ctypes.byref(data_in), None, None, None, None, 0x01, ctypes.byref(data_out)):
            out_bytes = ctypes.string_at(data_out.pbData, data_out.cbData)
            ctypes.windll.kernel32.LocalFree(data_out.pbData)
            return out_bytes
    except Exception:
        pass
    return data


def get_or_create_key(path: Path) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        data = _read_key_file(path)
        try:
            return _dpapi_unprotect(data)
        except Exception:
            return data

    key = secrets.token_hex(32).encode("ascii")
    encrypted_key = _dpapi_protect(key)
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(encrypted_key)
    except FileExistsError:
        return _dpapi_unprotect(_read_key_file(path))
    except OSError:
        path.write_bytes(encrypted_key)
    _best_effort_private(path)
    return key


def sign_payload(payload: dict[str, Any], key: bytes, purpose: str) -> dict[str, Any]:
    canonical = canonical_json(_without_integrity(payload))
    return {
        "algorithm": HASH_ALGORITHM,
        "purpose": purpose,
        "digest": hmac_sha256(key, f"{purpose}\n{canonical}"),
    }


def verify_payload(payload: dict[str, Any], key: bytes, purpose: str) -> tuple[bool, str]:
    integrity = payload.get(INTEGRITY_FIELD)
    if not isinstance(integrity, dict):
        return False, "missing integrity metadata"
    expected = sign_payload(payload, key, purpose)
    digest = str(integrity.get("digest") or "")
    if not hmac.compare_digest(digest, expected["digest"]):
        return False, "integrity digest mismatch"
    return True, "ok"


def audit_record_integrity(
    record: dict[str, Any],
    key: bytes,
    previous_hash: str,
) -> dict[str, Any]:
    canonical = canonical_json(_without_integrity(record))
    record_hash = hmac_sha256(key, f"audit-record\n{previous_hash}\n{canonical}")
    return {
        "algorithm": HASH_ALGORITHM,
        "previous_hash": previous_hash,
        "record_hash": record_hash,
    }


def verify_audit_log(path: Path, key_path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"ok": True, "records": 0, "error": None}
    if not key_path.exists():
        return {"ok": False, "records": 0, "error": "integrity key missing"}

    key = get_or_create_key(key_path)
    previous = GENESIS_HASH
    records = 0
    legacy_unsigned_records = 0
    signed_records_started = False
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_number, line in enumerate(handle, start=1):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    record = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    return {
                        "ok": False,
                        "records": records,
                        "line": line_number,
                        "error": f"invalid JSON: {exc}",
                    }
                integrity = record.get(INTEGRITY_FIELD)
                if not isinstance(integrity, dict):
                    if not signed_records_started:
                        legacy_unsigned_records += 1
                        continue
                    return {
                        "ok": False,
                        "records": records,
                        "line": line_number,
                        "error": "missing audit integrity metadata",
                    }
                signed_records_started = True
                expected = audit_record_integrity(record, key, previous)
                if integrity.get("previous_hash") != previous:
                    return {
                        "ok": False,
                        "records": records,
                        "line": line_number,
                        "error": "previous hash mismatch",
                    }
                if not hmac.compare_digest(
                    str(integrity.get("record_hash") or ""),
                    expected["record_hash"],
                ):
                    return {
                        "ok": False,
                        "records": records,
                        "line": line_number,
                        "error": "record hash mismatch",
                    }
                previous = expected["record_hash"]
                records += 1
    except OSError as exc:
        return {"ok": False, "records": records, "error": str(exc)}

    return {
        "ok": True,
        "records": records,
        "legacy_unsigned_records": legacy_unsigned_records,
        "last_hash": previous,
        "error": None,
    }


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def hmac_sha256(key: bytes, message: str | bytes) -> str:
    data = message.encode("utf-8") if isinstance(message, str) else message
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def _without_integrity(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key != INTEGRITY_FIELD}


def _read_key_file(path: Path) -> bytes:
    data = path.read_bytes()
    # Legacy plaintext keys are 64 ASCII hex bytes and may have a newline.
    # DPAPI-protected keys are binary blobs where trailing 0A/0D0A bytes are
    # valid ciphertext and must never be stripped.
    candidate = data.rstrip(b"\r\n")
    if len(candidate) == 64 and all(byte in b"0123456789abcdefABCDEF" for byte in candidate):
        return candidate
    return data


def _best_effort_private(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
