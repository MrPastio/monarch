"""Windows-only, explicit owner asset admission. No discovery or model loading."""
from __future__ import annotations

import ctypes
import hashlib
import os
import re
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AstraAssetExpectation:
    root: Path
    candidate: Path
    digest: str
    size: int


@dataclass(frozen=True)
class AstraPinnedAsset:
    path: Path
    digest: str
    size: int
    device: int
    inode: int


@contextmanager
def pin_astra_asset(*, root: Path, candidate: Path, expected_digest: str, expected_bytes: int):
    """Keep admitted bytes read-shareable, but not writable/deletable, until exit.

    Root and expected variant must come from the host's component owner, NOT a
    model request. Keep this context alive through native load and residency.
    No non-Windows approximation, per-turn hash, or claim against privileged OS
    tampering. Caller must stop native work before leaving this context.
    """
    if os.name != "nt":
        raise ValueError("asset-pin-platform")
    if not isinstance(expected_digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest):
        raise ValueError("asset-pin-digest")
    if type(expected_bytes) is not int or expected_bytes < 4:
        raise ValueError("asset-pin-size")
    physical_root = root.resolve(strict=True)
    lexical = Path(os.path.abspath(candidate))
    physical = lexical.resolve(strict=True)
    if not physical_root.is_dir() or lexical != physical or not physical.is_relative_to(physical_root) or physical == physical_root:
        raise ValueError("asset-pin-scope")
    if not stat.S_ISREG(physical.stat().st_mode):
        raise ValueError("asset-pin-file")

    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handles = []

    def opened(path: Path, access: int, sharing: int, flags: int):
        handle = create(str(path), access, sharing, None, 3, flags, None)  # OPEN_EXISTING
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        handles.append(handle)
        return handle

    try:
        # Deny renaming the owned directory chain; allow normal unrelated child I/O.
        directory = physical_root
        opened(directory, 0x80, 3, 0x02000000)  # attributes, READ|WRITE, BACKUP_SEMANTICS
        for part in physical.relative_to(physical_root).parts[:-1]:
            directory /= part
            opened(directory, 0x80, 3, 0x02000000)
        handle = opened(physical, 0x80000000, 1, 0x00200000)  # GENERIC_READ, SHARE_READ, OPEN_REPARSE_POINT
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handles.pop()  # fd now owns this handle, including on hash/validation failure.
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            current = physical.stat()
            if (getattr(before, "st_file_attributes", 0) & 0x400 or not stat.S_ISREG(before.st_mode)
                    or before.st_size != expected_bytes or not os.path.samestat(before, current)
                    or lexical.resolve(strict=True) != physical):
                raise ValueError("asset-pin-identity")
            if stream.read(4) != b"GGUF":
                raise ValueError("asset-pin-envelope")
            digest = hashlib.sha256(b"GGUF")
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            if "sha256:" + digest.hexdigest() != expected_digest:
                raise ValueError("asset-pin-hash")
            after = os.fstat(stream.fileno())
            if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
                raise ValueError("asset-pin-changed")
            yield AstraPinnedAsset(physical, expected_digest, expected_bytes, before.st_dev, before.st_ino)
    finally:
        for handle in reversed(handles):
            close(handle)
