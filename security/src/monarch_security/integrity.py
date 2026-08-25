from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import hashlib
import hmac
import json
import os
import secrets
import stat
import sys
import ctypes
import ctypes.wintypes


HASH_ALGORITHM = "hmac-sha256"
GENESIS_HASH = "0" * 64
INTEGRITY_FIELD = "_integrity"
KEY_FILE_MAGIC = b"MONARCH-SECURITY-DPAPI-V1\x00"
MAX_KEY_FILE_BYTES = 65_536

CRYPTPROTECT_UI_FORBIDDEN = 0x01
CRYPTPROTECT_LOCAL_MACHINE = 0x04
TOKEN_QUERY = 0x0008
TOKEN_USER_CLASS = 1
OWNER_SECURITY_INFORMATION = 0x00000001
DACL_SECURITY_INFORMATION = 0x00000004
PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
SE_DACL_PROTECTED = 0x1000
ACCESS_ALLOWED_ACE_TYPE = 0x00
INHERITED_ACE = 0x10
FILE_ALL_ACCESS = 0x001F01FF
SYSTEM_SID = "S-1-5-18"
BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544"


class IntegrityKeyError(RuntimeError):
    pass


class IntegrityKeyProtectionError(IntegrityKeyError):
    pass


class IntegrityKeyAccessError(IntegrityKeyError):
    pass


@dataclass(frozen=True)
class ProtectedDataResult:
    ok: bool
    data: bytes | None = None
    error: str | None = None


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("Sid", ctypes.c_void_p),
        ("Attributes", ctypes.wintypes.DWORD),
    ]


class TOKEN_USER(ctypes.Structure):
    _fields_ = [("User", SID_AND_ATTRIBUTES)]


class ACL(ctypes.Structure):
    _fields_ = [
        ("AclRevision", ctypes.c_ubyte),
        ("Sbz1", ctypes.c_ubyte),
        ("AclSize", ctypes.c_ushort),
        ("AceCount", ctypes.c_ushort),
        ("Sbz2", ctypes.c_ushort),
    ]


class ACE_HEADER(ctypes.Structure):
    _fields_ = [
        ("AceType", ctypes.c_ubyte),
        ("AceFlags", ctypes.c_ubyte),
        ("AceSize", ctypes.c_ushort),
    ]


def _dpapi_protect(data: bytes) -> ProtectedDataResult:
    if sys.platform != "win32":
        return ProtectedDataResult(False, error="dpapi-unavailable")
    output = DATA_BLOB()
    try:
        crypt32 = ctypes.windll.crypt32
        buffer = ctypes.create_string_buffer(data, len(data))
        source = DATA_BLOB(
            len(data),
            ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)),
        )
        flags = CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE
        if not crypt32.CryptProtectData(
            ctypes.byref(source),
            "Monarch Security integrity key",
            None,
            None,
            None,
            flags,
            ctypes.byref(output),
        ):
            return ProtectedDataResult(
                False,
                error=f"dpapi-protect-failed:{_windows_last_error()}",
            )
        if not output.pbData or output.cbData <= 0:
            return ProtectedDataResult(False, error="dpapi-protect-empty")
        return ProtectedDataResult(
            True,
            data=ctypes.string_at(output.pbData, output.cbData),
        )
    except Exception as exc:
        return ProtectedDataResult(False, error=f"dpapi-protect-error:{type(exc).__name__}")
    finally:
        if output.pbData:
            ctypes.windll.kernel32.LocalFree(output.pbData)


