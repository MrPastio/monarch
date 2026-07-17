"""Local Qwen3-TTS bridge used by Monarch Sharing's audio endpoint."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TTS_MODELS_DIR = PROJECT_ROOT / "runtime" / "voice" / "models"
DEFAULT_TTS_PYTHON = PROJECT_ROOT / "runtime" / "voice" / ".venv" / "Scripts" / "python.exe"
TTS_WORKER = PROJECT_ROOT / "tools" / "sharing-tts-worker.py"
MAX_AUDIO_BYTES = 32 * 1024 * 1024
DEFAULT_TTS_TIMEOUT_SECONDS = 180


@dataclass(frozen=True, slots=True)
class QwenTtsModel:
    id: str
    directory: str
    mode: str
    label: str
    description: str


QWEN_TTS_MODELS: tuple[QwenTtsModel, ...] = (
    QwenTtsModel(
        id="qwen3-tts-0.6b-base",
        directory="qwen3-tts-0.6b-base",
        mode="base",
        label="Qwen3-TTS 0.6B Base",
        description="Быстрый voice-clone с тремя встроенными голосами Monarch.",
    ),
    QwenTtsModel(
        id="qwen3-tts-0.6b-custom",
        directory="qwen3-tts-0.6b-custom",
        mode="custom",
        label="Qwen3-TTS 0.6B CustomVoice",
        description="Встроенные Qwen timbres с текстовой стилевой инструкцией.",
    ),
    QwenTtsModel(
        id="qwen3-tts-1.7b-voice-design",
        directory="qwen3-tts-1.7b-voice-design",
        mode="design",
        label="Qwen3-TTS 1.7B Voice Design",
        description="Крупный профиль для создания голоса по естественной инструкции.",
    ),
)


class TtsSynthesisError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class TtsSynthesisResult:
    audio: bytes
    model: str
    sample_rate: int


def tts_models_root(settings: object) -> Path:
    return Path(getattr(settings, "sharing_tts_models_dir", DEFAULT_TTS_MODELS_DIR)).resolve()


def find_qwen_tts_model(model_id: str) -> QwenTtsModel | None:
    normalized = str(model_id or "").strip().lower()
    return next((model for model in QWEN_TTS_MODELS if model.id == normalized), None)


def is_qwen_tts_model_available(settings: object, model: QwenTtsModel) -> bool:
    root = tts_models_root(settings) / model.directory
    return (
        root.is_dir()
        and (root / "config.json").is_file()
        and (root / "model.safetensors").is_file()
        and (root / "speech_tokenizer" / "model.safetensors").is_file()
    )


def available_qwen_tts_models(settings: object) -> tuple[QwenTtsModel, ...]:
    return tuple(model for model in QWEN_TTS_MODELS if is_qwen_tts_model_available(settings, model))


class QwenTtsSharingRuntime:
    """Runs one bounded offline synthesis worker per Sharing request.

    The Qwen TTS dependencies intentionally live in ``runtime/voice/.venv``
    rather than Oscar's API environment. This is a worker process, not another
    HTTP service; it exits after writing the requested WAV and releases GPU RAM.
    """

    def __init__(
        self,
        settings: object,
        *,
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.settings = settings
        self._runner = runner

    def available_models(self) -> tuple[QwenTtsModel, ...]:
        return available_qwen_tts_models(self.settings)

    def synthesize(self, request: object) -> TtsSynthesisResult:
        model_id = str(getattr(request, "model", "")).strip().lower()
        model = find_qwen_tts_model(model_id)
        if model is None:
            raise TtsSynthesisError("model_not_found", f"The TTS model '{model_id}' does not exist in Monarch Sharing.")
        if not is_qwen_tts_model_available(self.settings, model):
            raise TtsSynthesisError("model_not_found", f"The TTS model '{model_id}' is not installed locally.")

        python_path = Path(getattr(self.settings, "sharing_tts_python", DEFAULT_TTS_PYTHON))
        if not python_path.is_file() or not TTS_WORKER.is_file():
            raise TtsSynthesisError(
                "tts_runtime_missing",
                "Qwen TTS runtime is unavailable. Run npm run voice:setup before using Sharing TTS.",
            )

        output_dir = Path(getattr(self.settings, "data_dir", PROJECT_ROOT / "oscar" / "data")) / "sharing-tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        descriptor, output_name = tempfile.mkstemp(prefix="speech-", suffix=".wav", dir=output_dir)
        os.close(descriptor)
        output_path = Path(output_name)
        payload = {
            "model": model.id,
            "input": str(getattr(request, "input", "")),
            "voice": str(getattr(request, "voice", "")),
            "language": str(getattr(request, "language", "ru-RU")),
            "instructions": str(getattr(request, "instructions", "")),
        }
        command = [
            str(python_path),
            "-u",
            str(TTS_WORKER),
            "--model-root",
            str(tts_models_root(self.settings)),
            "--workspace-root",
            str(PROJECT_ROOT),
            "--output-dir",
            str(output_dir),
            "--output",
            str(output_path),
        ]
        try:
            completed = self._runner(
                command,
                input=json.dumps(payload, ensure_ascii=False),
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=DEFAULT_TTS_TIMEOUT_SECONDS,
                check=False,
            )
            result = read_worker_result(completed.stdout)
            if completed.returncode != 0 or not result.get("ok"):
                code = str(result.get("code") or "tts_generation_failed")
                message = str(result.get("message") or "Local Qwen TTS could not synthesize speech.")[:500]
                raise TtsSynthesisError(code, message)
            audio = output_path.read_bytes()
            if len(audio) > MAX_AUDIO_BYTES or not is_wav(audio):
                raise TtsSynthesisError("tts_audio_invalid", "Local Qwen TTS returned an invalid WAV response.")
            sample_rate = result.get("sample_rate")
            if not isinstance(sample_rate, int) or sample_rate <= 0:
                raise TtsSynthesisError("tts_audio_invalid", "Local Qwen TTS did not report a valid sample rate.")
            return TtsSynthesisResult(audio=audio, model=model.id, sample_rate=sample_rate)
        except subprocess.TimeoutExpired as exc:
            raise TtsSynthesisError("tts_timeout", "Local Qwen TTS did not finish before the 180-second safety timeout.") from exc
        except OSError as exc:
            raise TtsSynthesisError("tts_worker_start_failed", f"Local Qwen TTS worker could not start: {exc}") from exc
        finally:
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass


def read_worker_result(stdout: str) -> dict[str, Any]:
    for line in reversed(str(stdout or "").splitlines()):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {"ok": False, "code": "tts_worker_protocol_error", "message": "Qwen TTS worker returned no valid result."}


def is_wav(value: bytes) -> bool:
    return len(value) >= 12 and value[:4] == b"RIFF" and value[8:12] == b"WAVE"
