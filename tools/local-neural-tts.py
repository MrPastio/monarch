#!/usr/bin/env python3
"""Persistent local Qwen3-TTS worker for Monarch Desktop.

Protocol messages are newline-delimited JSON on stdin/stdout. Library diagnostics
are redirected to stderr so Electron never has to parse third-party logs.
"""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any


PROTOCOL_STDOUT = sys.stdout
sys.stdout = sys.stderr
EMIT_LOCK = threading.Lock()

MAX_TEXT_CHARS = 64_000
MAX_SEGMENT_CHARS = 360
WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = Path(
    os.environ.get(
        "MONARCH_TTS_MODEL_PATH",
        WORKSPACE_ROOT / "runtime" / "voice" / "models" / "qwen3-tts-0.6b-base",
    )
).resolve()
REFERENCE_AUDIO_PATH = Path(
    os.environ.get(
        "MONARCH_TTS_REFERENCE_AUDIO",
        WORKSPACE_ROOT / "assets" / "voice" / "oscar-reference.wav",
    )
).resolve()
REFERENCE_TEXT = os.environ.get(
    "MONARCH_TTS_REFERENCE_TEXT",
    "Привет. Меня зовут Оскар. Я говорю спокойно, уверенно и по делу. "
    "Давай вместе найдём точное и надёжное решение.",
).strip()
VOICE_REFERENCES = {
    "oscar": REFERENCE_AUDIO_PATH,
    "oscar-clear": WORKSPACE_ROOT / "assets" / "voice" / "oscar-clear-reference.wav",
    "aurora": WORKSPACE_ROOT / "assets" / "voice" / "aurora-reference.wav",
}
STYLE_INSTRUCTIONS = {
    "natural": "",
    "calm": "Говори спокойно, ровно и уверенно, с естественными короткими паузами.",
    "warm": "Говори тепло, дружелюбно и естественно, без наигранности.",
    "focused": "Говори собранно, точно и уверенно, выделяя ключевые выводы.",
    "energetic": "Говори живо и энергично, сохраняя естественность и ясную дикцию.",
}

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_OFFLINE", "1")


def emit(payload: dict[str, Any]) -> None:
    with EMIT_LOCK:
        PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        PROTOCOL_STDOUT.flush()


def bounded_error(error: BaseException) -> str:
    message = " ".join(str(error).split())
    return (message or error.__class__.__name__)[:800]


def qwen_language(value: Any) -> str:
    prefix = str(value or "ru-RU").strip().lower().replace("_", "-").split("-", 1)[0]
    return {
        "en": "English",
        "fr": "French",
        "de": "German",
        "it": "Italian",
        "pt": "Portuguese",
        "es": "Spanish",
        "ja": "Japanese",
        "ko": "Korean",
        "zh": "Chinese",
    }.get(prefix, "Russian")


def voice_reference(value: Any) -> tuple[str, Path]:
    voice_id = str(value or "oscar").strip().lower()
    if voice_id not in VOICE_REFERENCES:
        voice_id = "oscar"
    return voice_id, VOICE_REFERENCES[voice_id].resolve()


def bounded_integer(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        numeric = round(float(value))
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, int(numeric)))


def speech_controls(request: dict[str, Any]) -> dict[str, Any]:
    speed = bounded_integer(request.get("speed"), 80, 120, 100)
    pitch = bounded_integer(request.get("pitch"), -2, 2, 0)
    expressiveness = bounded_integer(request.get("expressiveness"), 0, 100, 55)
    return {
        "speed": speed,
        "pitch": pitch,
        "expressiveness": expressiveness,
        "pause_ms": bounded_integer(request.get("pauseMs"), 40, 400, 80),
        "volume": bounded_integer(request.get("volume"), 20, 100, 100),
        "temperature": round(0.68 + expressiveness * 0.003, 3),
        "top_k": round(24 + expressiveness * 0.16),
        "top_p": round(0.88 + expressiveness * 0.0009, 3),
        "repetition_penalty": round(1.10 - expressiveness * 0.0004, 3),
    }


