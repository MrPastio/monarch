"""Local Qwen3-TTS bridge used by Monarch Sharing's audio endpoint."""

from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
import stat
import subprocess
import wave
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
    return Path(
        getattr(settings, "sharing_tts_models_dir", DEFAULT_TTS_MODELS_DIR)
    ).absolute()


def _lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _windows_stream_names(path: Path) -> list[str]:
    if os.name != "nt":
        return []
    import ctypes
    from ctypes import wintypes

    class Win32FindStreamData(ctypes.Structure):
        _fields_ = [
            ("stream_size", ctypes.c_longlong),
            ("stream_name", ctypes.c_wchar * 296),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    find_first = kernel32.FindFirstStreamW
    find_first.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(Win32FindStreamData),
        wintypes.DWORD,
    ]
    find_first.restype = wintypes.HANDLE
    find_next = kernel32.FindNextStreamW
    find_next.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(Win32FindStreamData),
    ]
    find_next.restype = wintypes.BOOL
    find_close = kernel32.FindClose
    find_close.argtypes = [wintypes.HANDLE]
    find_close.restype = wintypes.BOOL

    data = Win32FindStreamData()
    handle = find_first(str(path), 0, ctypes.byref(data), 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if handle == invalid_handle:
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"Cannot enumerate Windows streams for {path.name}: "
            f"error {ctypes.get_last_error()}.",
        )
    names: list[str] = []
    try:
        names.append(str(data.stream_name))
        while find_next(handle, ctypes.byref(data)):
            names.append(str(data.stream_name))
        error = ctypes.get_last_error()
        if error != 38:  # ERROR_HANDLE_EOF
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"Windows stream enumeration failed for {path.name}: "
                f"error {error}.",
            )
    finally:
        if not find_close(handle):
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"Windows stream handle close failed for {path.name}: "
                f"error {ctypes.get_last_error()}.",
            )
    return names


def _verify_lexical_path(path: Path, *, label: str) -> Path:
    absolute = _lexical_absolute(path)
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except OSError as error:
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"{label} is unavailable: {error}",
            ) from error
        if stat.S_ISLNK(metadata.st_mode) or getattr(
            metadata,
            "st_reparse_tag",
            0,
        ):
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"{label} resolves through a link or junction.",
            )
        if current != absolute and not stat.S_ISDIR(metadata.st_mode):
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"{label} has a non-directory parent.",
            )
    return absolute


def _verify_trusted_regular_file(path: Path, *, label: str) -> Path:
    absolute = _verify_lexical_path(path, label=label)
    metadata = absolute.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or getattr(metadata, "st_reparse_tag", 0)
    ):
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} is not a trusted regular file.",
        )
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} resolves through a link or junction.",
        )
    if os.name == "nt" and _windows_stream_names(absolute) != ["::$DATA"]:
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} has an alternate data stream.",
        )
    return absolute


def _verify_trusted_directory(path: Path, *, label: str) -> Path:
    absolute = _verify_lexical_path(path, label=label)
    metadata = absolute.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or getattr(metadata, "st_reparse_tag", 0)
    ):
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} is not a trusted directory.",
        )
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} resolves through a link or junction.",
        )
    return absolute


def _ensure_trusted_directory(path: Path, *, label: str) -> Path:
    """Create missing components only below an already verified directory."""
    absolute = _lexical_absolute(path)
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        candidate = current / component
        try:
            candidate.lstat()
        except FileNotFoundError:
            _verify_trusted_directory(
                current,
                label=f"{label} parent",
            )
            try:
                os.mkdir(candidate, 0o700)
            except FileExistsError as error:
                raise TtsSynthesisError(
                    "tts_file_invalid",
                    f"{label} identity appeared during creation.",
                ) from error
        except OSError as error:
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"{label} is unavailable: {error}",
            ) from error
        current = _verify_trusted_directory(candidate, label=label)
    return current


def _open_bound_launch_file(
    path: Path,
    *,
    label: str,
) -> tuple[Path, int, tuple[int, int, int, int]]:
    absolute = _verify_trusted_regular_file(path, label=label)
    before = absolute.lstat()
    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(absolute, flags)
    except OSError as error:
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} could not be opened safely: {error}",
        ) from error
    try:
        opened = os.fstat(descriptor)
        receipt = (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
            opened.st_mtime_ns,
        )
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or (opened.st_dev, opened.st_ino)
            != (before.st_dev, before.st_ino)
        ):
            raise TtsSynthesisError(
                "tts_file_invalid",
                f"{label} identity changed before dispatch.",
            )
    except Exception:
        os.close(descriptor)
        raise
    return absolute, descriptor, receipt


def _reconcile_bound_launch_file(
    path: Path,
    descriptor: int,
    receipt: tuple[int, int, int, int],
    *,
    label: str,
) -> None:
    absolute = _verify_trusted_regular_file(path, label=label)
    opened = os.fstat(descriptor)
    visible = absolute.lstat()
    current = (
        opened.st_dev,
        opened.st_ino,
        opened.st_size,
        opened.st_mtime_ns,
    )
    if (
        current != receipt
        or (opened.st_dev, opened.st_ino) != (visible.st_dev, visible.st_ino)
        or opened.st_nlink != 1
    ):
        raise TtsSynthesisError(
            "tts_file_invalid",
            f"{label} identity changed during dispatch.",
        )