def _dpapi_unprotect(data: bytes) -> ProtectedDataResult:
    if sys.platform != "win32":
        return ProtectedDataResult(False, error="dpapi-unavailable")
    output = DATA_BLOB()
    try:
        crypt32 = ctypes.windll.crypt32
        buffer = ctypes.create_string_buffer(data, len(data))
        source = DATA_BLOB(
            len(data),
            ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)),
        )
        if not crypt32.CryptUnprotectData(
            ctypes.byref(source),
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(output),
        ):
            return ProtectedDataResult(
                False,
                error=f"dpapi-unprotect-failed:{_windows_last_error()}",
            )
        if not output.pbData or output.cbData <= 0:
            return ProtectedDataResult(False, error="dpapi-unprotect-empty")
        return ProtectedDataResult(
            True,
            data=ctypes.string_at(output.pbData, output.cbData),
        )
    except Exception as exc:
        return ProtectedDataResult(False, error=f"dpapi-unprotect-error:{type(exc).__name__}")
    finally:
        if output.pbData:
            ctypes.windll.kernel32.LocalFree(output.pbData)


def get_or_create_key(path: Path) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(path):
        return _load_existing_key(path)

    key = secrets.token_hex(32).encode("ascii")
    protected = _dpapi_protect(key)
    if not protected.ok or protected.data is None:
        raise IntegrityKeyProtectionError(protected.error or "dpapi-protect-failed")
    encoded = KEY_FILE_MAGIC + protected.data
    created_identity: tuple[int, int] | None = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        fd = os.open(str(path), flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        created_identity = _object_identity(os.lstat(path))
    except FileExistsError:
        return _load_existing_key(path)
    except OSError as exc:
        raise IntegrityKeyAccessError(f"integrity-key-create-failed:{exc.errno}") from exc
    try:
        loaded = _load_existing_key(path)
        if not hmac.compare_digest(loaded, key):
            raise IntegrityKeyProtectionError("integrity-key-readback-mismatch")
    except Exception:
        _unlink_created_key(path, created_identity)
        raise
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

    try:
        key = get_or_create_key(key_path)
    except IntegrityKeyError as exc:
        return {
            "ok": False,
            "records": 0,
            "error": f"integrity key unavailable: {exc}",
        }
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
    return _normalize_key_file_bytes(path.read_bytes())


def _normalize_key_file_bytes(data: bytes) -> bytes:
    # Legacy plaintext keys are 64 ASCII hex bytes and may have a newline.
    # DPAPI-protected keys are binary blobs where trailing 0A/0D0A bytes are
    # valid ciphertext and must never be stripped.
    candidate = data.rstrip(b"\r\n")
    if len(candidate) == 64 and all(byte in b"0123456789abcdefABCDEF" for byte in candidate):
        return candidate
    return data


def _load_existing_key(path: Path) -> bytes:
    data = _read_key_file_secure(path)
    if _is_master_key(data):
        return _migrate_plaintext_key(path, data)
    return _decode_protected_key(data)


def _decode_protected_key(data: bytes) -> bytes:
    protected = data[len(KEY_FILE_MAGIC):] if data.startswith(KEY_FILE_MAGIC) else data
    if not protected:
        raise IntegrityKeyProtectionError("integrity-key-payload-empty")
    result = _dpapi_unprotect(protected)
    if not result.ok or result.data is None:
        raise IntegrityKeyProtectionError(result.error or "dpapi-unprotect-failed")
    if not _is_master_key(result.data):
        raise IntegrityKeyProtectionError("integrity-key-payload-invalid")
    return result.data


def _migrate_plaintext_key(path: Path, key: bytes) -> bytes:
    protected = _dpapi_protect(key)
    if not protected.ok or protected.data is None:
        raise IntegrityKeyProtectionError(protected.error or "dpapi-protect-failed")

    source_identity = _stable_file_identity(os.lstat(path))
    candidate = path.with_name(f".{path.name}.{secrets.token_hex(8)}.migrating")
    candidate_identity: tuple[int, int] | None = None
    replaced = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        fd = os.open(str(candidate), flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(KEY_FILE_MAGIC + protected.data)
            handle.flush()
            os.fsync(handle.fileno())
        candidate_identity = _object_identity(os.lstat(candidate))
        migrated = _decode_protected_key(_read_key_file_secure(candidate))
        if not hmac.compare_digest(migrated, key):
            raise IntegrityKeyProtectionError("integrity-key-migration-readback-mismatch")

        current = _read_key_file_secure(path)
        current_identity = _stable_file_identity(os.lstat(path))
        if current_identity != source_identity or not hmac.compare_digest(current, key):
            raise IntegrityKeyAccessError("integrity-key-changed-during-migration")

        os.replace(candidate, path)
        replaced = True
        if _object_identity(os.lstat(path)) != candidate_identity:
            raise IntegrityKeyAccessError("integrity-key-migration-identity-mismatch")
        return key
    except IntegrityKeyError:
        raise
    except OSError as exc:
        raise IntegrityKeyAccessError(f"integrity-key-migration-failed:{exc.errno}") from exc
    finally:
        if not replaced:
            _unlink_created_key(candidate, candidate_identity)


def _read_key_file_secure(path: Path) -> bytes:
    try:
        before = os.lstat(path)
    except OSError as exc:
        raise IntegrityKeyAccessError(f"integrity-key-read-failed:{exc.errno}") from exc
    _validate_key_file_stat(before)
    _set_and_verify_private_acl(path)
    try:
        secured = os.lstat(path)
        _validate_key_file_stat(secured)
        secured_identity = _stable_file_identity(secured)
        with path.open("rb") as handle:
            opened = os.fstat(handle.fileno())
            _validate_key_file_stat(opened)
            if _stable_file_identity(opened) != secured_identity:
                raise IntegrityKeyAccessError("integrity-key-identity-changed")
            data = handle.read(MAX_KEY_FILE_BYTES + 1)
        after = os.lstat(path)
        _validate_key_file_stat(after)
    except IntegrityKeyError:
        raise
    except OSError as exc:
        raise IntegrityKeyAccessError(f"integrity-key-read-failed:{exc.errno}") from exc
    if _stable_file_identity(after) != secured_identity:
        raise IntegrityKeyAccessError("integrity-key-identity-changed")
    if len(data) > MAX_KEY_FILE_BYTES:
        raise IntegrityKeyAccessError("integrity-key-file-too-large")
    return _normalize_key_file_bytes(data)


def _validate_key_file_stat(value: os.stat_result) -> None:
    attributes = int(getattr(value, "st_file_attributes", 0))
    if (
        not stat.S_ISREG(value.st_mode)
        or stat.S_ISLNK(value.st_mode)
        or bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))
        or int(getattr(value, "st_nlink", 1)) != 1
    ):
        raise IntegrityKeyAccessError("integrity-key-must-be-one-unlinked-regular-file")