def speech_instruction(request: dict[str, Any]) -> str | None:
    style = str(request.get("style") or "natural").strip().lower()
    controls = speech_controls(request)
    custom = " ".join(str(request.get("instruction") or "").split()).strip()[:300]
    speed = controls["speed"]
    pitch = controls["pitch"]
    expressiveness = controls["expressiveness"]
    speed_instruction = (
        "Говори заметно медленнее обычного." if speed <= 88 else
        "Говори немного медленнее обычного." if speed < 98 else
        "Говори заметно быстрее обычного, но не торопись." if speed >= 114 else
        "Говори немного быстрее обычного, сохраняя ясность." if speed > 102 else ""
    )
    pitch_instruction = (
        "Используй ощутимо более низкую высоту голоса." if pitch == -2 else
        "Используй немного более низкую высоту голоса." if pitch == -1 else
        "Используй ощутимо более высокую высоту голоса." if pitch == 2 else
        "Используй немного более высокую высоту голоса." if pitch == 1 else ""
    )
    expression_instruction = (
        "Подача сдержанная и стабильная, без лишних эмоций." if expressiveness <= 25 else
        "Подача выразительная и эмоционально живая, но естественная." if expressiveness >= 75 else ""
    )
    parts = [STYLE_INSTRUCTIONS.get(style, ""), speed_instruction, pitch_instruction, expression_instruction, custom]
    result = " ".join(part for part in parts if part).strip()
    return result or None


def split_speech_text(value: Any) -> list[str]:
    text = " ".join(str(value or "").split()).strip()
    if not text:
        return []
    sentences = re.split(r"(?<=[.!?…;:])\s+", text)
    segments: list[str] = []
    current = ""

    def push(part: str) -> None:
        nonlocal current
        clean = part.strip()
        if not clean:
            return
        candidate = f"{current} {clean}".strip()
        if len(candidate) <= MAX_SEGMENT_CHARS:
            current = candidate
            return
        if current:
            segments.append(current)
            current = ""
        if len(clean) <= MAX_SEGMENT_CHARS:
            current = clean
            return
        words = clean.split()
        word_chunk = ""
        for word in words:
            candidate = f"{word_chunk} {word}".strip()
            if len(candidate) <= MAX_SEGMENT_CHARS:
                word_chunk = candidate
            else:
                if word_chunk:
                    segments.append(word_chunk)
                if len(word) <= MAX_SEGMENT_CHARS:
                    word_chunk = word
                else:
                    segments.extend(
                        word[offset : offset + MAX_SEGMENT_CHARS]
                        for offset in range(0, len(word), MAX_SEGMENT_CHARS)
                    )
                    word_chunk = ""
        current = word_chunk

    for sentence in sentences:
        push(sentence)
    if current:
        segments.append(current)
    return segments


