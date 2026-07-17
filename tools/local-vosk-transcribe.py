#!/usr/bin/env python3
"""Local Vosk STT adapter and persistent worker for Monarch voice input."""

from __future__ import annotations

import gc
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Any


SUPPORTED_LANGUAGES = {"ru", "uk", "bg", "en"}
MAX_WORKER_AUDIO_BYTES = 12 * 1024 * 1024
MAX_STREAMING_PCM_BYTES = 3 * 1024 * 1024
MAX_STREAMING_SESSIONS = 4
MAX_STREAMING_DURATION_SECONDS = 30


class WorkerFailure(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class VoskEngine:
    """Keeps exactly one Vosk model resident and reuses it between utterances."""

    def __init__(self) -> None:
        self._model: Any | None = None
        self._model_dir: Path | None = None
        self._streams: dict[str, dict[str, Any]] = {}

    def prepare(self, language: str) -> dict[str, Any]:
        language_code = require_language_code(language)
        model_dir = require_model_dir(language_code)
        load_ms = self._ensure_model(model_dir)
        return {
            "engine": "vosk",
            "model": model_dir.name,
            "loadMs": load_ms,
            "warm": load_ms == 0,
            "pid": os.getpid(),
        }

    def transcribe(self, audio_path: Path, language: str) -> dict[str, Any]:
        language_code = require_language_code(language)
        model_dir = require_model_dir(language_code)
        ffmpeg = os.environ.get("MONARCH_FFMPEG_PATH") or shutil.which("ffmpeg")
        if not ffmpeg:
            raise WorkerFailure(
                "voice-stt-runtime-missing",
                "ffmpeg не найден в PATH. Он нужен для локальной конвертации аудио.",
            )

        started_at = time.perf_counter()
        load_ms = self._ensure_model(model_dir)
        with tempfile.TemporaryDirectory(prefix="monarch-vosk-decode-") as temp_dir:
            wav_path = Path(temp_dir) / "voice.wav"
            convert_started_at = time.perf_counter()
            convert = convert_audio(ffmpeg, audio_path, wav_path)
            conversion_ms = elapsed_ms(convert_started_at)
            if convert.returncode != 0:
                diagnostic = convert.stderr.strip()[-800:]
                raise WorkerFailure(
                    "voice-stt-command-exit",
                    f"ffmpeg не смог прочитать аудио: {diagnostic}",
                )

            recognition_started_at = time.perf_counter()
            transcript = transcribe_wav(wav_path, self._model)
            recognition_ms = elapsed_ms(recognition_started_at)

        return {
            "text": transcript,
            "engine": "vosk",
            "model": model_dir.name,
            "loadMs": load_ms,
            "warm": load_ms == 0,
            "conversionMs": conversion_ms,
            "recognitionMs": recognition_ms,
            "totalMs": elapsed_ms(started_at),
            "pid": os.getpid(),
        }

    def _ensure_model(self, model_dir: Path) -> int:
        if self._model is not None and self._model_dir == model_dir:
            return 0

        try:
            from vosk import Model, SetLogLevel
        except Exception as exc:  # pragma: no cover - environment-specific message.
            raise WorkerFailure(
                "voice-stt-runtime-missing",
                f"Python package vosk is not available: {exc}",
            ) from exc

        SetLogLevel(-1)
        self._model = None
        self._model_dir = None
        gc.collect()
        started_at = time.perf_counter()
        try:
            model = Model(str(model_dir))
        except Exception as exc:
            raise WorkerFailure(
                "voice-stt-model-load-failed",
                f"Vosk не смог загрузить модель {model_dir.name}: {exc}",
            ) from exc
        self._model = model
        self._model_dir = model_dir
        return elapsed_ms(started_at)

    def start_stream(self, stream_id: str, language: str, sample_rate: int) -> dict[str, Any]:
        if stream_id in self._streams:
            raise WorkerFailure("voice-stt-stream-conflict", "STT stream already exists.")
        if len(self._streams) >= MAX_STREAMING_SESSIONS:
            raise WorkerFailure("voice-stt-stream-limit", "Too many active STT streams.")
        if sample_rate < 8_000 or sample_rate > 48_000:
            raise WorkerFailure("voice-stt-stream-rate-invalid", "STT stream sample rate is invalid.")
        language_code = require_language_code(language)
        model_dir = require_model_dir(language_code)
        if self._streams and self._model_dir != model_dir:
            raise WorkerFailure(
                "voice-stt-stream-language-busy",
                "Cannot switch the resident Vosk model while another stream is active.",
            )
        load_ms = self._ensure_model(model_dir)
        try:
            from vosk import KaldiRecognizer
        except Exception as exc:  # pragma: no cover - environment-specific message.
            raise WorkerFailure(
                "voice-stt-runtime-missing",
                f"Python package vosk is not available: {exc}",
            ) from exc
        recognizer = KaldiRecognizer(self._model, sample_rate)
        recognizer.SetWords(False)
        self._streams[stream_id] = {
            "recognizer": recognizer,
            "model": model_dir.name,
            "sampleRate": sample_rate,
            "sequence": 0,
            "bytes": 0,
            "frames": 0,
            "parts": [],
            "recognitionMs": 0,
            "startedAt": time.perf_counter(),
            "lastPartialAt": None,
        }
        return {
            "engine": "vosk",
            "model": model_dir.name,
            "loadMs": load_ms,
            "warm": load_ms == 0,
            "sampleRate": sample_rate,
            "pid": os.getpid(),
        }

    def push_stream(self, stream_id: str, sequence: int, pcm_base64: str) -> dict[str, Any]:
        state = self._streams.get(stream_id)
        if state is None:
            raise WorkerFailure("voice-stt-stream-not-found", "STT stream does not exist.")
        if sequence != state["sequence"]:
            raise WorkerFailure("voice-stt-stream-sequence", "STT stream batch sequence is invalid.")
        try:
            pcm = base64.b64decode(pcm_base64, validate=True)
        except Exception as exc:
            raise WorkerFailure("voice-stt-stream-pcm-invalid", "STT PCM batch is invalid.") from exc
        if not pcm or len(pcm) % 2 != 0 or len(pcm) > 64 * 1024:
            raise WorkerFailure("voice-stt-stream-pcm-invalid", "STT PCM batch size is invalid.")
        next_bytes = state["bytes"] + len(pcm)
        next_frames = state["frames"] + len(pcm) // 2
        if next_bytes > MAX_STREAMING_PCM_BYTES:
            raise WorkerFailure("voice-stt-stream-too-large", "STT stream exceeded its byte limit.")
        if next_frames > state["sampleRate"] * MAX_STREAMING_DURATION_SECONDS:
            raise WorkerFailure("voice-stt-stream-too-long", "STT stream exceeded its duration limit.")

        started_at = time.perf_counter()
        recognizer = state["recognizer"]
        if recognizer.AcceptWaveform(pcm):
            append_result(state["parts"], recognizer.Result())
            partial = " ".join(state["parts"]).strip()
        else:
            partial = read_partial_result(recognizer.PartialResult())
            if state["parts"] and partial:
                partial = f"{' '.join(state['parts'])} {partial}".strip()
        processing_ms = elapsed_ms(started_at)
        state["recognitionMs"] += processing_ms
        state["sequence"] += 1
        state["bytes"] = next_bytes
        state["frames"] = next_frames
        if partial:
            state["lastPartialAt"] = time.perf_counter()
        return {
            "engine": "vosk",
            "partial": partial,
            "sequence": sequence,
            "processingMs": processing_ms,
            "audioMs": round(next_frames * 1000 / state["sampleRate"]),
            "pid": os.getpid(),
        }

    def finish_stream(self, stream_id: str) -> dict[str, Any]:
        state = self._streams.pop(stream_id, None)
        if state is None:
            raise WorkerFailure("voice-stt-stream-not-found", "STT stream does not exist.")
        started_at = time.perf_counter()
        append_result(state["parts"], state["recognizer"].FinalResult())
        finalize_ms = elapsed_ms(started_at)
        last_partial_at = state["lastPartialAt"]
        return {
            "text": " ".join(part for part in state["parts"] if part).strip(),
            "engine": "vosk",
            "model": state["model"],
            "recognitionMs": state["recognitionMs"],
            "finalizeMs": finalize_ms,
            "audioMs": round(state["frames"] * 1000 / state["sampleRate"]),
            "bytes": state["bytes"],
            "partialAgeMs": (
                elapsed_ms(last_partial_at) if isinstance(last_partial_at, float) else None
            ),
            "pid": os.getpid(),
        }

    def cancel_stream(self, stream_id: str) -> bool:
        return self._streams.pop(stream_id, None) is not None


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        return run_worker()

    audio_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
    language = sys.argv[2] if len(sys.argv) > 2 else "ru-RU"
    if not audio_path or not audio_path.exists():
        return fail("Audio file was not provided.")

    try:
        result = VoskEngine().transcribe(audio_path, language)
    except WorkerFailure as exc:
        return fail(str(exc), exc.code)

    print(json.dumps(result, ensure_ascii=False))
    return 0


def run_worker() -> int:
    engine = VoskEngine()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = parse_worker_request(line)
            request_id = request["id"]
            request_type = request["type"]
            if request_type == "shutdown":
                emit_worker({"id": request_id, "type": "stopped", "pid": os.getpid()})
                return 0
            if request_type == "prepare":
                result = engine.prepare(request["language"])
                emit_worker({"id": request_id, "type": "ready", **result})
                continue
            if request_type == "stream-start":
                result = engine.start_stream(
                    request["streamId"],
                    request["language"],
                    request["sampleRate"],
                )
                emit_worker({"id": request_id, "type": "stream-started", **result})
                continue
            if request_type == "stream-push":
                result = engine.push_stream(
                    request["streamId"],
                    request["sequence"],
                    request["pcmBase64"],
                )
                emit_worker({"id": request_id, "type": "stream-partial", **result})
                continue
            if request_type == "stream-finish":
                result = engine.finish_stream(request["streamId"])
                emit_worker({"id": request_id, "type": "stream-final", **result})
                continue
            if request_type == "stream-cancel":
                cancelled = engine.cancel_stream(request["streamId"])
                emit_worker({
                    "id": request_id,
                    "type": "stream-cancelled",
                    "cancelled": cancelled,
                    "pid": os.getpid(),
                })
                continue
            audio_path = require_worker_audio_path(request["audioPath"])
            result = engine.transcribe(audio_path, request["language"])
            emit_worker({"id": request_id, "type": "transcript", **result})
        except WorkerFailure as exc:
            emit_worker({
                "id": request_id,
                "type": "error",
                "code": exc.code,
                "message": str(exc)[:500],
            })
        except Exception as exc:  # pragma: no cover - final protocol guard.
            emit_worker({
                "id": request_id,
                "type": "error",
                "code": "voice-stt-worker-error",
                "message": str(exc)[:500],
            })
    return 0


def parse_worker_request(line: str) -> dict[str, Any]:
    try:
        value = json.loads(line)
    except Exception as exc:
        raise WorkerFailure("voice-stt-protocol-error", "STT worker received invalid JSON.") from exc
    if not isinstance(value, dict):
        raise WorkerFailure("voice-stt-protocol-error", "STT worker request must be an object.")
    request_id = value.get("id")
    request_type = value.get("type")
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 160:
        raise WorkerFailure("voice-stt-protocol-error", "STT worker request id is invalid.")
    if request_type not in {
        "prepare",
        "transcribe",
        "shutdown",
        "stream-start",
        "stream-push",
        "stream-finish",
        "stream-cancel",
    }:
        raise WorkerFailure("voice-stt-protocol-error", "STT worker request type is invalid.")
    language = value.get("language", "ru-RU")
    if not isinstance(language, str) or len(language) > 32:
        raise WorkerFailure("voice-stt-language-unsupported", "Voice language is invalid.")
    audio_path = value.get("audioPath", "")
    if request_type == "transcribe" and not isinstance(audio_path, str):
        raise WorkerFailure("voice-stt-audio-invalid", "STT worker audio path is invalid.")
    stream_id = value.get("streamId", "")
    if request_type.startswith("stream-") and (
        not isinstance(stream_id, str)
        or not stream_id.strip()
        or len(stream_id) > 160
    ):
        raise WorkerFailure("voice-stt-protocol-error", "STT worker stream id is invalid.")
    sample_rate = value.get("sampleRate", 0)
    if request_type == "stream-start" and (
        not isinstance(sample_rate, int)
        or isinstance(sample_rate, bool)
        or sample_rate < 8_000
        or sample_rate > 48_000
    ):
        raise WorkerFailure("voice-stt-stream-rate-invalid", "STT stream sample rate is invalid.")
    sequence = value.get("sequence", 0)
    if request_type == "stream-push" and (
        not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 0
    ):
        raise WorkerFailure("voice-stt-stream-sequence", "STT stream sequence is invalid.")
    pcm_base64 = value.get("pcmBase64", "")
    if request_type == "stream-push" and (
        not isinstance(pcm_base64, str)
        or not pcm_base64
        or len(pcm_base64) > 96 * 1024
    ):
        raise WorkerFailure("voice-stt-stream-pcm-invalid", "STT PCM batch is invalid.")
    return {
        "id": request_id.strip(),
        "type": request_type,
        "language": language,
        "audioPath": audio_path,
        "streamId": stream_id.strip() if isinstance(stream_id, str) else "",
        "sampleRate": sample_rate,
        "sequence": sequence,
        "pcmBase64": pcm_base64,
    }


def require_worker_audio_path(value: str) -> Path:
    if not value:
        raise WorkerFailure("voice-stt-audio-invalid", "STT worker audio path is missing.")
    candidate = Path(value).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    try:
        candidate.relative_to(temp_root)
    except ValueError as exc:
        raise WorkerFailure(
            "voice-stt-audio-path-denied",
            "STT worker accepts only Monarch temporary audio files.",
        ) from exc
    if not candidate.is_file():
        raise WorkerFailure("voice-stt-audio-invalid", "STT worker audio file does not exist.")
    if candidate.stat().st_size > MAX_WORKER_AUDIO_BYTES:
        raise WorkerFailure("voice-audio-too-large", "STT worker audio file is too large.")
    return candidate


def emit_worker(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def normalize_language_code(language: str) -> str | None:
    prefix = str(language or "").strip().lower().replace("_", "-").split("-", 1)[0]
    return prefix if prefix in SUPPORTED_LANGUAGES else None


def require_language_code(language: str) -> str:
    language_code = normalize_language_code(language)
    if not language_code:
        raise WorkerFailure(
            "voice-stt-language-unsupported",
            f"Язык {language!r} не поддерживается. Доступны RU, UK, BG и EN.",
        )
    return language_code


def require_model_dir(language_code: str) -> Path:
    model_dir = find_model_dir(language_code)
    if model_dir:
        return model_dir
    raise WorkerFailure(
        "voice-stt-language-unavailable",
        f"Локальная Vosk-модель для языка {language_code.upper()} не найдена. "
        "Положи подходящую модель в runtime/voice/models/ "
        "или явно укажи MONARCH_VOSK_MODEL_DIR.",
    )


def find_model_dir(language_code: str) -> Path | None:
    configured = os.environ.get("MONARCH_VOSK_MODEL_DIR", "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        return path if is_vosk_model(path) else None

    root = Path(__file__).resolve().parents[1]
    models_root = root / "runtime" / "voice" / "models"
    if not models_root.exists():
        return None

    models = [path for path in models_root.iterdir() if is_vosk_model(path)]
    preferred = [path for path in models if model_matches_language(path, language_code)]
    return sorted(preferred, key=lambda path: path.name.lower())[0] if preferred else None


def model_matches_language(model_dir: Path, language_code: str) -> bool:
    normalized = model_dir.name.lower().replace("_", "-")
    tokens = [token for token in normalized.split("-") if token]
    return language_code in tokens


def is_vosk_model(path: Path) -> bool:
    return path.is_dir() and (path / "am").exists() and (path / "conf").exists()


def convert_audio(ffmpeg: str, audio_path: Path, wav_path: Path) -> subprocess.CompletedProcess[str]:
    filters = os.environ.get(
        "MONARCH_VOSK_FFMPEG_FILTERS",
        "highpass=f=80,lowpass=f=7600,dynaudnorm=f=100:g=8",
    ).strip()
    if filters.lower() in {"0", "false", "off", "none"}:
        filters = ""
    result = run_ffmpeg_convert(ffmpeg, audio_path, wav_path, filters)
    if result.returncode != 0 and filters:
        print("ffmpeg voice filters failed; retrying without filters.", file=sys.stderr)
        return run_ffmpeg_convert(ffmpeg, audio_path, wav_path, "")
    return result


def run_ffmpeg_convert(
    ffmpeg: str,
    audio_path: Path,
    wav_path: Path,
    filters: str,
) -> subprocess.CompletedProcess[str]:
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(audio_path),
        "-vn",
    ]
    if filters:
        command += ["-af", filters]
    command += [
        "-ac",
        "1",
        "-ar",
        "16000",
        "-acodec",
        "pcm_s16le",
        "-f",
        "wav",
        str(wav_path),
    ]
    return subprocess.run(command, text=True, capture_output=True, check=False)


def transcribe_wav(wav_path: Path, model: Any) -> str:
    try:
        from vosk import KaldiRecognizer
    except Exception as exc:  # pragma: no cover - environment-specific message.
        raise WorkerFailure(
            "voice-stt-runtime-missing",
            f"Python package vosk is not available: {exc}",
        ) from exc

    parts: list[str] = []
    with wave.open(str(wav_path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise WorkerFailure("voice-stt-audio-invalid", "Converted WAV must be mono 16-bit PCM.")
        recognizer = KaldiRecognizer(model, wav.getframerate())
        recognizer.SetWords(False)
        while True:
            data = wav.readframes(4000)
            if not data:
                break
            if recognizer.AcceptWaveform(data):
                append_result(parts, recognizer.Result())
        append_result(parts, recognizer.FinalResult())
    return " ".join(part for part in parts if part).strip()


def append_result(parts: list[str], payload: str) -> None:
    try:
        text = json.loads(payload).get("text", "")
    except Exception:
        text = ""
    if text:
        parts.append(str(text).strip())


def read_partial_result(payload: str) -> str:
    try:
        value = json.loads(payload).get("partial", "")
    except Exception:
        return ""
    return str(value).strip() if value else ""


def elapsed_ms(started_at: float) -> int:
    return max(0, round((time.perf_counter() - started_at) * 1000))


def fail(message: str, code: str | None = None) -> int:
    if code:
        print(f"MONARCH_VOICE_ERROR={code}", file=sys.stderr)
    print(message, file=sys.stderr)
    return 2


if __name__ == "__main__":
    configure_stdio()
    try:
        raise SystemExit(main())
    except WorkerFailure as exc:
        raise SystemExit(fail(str(exc), exc.code))
    except Exception as exc:
        raise SystemExit(fail(str(exc)))