def _is_trusted_regular_file(path: Path) -> bool:
    try:
        _verify_trusted_regular_file(
            path,
            label="local TTS model file",
        )
        return True
    except (OSError, TtsSynthesisError):
        return False


def _is_trusted_directory(path: Path) -> bool:
    try:
        _verify_trusted_directory(
            path,
            label="local TTS model directory",
        )
        return True
    except (OSError, TtsSynthesisError):
        return False


def find_qwen_tts_model(model_id: str) -> QwenTtsModel | None:
    normalized = str(model_id or "").strip().lower()
    return next((model for model in QWEN_TTS_MODELS if model.id == normalized), None)


def is_qwen_tts_model_available(settings: object, model: QwenTtsModel) -> bool:
    root = tts_models_root(settings) / model.directory
    return (
        _is_trusted_directory(root)
        and _is_trusted_regular_file(root / "config.json")
        and _is_trusted_regular_file(root / "model.safetensors")
        and _is_trusted_regular_file(
            root / "speech_tokenizer" / "model.safetensors"
        )
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

        python_candidate = Path(
            getattr(
                self.settings,
                "sharing_tts_python",
                DEFAULT_TTS_PYTHON,
            )
        )
        for candidate in (python_candidate, TTS_WORKER):
            try:
                candidate.lstat()
            except FileNotFoundError as error:
                raise TtsSynthesisError(
                    "tts_runtime_missing",
                    "Qwen TTS runtime is unavailable. Run npm run "
                    "voice:setup before using Sharing TTS.",
                ) from error

        python_descriptor: int | None = None
        worker_descriptor: int | None = None
        output_path: Path | None = None
        try:
            (
                python_path,
                python_descriptor,
                python_receipt,
            ) = _open_bound_launch_file(
                python_candidate,
                label="local Qwen TTS Python runtime",
            )
            (
                worker_path,
                worker_descriptor,
                worker_receipt,
            ) = _open_bound_launch_file(
                TTS_WORKER,
                label="local Qwen TTS worker",
            )

            data_root = _ensure_trusted_directory(
                Path(
                    getattr(
                        self.settings,
                        "data_dir",
                        PROJECT_ROOT / "oscar" / "data",
                    )
                ),
                label="local Qwen TTS data directory",
            )
            output_dir = _ensure_trusted_directory(
                data_root / "sharing-tts",
                label="local Qwen TTS output directory",
            )
            for _attempt in range(16):
                candidate = (
                    output_dir
                    / f"speech-{secrets.token_hex(16)}.wav"
                )
                try:
                    candidate.lstat()
                except FileNotFoundError:
                    output_path = candidate
                    break
            if output_path is None:
                raise TtsSynthesisError(
                    "tts_output_unavailable",
                    "Local Qwen TTS could not reserve a unique output identity.",
                )
            payload = {
                "model": model.id,
                "input": str(getattr(request, "input", "")),
                "voice": str(getattr(request, "voice", "")),
                "language": str(getattr(request, "language", "ru-RU")),
                "instructions": str(
                    getattr(request, "instructions", "")
                ),
            }
            command = [
                str(python_path),
                "-u",
                str(worker_path),
                "--model-root",
                str(tts_models_root(self.settings)),
                "--workspace-root",
                str(PROJECT_ROOT),
                "--output-dir",
                str(output_dir),
                "--output",
                str(output_path),
            ]
            _reconcile_bound_launch_file(
                python_path,
                python_descriptor,
                python_receipt,
                label="local Qwen TTS Python runtime",
            )
            _reconcile_bound_launch_file(
                worker_path,
                worker_descriptor,
                worker_receipt,
                label="local Qwen TTS worker",
            )
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
            _reconcile_bound_launch_file(
                python_path,
                python_descriptor,
                python_receipt,
                label="local Qwen TTS Python runtime",
            )
            _reconcile_bound_launch_file(
                worker_path,
                worker_descriptor,
                worker_receipt,
                label="local Qwen TTS worker",
            )
            result = read_worker_result(completed.stdout)
            if completed.returncode != 0 or not result.get("ok"):
                code = str(result.get("code") or "tts_generation_failed")
                message = str(result.get("message") or "Local Qwen TTS could not synthesize speech.")[:500]
                raise TtsSynthesisError(code, message)
            expected_bytes = result.get("bytes")
            expected_sha256 = result.get("sha256")
            audio = read_worker_audio(
                output_path,
                expected_bytes=expected_bytes,
                expected_sha256=expected_sha256,
            )
            sample_rate = result.get("sample_rate")
            if not isinstance(sample_rate, int) or sample_rate <= 0:
                raise TtsSynthesisError("tts_audio_invalid", "Local Qwen TTS did not report a valid sample rate.")
            if wav_sample_rate(audio) != sample_rate:
                raise TtsSynthesisError(
                    "tts_audio_invalid",
                    "Local Qwen TTS reported a mismatched sample rate.",
                )
            return TtsSynthesisResult(audio=audio, model=model.id, sample_rate=sample_rate)
        except subprocess.TimeoutExpired as exc:
            raise TtsSynthesisError("tts_timeout", "Local Qwen TTS did not finish before the 180-second safety timeout.") from exc
        except OSError as exc:
            raise TtsSynthesisError("tts_worker_start_failed", f"Local Qwen TTS worker could not start: {exc}") from exc
        finally:
            if worker_descriptor is not None:
                os.close(worker_descriptor)
            if python_descriptor is not None:
                os.close(python_descriptor)
            if output_path is not None:
                try:
                    output_parent = _verify_trusted_directory(
                        output_path.parent,
                        label="local Qwen TTS output directory",
                    )
                    metadata = output_path.lstat()
                    if (
                        output_path.parent == output_parent
                        and stat.S_ISREG(metadata.st_mode)
                        and metadata.st_nlink == 1
                        and not getattr(metadata, "st_reparse_tag", 0)
                    ):
                        output_path.unlink()
                except (FileNotFoundError, OSError, TtsSynthesisError):
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


def read_worker_audio(
    path: Path,
    *,
    expected_bytes: Any,
    expected_sha256: Any,
) -> bytes:
    if (
        not isinstance(expected_bytes, int)
        or isinstance(expected_bytes, bool)
        or expected_bytes < 44
        or expected_bytes > MAX_AUDIO_BYTES
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_sha256)
    ):
        raise TtsSynthesisError(
            "tts_audio_invalid",
            "Local Qwen TTS returned invalid output evidence.",
        )
    absolute = _verify_lexical_path(
        path,
        label="local TTS worker output",
    )
    before = absolute.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or getattr(before, "st_reparse_tag", 0)
    ):
        raise TtsSynthesisError(
            "tts_audio_invalid",
            "Local Qwen TTS output identity is unsafe.",
        )
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        raise TtsSynthesisError(
            "tts_audio_invalid",
            "Local Qwen TTS output resolves through a link or junction.",
        )
    if os.name == "nt" and _windows_stream_names(absolute) != ["::$DATA"]:
        raise TtsSynthesisError(
            "tts_audio_invalid",
            "Local Qwen TTS output has an alternate data stream.",
        )
    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(absolute, flags)
    except OSError as error:
        raise TtsSynthesisError(
            "tts_audio_invalid",
            f"Local Qwen TTS output could not be opened safely: {error}",
        ) from error
    try:
        opened_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_before.st_mode)
            or opened_before.st_nlink != 1
            or (opened_before.st_dev, opened_before.st_ino)
            != (before.st_dev, before.st_ino)
        ):
            raise TtsSynthesisError(
                "tts_audio_invalid",
                "Local Qwen TTS output identity changed before read.",
            )
        payload = bytearray()
        while len(payload) <= MAX_AUDIO_BYTES:
            chunk = os.read(
                descriptor,
                min(1024 * 1024, MAX_AUDIO_BYTES + 1 - len(payload)),
            )
            if not chunk:
                break
            payload.extend(chunk)
        opened_after = os.fstat(descriptor)
        visible_after = absolute.lstat()
        if (
            (opened_before.st_dev, opened_before.st_ino)
            != (opened_after.st_dev, opened_after.st_ino)
            or (opened_after.st_dev, opened_after.st_ino)
            != (visible_after.st_dev, visible_after.st_ino)
            or opened_before.st_size != opened_after.st_size
            or opened_before.st_mtime_ns != opened_after.st_mtime_ns
        ):
            raise TtsSynthesisError(
                "tts_audio_invalid",
                "Local Qwen TTS output changed during read.",
            )
        if os.name == "nt" and _windows_stream_names(absolute) != ["::$DATA"]:
            raise TtsSynthesisError(
                "tts_audio_invalid",
                "Local Qwen TTS output gained an alternate data stream.",
            )
    finally:
        os.close(descriptor)
    audio = bytes(payload)
    if (
        len(audio) != expected_bytes
        or hashlib.sha256(audio).hexdigest() != expected_sha256
        or not is_wav(audio)
    ):
        raise TtsSynthesisError(
            "tts_audio_invalid",
            "Local Qwen TTS output does not match worker evidence.",
        )
    return audio


def wav_sample_rate(value: bytes) -> int:
    try:
        with wave.open(io.BytesIO(value), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2:
                raise TtsSynthesisError(
                    "tts_audio_invalid",
                    "Local Qwen TTS returned an unsupported PCM format.",
                )
            return int(source.getframerate())
    except (EOFError, wave.Error) as error:
        raise TtsSynthesisError(
            "tts_audio_invalid",
            "Local Qwen TTS returned an unreadable WAV response.",
        ) from error


def is_wav(value: bytes) -> bool:
    return len(value) >= 12 and value[:4] == b"RIFF" and value[8:12] == b"WAVE"