class StreamingAudioPlayer:
    """Queue-backed PortAudio player so synthesis overlaps playback."""

    def __init__(
        self,
        sounddevice: Any,
        numpy: Any,
        sample_rate: int,
        volume: int = 100,
        on_telemetry: Any | None = None,
    ) -> None:
        self._sd = sounddevice
        self._np = numpy
        self.sample_rate = int(sample_rate)
        self.gain = max(0.2, min(1.0, volume / 100.0))
        self.total_samples = 0
        self._queue: queue.Queue[Any] = queue.Queue()
        self._current = numpy.zeros((0,), dtype=numpy.float32)
        self._offset = 0
        self._generation_done = threading.Event()
        self._drained = threading.Event()
        self._stopped = threading.Event()
        self._started = False
        self._on_telemetry = on_telemetry if callable(on_telemetry) else None
        self._telemetry_last_at = 0.0
        self._telemetry_sequence = 0
        self._telemetry_queue: queue.Queue[Any] | None = queue.Queue(maxsize=2) if self._on_telemetry else None
        self._telemetry_stop = threading.Event()
        self._telemetry_thread: threading.Thread | None = None
        if self._telemetry_queue is not None:
            self._telemetry_thread = threading.Thread(
                target=self._run_telemetry,
                name="monarch-tts-telemetry",
                daemon=True,
            )
            self._telemetry_thread.start()
        self._stream = sounddevice.OutputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="float32",
            latency="low",
            callback=self._callback,
        )

    def _callback(self, outdata: Any, frames: int, _time_info: Any, _status: Any) -> None:
        outdata.fill(0)
        if self._stopped.is_set():
            return
        written = 0
        while written < frames:
            if self._offset >= self._current.size:
                try:
                    self._current = self._queue.get_nowait()
                    self._offset = 0
                except queue.Empty:
                    if self._generation_done.is_set():
                        self._drained.set()
                    break
            remaining = self._current.size - self._offset
            if remaining <= 0:
                continue
            count = min(frames - written, remaining)
            outdata[written : written + count, 0] = self._current[self._offset : self._offset + count]
            written += count
            self._offset += count
        if written > 0:
            self._queue_telemetry(outdata[:written, 0])

    def _queue_telemetry(self, samples: Any) -> None:
        telemetry_queue = self._telemetry_queue
        if telemetry_queue is None or self._telemetry_stop.is_set():
            return
        now = time.monotonic()
        if now - self._telemetry_last_at < 0.045:
            return
        self._telemetry_last_at = now
        values = self._np.asarray(samples, dtype=self._np.float32).reshape(-1)
        if not values.size:
            return
        absolute = self._np.abs(values)
        rms = float(self._np.sqrt(self._np.mean(values * values)))
        peak = float(self._np.max(absolute))
        if values.size > 1:
            crossings = self._np.count_nonzero(self._np.signbit(values[1:]) != self._np.signbit(values[:-1]))
            brightness = min(1.0, float(crossings) / float(values.size - 1) * 8.0)
        else:
            brightness = 0.0
        self._telemetry_sequence += 1
        payload = {
            "sequence": self._telemetry_sequence,
            "rms": round(max(0.0, min(1.0, rms)), 6),
            "peak": round(max(0.0, min(1.0, peak)), 6),
            "brightness": round(max(0.0, min(1.0, brightness)), 6),
            "sampleRate": self.sample_rate,
        }
        try:
            telemetry_queue.put_nowait(payload)
        except queue.Full:
            try:
                telemetry_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                telemetry_queue.put_nowait(payload)
            except queue.Full:
                pass

    def _run_telemetry(self) -> None:
        telemetry_queue = self._telemetry_queue
        callback = self._on_telemetry
        if telemetry_queue is None or callback is None:
            return
        while not self._telemetry_stop.is_set():
            try:
                payload = telemetry_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if payload is None:
                return
            try:
                callback(payload)
            except Exception:
                continue

    def put(self, value: Any) -> None:
        if self._stopped.is_set():
            return
        chunk = self._np.asarray(value, dtype=self._np.float32).reshape(-1)
        if not chunk.size:
            return
        if self.gain != 1.0:
            chunk = self._np.clip(chunk * self.gain, -1.0, 1.0)
        self.total_samples += int(chunk.size)
        self._queue.put(chunk)
        if not self._started:
            self._stream.start()
            self._started = True

    def finish(self) -> None:
        self._generation_done.set()
        if not self._started:
            self._drained.set()

    def wait(self, cancelled: threading.Event) -> bool:
        timeout_at = time.monotonic() + max(5.0, self.total_samples / self.sample_rate + 5.0)
        while not self._drained.wait(0.05):
            if cancelled.is_set() or self._stopped.is_set():
                self.stop()
                return False
            if time.monotonic() >= timeout_at:
                self.stop()
                raise RuntimeError("Audio output did not drain before the safety timeout.")
        self.close()
        return True

    def stop(self) -> None:
        self._stopped.set()
        self._drained.set()
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        self.close(abort=True)

    def close(self, abort: bool = False) -> None:
        stream = self._stream
        self._stream = None
        if stream is None:
            return
        try:
            if abort:
                stream.abort()
            else:
                stream.stop()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass
        self._stop_telemetry()

    def _stop_telemetry(self) -> None:
        if self._telemetry_stop.is_set():
            return
        self._telemetry_stop.set()
        telemetry_queue = self._telemetry_queue
        if telemetry_queue is not None:
            try:
                telemetry_queue.put_nowait(None)
            except queue.Full:
                try:
                    telemetry_queue.get_nowait()
                    telemetry_queue.put_nowait(None)
                except (queue.Empty, queue.Full):
                    pass
        thread = self._telemetry_thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=0.25)


