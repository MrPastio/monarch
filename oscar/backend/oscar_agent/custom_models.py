"""Owner-added GGUF models ("custom-<id>" tiers).

The Monarch host owns the registry (``registry.v1.json`` in the custom models
directory); this runtime only reads it. A custom tier answers ordinary chat
with the model's own embedded chat template. It never takes part in automatic
tier routing, vision, speculative drafts or agent work.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

CUSTOM_TIER_PATTERN = re.compile(r"^custom-[a-z0-9]{6,32}$")
REGISTRY_FILE = "registry.v1.json"
DEFAULT_CONTEXT_TOKENS = 8192
_CACHE_SECONDS = 2.0

_cache_lock = threading.Lock()
_cache: tuple[str, float, float, dict[str, "CustomModelEntry"]] | None = None


@dataclass(frozen=True)
class CustomModelEntry:
    tier: str
    label: str
    path: Path
    context_tokens: int
    size_bytes: int


def is_custom_tier(value: object) -> bool:
    return isinstance(value, str) and bool(CUSTOM_TIER_PATTERN.fullmatch(value.strip().lower()))


def read_custom_models(root: Path | str) -> dict[str, CustomModelEntry]:
    """Ready models from the host registry; a damaged registry reads as empty."""
    global _cache
    registry = Path(root) / REGISTRY_FILE
    try:
        mtime = registry.stat().st_mtime
    except OSError:
        return {}
    now = time.monotonic()
    key = str(registry.resolve())
    with _cache_lock:
        if _cache and _cache[0] == key and _cache[1] == mtime and now - _cache[2] < _CACHE_SECONDS:
            return dict(_cache[3])
    try:
        payload = json.loads(registry.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    models: dict[str, CustomModelEntry] = {}
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        return {}
    for record in payload.get("models") or []:
        if not isinstance(record, dict) or record.get("status") != "ready":
            continue
        tier = str(record.get("id") or "").strip().lower()
        path_value = record.get("path")
        if not is_custom_tier(tier) or not isinstance(path_value, str) or not path_value:
            continue
        path = Path(path_value)
        if not path.is_absolute() or path.suffix.lower() != ".gguf":
            continue
        try:
            context = int(record.get("contextTokens") or DEFAULT_CONTEXT_TOKENS)
        except (TypeError, ValueError):
            context = DEFAULT_CONTEXT_TOKENS
        try:
            size = int(record.get("sizeBytes") or 0)
        except (TypeError, ValueError):
            size = 0
        label = str(record.get("label") or tier)[:60]
        models[tier] = CustomModelEntry(
            tier=tier,
            label=label,
            path=path,
            context_tokens=max(2048, min(131072, context)),
            size_bytes=max(0, size),
        )
    with _cache_lock:
        _cache = (key, mtime, now, dict(models))
    return models


def custom_model_entry(root: Path | str, tier: str) -> CustomModelEntry | None:
    return read_custom_models(root).get(str(tier or "").strip().lower())


def custom_gpu_layers(size_bytes: int) -> int:
    """Conservative offload for an unknown model on the tested 8 GiB device.

    Small models fit entirely; larger ones keep enough transient CUDA headroom
    that the native process does not fast-fail during sampling.
    """
    gib = size_bytes / (1024 ** 3) if size_bytes > 0 else 0
    if gib and gib <= 4.5:
        return 99
    if gib and gib <= 9:
        return 24
    return 14
