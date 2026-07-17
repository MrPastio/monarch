from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class BackendStatus:
    available: bool
    loaded: bool
    reason: str
    backend: str = "unknown"


class LLMBackend(Protocol):
    def status(self) -> BackendStatus:
        ...

    def generate(self, prompt: str) -> str:
        ...

    def unload_if_idle(self) -> bool:
        ...

    def unload(self) -> None:
        ...
