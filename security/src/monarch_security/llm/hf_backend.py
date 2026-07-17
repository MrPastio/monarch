from __future__ import annotations

import importlib.util
import time
from typing import Any

from monarch_security.config import ModelConfig
from monarch_security.llm.base import BackendStatus


class LazyHfBackend:
    def __init__(self, config: ModelConfig) -> None:
        self.config = config
        self._model: Any | None = None
        self._tokenizer: Any | None = None
        self._torch: Any | None = None
        self._device = "cpu"
        self._last_used = 0.0
        self._import_error: str | None = None

    def status(self) -> BackendStatus:
        if not self.config.path.exists():
            return BackendStatus(False, False, f"model not found: {self.config.path}", "hf")
        if not self.config.path.is_dir():
            return BackendStatus(False, False, "HF backend requires a model directory", "hf")
        if self._import_error:
            return BackendStatus(False, self._model is not None, self._import_error, "hf")
        missing = [
            package
            for package in ("transformers", "torch")
            if importlib.util.find_spec(package) is None
        ]
        if missing:
            return BackendStatus(
                False,
                False,
                "missing optional packages: " + ", ".join(missing),
                "hf",
            )
        return BackendStatus(True, self._model is not None, "ready", "hf")

    def generate(self, prompt: str) -> str:
        model, tokenizer, torch = self._get_or_load()
        encoded = tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=self.config.n_ctx,
        )
        encoded = {key: value.to(self._device) for key, value in encoded.items()}
        generate_kwargs = {
            "max_new_tokens": self.config.max_tokens,
            "do_sample": self.config.temperature > 0,
            "pad_token_id": tokenizer.eos_token_id,
        }
        if self.config.temperature > 0:
            generate_kwargs["temperature"] = self.config.temperature
        with torch.no_grad():
            generated = model.generate(**encoded, **generate_kwargs)
        prompt_length = int(encoded["input_ids"].shape[-1])
        text = tokenizer.decode(generated[0][prompt_length:], skip_special_tokens=True)
        self._last_used = time.monotonic()
        return str(text).strip()

    def unload_if_idle(self) -> bool:
        if self._model is None:
            return False
        if time.monotonic() - self._last_used < self.config.unload_after_seconds:
            return False
        self.unload()
        return True

    def unload(self) -> None:
        self._model = None
        self._tokenizer = None
        self._torch = None
        self._device = "cpu"

    def _get_or_load(self) -> tuple[Any, Any, Any]:
        if self._model is not None and self._tokenizer is not None and self._torch is not None:
            return self._model, self._tokenizer, self._torch
        try:
            import torch  # type: ignore
            from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
        except Exception as exc:
            self._import_error = (
                "transformers/torch are not installed or failed to import: "
                f"{exc.__class__.__name__}: {exc}"
            )
            raise RuntimeError(self._import_error) from exc

        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        tokenizer = AutoTokenizer.from_pretrained(
            str(self.config.path),
            local_files_only=True,
            trust_remote_code=False,
        )
        model = AutoModelForCausalLM.from_pretrained(
            str(self.config.path),
            local_files_only=True,
            trust_remote_code=False,
            torch_dtype="auto",
        )
        model.to(self._device)
        model.eval()

        self._torch = torch
        self._tokenizer = tokenizer
        self._model = model
        self._last_used = time.monotonic()
        return model, tokenizer, torch
