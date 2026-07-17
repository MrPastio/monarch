from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
import base64
import hashlib
import json
import os
import re
import secrets
import time

from .events import utc_now
from .integrity import INTEGRITY_FIELD, get_or_create_key, sign_payload, verify_payload
from .state import FileLock


PIN_PATTERN = re.compile(r"^\d{6}$")
RECOVERY_CODE_PATTERN = re.compile(r"^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$")
RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class SecurityPinError(RuntimeError):
    pass


class SecurityPinIntegrityError(SecurityPinError):
    pass


@dataclass(frozen=True)
class PinVerification:
    ok: bool
    configured: bool
    locked: bool
    retry_after_seconds: int
    failed_attempts: int
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


class SecurityPinManager:
    def __init__(
        self,
        path: Path,
        integrity_key_path: Path,
        *,
        time_fn: Callable[[], float] = time.time,
    ) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.integrity_key_path = integrity_key_path.resolve()
        self.time_fn = time_fn

    def status(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "configured": False,
                "locked": False,
                "retry_after_seconds": 0,
                "failed_attempts": 0,
                "recovery_codes_remaining": 0,
                "recovery_locked": False,
                "recovery_retry_after_seconds": 0,
                "recovery_failed_attempts": 0,
            }
        record = self._load()
        now = self.time_fn()
        locked_until = float(record.get("locked_until") or 0)
        recovery_locked_until = float(record.get("recovery_locked_until") or 0)
        return {
            "configured": True,
            "locked": locked_until > now,
            "retry_after_seconds": max(0, int(locked_until - now + 0.999)),
            "failed_attempts": int(record.get("failed_attempts") or 0),
            "recovery_codes_remaining": len(record.get("recovery_digests") or []),
            "recovery_locked": recovery_locked_until > now,
            "recovery_retry_after_seconds": max(0, int(recovery_locked_until - now + 0.999)),
            "recovery_failed_attempts": int(record.get("recovery_failed_attempts") or 0),
            "updated_at": record.get("updated_at"),
        }

    def set_pin(self, new_pin: str, *, current_pin: str | None = None) -> dict[str, Any]:
        _validate_pin_format(new_pin)
        with FileLock(self.path):
            if self.path.exists():
                if current_pin is None:
                    raise SecurityPinError("Current Security PIN is required")
                verification = self._verify_locked(current_pin)
                if not verification.ok:
                    raise SecurityPinError(verification.reason)
            record, recovery_codes = _new_pin_record(new_pin)
            self._write(record)
        return {**self.status(), "recovery_codes": recovery_codes}

    def recover(self, recovery_code: str, new_pin: str) -> dict[str, Any]:
        _validate_pin_format(new_pin)
        if not self.path.exists():
            raise SecurityPinError("Security PIN is not configured")
        with FileLock(self.path):
            record = self._load()
            now = self.time_fn()
            locked_until = float(record.get("recovery_locked_until") or 0)
            failed_attempts = int(record.get("recovery_failed_attempts") or 0)
            if locked_until > now:
                raise SecurityPinError(
                    f"Security PIN recovery is temporarily locked for {max(1, int(locked_until - now + 0.999))} seconds"
                )
            digests = [str(item) for item in record.get("recovery_digests") or []]
            salt_value = str(record.get("recovery_salt") or "")
            if not digests or not salt_value:
                raise SecurityPinError("Recovery codes are not configured; rotate PIN with the current PIN first")
            try:
                salt = base64.b64decode(salt_value, validate=True)
            except ValueError as exc:
                raise SecurityPinIntegrityError("Recovery code record is malformed") from exc
            normalized = _normalize_recovery_code(recovery_code)
            candidate = _recovery_digest(normalized, salt) if normalized else ""
            matched = any(secrets.compare_digest(candidate, expected) for expected in digests)
            if not matched:
                failed_attempts += 1
                delay = 0 if failed_attempts < 5 else min(1800, 60 * (2 ** min(5, failed_attempts - 5)))
                record["recovery_failed_attempts"] = failed_attempts
                record["recovery_locked_until"] = now + delay if delay else 0
                record["updated_at"] = utc_now()
                self._write(record)
                raise SecurityPinError("Security PIN recovery code is invalid")
            new_record, recovery_codes = _new_pin_record(new_pin)
            self._write(new_record)
        return {**self.status(), "recovery_codes": recovery_codes, "recovered": True}

    def verify(self, pin: str) -> PinVerification:
        if not self.path.exists():
            return PinVerification(False, False, False, 0, 0, "Security PIN is not configured")
        with FileLock(self.path):
            return self._verify_locked(pin)

    def _verify_locked(self, pin: str) -> PinVerification:
        record = self._load()
        now = self.time_fn()
        failed_attempts = int(record.get("failed_attempts") or 0)
        locked_until = float(record.get("locked_until") or 0)
        if locked_until > now:
            return PinVerification(
                False, True, True, max(1, int(locked_until - now + 0.999)), failed_attempts,
                "Security PIN is temporarily locked after repeated failures",
            )
        try:
            salt = base64.b64decode(str(record["salt"]), validate=True)
            expected = base64.b64decode(str(record["digest"]), validate=True)
        except (KeyError, ValueError) as exc:
            raise SecurityPinIntegrityError("Security PIN record is malformed") from exc
        candidate = _derive(
            pin,
            salt,
            n=int(record.get("n") or 16384),
            r=int(record.get("r") or 8),
            p=int(record.get("p") or 1),
        )
        if PIN_PATTERN.fullmatch(pin or "") and secrets.compare_digest(candidate, expected):
            record["failed_attempts"] = 0
            record["locked_until"] = 0
            record["updated_at"] = utc_now()
            self._write(record)
            return PinVerification(True, True, False, 0, 0, "Security PIN verified")

        failed_attempts += 1
        delay = 0 if failed_attempts < 5 else min(900, 30 * (2 ** min(5, failed_attempts - 5)))
        record["failed_attempts"] = failed_attempts
        record["locked_until"] = now + delay if delay else 0
        record["updated_at"] = utc_now()
        self._write(record)
        return PinVerification(
            False,
            True,
            delay > 0,
            delay,
            failed_attempts,
            "Security PIN is invalid",
        )

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            raise SecurityPinError("Security PIN is not configured")
        if not self.integrity_key_path.exists():
            raise SecurityPinIntegrityError("Security PIN integrity key is missing")
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SecurityPinIntegrityError("Security PIN record cannot be read") from exc
        if not isinstance(payload, dict):
            raise SecurityPinIntegrityError("Security PIN record is not an object")
        key = get_or_create_key(self.integrity_key_path)
        ok, reason = verify_payload(payload, key, "security-pin")
        if not ok:
            raise SecurityPinIntegrityError(f"Security PIN integrity check failed: {reason}")
        return payload

    def _write(self, record: dict[str, Any]) -> None:
        key = get_or_create_key(self.integrity_key_path)
        sealed = dict(record)
        sealed.pop(INTEGRITY_FIELD, None)
        sealed[INTEGRITY_FIELD] = sign_payload(sealed, key, "security-pin")
        temporary = self.path.with_name(f"{self.path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
        temporary.write_text(
            json.dumps(sealed, ensure_ascii=True, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        try:
            for attempt in range(20):
                try:
                    os.replace(temporary, self.path)
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.05)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def read_pin_status(path: Path, integrity_key_path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "configured": False,
            "locked": False,
            "retry_after_seconds": 0,
            "failed_attempts": 0,
            "recovery_codes_remaining": 0,
            "recovery_locked": False,
            "recovery_retry_after_seconds": 0,
            "recovery_failed_attempts": 0,
            "integrity_ok": True,
            "integrity_error": None,
        }
    try:
        return {
            **SecurityPinManager(path, integrity_key_path).status(),
            "integrity_ok": True,
            "integrity_error": None,
        }
    except SecurityPinError as exc:
        return {
            "configured": True,
            "locked": True,
            "retry_after_seconds": 0,
            "failed_attempts": 0,
            "recovery_codes_remaining": 0,
            "recovery_locked": True,
            "recovery_retry_after_seconds": 0,
            "recovery_failed_attempts": 0,
            "integrity_ok": False,
            "integrity_error": str(exc),
        }


def _validate_pin_format(pin: str) -> None:
    if not PIN_PATTERN.fullmatch(pin or ""):
        raise SecurityPinError("Security PIN must contain exactly 6 digits")


def _derive(pin: str, salt: bytes, *, n: int = 16384, r: int = 8, p: int = 1) -> bytes:
    return hashlib.scrypt(pin.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=32)


def _new_pin_record(pin: str) -> tuple[dict[str, Any], list[str]]:
    salt = secrets.token_bytes(16)
    recovery_salt = secrets.token_bytes(16)
    recovery_codes = [_generate_recovery_code() for _ in range(8)]
    return {
        "schema": 2,
        "algorithm": "scrypt",
        "n": 16384,
        "r": 8,
        "p": 1,
        "salt": base64.b64encode(salt).decode("ascii"),
        "digest": base64.b64encode(_derive(pin, salt)).decode("ascii"),
        "failed_attempts": 0,
        "locked_until": 0,
        "recovery_salt": base64.b64encode(recovery_salt).decode("ascii"),
        "recovery_digests": [_recovery_digest(code, recovery_salt) for code in recovery_codes],
        "recovery_failed_attempts": 0,
        "recovery_locked_until": 0,
        "updated_at": utc_now(),
    }, recovery_codes


def _generate_recovery_code() -> str:
    compact = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(20))
    return "-".join(compact[index:index + 4] for index in range(0, 20, 4))


def _normalize_recovery_code(value: str) -> str:
    normalized = str(value or "").strip().upper().replace(" ", "-")
    if RECOVERY_CODE_PATTERN.fullmatch(normalized):
        return normalized
    compact = normalized.replace("-", "")
    if len(compact) == 20 and all(char in RECOVERY_ALPHABET for char in compact):
        return "-".join(compact[index:index + 4] for index in range(0, 20, 4))
    return ""


def _recovery_digest(code: str, salt: bytes) -> str:
    return hashlib.sha256(b"monarch-security-recovery\0" + salt + code.encode("ascii", errors="ignore")).hexdigest()
