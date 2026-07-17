from __future__ import annotations

import importlib.util
import time
from typing import Any

from monarch_security.config import ModelConfig
from monarch_security.llm.base import BackendStatus


class LazyGgufBackend:
    def __init__(self, config: ModelConfig) -> None:
        self.config = config
        self._llm: Any | None = None
        self._last_used = 0.0
        self._import_error: str | None = None

    def status(self) -> BackendStatus:
        if not self.config.path.exists():
            return BackendStatus(False, False, f"model not found: {self.config.path}", "gguf")
        if self._import_error:
            return BackendStatus(False, self._llm is not None, self._import_error, "gguf")
        if importlib.util.find_spec("llama_cpp") is None:
            return BackendStatus(False, False, "llama-cpp-python is not installed", "gguf")
        return BackendStatus(True, self._llm is not None, "ready", "gguf")

    def generate(self, prompt: str) -> str:
        llm = self._get_or_load()
        result = llm(
            prompt,
            max_tokens=self.config.max_tokens,
            temperature=self.config.temperature,
            stop=["\n\n"],
        )
        self._last_used = time.monotonic()
        return str(result["choices"][0]["text"]).strip()

    def unload_if_idle(self) -> bool:
        if self._llm is None:
            return False
        if time.monotonic() - self._last_used < self.config.unload_after_seconds:
            return False
        self._llm = None
        return True

    def unload(self) -> None:
        self._llm = None

    def _get_or_load(self) -> Any:
        if self._llm is not None:
            return self._llm
        if not self.config.path.exists():
            raise RuntimeError(f"GGUF model not found: {self.config.path}")
        try:
            from llama_cpp import Llama  # type: ignore
        except Exception as exc:
            self._import_error = (
                "llama-cpp-python is not installed or failed to import: "
                f"{exc.__class__.__name__}: {exc}"
            )
            raise RuntimeError(self._import_error) from exc

        self._llm = Llama(
            model_path=str(self.config.path),
            n_ctx=self.config.n_ctx,
            n_threads=self.config.n_threads,
            verbose=False,
        )
        self._last_used = time.monotonic()
        return self._llm