def _stable_file_identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
    )


def _object_identity(value: os.stat_result) -> tuple[int, int]:
    return int(value.st_dev), int(value.st_ino)


def _unlink_created_key(path: Path, identity: tuple[int, int] | None) -> None:
    if identity is None:
        return
    try:
        current = os.lstat(path)
        if _object_identity(current) == identity:
            path.unlink()
    except OSError:
        return


def _is_master_key(value: bytes) -> bool:
    return len(value) == 64 and all(byte in b"0123456789abcdefABCDEF" for byte in value)


def _set_and_verify_private_acl(path: Path) -> None:
    if sys.platform != "win32":
        raise IntegrityKeyAccessError("windows-private-acl-unavailable")
    current_sid = _current_user_sid()
    allowed_sids = [current_sid]
    if current_sid != SYSTEM_SID:
        allowed_sids.append(SYSTEM_SID)
    allowed = set(allowed_sids)
    trusted_owners = {
        current_sid,
        SYSTEM_SID,
        BUILTIN_ADMINISTRATORS_SID,
    }
    try:
        _verify_private_acl(path, trusted_owners, allowed)
        return
    except IntegrityKeyAccessError:
        pass
    dacl = "".join(f"(A;;FA;;;{sid})" for sid in allowed_sids)
    sddl = f"D:P{dacl}"
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    descriptor = ctypes.c_void_p()
    size = ctypes.wintypes.DWORD()
    convert = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [
        ctypes.c_wchar_p,
        ctypes.wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.wintypes.DWORD),
    ]
    convert.restype = ctypes.wintypes.BOOL
    if not convert(sddl, 1, ctypes.byref(descriptor), ctypes.byref(size)):
        raise IntegrityKeyAccessError(
            f"integrity-key-acl-build-failed:{ctypes.get_last_error()}"
        )
    try:
        set_security = advapi32.SetFileSecurityW
        set_security.argtypes = [ctypes.c_wchar_p, ctypes.wintypes.DWORD, ctypes.c_void_p]
        set_security.restype = ctypes.wintypes.BOOL
        information = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION
        if not set_security(str(path), information, descriptor):
            raise IntegrityKeyAccessError(
                f"integrity-key-acl-set-failed:{ctypes.get_last_error()}"
            )
    finally:
        local_free = kernel32.LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free.restype = ctypes.c_void_p
        local_free(descriptor)
    _verify_private_acl(path, trusted_owners, allowed)


