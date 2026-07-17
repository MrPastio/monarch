from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import ctypes
from ctypes import wintypes
import json
import os
import statistics
import time


MAX_BENCHMARK_SAMPLES = 3_600


def run_background_benchmark(
    pid_path: Path,
    reports_root: Path,
    *,
    duration_seconds: float = 300.0,
    interval_seconds: float = 0.5,
    output_path: Path | None = None,
    sampler: Any | None = None,
) -> dict[str, Any]:
    duration = max(0.1, min(900.0, float(duration_seconds)))
    interval = max(0.05, min(5.0, float(interval_seconds)))
    sample_limit = min(MAX_BENCHMARK_SAMPLES, max(1, int(duration / interval)))
    pid = int(pid_path.read_text(encoding="utf-8").strip())

    process_sampler = sampler or _create_process_sampler(pid)
    started_at = _utc_now()
    started = time.perf_counter()
    samples: list[dict[str, Any]] = []
    error: str | None = None
    for _ in range(sample_limit):
        remaining = duration - (time.perf_counter() - started)
        if remaining <= 0:
            break
        try:
            cpu, rss = process_sampler.sample(min(interval, remaining))
            samples.append({
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "cpu_percent": round(cpu, 2),
                "rss_bytes": int(rss),
            })
        except (OSError, RuntimeError) as exc:
            error = f"{type(exc).__name__}: {exc}"[:200]
            break
    close = getattr(process_sampler, "close", None)
    if callable(close):
        close()

    cpu_values = [float(item["cpu_percent"]) for item in samples]
    rss_values = [int(item["rss_bytes"]) for item in samples]
    elapsed = max(0.0, time.perf_counter() - started)
    payload: dict[str, Any] = {
        "ok": bool(samples) and error is None,
        "measurement": "background_protector_process_observation",
        "pid": pid,
        "started_at": started_at,
        "finished_at": _utc_now(),
        "requested_duration_seconds": duration,
        "observed_duration_seconds": round(elapsed, 3),
        "interval_seconds": interval,
        "sample_count": len(samples),
        "sample_limit": sample_limit,
        "completed_window": error is None and elapsed >= max(0.0, duration - interval),
        "cpu_percent": _summary(cpu_values),
        "rss_bytes": _summary(rss_values),
        "active_sample_rate": {
            "above_1_percent": _rate(cpu_values, 1.0),
            "above_5_percent": _rate(cpu_values, 5.0),
            "scope": "process_cpu_samples_not_per_sensor_duty_cycle",
        },
        "samples": samples,
        "error": error,
        "limitations": [
            "CPU is observed for the whole protector process, not attributed to individual sensors.",
            "The benchmark does not generate attacks and does not measure sensor polling detection latency.",
            "Results describe this local observation window only.",
        ],
    }
    artifact = _write_artifact(reports_root, output_path, payload)
    payload["artifact_path"] = str(artifact)
    return payload


def _summary(values: list[float] | list[int]) -> dict[str, float | int | None]:
    if not values:
        return {"p50": None, "p95": None, "max": None}
    ordered = sorted(values)
    return {
        "p50": round(float(statistics.median(ordered)), 2),
        "p95": round(float(_percentile(ordered, 0.95)), 2),
        "max": round(float(max(ordered)), 2),
    }


def _percentile(values: list[float] | list[int], quantile: float) -> float:
    index = min(len(values) - 1, max(0, int(round((len(values) - 1) * quantile))))
    return float(values[index])


def _rate(values: list[float], threshold: float) -> float:
    if not values:
        return 0.0
    return round(sum(1 for value in values if value > threshold) / len(values), 4)


def _write_artifact(reports_root: Path, requested: Path | None, payload: dict[str, Any]) -> Path:
    root = reports_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    if requested is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = root / f"background-benchmark-{stamp}.json"
    else:
        target = requested if requested.is_absolute() else root / requested
        target = target.resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise ValueError("benchmark output must stay inside the local security reports directory") from exc
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    return target


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _create_process_sampler(pid: int):
    try:
        import psutil  # type: ignore

        return _PsutilSampler(psutil.Process(pid))
    except ImportError:
        if os.name == "nt":
            return _WindowsProcessSampler(pid)
        raise RuntimeError("process metrics require psutil outside Windows")


class _PsutilSampler:
    def __init__(self, process: Any) -> None:
        self.process = process

    def sample(self, interval: float) -> tuple[float, int]:
        cpu = float(self.process.cpu_percent(interval=interval))
        return cpu, int(self.process.memory_info().rss)


class _WindowsProcessSampler:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_VM_READ = 0x0010

    class _FILETIME(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    class _PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
            ("PrivateUsage", ctypes.c_size_t),
        ]

    def __init__(self, pid: int) -> None:
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.psapi = ctypes.WinDLL("psapi", use_last_error=True)
        self.handle = self.kernel32.OpenProcess(
            self.PROCESS_QUERY_LIMITED_INFORMATION | self.PROCESS_VM_READ,
            False,
            pid,
        )
        if not self.handle:
            raise OSError(ctypes.get_last_error(), f"OpenProcess failed for PID {pid}")
        self.last_cpu = self._cpu_seconds()
        self.last_wall = time.perf_counter()

    def sample(self, interval: float) -> tuple[float, int]:
        time.sleep(interval)
        now = time.perf_counter()
        cpu = self._cpu_seconds()
        wall_delta = max(0.000001, now - self.last_wall)
        cpu_percent = max(0.0, (cpu - self.last_cpu) / wall_delta * 100.0)
        self.last_cpu = cpu
        self.last_wall = now
        counters = self._PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(counters)
        if not self.psapi.GetProcessMemoryInfo(
            self.handle,
            ctypes.byref(counters),
            counters.cb,
        ):
            raise OSError(ctypes.get_last_error(), "GetProcessMemoryInfo failed")
        return cpu_percent, int(counters.WorkingSetSize)

    def _cpu_seconds(self) -> float:
        created = self._FILETIME()
        exited = self._FILETIME()
        kernel = self._FILETIME()
        user = self._FILETIME()
        if not self.kernel32.GetProcessTimes(
            self.handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            raise OSError(ctypes.get_last_error(), "GetProcessTimes failed")
        return (_filetime_value(kernel) + _filetime_value(user)) / 10_000_000.0

    def close(self) -> None:
        if self.handle:
            self.kernel32.CloseHandle(self.handle)
            self.handle = None


def _filetime_value(value: _WindowsProcessSampler._FILETIME) -> int:
    return (int(value.high) << 32) | int(value.low)
