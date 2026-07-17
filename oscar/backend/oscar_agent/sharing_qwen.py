"""Small local Qwen chat profiles exposed by Monarch Sharing.

These profiles deliberately stay separate from Voice Mode's long-lived workers:
Sharing receives caller-owned OpenAI messages, while Voice Mode owns a narrow
spoken-response prompt. The sharing runtime is process-local, serialized by
the existing Oscar inference lock, and unloaded after each request so it never
coexists with a loaded Gemma model inside Sharing.
"""

from __future__ import annotations

import gc
import os
import threading
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .model_runtime import configure_nvidia_dll_directories
from .schemas import ChatMessage


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_QWEN_MODELS_DIR = PROJECT_ROOT / "runtime" / "voice" / "models" / "voice-lite"


@dataclass(frozen=True, slots=True)
class QwenChatModel:
    id: str
    filename: str
    label: str
    description: str
    aliases: tuple[str, ...] = ()
    context_tokens: int = 1_536


QWEN_CHAT_MODELS: tuple[QwenChatModel, ...] = (
    QwenChatModel(
        id="qwen2.5-0.5b-instruct",
        filename="qwen2.5-0.5b-instruct-q4_k_m.gguf",
        label="Qwen2.5 0.5B",
        description="Минимальная локальная Qwen-модель для очень коротких запросов.",
        aliases=("qwen2.5-0.5b",),
    ),
    QwenChatModel(
        id="qwen3-1.7b-instruct",
        filename="qwen3-1.7b-q4_k_m.gguf",
        label="Qwen3 1.7B",
        description="Быстрый локальный Qwen3-профиль без thinking trace.",
        aliases=("qwen3-1.7b",),
    ),
)


def qwen_models_root(settings: object) -> Path:
    return Path(getattr(settings, "sharing_qwen_models_dir", DEFAULT_QWEN_MODELS_DIR)).resolve()


def find_qwen_chat_model(model_id: str) -> QwenChatModel | None:
    normalized = str(model_id or "").strip().lower()
    return next(
        (model for model in QWEN_CHAT_MODELS if normalized == model.id or normalized in model.aliases),
        None,
    )


def is_qwen_chat_model_available(settings: object, model: QwenChatModel) -> bool:
    path = qwen_models_root(settings) / model.filename
    if not path.is_file():
        return False
    try:
        with path.open("rb") as stream:
            return stream.read(4) == b"GGUF"
    except OSError:
        return False


def available_qwen_chat_models(settings: object) -> tuple[QwenChatModel, ...]:
    return tuple(model for model in QWEN_CHAT_MODELS if is_qwen_chat_model_available(settings, model))


class QwenSharingRuntime:
    """One-at-a-time CPU llama.cpp runtime for Sharing's Super Fast models."""

    def __init__(self, settings: object) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._model: Any | None = None
        self._model_id: str | None = None
        self._generation_cancelled = threading.Event()

    def available_models(self) -> tuple[QwenChatModel, ...]:
        return available_qwen_chat_models(self.settings)

    def unload(self) -> None:
        with self._lock:
            model = self._model
            self._model = None
            self._model_id = None
            if model is not None:
                close = getattr(model, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:
                        pass
            gc.collect()

    def reset_generation_cancel(self) -> None:
        self._generation_cancelled.clear()

    def cancel_generation(self) -> None:
        self._generation_cancelled.set()

    def stream_raw_chat(
        self,
        model_id: str,
        messages: list[ChatMessage],
        max_tokens: int,
        temperature: float,
        top_p: float,
    ) -> Generator[str, None, None]:
        model = find_qwen_chat_model(model_id)
        if model is None:
            raise ValueError(f"Unknown Qwen Sharing model: {model_id}")
        if not is_qwen_chat_model_available(self.settings, model):
            raise FileNotFoundError(f"Qwen model is not installed locally: {model.id}")

        with self._lock:
            llama = self._load(model)
            stream = llama.create_chat_completion(
                messages=[{"role": message.role, "content": message.content} for message in messages],
                max_tokens=max(32, min(int(max_tokens), model.context_tokens - 128)),
                temperature=float(temperature),
                top_p=float(top_p),
                repeat_penalty=1.05,
                stream=True,
            )
            for chunk in stream:
                if self._generation_cancelled.is_set():
                    return
                content = read_stream_content(chunk)
                if content:
                    yield content

    def _load(self, model: QwenChatModel):
        if self._model is not None and self._model_id == model.id:
            return self._model

        self.unload()
        # The installed llama-cpp package is CUDA-enabled even though these
        # Super Fast profiles stay CPU-only. On Windows its dependent CUDA DLLs
        # must still be discoverable before importing llama_cpp.
        configure_nvidia_dll_directories()
        from llama_cpp import Llama

        path = qwen_models_root(self.settings) / model.filename
        threads = max(2, min(8, (os.cpu_count() or 4) - 1))
        llama = Llama(
            model_path=str(path),
            n_gpu_layers=0,
            n_ctx=model.context_tokens,
            n_batch=128,
            n_threads=threads,
            n_threads_batch=threads,
            use_mmap=True,
            use_mlock=False,
            offload_kqv=False,
            op_offload=False,
            verbose=False,
        )
        if model.id.startswith("qwen3-"):
            self._disable_qwen3_thinking(llama)
        self._model = llama
        self._model_id = model.id
        return llama

    @staticmethod
    def _disable_qwen3_thinking(llama: Any) -> None:
        """Use Qwen3's native no-think template without changing caller text."""
        from llama_cpp import llama_chat_format

        handler = (
            llama.chat_handler
            or llama._chat_handlers.get(llama.chat_format)
            or llama_chat_format.get_chat_completion_handler(llama.chat_format)
        )

        def no_think_handler(*args: Any, **kwargs: Any) -> Any:
            return handler(*args, **{**kwargs, "enable_thinking": False})

        llama.chat_handler = no_think_handler


def read_stream_content(chunk: object) -> str:
    if not isinstance(chunk, dict):
        return ""
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    delta = choices[0].get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""
