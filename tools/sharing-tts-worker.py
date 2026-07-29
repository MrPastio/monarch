#!/usr/bin/env python3
"""One-shot WAV synthesis worker for Monarch Sharing.

The worker deliberately accepts only model IDs and built-in voice controls. It
never accepts arbitrary model, reference-audio, or output paths from an HTTP
caller; the Oscar bridge owns the command line and response file lifecycle.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import secrets
import stat
import sys
import traceback
import types
import wave
from pathlib import Path
from typing import Any


PROTOCOL_STDOUT = sys.stdout
sys.stdout = sys.stderr

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

MAX_INPUT_CHARS = 3_000
MAX_INSTRUCTION_CHARS = 320
MAX_REFERENCE_BYTES = 16 * 1024 * 1024
REFERENCE_TEXT = (
    "Привет. Меня зовут Оскар. Я говорю спокойно, уверенно и по делу. "
    "Давай вместе найдём точное и надёжное решение."
)
SUPPORTED_SPEAKERS = {
    "vivian": "Vivian",
    "serena": "Serena",
    "uncle_fu": "Uncle_Fu",
    "dylan": "Dylan",
    "eric": "Eric",
    "ryan": "Ryan",
    "aiden": "Aiden",
    "ono_anna": "Ono_Anna",
    "sohee": "Sohee",
}
MODEL_MODES = {
    "qwen3-tts-0.6b-base": ("qwen3-tts-0.6b-base", "base"),
    "qwen3-tts-0.6b-custom": ("qwen3-tts-0.6b-custom", "custom"),
    "qwen3-tts-1.7b-voice-design": ("qwen3-tts-1.7b-voice-design", "design"),
}


def emit(payload: dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL_STDOUT.flush()


def reject_duplicate_json_pairs(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in pairs:
        if key in payload:
            raise RuntimeError(f"JSON contains a duplicate key: {key}")
        payload[key] = value
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monarch Sharing Qwen TTS WAV worker")
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--workspace-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def clean_text(value: Any, *, field: str, maximum: int, required: bool = False) -> str:
    result = " ".join(str(value or "").split()).strip()
    if required and not result:
        raise ValueError(f"{field} must not be blank")
    if len(result) > maximum:
        raise ValueError(f"{field} exceeds the local safety limit")
    return result


def qwen_language(value: str) -> str:
    prefix = value.lower().replace("_", "-").split("-", 1)[0]
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


def is_inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.absolute().relative_to(root.absolute())
        return True
    except ValueError:
        return False


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def windows_stream_names(path: Path) -> list[str]:
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
        raise RuntimeError(
            f"cannot enumerate Windows streams for {path.name}: "
            f"error {ctypes.get_last_error()}"
        )
    names: list[str] = []
    try:
        names.append(str(data.stream_name))
        while find_next(handle, ctypes.byref(data)):
            names.append(str(data.stream_name))
        error = ctypes.get_last_error()
        if error != 38:  # ERROR_HANDLE_EOF
            raise RuntimeError(
                f"Windows stream enumeration failed for {path.name}: "
                f"error {error}"
            )
    finally:
        if not find_close(handle):
            raise RuntimeError(
                f"Windows stream handle close failed for {path.name}: "
                f"error {ctypes.get_last_error()}"
            )
    return names


def verify_lexical_path(path: Path, *, label: str) -> Path:
    """Reject every lexical symlink/reparse component before resolving it."""
    absolute = lexical_absolute(path)
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except OSError as error:
            raise RuntimeError(f"{label} is unavailable: {error}") from error
        if stat.S_ISLNK(metadata.st_mode) or getattr(
            metadata,
            "st_reparse_tag",
            0,
        ):
            raise RuntimeError(f"{label} resolves through a link or junction")
        if current != absolute and not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"{label} has a non-directory parent")
    return absolute


def verify_directory_identity(path: Path, *, label: str) -> Path:
    absolute = verify_lexical_path(path, label=label)
    metadata = absolute.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or getattr(metadata, "st_reparse_tag", 0)
    ):
        raise RuntimeError(f"{label} is not a trusted directory")
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        raise RuntimeError(f"{label} resolves through a link or junction")
    return absolute


def verify_local_regular_file(path: Path, *, label: str) -> Path:
    absolute = verify_lexical_path(path, label=label)
    metadata = absolute.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or getattr(metadata, "st_reparse_tag", 0)
        or metadata.st_nlink != 1
    ):
        raise RuntimeError(f"{label} is not a trusted regular file")
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        raise RuntimeError(f"{label} resolves through a link or junction")
    if os.name == "nt" and windows_stream_names(absolute) != ["::$DATA"]:
        raise RuntimeError(f"{label} has an alternate data stream")
    return absolute


def validate_wav_payload(
    payload: bytes,
    artifact: dict[str, Any],
    *,
    label: str,
) -> None:
    expected_bytes = artifact.get("bytes")
    expected_sha256 = artifact.get("sha256")
    if (
        not isinstance(expected_bytes, int)
        or expected_bytes <= 44
        or expected_bytes > MAX_REFERENCE_BYTES
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
    ):
        raise RuntimeError(f"{label} has invalid provenance measurements")
    if len(payload) != expected_bytes:
        raise RuntimeError(f"{label} size mismatch")
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise RuntimeError(f"{label} SHA-256 mismatch")
    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            if (
                source.getnchannels() != artifact.get("channels")
                or source.getsampwidth() * 8
                != artifact.get("sampleWidthBits")
                or source.getframerate() != artifact.get("sampleRateHz")
            ):
                raise RuntimeError(f"{label} PCM format mismatch")
            duration = source.getnframes() / source.getframerate()
    except (EOFError, wave.Error) as error:
        raise RuntimeError(f"{label} is not a readable WAV") from error
    if abs(duration - artifact.get("durationSeconds", -1)) > 0.000001:
        raise RuntimeError(f"{label} duration mismatch")


def read_bound_regular_file(
    path: Path,
    *,
    label: str,
    maximum_bytes: int,
) -> bytes:
    """Read through one no-follow descriptor and bind bytes to path identity."""
    absolute = verify_local_regular_file(path, label=label)
    before = absolute.lstat()
    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(absolute, flags)
    try:
        opened_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_before.st_mode)
            or opened_before.st_nlink != 1
            or (opened_before.st_dev, opened_before.st_ino)
            != (before.st_dev, before.st_ino)
        ):
            raise RuntimeError(f"{label} identity changed before read")
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > maximum_bytes:
            raise RuntimeError(f"{label} exceeds the local safety limit")
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
            raise RuntimeError(f"{label} identity changed during read")
        if os.name == "nt" and windows_stream_names(absolute) != ["::$DATA"]:
            raise RuntimeError(
                f"{label} gained an alternate data stream during read"
            )
        return payload
    finally:
        os.close(descriptor)


def exclusive_write_bytes(path: Path, payload: bytes, *, label: str) -> None:
    verify_directory_identity(path.parent, label=f"{label} parent")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise RuntimeError(f"{label} write made no progress")
            offset += written
        os.fsync(descriptor)
        opened = os.fstat(descriptor)
        visible = path.stat()
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or (opened.st_dev, opened.st_ino)
            != (visible.st_dev, visible.st_ino)
        ):
            raise RuntimeError(f"{label} output identity is unsafe")
    finally:
        os.close(descriptor)


def create_private_reference_snapshot(
    output_dir: Path,
    payload: bytes,
    artifact: dict[str, Any],
    *,
    voice_id: str,
) -> tuple[Path, int, tuple[int, int]]:
    """Create an unpredictable O_EXCL copy and keep its identity handle open."""
    trusted_dir = verify_directory_identity(
        output_dir,
        label="trusted reference snapshot directory",
    )
    for _attempt in range(16):
        target = (
            trusted_dir
            / f".reference-{voice_id}-{secrets.token_hex(16)}.wav"
        )
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(target, flags, 0o600)
        except FileExistsError:
            continue
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    raise RuntimeError(
                        "private voice reference write made no progress"
                    )
                offset += written
            os.fsync(descriptor)
            opened = os.fstat(descriptor)
            visible = target.lstat()
            identity = (opened.st_dev, opened.st_ino)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or identity != (visible.st_dev, visible.st_ino)
            ):
                raise RuntimeError(
                    "private voice reference identity is unsafe"
                )
            os.lseek(descriptor, 0, os.SEEK_SET)
            snapshot = bytearray()
            while len(snapshot) <= MAX_REFERENCE_BYTES:
                chunk = os.read(
                    descriptor,
                    min(
                        1024 * 1024,
                        MAX_REFERENCE_BYTES + 1 - len(snapshot),
                    ),
                )
                if not chunk:
                    break
                snapshot.extend(chunk)
            if len(snapshot) > MAX_REFERENCE_BYTES:
                raise RuntimeError(
                    "private voice reference exceeds the local safety limit"
                )
            validate_wav_payload(
                bytes(snapshot),
                artifact,
                label="private voice reference snapshot",
            )
            return target, descriptor, identity
        except Exception:
            os.close(descriptor)
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            raise
    raise RuntimeError("could not reserve a private voice reference snapshot")


def reconcile_private_reference(
    path: Path,
    descriptor: int,
    identity: tuple[int, int],
    artifact: dict[str, Any],
    *,
    label: str,
) -> None:
    opened = os.fstat(descriptor)
    visible = path.lstat()
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_nlink != 1
        or (opened.st_dev, opened.st_ino) != identity
        or (visible.st_dev, visible.st_ino) != identity
        or getattr(visible, "st_reparse_tag", 0)
    ):
        raise RuntimeError(f"{label} identity changed")
    os.lseek(descriptor, 0, os.SEEK_SET)
    payload = bytearray()
    while len(payload) <= MAX_REFERENCE_BYTES:
        chunk = os.read(
            descriptor,
            min(1024 * 1024, MAX_REFERENCE_BYTES + 1 - len(payload)),
        )
        if not chunk:
            break
        payload.extend(chunk)
    if len(payload) > MAX_REFERENCE_BYTES:
        raise RuntimeError(f"{label} exceeds the local safety limit")
    validate_wav_payload(bytes(payload), artifact, label=label)


def cleanup_private_reference(
    path: Path | None,
    descriptor: int | None,
    identity: tuple[int, int] | None,
) -> None:
    if descriptor is not None:
        os.close(descriptor)
    if path is None or identity is None:
        return
    try:
        visible = path.lstat()
    except FileNotFoundError:
        return
    if not (
        stat.S_ISREG(visible.st_mode)
        and visible.st_nlink == 1
        and not getattr(visible, "st_reparse_tag", 0)
        and (visible.st_dev, visible.st_ino) == identity
    ):
        raise RuntimeError(
            "private voice reference identity changed before cleanup; "
            "the unexpected path was preserved"
        )
    path.unlink()


def load_provenance_verifier(
    workspace_root: Path,
) -> tuple[Any, dict[str, Any], str]:
    contract_path = (
        workspace_root / "assets" / "voice" / "reference-provenance.json"
    )
    generator_path = (
        workspace_root / "tools" / "generate-voice-references.py"
    )
    try:
        contract_bytes = read_bound_regular_file(
            contract_path,
            label="voice provenance contract",
            maximum_bytes=1024 * 1024,
        )
        bootstrap_contract = json.loads(
            contract_bytes.decode("utf-8"),
            object_pairs_hook=reject_duplicate_json_pairs,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"voice provenance contract is unreadable: {error}"
        ) from error
    generator_sha256 = (
        bootstrap_contract.get("generationEvidence", {})
        .get("generatorSha256")
        if isinstance(bootstrap_contract, dict)
        else None
    )
    if (
        not isinstance(bootstrap_contract, dict)
        or bootstrap_contract.get("status") != "verified"
        or not isinstance(generator_sha256, str)
        or len(generator_sha256) != 64
        or any(character not in "0123456789abcdef" for character in generator_sha256)
    ):
        raise RuntimeError("voice provenance contract is not verified")
    generator_bytes = read_bound_regular_file(
        generator_path,
        label="voice provenance verifier",
        maximum_bytes=2 * 1024 * 1024,
    )
    if hashlib.sha256(generator_bytes).hexdigest() != generator_sha256:
        raise RuntimeError("voice provenance verifier digest mismatch")
    module = types.ModuleType("monarch_voice_reference_provenance")
    module.__file__ = str(generator_path)
    module.__package__ = ""
    exec(
        compile(
            generator_bytes,
            str(generator_path),
            "exec",
            dont_inherit=True,
        ),
        module.__dict__,
    )
    if module.WORKSPACE_ROOT != workspace_root:
        raise RuntimeError("voice provenance verifier workspace mismatch")
    return (
        module,
        bootstrap_contract,
        hashlib.sha256(contract_bytes).hexdigest(),
    )


def verify_installed_voice_release(
    workspace_root: Path,
) -> tuple[Any, dict[str, Any]]:
    verifier, contract, contract_file_sha256 = load_provenance_verifier(
        workspace_root
    )
    verifier.validate_contract(contract)
    if contract.get("status") != "verified":
        raise RuntimeError("installed voice provenance contract is not verified")
    # This is the release gate, not an asset-only shortcut: it binds the
    # canonical source projection, generator, promoted generation manifest,
    # every manifest model record, and every promoted WAV before torch imports.
    verifier.verify_release(
        contract,
        contract_file_sha256=contract_file_sha256,
    )
    if contract["generation"].get("referenceText") != REFERENCE_TEXT:
        raise RuntimeError("installed voice reference transcript changed")
    return verifier, contract


def verified_reference_record(
    workspace_root: Path,
    voice_id: str,
    *,
    verified_release: tuple[Any, dict[str, Any]] | None = None,
) -> tuple[Path, dict[str, Any]]:
    verifier, contract = (
        verified_release
        if verified_release is not None
        else verify_installed_voice_release(workspace_root)
    )
    voices = {
        voice["id"]: voice
        for voice in contract["voices"]
        if isinstance(voice, dict) and isinstance(voice.get("id"), str)
    }
    voice = voices.get(voice_id)
    if voice is None:
        raise RuntimeError("installed voice is absent from provenance contract")
    expected_relative = f"assets/voice/{voice_id}-reference.wav"
    if voice.get("assetPath") != expected_relative:
        raise RuntimeError("installed voice asset path identity changed")
    target = workspace_root / expected_relative
    if target.parent != workspace_root / "assets" / "voice":
        raise RuntimeError("installed voice asset escaped its fixed directory")
    verifier.verify_wav_against_artifact(
        target,
        voice["artifact"],
        label=f"installed voice reference {voice_id}",
    )
    return target, dict(voice["artifact"])


def verify_installed_reference(workspace_root: Path, voice_id: str) -> Path:
    """Compatibility probe used by release tests; synthesis uses the record."""
    target, _artifact = verified_reference_record(workspace_root, voice_id)
    return target


def capture_model_tree_identity(
    model_path: Path,
) -> tuple[tuple[str, int, int, int, int], ...]:
    """Reject linked model entries and capture an exact local identity receipt."""
    root = verify_directory_identity(
        model_path,
        label="selected local TTS model",
    )
    receipt: list[tuple[str, int, int, int, int]] = []
    for current_root, directories, files in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        current = Path(current_root)
        verify_directory_identity(current, label="TTS model directory")
        for directory in sorted(directories):
            verify_directory_identity(
                current / directory,
                label=f"TTS model directory {directory}",
            )
        for filename in sorted(files):
            candidate = verify_local_regular_file(
                current / filename,
                label=f"TTS model file {filename}",
            )
            metadata = candidate.lstat()
            receipt.append(
                (
                    candidate.relative_to(root).as_posix(),
                    metadata.st_dev,
                    metadata.st_ino,
                    metadata.st_size,
                    metadata.st_mtime_ns,
                )
            )
    if not receipt:
        raise RuntimeError("selected local TTS model contains no files")
    return tuple(sorted(receipt))


def resolve_request(
    args: argparse.Namespace,
) -> tuple[Path, Path, str, dict[str, str]]:
    payload = json.loads(sys.stdin.read() or "{}")
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    model_id = clean_text(payload.get("model"), field="model", maximum=120, required=True).lower()
    spec = MODEL_MODES.get(model_id)
    if spec is None:
        raise ValueError("unsupported TTS model")
    model_root = verify_directory_identity(
        args.model_root,
        label="TTS model root",
    )
    model_path = model_root / spec[0]
    if not is_inside(model_root, model_path):
        raise FileNotFoundError("selected local TTS model is unavailable")
    model_path = verify_directory_identity(
        model_path,
        label="selected local TTS model",
    )
    config_path = model_path / "config.json"
    verify_local_regular_file(
        config_path,
        label="selected local TTS model config",
    )

    output_dir = verify_directory_identity(
        args.output_dir,
        label="trusted WAV directory",
    )
    output = args.output.absolute()
    if not is_inside(output_dir, output) or output.suffix.lower() != ".wav":
        raise ValueError("output path is outside the trusted WAV directory")
    if output.exists():
        raise FileExistsError("trusted WAV output must not already exist")

    request = {
        "model": model_id,
        "mode": spec[1],
        "text": clean_text(payload.get("input"), field="input", maximum=MAX_INPUT_CHARS, required=True),
        "voice": clean_text(payload.get("voice"), field="voice", maximum=160),
        "language": qwen_language(clean_text(payload.get("language"), field="language", maximum=32) or "ru-RU"),
        "instructions": clean_text(payload.get("instructions"), field="instructions", maximum=MAX_INSTRUCTION_CHARS),
    }
    return output, model_path, spec[1], request


def write_wav(
    path: Path,
    samples: Any,
    sample_rate: int,
) -> tuple[int, str]:
    import numpy as np

    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not values.size:
        raise RuntimeError("Qwen TTS produced no audio")
    encoded = (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(int(sample_rate))
        stream.writeframes(encoded)
    payload = output.getvalue()
    exclusive_write_bytes(path, payload, label="Sharing TTS WAV")
    return len(payload), hashlib.sha256(payload).hexdigest()


def synthesize(args: argparse.Namespace) -> dict[str, Any]:
    output, model_dir, mode, request = resolve_request(args)
    reference: Path | None = None
    reference_descriptor: int | None = None
    reference_identity: tuple[int, int] | None = None
    reference_artifact: dict[str, Any] | None = None
    try:
        workspace_root = verify_directory_identity(
            args.workspace_root,
            label="Sharing workspace root",
        )
        release_verifier, release_contract = verify_installed_voice_release(
            workspace_root
        )
        if mode == "base":
            voice_id = (request["voice"] or "oscar").lower()
            if voice_id not in {"oscar", "oscar-clear", "aurora"}:
                raise ValueError(
                    "base TTS accepts only installed voices: "
                    "oscar, oscar-clear, aurora"
                )
            installed, reference_artifact = verified_reference_record(
                workspace_root,
                voice_id,
                verified_release=(release_verifier, release_contract),
            )
            installed_bytes = read_bound_regular_file(
                installed,
                label=f"installed voice reference {voice_id}",
                maximum_bytes=MAX_REFERENCE_BYTES,
            )
            validate_wav_payload(
                installed_bytes,
                reference_artifact,
                label=f"installed voice reference {voice_id}",
            )
            (
                reference,
                reference_descriptor,
                reference_identity,
            ) = create_private_reference_snapshot(
                output.parent,
                installed_bytes,
                reference_artifact,
                voice_id=voice_id,
            )

        # The tree receipt is captured before heavy imports and reconciled after
        # load/generation. This is post-dispatch detection: no unsafe output is
        # accepted if the loader's path-backed inputs changed in either stage.
        model_receipt = capture_model_tree_identity(model_dir)

        import numpy as np
        import torch
        from faster_qwen3_tts import FasterQwen3TTS

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable for local Qwen TTS")
        torch.set_grad_enabled(False)
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        model = FasterQwen3TTS.from_pretrained(
            str(model_dir),
            device="cuda",
            dtype="bfloat16",
            attn_implementation="sdpa",
            max_seq_len=1024,
            local_files_only=True,
        )
        if capture_model_tree_identity(model_dir) != model_receipt:
            raise RuntimeError("local TTS model changed during model load")
        common = {
            "text": request["text"],
            "language": request["language"],
            "chunk_size": 8,
            "do_sample": True,
            "temperature": 0.78,
            "top_k": 36,
            "top_p": 0.94,
            "repetition_penalty": 1.08,
            "max_new_tokens": 768,
        }
        if mode == "base":
            if (
                reference is None
                or reference_descriptor is None
                or reference_identity is None
                or reference_artifact is None
            ):
                raise RuntimeError(
                    "installed base voice reference was not verified"
                )
            reconcile_private_reference(
                reference,
                reference_descriptor,
                reference_identity,
                reference_artifact,
                label="private voice reference before model use",
            )
            generator = model.generate_voice_clone_streaming(
                **common,
                ref_audio=reference,
                ref_text=REFERENCE_TEXT,
                append_silence=True,
                instruct=request["instructions"] or None,
            )
        elif mode == "custom":
            speaker = (request["voice"] or "ryan").lower()
            if speaker not in SUPPORTED_SPEAKERS:
                raise ValueError(
                    "custom TTS voice must be one of the installed Qwen speakers"
                )
            canonical_speaker = SUPPORTED_SPEAKERS[speaker]
            generator = model.generate_custom_voice_streaming(
                **common,
                speaker=canonical_speaker,
                instruct=request["instructions"] or None,
            )
        else:
            instruction = request["instructions"] or request["voice"]
            if not instruction:
                raise ValueError(
                    "voice-design TTS requires instructions describing "
                    "the desired voice"
                )
            generator = model.generate_voice_design_streaming(
                **common,
                instruct=instruction,
            )

        chunks: list[Any] = []
        sample_rate = 0
        for chunk, current_sample_rate, _timing in generator:
            chunks.append(np.asarray(chunk, dtype=np.float32).reshape(-1))
            sample_rate = int(current_sample_rate)
        if sample_rate <= 0:
            raise RuntimeError("Qwen TTS returned no valid sample rate")
        if capture_model_tree_identity(model_dir) != model_receipt:
            raise RuntimeError("local TTS model changed during generation")
        if (
            reference is not None
            and reference_descriptor is not None
            and reference_identity is not None
            and reference_artifact is not None
        ):
            reconcile_private_reference(
                reference,
                reference_descriptor,
                reference_identity,
                reference_artifact,
                label="private voice reference after model use",
            )
        output_bytes, output_sha256 = write_wav(
            output,
            np.concatenate(chunks)
            if chunks
            else np.zeros((0,), dtype=np.float32),
            sample_rate,
        )
        return {
            "ok": True,
            "model": request["model"],
            "sample_rate": sample_rate,
            "bytes": output_bytes,
            "sha256": output_sha256,
        }
    finally:
        cleanup_private_reference(
            reference,
            reference_descriptor,
            reference_identity,
        )


def main() -> int:
    args = parse_args()
    try:
        result = synthesize(args)
        emit(result)
        return 0
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"ok": False, "code": "tts_generation_failed", "message": " ".join(str(error).split())[:500] or type(error).__name__})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
