"""Bounded native process incarnation, without command line or environment."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import ctypes
import os


@dataclass(frozen=True)
class ProcessProbe:
    state: str  # alive, dead or unavailable; unknown is never confirmed absence.
    started: str | None = None


def probe_process(pid: int) -> ProcessProbe:
    if type(pid) is not int or not 0 < pid < 2**32:
        return ProcessProbe('dead')
    if os.name == 'nt':
        from ctypes import wintypes as w
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.OpenProcess.argtypes, api.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
        api.CloseHandle.argtypes, api.CloseHandle.restype = [w.HANDLE], w.BOOL
        api.WaitForSingleObject.argtypes, api.WaitForSingleObject.restype = [w.HANDLE, w.DWORD], w.DWORD
        api.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
        api.GetProcessTimes.restype = w.BOOL
        handle = api.OpenProcess(0x1000 | 0x100000, False, pid)
        if not handle:
            return ProcessProbe('dead' if ctypes.get_last_error() == 87 else 'unavailable')
        try:
            result = api.WaitForSingleObject(handle, 0)
            if result == 0:
                return ProcessProbe('dead')
            if result != 258:
                return ProcessProbe('unavailable')
            created, exited, kernel, user = (w.FILETIME() for _ in range(4))
            if not api.GetProcessTimes(handle, *(ctypes.byref(value) for value in (created, exited, kernel, user))):
                return ProcessProbe('unavailable')
            ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
            return ProcessProbe('alive', f'windows:{ticks:016x}')
        finally:
            api.CloseHandle(handle)
    # Linux procfs start ticks plus boot ID avoid wall-clock/float PID matching.
    try:
        with Path(f'/proc/{pid}/stat').open('rb') as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            return ProcessProbe('unavailable')
        values = raw.rsplit(b')', 1)[1].split()
        if values[0] == b'Z':
            return ProcessProbe('dead')
        ticks = values[19].decode('ascii')
        try:
            with Path('/proc/sys/kernel/random/boot_id').open('r', encoding='ascii') as stream:
                boot = stream.read(37).strip()
        except OSError:
            return ProcessProbe('unavailable')
        if not ticks.isdecimal() or len(boot) != 36:
            return ProcessProbe('unavailable')
        return ProcessProbe('alive', f'linux:{boot}:{ticks}')
    except FileNotFoundError:
        if Path('/proc').is_dir():
            return ProcessProbe('dead')
    except (OSError, UnicodeError, ValueError, IndexError):
        return ProcessProbe('unavailable')
    return ProcessProbe('unavailable')