class NeuralSpeechEngine:
    def __init__(self) -> None:
        self.model: Any = None
        self.torch: Any = None
        self.numpy: Any = None
        self.sounddevice: Any = None
        self.model_lock = threading.Lock()
        self.active_lock = threading.Lock()
        self.active_thread: threading.Thread | None = None
        self.active_cancel: threading.Event | None = None
        self.active_player: StreamingAudioPlayer | None = None
        self.active_request_id = ""

    def load_and_warm(self) -> dict[str, Any]:
        if not MODEL_PATH.is_dir():
            raise FileNotFoundError(f"Qwen3-TTS model is missing: {MODEL_PATH}")
        for voice_id, reference_path in VOICE_REFERENCES.items():
            if not reference_path.is_file():
                raise FileNotFoundError(f"Oscar voice reference is missing ({voice_id}): {reference_path}")

        started = time.perf_counter()
        import numpy as np
        import sounddevice as sd
        import torch
        from faster_qwen3_tts import FasterQwen3TTS

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; the realtime Qwen3-TTS path requires an NVIDIA GPU.")
        torch.set_grad_enabled(False)
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

        self.torch = torch
        self.numpy = np
        self.sounddevice = sd
        self.model = FasterQwen3TTS.from_pretrained(
            str(MODEL_PATH),
            device="cuda",
            dtype="bfloat16",
            attn_implementation="sdpa",
            max_seq_len=1024,
            local_files_only=True,
        )
        loaded_at = time.perf_counter()

        for _chunk, _sample_rate, _timing in self.model.generate_voice_clone_streaming(
            text="Готов.",
            language="Russian",
            ref_audio=REFERENCE_AUDIO_PATH,
            ref_text=REFERENCE_TEXT,
            xvec_only=False,
            append_silence=True,
            chunk_size=8,
            do_sample=False,
            max_new_tokens=96,
        ):
            pass
        warmed_at = time.perf_counter()
        return {
            "engine": "qwen3-tts-cuda-graph",
            "speaker": "oscar-designed",
            "model": MODEL_PATH.name,
            "device": torch.cuda.get_device_name(0),
            "loadSeconds": round(loaded_at - started, 3),
            "warmupSeconds": round(warmed_at - loaded_at, 3),
        }

    def cancel_active(self, wait_seconds: float = 2.0) -> bool:
        with self.active_lock:
            thread = self.active_thread
            cancel = self.active_cancel
            player = self.active_player
        if not thread:
            return False
        if cancel:
            cancel.set()
        if player:
            player.stop()
        if thread is not threading.current_thread():
            thread.join(timeout=wait_seconds)
        return True

    def speak(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("id") or "")
        text = str(request.get("text") or "").strip()
        if not request_id or not text:
            emit({"type": "error", "id": request_id, "error": "speech-input-invalid", "summary": "Speech request is empty."})
            return
        if len(text) > MAX_TEXT_CHARS:
            emit({"type": "error", "id": request_id, "error": "speech-input-too-long", "summary": "Speech text exceeds the local safety limit."})
            return

        self.cancel_active()
        cancelled = threading.Event()
        voice_id, reference_path = voice_reference(request.get("voice"))
        instruction = speech_instruction(request)
        controls = speech_controls(request)
        thread = threading.Thread(
            target=self._run_speech,
            args=(
                request_id,
                text,
                qwen_language(request.get("language")),
                voice_id,
                reference_path,
                instruction,
                controls,
                cancelled,
            ),
            name=f"monarch-tts-{request_id[:12]}",
            daemon=True,
        )
        with self.active_lock:
            self.active_thread = thread
            self.active_cancel = cancelled
            self.active_player = None
            self.active_request_id = request_id
        thread.start()

    def _run_speech(
        self,
        request_id: str,
        text: str,
        language: str,
        voice_id: str,
        reference_path: Path,
        instruction: str | None,
        controls: dict[str, Any],
        cancelled: threading.Event,
    ) -> None:
        started = time.perf_counter()
        first_audio_at: float | None = None
        generation_finished_at: float | None = None
        player: StreamingAudioPlayer | None = None
        segments = split_speech_text(text)
        try:
            with self.model_lock:
                for segment_index, segment in enumerate(segments):
                    if cancelled.is_set():
                        break
                    generator = self.model.generate_voice_clone_streaming(
                        text=segment,
                        language=language,
                        ref_audio=reference_path,
                        ref_text=REFERENCE_TEXT,
                        xvec_only=False,
                        append_silence=True,
                        chunk_size=8,
                        do_sample=True,
                        temperature=controls["temperature"],
                        top_k=controls["top_k"],
                        top_p=controls["top_p"],
                        repetition_penalty=controls["repetition_penalty"],
                        max_new_tokens=768,
                        instruct=instruction,
                    )
                    for audio_chunk, sample_rate, _timing in generator:
                        if cancelled.is_set():
                            break
                        if player is None:
                            player = StreamingAudioPlayer(
                                self.sounddevice,
                                self.numpy,
                                int(sample_rate),
                                controls["volume"],
                                on_telemetry=lambda frame: emit(
                                    {
                                        "type": "frame",
                                        "id": request_id,
                                        **frame,
                                    }
                                ),
                            )
                            with self.active_lock:
                                if self.active_request_id == request_id:
                                    self.active_player = player
                            first_audio_at = time.perf_counter()
                            emit({"type": "speaking", "id": request_id, "engine": "qwen3-tts-cuda-graph"})
                        player.put(audio_chunk)
                    if cancelled.is_set():
                        break
                    if player is not None and segment_index < len(segments) - 1:
                        player.put(
                            self.numpy.zeros(
                                int(player.sample_rate * controls["pause_ms"] / 1000),
                                dtype=self.numpy.float32,
                            )
                        )

            generation_finished_at = time.perf_counter()
            if cancelled.is_set():
                if player:
                    player.stop()
                emit({"type": "stopped", "id": request_id})
                return
            if player is None:
                raise RuntimeError("Neural TTS completed without audio.")
            player.finish()
            if not player.wait(cancelled):
                emit({"type": "stopped", "id": request_id})
                return
            completed_at = time.perf_counter()
            audio_seconds = player.total_samples / player.sample_rate
            generation_seconds = (generation_finished_at or completed_at) - started
            emit(
                {
                    "type": "done",
                    "id": request_id,
                    "engine": "qwen3-tts-cuda-graph",
                    "speaker": voice_id,
                    "segments": len(segments),
                    "ttfaSeconds": round((first_audio_at or completed_at) - started, 3),
                    "generationSeconds": round(generation_seconds, 3),
                    "audioSeconds": round(audio_seconds, 3),
                    "speedX": round(audio_seconds / generation_seconds, 3) if generation_seconds > 0 else 0,
                    "tuning": {
                        "speed": controls["speed"],
                        "pitch": controls["pitch"],
                        "expressiveness": controls["expressiveness"],
                        "pauseMs": controls["pause_ms"],
                        "volume": controls["volume"],
                    },
                }
            )
        except Exception as error:
            if player:
                player.stop()
            if cancelled.is_set():
                emit({"type": "stopped", "id": request_id})
            else:
                traceback.print_exc(file=sys.stderr)
                emit({"type": "error", "id": request_id, "error": "neural-tts-failed", "summary": bounded_error(error)})
        finally:
            with self.active_lock:
                if self.active_request_id == request_id:
                    self.active_thread = None
                    self.active_cancel = None
                    self.active_player = None
                    self.active_request_id = ""


def main() -> int:
    engine = NeuralSpeechEngine()
    try:
        details = engine.load_and_warm()
        emit({"type": "ready", **details})
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "fatal", "error": "neural-tts-startup-failed", "summary": bounded_error(error)})
        return 1

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Protocol message must be a JSON object.")
            message_type = str(request.get("type") or "")
            if message_type == "speak":
                engine.speak(request)
            elif message_type == "stop":
                engine.cancel_active()
            elif message_type == "ping":
                emit({"type": "pong", "id": str(request.get("id") or "")})
            elif message_type == "shutdown":
                engine.cancel_active()
                return 0
            else:
                emit({"type": "error", "id": str(request.get("id") or ""), "error": "protocol-message-invalid", "summary": "Unknown worker message."})
        except Exception as error:
            emit({"type": "error", "id": "", "error": "protocol-message-invalid", "summary": bounded_error(error)})
    engine.cancel_active()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
