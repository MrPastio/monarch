from __future__ import annotations

import csv
import io
import subprocess

from .schemas import HardwareInfo


def _query_nvidia_smi() -> dict[str, str] | None:
    cmd = [
        "nvidia-smi",
        "--query-gpu=name,memory.total,memory.used,driver_version",
        "--format=csv,noheader,nounits",
    ]
    try:
        completed = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=4)
    except (OSError, subprocess.SubprocessError):
        return None

    rows = list(csv.reader(io.StringIO(completed.stdout.strip())))
    if not rows:
        return None

    name, total, used, driver = [cell.strip() for cell in rows[0][:4]]
    return {
        "gpu_name": name,
        "gpu_memory_total_mb": total,
        "gpu_memory_used_mb": used,
        "driver_version": driver,
    }


def get_hardware_info() -> HardwareInfo:
    gpu = _query_nvidia_smi() or {}

    ram_total_gb = None
    ram_available_gb = None
    try:
        import psutil

        vm = psutil.virtual_memory()
        ram_total_gb = round(vm.total / (1024**3), 2)
        ram_available_gb = round(vm.available / (1024**3), 2)
    except Exception:
        pass

    torch_version = None
    cuda_available = False
    bf16_supported = None
    try:
        import torch

        torch_version = torch.__version__
        cuda_available = torch.cuda.is_available()
        if cuda_available:
            bf16_supported = torch.cuda.is_bf16_supported()
    except Exception:
        pass

    def as_int(value: str | None) -> int | None:
        if value is None:
            return None
        try:
            return int(float(value))
        except ValueError:
            return None

    return HardwareInfo(
        gpu_name=gpu.get("gpu_name"),
        gpu_memory_total_mb=as_int(gpu.get("gpu_memory_total_mb")),
        gpu_memory_used_mb=as_int(gpu.get("gpu_memory_used_mb")),
        driver_version=gpu.get("driver_version"),
        cuda_available=cuda_available,
        torch_version=torch_version,
        bf16_supported=bf16_supported,
        ram_total_gb=ram_total_gb,
        ram_available_gb=ram_available_gb,
    )
