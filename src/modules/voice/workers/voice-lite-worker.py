from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Iterator


BACKEND = "llama-cpp-cpu"
MAX_TEXT_LENGTH = 1_200
EXPECTED_MODEL_NAMES = {
    "micro": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    "lite": "qwen3-1.7b-q4_k_m.gguf",
}
MICRO_SYSTEM_PROMPT_RU = """Ты Оскар. Дай только короткий русский ответ по запросу: без Markdown, рассуждений, выдуманных данных или действий."""
LITE_SYSTEM_PROMPT_RU = """Ты Оскар. Ответь по-русски естественно и точно, одним-двумя предложениями, без Markdown и рассуждений. Используй общие знания; не заявляй о live-данных, интернете, устройствах или выполненных действиях."""
PROFILE_POLICIES = {
    "micro": {
        "system_prompt": MICRO_SYSTEM_PROMPT_RU,
        "max_new_tokens": 64,
        "temperature": 0.0,
        "top_p": 1.0,
    },
    "lite": {
        "system_prompt": LITE_SYSTEM_PROMPT_RU,
        "max_new_tokens": 96,
        "temperature": 0.0,
        "top_p": 1.0,
    },
}

_DLL_DIRECTORY_HANDLES: list[Any] = []


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def configure_nvidia_dll_directories() -> None:
    """Allow the installed llama_cpp build to import; inference still uses zero GPU layers."""
    if os.name != "nt":
        return
    root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    candidates = [
        root / "cublas" / "bin",
        root / "cuda_runtime" / "bin",
        root / "nvjitlink" / "bin",
    ]
    existing = [candidate for candidate in candidates if candidate.is_dir()]
    if existing:
        current = [entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry]
        known = {entry.casefold() for entry in current}
        missing = [str(candidate) for candidate in existing if str(candidate).casefold() not in known]
        updated = os.pathsep.join([*missing, *current])
        if missing and len(updated) <= 32_767:
            os.environ["PATH"] = updated
    add_directory = getattr(os, "add_dll_directory", None)
    if callable(add_directory):
        for directory in existing:
            _DLL_DIRECTORY_HANDLES.append(add_directory(str(directory)))


class VoiceProfileEngine:
    def __init__(self, model_path: Path, profile: str) -> None:
        self.model_path = model_path.resolve()
        self.profile = profile
        self.model: Any | None = None
        self.load_ms = 0.0

    def prepare(self) -> dict[str, Any]:
        self._load()
        return {
            "status": "ready",
            "profile": self.profile,
            "backend": BACKEND,
            "model": self.model_path.name,
            "loadMs": round(self.load_ms, 2),
            "pid": os.getpid(),
        }

    def respond(
        self,
        text: str,
    ) -> dict[str, Any]:
        self._load()
        policy = PROFILE_POLICIES[self.profile]
        user_text = f"{text}\n/no_think" if self.profile == "lite" else text
        started = time.perf_counter()
        first_token_at: float | None = None
        pieces: list[str] = []
        try:
            stream = self.model.create_chat_completion(
                messages=[
                    {"role": "system", "content": policy["system_prompt"]},
                    {"role": "user", "content": user_text},
                ],
                max_tokens=policy["max_new_tokens"],
                temperature=policy["temperature"],
                top_p=policy["top_p"],
                repeat_penalty=1.05,
                stream=True,
            )
            for chunk in _iter_chunks(stream):
                content = _read_stream_content(chunk)
                if not content:
                    continue
                if first_token_at is None:
                    first_token_at = time.perf_counter()
                pieces.append(content)
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError("voice-lite-generation-failed", f"Локальный ответ не сгенерирован: {error}") from error

        finished = time.perf_counter()
        spoken_text = sanitize_spoken_text("".join(pieces))
        if not spoken_text:
            raise WorkerError("voice-lite-empty-response", "Локальная голосовая модель вернула пустой ответ.")
        return {
            "text": spoken_text,
            "profile": self.profile,
            "backend": BACKEND,
            "model": self.model_path.name,
            "loadMs": round(self.load_ms, 2),
            "generationMs": round((finished - started) * 1_000, 2),
            "ttftMs": round(((first_token_at or finished) - started) * 1_000, 2),
            "pid": os.getpid(),
        }

    def _load(self) -> None:
        if self.model is not None:
            return
        if not self.model_path.is_file():
            raise WorkerError("voice-lite-model-missing", f"Модель не найдена: {self.model_path.name}.")
        if self.model_path.suffix.lower() != ".gguf" or not _has_gguf_header(self.model_path):
            raise WorkerError("voice-lite-model-invalid", "Voice-lite model is not a valid GGUF file.")
        if self.model_path.name.casefold() != EXPECTED_MODEL_NAMES[self.profile].casefold():
            raise WorkerError(
                "voice-lite-model-profile-mismatch",
                f"Model file does not match the {self.profile} voice profile.",
            )

        configure_nvidia_dll_directories()
        try:
            from llama_cpp import Llama
        except Exception as error:
            raise WorkerError(
                "voice-lite-dependency-missing",
                f"llama-cpp-python недоступен в выбранном runtime: {error}",
            ) from error

        started = time.perf_counter()
        threads = max(2, min(8, (os.cpu_count() or 4) - 1))
        try:
            self.model = Llama(
                model_path=str(self.model_path),
                n_gpu_layers=0,
                n_ctx=1_536,
                n_batch=128,
                n_threads=threads,
                n_threads_batch=threads,
                use_mmap=True,
                use_mlock=False,
                offload_kqv=False,
                op_offload=False,
                verbose=False,
            )
        except Exception as error:
            raise WorkerError("voice-lite-model-load-failed", f"Voice-lite model could not load: {error}") from error
        self.load_ms = (time.perf_counter() - started) * 1_000
        if self.profile == "lite":
            self._disable_qwen3_thinking()

    def _disable_qwen3_thinking(self) -> None:
        try:
            from llama_cpp import llama_chat_format

            base_handler = (
                self.model.chat_handler
                or self.model._chat_handlers.get(self.model.chat_format)
                or llama_chat_format.get_chat_completion_handler(self.model.chat_format)
            )

            def chat_handler_no_think(*args: Any, **kwargs: Any) -> Any:
                return base_handler(*args, **{**kwargs, "enable_thinking": False})

            self.model.chat_handler = chat_handler_no_think
        except Exception as error:
            raise WorkerError(
                "voice-lite-template-failed",
                f"Could not enforce Qwen3 no-think chat template: {error}",
            ) from error