def _verify_private_acl(
    path: Path,
    trusted_owner_sids: set[str],
    allowed_sids: set[str],
) -> None:
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    information = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
    get_security = advapi32.GetFileSecurityW
    get_security.argtypes = [
        ctypes.c_wchar_p,
        ctypes.wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.wintypes.DWORD,
        ctypes.POINTER(ctypes.wintypes.DWORD),
    ]
    get_security.restype = ctypes.wintypes.BOOL
    needed = ctypes.wintypes.DWORD()
    get_security(str(path), information, None, 0, ctypes.byref(needed))
    if needed.value <= 0:
        raise IntegrityKeyAccessError(
            f"integrity-key-acl-read-failed:{ctypes.get_last_error()}"
        )
    buffer = ctypes.create_string_buffer(needed.value)
    if not get_security(
        str(path),
        information,
        buffer,
        needed.value,
        ctypes.byref(needed),
    ):
        raise IntegrityKeyAccessError(
            f"integrity-key-acl-read-failed:{ctypes.get_last_error()}"
        )
    descriptor = ctypes.cast(buffer, ctypes.c_void_p)
    owner = ctypes.c_void_p()
    owner_defaulted = ctypes.wintypes.BOOL()
    get_owner = advapi32.GetSecurityDescriptorOwner
    get_owner.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.wintypes.BOOL),
    ]
    get_owner.restype = ctypes.wintypes.BOOL
    if not get_owner(descriptor, ctypes.byref(owner), ctypes.byref(owner_defaulted)):
        raise IntegrityKeyAccessError("integrity-key-owner-read-failed")
    if _sid_to_string(owner) not in trusted_owner_sids:
        raise IntegrityKeyAccessError("integrity-key-owner-mismatch")

    control = ctypes.c_ushort()
    revision = ctypes.wintypes.DWORD()
    get_control = advapi32.GetSecurityDescriptorControl
    get_control.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ushort),
        ctypes.POINTER(ctypes.wintypes.DWORD),
    ]
    get_control.restype = ctypes.wintypes.BOOL
    if not get_control(descriptor, ctypes.byref(control), ctypes.byref(revision)):
        raise IntegrityKeyAccessError("integrity-key-acl-control-read-failed")
    if not control.value & SE_DACL_PROTECTED:
        raise IntegrityKeyAccessError("integrity-key-acl-inheritance-enabled")

    present = ctypes.wintypes.BOOL()
    defaulted = ctypes.wintypes.BOOL()
    dacl = ctypes.c_void_p()
    get_dacl = advapi32.GetSecurityDescriptorDacl
    get_dacl.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.wintypes.BOOL),
    ]
    get_dacl.restype = ctypes.wintypes.BOOL
    if not get_dacl(
        descriptor,
        ctypes.byref(present),
        ctypes.byref(dacl),
        ctypes.byref(defaulted),
    ) or not present.value or not dacl.value:
        raise IntegrityKeyAccessError("integrity-key-acl-missing")
    acl = ctypes.cast(dacl, ctypes.POINTER(ACL)).contents
    if int(acl.AceCount) != len(allowed_sids):
        raise IntegrityKeyAccessError("integrity-key-acl-unexpected-entry-count")
    observed: set[str] = set()
    get_ace = advapi32.GetAce
    get_ace.argtypes = [
        ctypes.c_void_p,
        ctypes.wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    get_ace.restype = ctypes.wintypes.BOOL
    for index in range(int(acl.AceCount)):
        ace_pointer = ctypes.c_void_p()
        if not get_ace(dacl, index, ctypes.byref(ace_pointer)) or not ace_pointer.value:
            raise IntegrityKeyAccessError("integrity-key-acl-entry-read-failed")
        header = ctypes.cast(ace_pointer, ctypes.POINTER(ACE_HEADER)).contents
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE or header.AceFlags & INHERITED_ACE:
            raise IntegrityKeyAccessError("integrity-key-acl-entry-invalid")
        mask = ctypes.c_uint32.from_address(ace_pointer.value + 4).value
        if mask != FILE_ALL_ACCESS:
            raise IntegrityKeyAccessError("integrity-key-acl-rights-invalid")
        sid = _sid_to_string(ctypes.c_void_p(ace_pointer.value + 8))
        if sid not in allowed_sids or sid in observed:
            raise IntegrityKeyAccessError("integrity-key-acl-principal-invalid")
        observed.add(sid)
    if observed != allowed_sids:
        raise IntegrityKeyAccessError("integrity-key-acl-principal-missing")


def _current_user_sid() -> str:
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    token = ctypes.wintypes.HANDLE()
    open_token = advapi32.OpenProcessToken
    open_token.argtypes = [
        ctypes.wintypes.HANDLE,
        ctypes.wintypes.DWORD,
        ctypes.POINTER(ctypes.wintypes.HANDLE),
    ]
    open_token.restype = ctypes.wintypes.BOOL
    kernel32.GetCurrentProcess.restype = ctypes.wintypes.HANDLE
    if not open_token(kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)):
        raise IntegrityKeyAccessError(
            f"current-user-token-open-failed:{ctypes.get_last_error()}"
        )
    try:
        get_information = advapi32.GetTokenInformation
        get_information.argtypes = [
            ctypes.wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.wintypes.DWORD,
            ctypes.POINTER(ctypes.wintypes.DWORD),
        ]
        get_information.restype = ctypes.wintypes.BOOL
        needed = ctypes.wintypes.DWORD()
        get_information(token, TOKEN_USER_CLASS, None, 0, ctypes.byref(needed))
        if needed.value <= 0:
            raise IntegrityKeyAccessError("current-user-token-read-failed")
        buffer = ctypes.create_string_buffer(needed.value)
        if not get_information(
            token,
            TOKEN_USER_CLASS,
            buffer,
            needed.value,
            ctypes.byref(needed),
        ):
            raise IntegrityKeyAccessError(
                f"current-user-token-read-failed:{ctypes.get_last_error()}"
            )
        token_user = ctypes.cast(buffer, ctypes.POINTER(TOKEN_USER)).contents
        return _sid_to_string(token_user.User.Sid)
    finally:
        kernel32.CloseHandle(token)


def _sid_to_string(sid: ctypes.c_void_p) -> str:
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    output = ctypes.c_wchar_p()
    convert = advapi32.ConvertSidToStringSidW
    convert.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    convert.restype = ctypes.wintypes.BOOL
    if not convert(sid, ctypes.byref(output)) or not output.value:
        raise IntegrityKeyAccessError("sid-conversion-failed")
    try:
        return str(output.value)
    finally:
        local_free = kernel32.LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free.restype = ctypes.c_void_p
        local_free(ctypes.cast(output, ctypes.c_void_p))


def _windows_last_error() -> int:
    value = int(ctypes.get_last_error())
    if value:
        return value
    try:
        return int(ctypes.windll.kernel32.GetLastError())
    except (AttributeError, OSError):
        return 0
