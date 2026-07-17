from __future__ import annotations

from typing import Any
import hashlib
import json


def persistence_baseline_digest(signatures: dict[str, str]) -> str:
    canonical = json.dumps(
        {str(key): str(signatures[key]) for key in sorted(signatures)},
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_persistence_baseline_preview(
    current: dict[str, str],
    approved: dict[str, str],
    *,
    max_entries: int = 200,
) -> dict[str, Any]:
    current_keys = set(current)
    approved_keys = set(approved)
    added = sorted(current_keys - approved_keys)
    removed = sorted(approved_keys - current_keys)
    changed = sorted(key for key in current_keys & approved_keys if current[key] != approved[key])
    unchanged = sorted(key for key in current_keys & approved_keys if current[key] == approved[key])
    ordered = [
        *((key, "changed") for key in changed),
        *((key, "added") for key in added),
        *((key, "removed") for key in removed),
    ]
    bounded = ordered[: max(1, min(500, int(max_entries)))]
    return {
        "ok": True,
        "scope": "persistence",
        "digest": persistence_baseline_digest(current),
        "current_count": len(current),
        "approved_count": len(approved),
        "counts": {
            "added": len(added),
            "changed": len(changed),
            "removed": len(removed),
            "unchanged": len(unchanged),
        },
        "changes": [
            {"key": str(key)[:240], "status": status}
            for key, status in bounded
        ],
        "changes_truncated": max(0, len(ordered) - len(bounded)),
        "requires_confirmation": True,
        "note": "Digest binds approval to this exact current persistence snapshot.",
    }
