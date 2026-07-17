from __future__ import annotations

from dataclasses import dataclass
import ctypes
import sys
import time

from .config import ResourceConfig


@dataclass(frozen=True)
class ResourceState:
    cpu_percent: float | None
    memory_percent: float | None
    heavy: bool
    reason: str


class ResourceGuard:
    def __init__(self, config: ResourceConfig) -> None:
        self.config = config
        self._psutil = None
        self._windows_sampler = None
        self._last_sample_at = 0.0
        self._last_state = ResourceState(None, None, False, "resource metrics unavailable")
        try:
            import psutil  # type: ignore

            self._psutil = psutil
        except Exception:
            self._psutil = None
            if sys.platform == "win32":
                self._windows_sampler = _WindowsResourceSampler()

    @property
    def has_metrics(self) -> bool:
        return self._psutil is not None or self._windows_sampler is not None

    def sample(self, force: bool = False) -> ResourceState:
        if self._psutil is None and self._windows_sampler is None:
            return self._last_state

        now = time.monotonic()
        if not force and now - self._last_sample_at < 1.0:
            return self._last_state

        cpu, memory = self._sample_metrics()
        reasons = []
        if cpu is not None and cpu >= self.config.high_cpu_percent:
            reasons.append(f"cpu {cpu:.1f}%")
        if memory is not None and memory >= self.config.high_memory_percent:
            reasons.append(f"memory {memory:.1f}%")

        self._last_sample_at = now
        self._last_state = ResourceState(
            cpu_percent=cpu,
            memory_percent=memory,
            heavy=bool(reasons),
            reason=", ".join(reasons) if reasons else "normal",
        )
        return self._last_state

    def allow_expensive_work(self, critical: bool = False) -> bool:
        state = self.sample()
        if not state.heavy:
            return True
        return critical

    def process_poll_seconds(self) -> float:
        state = self.sample()
        if state.heavy:
            return self.config.heavy_process_poll_seconds
        return self.config.min_process_poll_seconds

    def _sample_metrics(self) -> tuple[float | None, float | None]:
        if self._psutil is not None:
            return (
                float(self._psutil.cpu_percent(interval=None)),
                float(self._psutil.virtual_memory().percent),
            )
        if self._windows_sampler is not None:
            return self._windows_sampler.sample()
        return None, None


class _FileTime(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", ctypes.c_uint32),
        ("dwHighDateTime", ctypes.c_uint32),
    ]


class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_uint32),
        ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


class _WindowsResourceSampler:
    def __init__(self) -> None:
        self._kernel32 = ctypes.windll.kernel32
        self._last_idle: int | None = None
        self._last_total: int | None = None

    def sample(self) -> tuple[float | None, float | None]:
        cpu = self._cpu_percent()
        memory = self._memory_percent()
        return cpu, memory

    def _cpu_percent(self) -> float | None:
        idle = _FileTime()
        kernel = _FileTime()
        user = _FileTime()
        ok = self._kernel32.GetSystemTimes(
            ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
        )
        if not ok:
            return None

        idle_value = self._filetime_to_int(idle)
        kernel_value = self._filetime_to_int(kernel)
        user_value = self._filetime_to_int(user)
        total = kernel_value + user_value

        if self._last_idle is None or self._last_total is None:
            self._last_idle = idle_value
            self._last_total = total
            return 0.0

        total_delta = total - self._last_total
        idle_delta = idle_value - self._last_idle
        self._last_idle = idle_value
        self._last_total = total

        if total_delta <= 0:
            return 0.0
        used = max(0, total_delta - idle_delta)
        return round((used / total_delta) * 100.0, 1)

    def _memory_percent(self) -> float | None:
        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        ok = self._kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        if not ok:
            return None
        return float(status.dwMemoryLoad)

    @staticmethod
    def _filetime_to_int(value: _FileTime) -> int:
        return (int(value.dwHighDateTime) << 32) + int(value.dwLowDateTime)