def _iter_chunks(stream: Any) -> Iterator[dict[str, Any]]:
    if not hasattr(stream, "__iter__"):
        raise WorkerError("voice-lite-protocol-error", "llama_cpp did not return a token stream.")
    for chunk in stream:
        if isinstance(chunk, dict):
            yield chunk


def _read_stream_content(chunk: dict[str, Any]) -> str:
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    delta = choices[0].get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def sanitize_spoken_text(value: str) -> str:
    text = repair_streamed_utf8_mojibake(str(value or ""))
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^[\s\S]*?</think>", "", text, count=1, flags=re.IGNORECASE)
    text = re.sub(r"<think>[\s\S]*$", "", text, count=1, flags=re.IGNORECASE)
    text = re.sub(r"\[\[\s*MONARCH_COMMAND[\s\S]*?\]\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"(?m)^\s{0,3}(?:#{1,6}|[-*+]\s|\d+[.)]\s)", "", text)
    text = re.sub(r"[`*_~]", "", text)
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:1_200].strip()


def repair_streamed_utf8_mojibake(value: str) -> str:
    """Repair Cyrillic UTF-8 byte pairs decoded as cp1251 by streamed llama output.

    A real Cyrillic word such as ``привет`` may arrive as ``РїСЂРёРІРµС‚`` on
    Windows. Repair only two-character sequences that round-trip to exactly one
    Cyrillic Unicode scalar; ordinary Russian pairs such as ``Ра`` do not form
    valid UTF-8 and are therefore preserved.
    """
    repaired: list[str] = []
    index = 0
    while index < len(value):
        if value[index] in "РС" and index + 1 < len(value):
            pair = value[index:index + 2]
            try:
                candidate = pair.encode("cp1251").decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                candidate = ""
            if len(candidate) == 1 and _is_cyrillic_scalar(candidate):
                repaired.append(candidate)
                index += 2
                continue
        repaired.append(value[index])
        index += 1
    return "".join(repaired)


def _is_cyrillic_scalar(value: str) -> bool:
    return len(value) == 1 and (
        "\u0400" <= value <= "\u04ff"
        or "\u0500" <= value <= "\u052f"
    )


def normalize_request(payload: dict[str, Any]) -> str:
    raw_text = payload.get("text")
    text = re.sub(r"\s+", " ", raw_text).strip() if isinstance(raw_text, str) else ""
    if not text:
        raise WorkerError("voice-lite-text-empty", "Voice-lite needs a non-empty transcript.")
    if len(text) > MAX_TEXT_LENGTH:
        raise WorkerError("voice-lite-text-too-long", "Voice-lite transcript is too long.")
    if any(key in payload for key in ("maxNewTokens", "temperature", "topP")):
        raise WorkerError(
            "voice-lite-policy-override-denied",
            "Voice model sampling policy is server-owned.",
        )
    return text


def _has_gguf_header(model_path: Path) -> bool:
    try:
        with model_path.open("rb") as stream:
            return stream.read(4) == b"GGUF"
    except OSError:
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monarch persistent CPU-only voice-lite worker")
    parser.add_argument("--profile", required=True, choices=sorted(PROFILE_POLICIES))
    parser.add_argument("--model", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    args = parse_args()
    engine = VoiceProfileEngine(args.model, args.profile)
    for line in sys.stdin:
        request_id: str | None = None
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise WorkerError("voice-lite-protocol-error", "JSONL request must be an object.")
            request_id = payload.get("id") if isinstance(payload.get("id"), str) else None
            request_type = payload.get("type")
            if request_type == "shutdown":
                emit({"id": request_id, "type": "shutdown", "ok": True})
                return 0
            if request_type == "prepare":
                emit({"id": request_id, "type": "ready", **engine.prepare()})
                continue
            if request_type == "respond":
                text = normalize_request(payload)
                emit({
                    "id": request_id,
                    "type": "response",
                    **engine.respond(text),
                })
                continue
            raise WorkerError("voice-lite-protocol-error", "Unsupported voice-lite request type.")
        except WorkerError as error:
            emit({"id": request_id, "type": "error", "code": error.code, "message": str(error)})
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            emit({
                "id": request_id,
                "type": "error",
                "code": "voice-lite-protocol-error",
                "message": f"Invalid voice-lite JSONL request: {error}",
            })
        except Exception as error:
            print(f"voice-lite worker failure: {error}", file=sys.stderr, flush=True)
            emit({
                "id": request_id,
                "type": "error",
                "code": "voice-lite-worker-error",
                "message": "Voice-lite worker failed unexpectedly.",
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
