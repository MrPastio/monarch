"""Explicit same-owner local Memory V4 binding; no lookup, credentials or routing."""
from __future__ import annotations

import re
from collections.abc import Callable

from .memory_v4 import MemoryV4Service


def create_astra_memory_guard(service: MemoryV4Service, *, owner_actor: str) -> Callable[[str, str], bool]:
    """Bind an existing service to the current chat-only local recall contract.

    The token is a version, not a capability. Actor and scope are host-owned.
    This checks admission on the model worker, not atomic SQL/GPU execution.
    SQLite lock waiting is short; the model host retains physical worker ownership
    if the OS itself stalls. Never retrieve text or start the semantic model here.
    """
    if not isinstance(owner_actor, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,96}", owner_actor):
        raise ValueError("memory-guard-owner")

    def current(actor: str, token: str) -> bool:
        if actor != owner_actor or not isinstance(token, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", token):
            return False
        try:
            return service.read_context_validity({"type": "chat"}, lock_timeout=0.1)["validityToken"] == token
        except Exception:
            return False

    return current
