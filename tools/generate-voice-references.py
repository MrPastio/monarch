#!/usr/bin/env python3
"""Verify and regenerate Monarch's synthetic Qwen VoiceDesign references.

The contract deliberately has no path arguments and never downloads a model.
Generation writes only the three fixed staging WAVs and one derived manifest.
Promotion into ``assets/voice`` remains a separate reviewed release step.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import os
import random
import stat
import sys
import wave
from pathlib import Path
from typing import Any


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = WORKSPACE_ROOT / "assets" / "voice" / "reference-provenance.json"
GENERATOR_PATH = WORKSPACE_ROOT / "tools" / "generate-voice-references.py"
MODEL_PATH = (
    WORKSPACE_ROOT
    / "runtime"
    / "voice"
    / "models"
    / "qwen3-tts-1.7b-voice-design"
)
STAGING_PATH = (
    WORKSPACE_ROOT / "artifacts" / "qa" / "voice-reference-provenance-v1"
)
STAGING_MANIFEST = STAGING_PATH / "generation-manifest.json"
RELEASE_MANIFEST = (
    WORKSPACE_ROOT / "assets" / "voice" / "generation-manifest.json"
)
SOURCE_PROJECTION_ID = "monarch-voice-generation-source-v1"
SOURCE_PROJECTION_PATH = (
    "assets/voice/reference-provenance.json#generation-source-v1"
)
MAX_CONTRACT_BYTES = 1024 * 1024
MAX_GENERATOR_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_VOICE_ARTIFACT_BYTES = 16 * 1024 * 1024

MODEL_REPOSITORY = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
MODEL_REVISION = "5ecdb67327fd37bb2e042aab12ff7391903235d3"
MODEL_LICENSE = "Apache-2.0"
MODEL_CARD_URL = (
    "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/blob/"
    "5ecdb67327fd37bb2e042aab12ff7391903235d3/README.md"
)
CANONICAL_REFERENCE_TEXT = (
    "Привет. Меня зовут Оскар. Я говорю спокойно, уверенно и по делу. "
    "Давай вместе найдём точное и надёжное решение."
)
PINNED_RUNTIME = {
    "python": "3.11.9",
    "torch": "2.11.0+cu128",
    "numpy": "2.4.6",
    "faster-qwen3-tts": "0.3.0",
    "qwen-tts": "0.1.1",
}
PINNED_MODEL_FILES = (
    ("config.json", 4421, "aecd2cc4c1fe9edef1cb7ca7c401685a43879ad43f3f9e883f1c6760b61731e0"),
    ("generation_config.json", 245, "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa"),
    ("merges.txt", 1671839, "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3"),
    ("model.safetensors", 3833402552, "391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522"),
    ("preprocessor_config.json", 127, "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119"),
    ("tokenizer_config.json", 7344, "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670"),
    ("vocab.json", 2776833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
    ("speech_tokenizer/config.json", 2336, "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167"),
    ("speech_tokenizer/configuration.json", 76, "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd"),
    ("speech_tokenizer/model.safetensors", 682293092, "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258"),
    ("speech_tokenizer/preprocessor_config.json", 234, "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb"),
)
GENERATION_SETTINGS = {
    "device": "cuda",
    "dtype": "bfloat16",
    "attentionImplementation": "sdpa",
    "chunkSize": 8,
    "doSample": True,
    "temperature": 0.78,
    "topK": 36,
    "topP": 0.94,
    "repetitionPenalty": 1.08,
    "maxNewTokens": 1024,
    "cublasWorkspaceConfig": ":4096:8",
    "deterministicAlgorithms": True,
    "allowTf32": False,
}
VOICE_SPECS = (
    {
        "id": "oscar",
        "description": (
            "Спокойный уверенный мужской голос среднего-низкого регистра, "
            "естественный и собранный. Чёткая русская дикция, ровный темп, "
            "короткие естественные паузы, без театральности и без имитации "
            "конкретного человека."
        ),
        "seed": 2026072901,
        "assetPath": "assets/voice/oscar-reference.wav",
        "stagingPath": (
            "artifacts/qa/voice-reference-provenance-v1/oscar-reference.wav"
        ),
    },
    {
        "id": "oscar-clear",
        "description": (
            "Чистый нейтральный мужской голос среднего регистра. Очень ясная "
            "русская дикция, спокойный ровный темп, точные окончания, минимум "
            "окраски, без театральности и без имитации конкретного человека."
        ),
        "seed": 2026072902,
        "assetPath": "assets/voice/oscar-clear-reference.wav",
        "stagingPath": (
            "artifacts/qa/voice-reference-provenance-v1/"
            "oscar-clear-reference.wav"
        ),
    },
    {
        "id": "aurora",
        "description": (
            "Тёплый ясный женский голос среднего регистра. Естественная "
            "русская дикция, мягкая уверенная подача, спокойный темп, "
            "дружелюбие без наигранности и без имитации конкретного человека."
        ),
        "seed": 2026072903,
        "assetPath": "assets/voice/aurora-reference.wav",
        "stagingPath": (
            "artifacts/qa/voice-reference-provenance-v1/aurora-reference.wav"
        ),
    },
)

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["CUBLAS_WORKSPACE_CONFIG"] = GENERATION_SETTINGS[
    "cublasWorkspaceConfig"
]


def fail(message: str) -> None:
    raise RuntimeError(message)


def canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def reject_duplicate_json_pairs(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in pairs:
        if key in payload:
            fail(f"JSON contains a duplicate key: {key}")
        payload[key] = value
    return payload


def parse_json_object(exact_bytes: bytes, *, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(
            exact_bytes.decode("utf-8"),
            object_pairs_hook=reject_duplicate_json_pairs,
        )
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"{label} is unreadable: {error}")
    if not isinstance(payload, dict):
        fail(f"{label} must be a JSON object")
    return payload


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
        fail(
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
            fail(
                f"Windows stream enumeration failed for {path.name}: "
                f"error {error}"
            )
    finally:
        if not find_close(handle):
            fail(
                f"Windows stream handle close failed for {path.name}: "
                f"error {ctypes.get_last_error()}"
            )
    return names


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def verify_lexical_path(path: Path, *, label: str) -> Path:
    """Reject lexical links/junctions before any canonical resolution."""
    absolute = lexical_absolute(path)
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except OSError as error:
            fail(f"{label} is unavailable: {error}")
        if stat.S_ISLNK(metadata.st_mode) or getattr(
            metadata,
            "st_reparse_tag",
            0,
        ):
            fail(f"{label} resolves through a link or junction")
        if current != absolute and not stat.S_ISDIR(metadata.st_mode):
            fail(f"{label} has a non-directory parent")
    return absolute


def verify_regular_file_identity(path: Path, *, label: str) -> Path:
    absolute = verify_lexical_path(path, label=label)
    metadata = absolute.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        fail(f"{label} is not a regular file")
    if getattr(metadata, "st_reparse_tag", 0):
        fail(f"{label} is a Windows reparse point")
    if metadata.st_nlink != 1:
        fail(f"{label} has multiple hard links")
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        fail(f"{label} resolves through a link or junction")
    if os.name == "nt":
        streams = windows_stream_names(absolute)
        if streams != ["::$DATA"]:
            fail(f"{label} has an alternate data stream")
    return absolute


def verify_directory_identity(path: Path, *, label: str) -> Path:
    absolute = verify_lexical_path(path, label=label)
    metadata = absolute.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        fail(f"{label} is not a directory")
    if getattr(metadata, "st_reparse_tag", 0):
        fail(f"{label} is a Windows reparse point")
    resolved = absolute.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        fail(f"{label} resolves through a link or junction")
    return absolute


def ensure_trusted_directory(path: Path, *, label: str) -> Path:
    """Create missing components only below an already verified directory."""
    absolute = lexical_absolute(path)
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        candidate = current / component
        try:
            candidate.lstat()
        except FileNotFoundError:
            verify_directory_identity(
                current,
                label=f"{label} parent",
            )
            try:
                os.mkdir(candidate, 0o700)
            except FileExistsError:
                fail(f"{label} identity appeared during creation")
        except OSError as error:
            fail(f"{label} is unavailable: {error}")
        current = verify_directory_identity(candidate, label=label)
    return current


def read_bound_regular_file(
    path: Path,
    *,
    label: str,
    maximum_bytes: int,
) -> bytes:
    """Read bounded bytes through one no-follow, identity-bound descriptor."""
    if maximum_bytes < 0:
        fail(f"{label} has an invalid safety limit")
    absolute = verify_regular_file_identity(path, label=label)
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
            fail(f"{label} identity changed before read")
        payload = bytearray()
        while len(payload) <= maximum_bytes:
            chunk = os.read(
                descriptor,
                min(1024 * 1024, maximum_bytes + 1 - len(payload)),
            )
            if not chunk:
                break
            payload.extend(chunk)
        if len(payload) > maximum_bytes:
            fail(f"{label} exceeds the local safety limit")
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
            fail(f"{label} identity changed during read")
        if os.name == "nt" and windows_stream_names(absolute) != ["::$DATA"]:
            fail(f"{label} gained an alternate data stream during read")
        return bytes(payload)
    finally:
        os.close(descriptor)


def measure_bound_regular_file(
    path: Path,
    *,
    label: str,
) -> tuple[int, str]:
    """Hash one no-follow descriptor and reconcile it to the visible path."""
    absolute = verify_regular_file_identity(path, label=label)
    before = absolute.lstat()
    flags = os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(absolute, flags)
    digest = hashlib.sha256()
    try:
        opened_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_before.st_mode)
            or opened_before.st_nlink != 1
            or (opened_before.st_dev, opened_before.st_ino)
            != (before.st_dev, before.st_ino)
        ):
            fail(f"{label} identity changed before read")
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b""):
            digest.update(chunk)
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
            fail(f"{label} identity changed during read")
        if os.name == "nt" and windows_stream_names(absolute) != ["::$DATA"]:
            fail(f"{label} gained an alternate data stream during read")
        return opened_after.st_size, digest.hexdigest()
    finally:
        os.close(descriptor)


def reconcile_bound_file_digest(
    path: Path,
    *,
    label: str,
    expected_sha256: str,
) -> None:
    _actual_size, actual_sha256 = measure_bound_regular_file(
        path,
        label=label,
    )
    if actual_sha256 != expected_sha256:
        fail(f"{label} persistent digest changed")


def exclusive_write_bytes(path: Path, payload: bytes, *, label: str) -> None:
    """Create one new regular file without following or replacing a target."""
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
                fail(f"{label} write made no progress")
            offset += written
        os.fsync(descriptor)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            fail(f"{label} output identity is unsafe")
        visible = path.stat()
        if (opened.st_dev, opened.st_ino) != (visible.st_dev, visible.st_ino):
            fail(f"{label} output identity changed during creation")
    finally:
        os.close(descriptor)
    verify_regular_file_identity(path, label=label)
    verify_directory_identity(path.parent, label=f"{label} parent")


def load_contract() -> tuple[dict[str, Any], str]:
    exact_bytes = read_bound_regular_file(
        CONTRACT_PATH,
        label="voice provenance contract",
        maximum_bytes=MAX_CONTRACT_BYTES,
    )
    payload = parse_json_object(
        exact_bytes,
        label="voice provenance contract",
    )
    return payload, hashlib.sha256(exact_bytes).hexdigest()


def reconcile_contract_snapshot(
    expected_contract: dict[str, Any],
    expected_file_sha256: str,
) -> dict[str, Any]:
    expected_sha256 = validate_sha256(
        expected_file_sha256,
        field="voice provenance contract file SHA-256",
    )
    current_contract, current_sha256 = load_contract()
    validate_contract(current_contract)
    if (
        current_sha256 != expected_sha256
        or current_contract != expected_contract
    ):
        fail("voice provenance contract snapshot changed")
    return current_contract


def load_generation_manifest_snapshot(
    manifest_path: Path,
) -> tuple[dict[str, Any], int, str]:
    exact_bytes = read_bound_regular_file(
        manifest_path,
        label="voice generation manifest",
        maximum_bytes=MAX_MANIFEST_BYTES,
    )
    manifest = parse_json_object(
        exact_bytes,
        label="voice generation manifest",
    )
    return (
        manifest,
        len(exact_bytes),
        hashlib.sha256(exact_bytes).hexdigest(),
    )


def load_generator_snapshot(
    expected_sha256: str,
) -> tuple[int, str]:
    expected = validate_sha256(
        expected_sha256,
        field="voice provenance generator SHA-256",
    )
    generator_bytes = read_bound_regular_file(
        GENERATOR_PATH,
        label="voice provenance generator",
        maximum_bytes=MAX_GENERATOR_BYTES,
    )
    actual = hashlib.sha256(generator_bytes).hexdigest()
    if actual != expected:
        fail("voice provenance generator changed after generation")
    return len(generator_bytes), actual


def source_contract_projection(contract: dict[str, Any]) -> dict[str, Any]:
    """Return the immutable pre-promotion input projected from either state."""
    return {
        "schemaVersion": 1,
        "projectionId": SOURCE_PROJECTION_ID,
        "contractId": contract["contractId"],
        "origin": contract["origin"],
        "model": contract["model"],
        "runtime": contract["runtime"],
        "generation": contract["generation"],
        "voices": [
            {
                **{
                    key: voice[key]
                    for key in (
                        "id",
                        "description",
                        "seed",
                        "assetPath",
                        "stagingPath",
                    )
                },
                "artifactContract": {
                    "channels": voice["artifact"]["channels"],
                    "sampleWidthBits": voice["artifact"]["sampleWidthBits"],
                },
            }
            for voice in contract["voices"]
        ],
    }


def source_contract_digest(contract: dict[str, Any]) -> str:
    return hashlib.sha256(
        canonical_json_bytes(source_contract_projection(contract))
    ).hexdigest()


def validate_sha256(value: Any, *, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        fail(f"{field} must be a lowercase SHA-256")
    return value


def validate_artifact_record(artifact: Any) -> None:
    if not isinstance(artifact, dict):
        fail("voice artifact metadata must be an object")
    if artifact.get("channels") != 1 or artifact.get("sampleWidthBits") != 16:
        fail("voice artifact PCM contract changed")
    status = artifact.get("status")
    measured = (
        artifact.get("sha256"),
        artifact.get("bytes"),
        artifact.get("durationSeconds"),
        artifact.get("sampleRateHz"),
    )
    if status == "pending-generation":
        if any(value is not None for value in measured):
            fail("pending voice artifact cannot claim measured output")
        return
    if status != "verified":
        fail("voice artifact status must be pending-generation or verified")
    sha256, size, duration, sample_rate = measured
    validate_sha256(sha256, field="verified voice artifact SHA-256")
    if not isinstance(size, int) or size <= 44:
        fail("verified voice artifact requires a WAV byte count")
    if not isinstance(duration, (int, float)) or duration <= 0:
        fail("verified voice artifact requires a positive duration")
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        fail("verified voice artifact requires a sample rate")


def validate_contract(contract: dict[str, Any]) -> None:
    if contract.get("schemaVersion") != 1:
        fail("unsupported voice provenance schema")
    if contract.get("contractId") != "monarch-synthetic-voice-references-v1":
        fail("unexpected voice provenance contract id")
    origin = contract.get("origin")
    if origin != {
        "kind": "synthetic-text-and-instruction-only",
        "humanReferenceAudio": False,
        "voiceCloning": False,
    }:
        fail("synthetic-only origin contract changed")
    model = contract.get("model")
    if not isinstance(model, dict):
        fail("model contract is missing")
    expected_model_fields = {
        "repository": MODEL_REPOSITORY,
        "revision": MODEL_REVISION,
        "license": MODEL_LICENSE,
        "modelCardUrl": MODEL_CARD_URL,
        "localPath": "runtime/voice/models/qwen3-tts-1.7b-voice-design",
    }
    for key, expected in expected_model_fields.items():
        if model.get(key) != expected:
            fail(f"model {key} changed")
    expected_files = [
        {"path": path, "bytes": size, "sha256": sha256}
        for path, size, sha256 in PINNED_MODEL_FILES
    ]
    if model.get("files") != expected_files:
        fail("pinned model file manifest changed")
    if contract.get("runtime") != PINNED_RUNTIME:
        fail("pinned generator runtime changed")
    generation = contract.get("generation")
    if not isinstance(generation, dict):
        fail("generation contract is missing")
    if generation.get("generator") != "tools/generate-voice-references.py":
        fail("voice generator path changed")
    if generation.get("language") != "Russian":
        fail("voice generation language changed")
    if generation.get("referenceText") != CANONICAL_REFERENCE_TEXT:
        fail("canonical Russian reference text changed")
    if generation.get("settings") != GENERATION_SETTINGS:
        fail("voice generation settings changed")
    if (
        generation.get("stagingDirectory")
        != "artifacts/qa/voice-reference-provenance-v1"
    ):
        fail("voice staging directory changed")
    voices = contract.get("voices")
    if not isinstance(voices, list) or len(voices) != len(VOICE_SPECS):
        fail("voice set changed")
    artifact_statuses: set[str] = set()
    for actual, expected in zip(voices, VOICE_SPECS, strict=True):
        if not isinstance(actual, dict):
            fail("voice entry must be an object")
        for key, value in expected.items():
            if actual.get(key) != value:
                fail(f"voice {expected['id']} field {key} changed")
        validate_artifact_record(actual.get("artifact"))
        artifact_statuses.add(actual["artifact"]["status"])
    contract_status = contract.get("status")
    expected_artifact_status = {
        "pending-regeneration": "pending-generation",
        "verified": "verified",
    }.get(contract_status)
    if expected_artifact_status is None:
        fail("voice provenance status must be pending-regeneration or verified")
    if artifact_statuses != {expected_artifact_status}:
        fail("voice provenance status does not match all artifact statuses")
    evidence = contract.get("generationEvidence")
    if not isinstance(evidence, dict) or set(evidence) != {
        "sourceContractSha256",
        "generatorSha256",
        "manifestSha256",
    }:
        fail("voice generation evidence contract is missing")
    source_contract_sha256 = evidence.get("sourceContractSha256")
    generator_sha256 = evidence.get("generatorSha256")
    manifest_sha256 = evidence.get("manifestSha256")
    if contract_status == "pending-regeneration":
        if (
            source_contract_sha256 is not None
            or generator_sha256 is not None
            or manifest_sha256 is not None
        ):
            fail("pending voice contract cannot claim generation evidence")
    else:
        validate_sha256(
            source_contract_sha256,
            field="generation evidence source contract SHA-256",
        )
        validate_sha256(
            generator_sha256,
            field="generation evidence generator SHA-256",
        )
        validate_sha256(
            manifest_sha256,
            field="generation evidence manifest SHA-256",
        )
        if source_contract_sha256 != source_contract_digest(contract):
            fail(
                "verified contract source evidence does not match the "
                "canonical generation projection"
            )


def verify_runtime_versions() -> None:
    running_python = ".".join(str(part) for part in sys.version_info[:3])
    if running_python != PINNED_RUNTIME["python"]:
        fail(
            f"Python version mismatch: {running_python} != "
            f"{PINNED_RUNTIME['python']}"
        )
    for package_name in ("torch", "numpy", "faster-qwen3-tts", "qwen-tts"):
        try:
            installed = importlib.metadata.version(package_name)
        except importlib.metadata.PackageNotFoundError:
            fail(f"required pinned package is unavailable: {package_name}")
        if installed != PINNED_RUNTIME[package_name]:
            fail(
                f"{package_name} version mismatch: {installed} != "
                f"{PINNED_RUNTIME[package_name]}"
            )


def verify_model() -> tuple[Path, list[dict[str, Any]]]:
    # Inspect every lexical component before resolve so a junction cannot be
    # normalized away before policy sees it.
    model_root = verify_directory_identity(
        MODEL_PATH,
        label="pinned model root",
    )
    verified: list[dict[str, Any]] = []
    for relative_path, expected_size, expected_sha256 in PINNED_MODEL_FILES:
        candidate = model_root / Path(relative_path)
        try:
            candidate.absolute().relative_to(model_root)
        except ValueError:
            fail(f"model file escapes the pinned model root: {relative_path}")
        candidate = verify_regular_file_identity(
            candidate,
            label=f"pinned model file {relative_path}",
        )
        actual_size, actual_sha256 = measure_bound_regular_file(
            candidate,
            label=f"pinned model file {relative_path}",
        )
        if actual_size != expected_size:
            fail(
                f"model size mismatch for {relative_path}: "
                f"{actual_size} != {expected_size}"
            )
        if actual_sha256 != expected_sha256:
            fail(f"model SHA-256 mismatch for {relative_path}")
        verified.append(
            {
                "path": relative_path,
                "bytes": actual_size,
                "sha256": actual_sha256,
            }
        )
    return model_root, verified


def reconcile_model_evidence(
    expected_root: Path,
    expected_files: list[dict[str, Any]],
    *,
    phase: str,
) -> None:
    actual_root, actual_files = verify_model()
    if actual_root != expected_root or actual_files != expected_files:
        fail(f"pinned model changed {phase}")


def set_generation_seed(torch: Any, numpy: Any, seed: int) -> None:
    random.seed(seed)
    numpy.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def wav_bytes(numpy: Any, samples: Any, sample_rate: int) -> tuple[bytes, int]:
    values = numpy.asarray(samples, dtype=numpy.float32).reshape(-1)
    if not values.size:
        fail("Qwen VoiceDesign produced no audio")
    encoded = (
        numpy.clip(values, -1.0, 1.0) * 32767.0
    ).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(encoded)
    return output.getvalue(), int(values.size)


def ensure_clean_staging() -> None:
    staging_parent = ensure_trusted_directory(
        STAGING_PATH.parent,
        label="voice staging parent",
    )
    staging_path = lexical_absolute(STAGING_PATH)
    if staging_path.parent != staging_parent:
        fail("fixed voice staging path escaped its trusted parent")
    try:
        staging_path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        fail(f"fixed voice staging path is unavailable: {error}")
    staging_path = verify_directory_identity(
        staging_path,
        label="fixed voice staging path",
    )
    if any(staging_path.iterdir()):
        fail(
            "voice staging is not empty; preserve and review the existing run "
            "before starting another"
        )


def build_generation_manifest(
    contract: dict[str, Any],
    model_files: list[dict[str, Any]],
    source_contract_sha256: str,
    generator_sha256: str,
    rendered: list[tuple[dict[str, Any], bytes, dict[str, Any]]],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "contractId": contract["contractId"],
        "source": {
            "contract": {
                "path": SOURCE_PROJECTION_PATH,
                "projectionId": SOURCE_PROJECTION_ID,
                "sha256": source_contract_sha256,
            },
            "generator": {
                "path": "tools/generate-voice-references.py",
                "sha256": generator_sha256,
            },
        },
        "model": {
            "repository": MODEL_REPOSITORY,
            "revision": MODEL_REVISION,
            "license": MODEL_LICENSE,
            "verifiedFiles": model_files,
        },
        "runtime": PINNED_RUNTIME,
        "origin": contract["origin"],
        "referenceText": CANONICAL_REFERENCE_TEXT,
        "settings": GENERATION_SETTINGS,
        "voices": [
            {
                "id": voice["id"],
                "description": voice["description"],
                "seed": voice["seed"],
                "stagingPath": voice["stagingPath"],
                "assetPath": voice["assetPath"],
                "artifact": artifact,
            }
            for voice, _payload, artifact in rendered
        ],
    }


def validate_generation_manifest_payload(
    contract: dict[str, Any],
    manifest: Any,
    *,
    source_contract_sha256: str,
    generator_sha256: str,
    require_contract_artifacts: bool,
) -> list[dict[str, Any]]:
    if not isinstance(manifest, dict) or set(manifest) != {
        "schemaVersion",
        "contractId",
        "source",
        "model",
        "runtime",
        "origin",
        "referenceText",
        "settings",
        "voices",
    }:
        fail("generation manifest has an unexpected shape")
    if manifest.get("schemaVersion") != 1:
        fail("unsupported generation manifest schema")
    if manifest.get("contractId") != contract["contractId"]:
        fail("generation manifest contract id changed")
    expected_source = {
        "contract": {
            "path": SOURCE_PROJECTION_PATH,
            "projectionId": SOURCE_PROJECTION_ID,
            "sha256": source_contract_sha256,
        },
        "generator": {
            "path": "tools/generate-voice-references.py",
            "sha256": generator_sha256,
        },
    }
    if manifest.get("source") != expected_source:
        fail("generation manifest source digests changed")
    expected_model = {
        "repository": MODEL_REPOSITORY,
        "revision": MODEL_REVISION,
        "license": MODEL_LICENSE,
        "verifiedFiles": [
            {"path": path, "bytes": size, "sha256": sha256}
            for path, size, sha256 in PINNED_MODEL_FILES
        ],
    }
    if manifest.get("model") != expected_model:
        fail("generation manifest model evidence changed")
    for field, expected in (
        ("runtime", PINNED_RUNTIME),
        ("origin", contract["origin"]),
        ("referenceText", CANONICAL_REFERENCE_TEXT),
        ("settings", GENERATION_SETTINGS),
    ):
        if manifest.get(field) != expected:
            fail(f"generation manifest {field} changed")
    manifest_voices = manifest.get("voices")
    contract_voices = contract["voices"]
    if (
        not isinstance(manifest_voices, list)
        or len(manifest_voices) != len(VOICE_SPECS)
    ):
        fail("generation manifest voice set changed")
    for actual, expected, contract_voice in zip(
        manifest_voices,
        VOICE_SPECS,
        contract_voices,
        strict=True,
    ):
        if not isinstance(actual, dict) or set(actual) != {
            "id",
            "description",
            "seed",
            "stagingPath",
            "assetPath",
            "artifact",
        }:
            fail("generation manifest voice has an unexpected shape")
        for field in (
            "id",
            "description",
            "seed",
            "stagingPath",
            "assetPath",
        ):
            if actual.get(field) != expected[field]:
                fail(
                    f"generation manifest voice {expected['id']} "
                    f"field {field} changed"
                )
        validate_artifact_record(actual.get("artifact"))
        if actual["artifact"]["status"] != "verified":
            fail(f"generation manifest artifact is not verified: {expected['id']}")
        if (
            require_contract_artifacts
            and actual["artifact"] != contract_voice["artifact"]
        ):
            fail(
                f"generation manifest artifact differs from contract: "
                f"{expected['id']}"
            )
    return manifest_voices


def verify_wav_against_artifact(
    target: Path,
    artifact: dict[str, Any],
    *,
    label: str,
) -> None:
    payload = read_bound_regular_file(
        target,
        label=label,
        maximum_bytes=MAX_VOICE_ARTIFACT_BYTES,
    )
    if len(payload) != artifact["bytes"]:
        fail(f"{label} size mismatch")
    if hashlib.sha256(payload).hexdigest() != artifact["sha256"]:
        fail(f"{label} SHA-256 mismatch")
    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2:
                fail(f"{label} PCM format mismatch")
            if source.getframerate() != artifact["sampleRateHz"]:
                fail(f"{label} sample rate mismatch")
            duration = source.getnframes() / source.getframerate()
    except (EOFError, wave.Error) as error:
        fail(f"{label} is not a readable WAV: {error}")
    if abs(duration - artifact["durationSeconds"]) > 0.000001:
        fail(f"{label} duration mismatch")


def validate_generation_manifest(
    contract: dict[str, Any],
    manifest: dict[str, Any],
    *,
    source_contract_sha256: str,
    generator_sha256: str,
    require_contract_artifacts: bool,
    verify_staged_wavs: bool,
) -> dict[str, Any]:
    validate_sha256(
        source_contract_sha256,
        field="generation manifest source contract SHA-256",
    )
    validate_sha256(
        generator_sha256,
        field="generation manifest generator SHA-256",
    )
    voices = validate_generation_manifest_payload(
        contract,
        manifest,
        source_contract_sha256=source_contract_sha256,
        generator_sha256=generator_sha256,
        require_contract_artifacts=require_contract_artifacts,
    )
    if verify_staged_wavs:
        for voice in voices:
            target = WORKSPACE_ROOT / voice["stagingPath"]
            if target.parent != STAGING_PATH or target.suffix.lower() != ".wav":
                fail(
                    f"generation manifest staging path is invalid: "
                    f"{voice['id']}"
                )
            verify_wav_against_artifact(
                target,
                voice["artifact"],
                label=f"staged voice artifact {voice['id']}",
            )
    return manifest


def generate(
    contract: dict[str, Any],
    contract_file_sha256: str,
    model_root: Path,
    model_files: list[dict[str, Any]],
    source_contract_sha256: str,
    generator_sha256: str,
) -> None:
    contract = reconcile_contract_snapshot(
        contract,
        contract_file_sha256,
    )
    if source_contract_digest(contract) != source_contract_sha256:
        fail("voice generation source projection changed before generation")
    _generator_size, generator_file_sha256 = load_generator_snapshot(
        generator_sha256
    )
    verify_runtime_versions()
    ensure_clean_staging()

    # Heavy runtime imports intentionally happen only after every local hash and
    # version check has passed. Offline flags are already fixed above.
    import numpy as np
    import torch
    from faster_qwen3_tts import FasterQwen3TTS

    if not torch.cuda.is_available():
        fail("CUDA is unavailable for the pinned VoiceDesign generator")
    torch.set_grad_enabled(False)
    torch.use_deterministic_algorithms(True, warn_only=False)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False

    # The first receipt was captured before imports. Rehash immediately before
    # dispatch, then after model load and after generation. The loader requires
    # path-backed multi-gigabyte files, so an exact private copy is not
    # practical; these reconciliations deliberately provide fail-closed
    # post-dispatch detection instead of claiming impossible preemption.
    reconcile_model_evidence(
        model_root,
        model_files,
        phase="before model load",
    )
    model = FasterQwen3TTS.from_pretrained(
        str(model_root),
        device="cuda",
        dtype="bfloat16",
        attn_implementation="sdpa",
        max_seq_len=1024,
        local_files_only=True,
    )
    reconcile_model_evidence(
        model_root,
        model_files,
        phase="during model load",
    )
    rendered: list[tuple[dict[str, Any], bytes, dict[str, Any]]] = []
    settings = contract["generation"]["settings"]
    for voice in VOICE_SPECS:
        set_generation_seed(torch, np, int(voice["seed"]))
        stream = model.generate_voice_design_streaming(
            text=CANONICAL_REFERENCE_TEXT,
            language="Russian",
            instruct=voice["description"],
            chunk_size=settings["chunkSize"],
            do_sample=settings["doSample"],
            temperature=settings["temperature"],
            top_k=settings["topK"],
            top_p=settings["topP"],
            repetition_penalty=settings["repetitionPenalty"],
            max_new_tokens=settings["maxNewTokens"],
        )
        chunks: list[Any] = []
        sample_rate = 0
        for chunk, current_sample_rate, _timing in stream:
            chunks.append(np.asarray(chunk, dtype=np.float32).reshape(-1))
            sample_rate = int(current_sample_rate)
        if sample_rate <= 0 or not chunks:
            fail(f"Qwen VoiceDesign returned no audio for {voice['id']}")
        payload, frame_count = wav_bytes(
            np,
            np.concatenate(chunks),
            sample_rate,
        )
        rendered.append(
            (
                voice,
                payload,
                {
                    "status": "verified",
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "bytes": len(payload),
                    "durationSeconds": round(frame_count / sample_rate, 6),
                    "sampleRateHz": sample_rate,
                    "channels": 1,
                    "sampleWidthBits": 16,
                },
            )
        )

    reconcile_model_evidence(
        model_root,
        model_files,
        phase="during generation",
    )
    ensure_clean_staging()
    try:
        STAGING_PATH.lstat()
    except FileNotFoundError:
        os.mkdir(STAGING_PATH, 0o700)
    staging_path = verify_directory_identity(
        STAGING_PATH,
        label="fixed voice staging path",
    )
    for voice, payload, artifact in rendered:
        target = WORKSPACE_ROOT / voice["stagingPath"]
        if target.parent != staging_path or target.suffix.lower() != ".wav":
            fail(f"internal staging target is invalid for {voice['id']}")
        exclusive_write_bytes(
            target,
            payload,
            label=f"staged voice artifact {voice['id']}",
        )
    manifest = build_generation_manifest(
        contract,
        model_files,
        source_contract_sha256,
        generator_sha256,
        rendered,
    )
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    exclusive_write_bytes(
        STAGING_MANIFEST,
        manifest_bytes,
        label="voice generation manifest",
    )
    (
        persisted_manifest,
        _manifest_size,
        manifest_file_sha256,
    ) = load_generation_manifest_snapshot(STAGING_MANIFEST)
    if (
        persisted_manifest != manifest
        or manifest_file_sha256
        != hashlib.sha256(manifest_bytes).hexdigest()
    ):
        fail("persisted voice generation manifest changed after creation")
    validate_generation_manifest(
        contract,
        persisted_manifest,
        source_contract_sha256=source_contract_sha256,
        generator_sha256=generator_sha256,
        require_contract_artifacts=False,
        verify_staged_wavs=True,
    )
    reconcile_bound_file_digest(
        CONTRACT_PATH,
        label="voice provenance contract",
        expected_sha256=contract_file_sha256,
    )
    reconcile_bound_file_digest(
        GENERATOR_PATH,
        label="voice provenance generator",
        expected_sha256=generator_file_sha256,
    )
    reconcile_bound_file_digest(
        STAGING_MANIFEST,
        label="voice generation manifest",
        expected_sha256=manifest_file_sha256,
    )


def verify_assets(contract: dict[str, Any]) -> None:
    if contract.get("status") != "verified":
        fail("voice provenance contract is not verified")
    for voice in contract["voices"]:
        artifact = voice["artifact"]
        if artifact["status"] != "verified":
            fail(f"voice artifact is not verified: {voice['id']}")
        target = WORKSPACE_ROOT / voice["assetPath"]
        expected_parent = WORKSPACE_ROOT / "assets" / "voice"
        if (
            target.parent != expected_parent
            or target.suffix.lower() != ".wav"
        ):
            fail(f"voice asset path is invalid: {voice['id']}")
        verify_wav_against_artifact(
            target,
            artifact,
            label=f"voice asset {voice['id']}",
        )


def verify_staging(
    contract: dict[str, Any],
    *,
    contract_file_sha256: str,
    source_contract_sha256: str,
    generator_sha256: str,
) -> None:
    contract = reconcile_contract_snapshot(
        contract,
        contract_file_sha256,
    )
    if contract.get("status") != "pending-regeneration":
        fail("verify-staging requires the pending source contract")
    if source_contract_digest(contract) != source_contract_sha256:
        fail("voice staging source projection changed")
    _generator_size, generator_file_sha256 = load_generator_snapshot(
        generator_sha256
    )
    (
        manifest,
        _manifest_size,
        manifest_file_sha256,
    ) = load_generation_manifest_snapshot(STAGING_MANIFEST)
    validate_generation_manifest(
        contract,
        manifest,
        source_contract_sha256=source_contract_sha256,
        generator_sha256=generator_sha256,
        require_contract_artifacts=False,
        verify_staged_wavs=True,
    )
    reconcile_bound_file_digest(
        CONTRACT_PATH,
        label="voice provenance contract",
        expected_sha256=contract_file_sha256,
    )
    reconcile_bound_file_digest(
        GENERATOR_PATH,
        label="voice provenance generator",
        expected_sha256=generator_file_sha256,
    )
    reconcile_bound_file_digest(
        STAGING_MANIFEST,
        label="voice generation manifest",
        expected_sha256=manifest_file_sha256,
    )


def verify_release(
    contract: dict[str, Any],
    *,
    contract_file_sha256: str,
) -> None:
    contract = reconcile_contract_snapshot(
        contract,
        contract_file_sha256,
    )
    if contract.get("status") != "verified":
        fail("verify-release requires a verified voice provenance contract")
    evidence = contract["generationEvidence"]
    source_contract_sha256 = validate_sha256(
        evidence["sourceContractSha256"],
        field="generation evidence source contract SHA-256",
    )
    generator_sha256 = validate_sha256(
        evidence["generatorSha256"],
        field="generation evidence generator SHA-256",
    )
    manifest_sha256 = validate_sha256(
        evidence["manifestSha256"],
        field="generation evidence manifest SHA-256",
    )
    if source_contract_digest(contract) != source_contract_sha256:
        fail("verified contract does not match its generation source projection")
    _generator_size, generator_file_sha256 = load_generator_snapshot(
        generator_sha256
    )
    (
        manifest,
        _manifest_size,
        manifest_file_sha256,
    ) = load_generation_manifest_snapshot(RELEASE_MANIFEST)
    if manifest_file_sha256 != manifest_sha256:
        fail("released voice generation manifest digest mismatch")
    validate_generation_manifest(
        contract,
        manifest,
        source_contract_sha256=source_contract_sha256,
        generator_sha256=generator_sha256,
        require_contract_artifacts=True,
        verify_staged_wavs=False,
    )
    verify_assets(contract)
    reconcile_bound_file_digest(
        CONTRACT_PATH,
        label="voice provenance contract",
        expected_sha256=contract_file_sha256,
    )
    reconcile_bound_file_digest(
        GENERATOR_PATH,
        label="voice provenance generator",
        expected_sha256=generator_file_sha256,
    )
    reconcile_bound_file_digest(
        RELEASE_MANIFEST,
        label="released voice generation manifest",
        expected_sha256=manifest_sha256,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pinned offline Monarch synthetic voice provenance tool"
    )
    parser.add_argument(
        "action",
        choices=(
            "verify-contract",
            "verify-model",
            "generate",
            "verify-staging",
            "verify-assets",
            "verify-release",
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        contract, contract_file_sha256 = load_contract()
        validate_contract(contract)
        source_contract_sha256 = source_contract_digest(contract)
        generator_bytes = read_bound_regular_file(
            GENERATOR_PATH,
            label="voice provenance generator",
            maximum_bytes=MAX_GENERATOR_BYTES,
        )
        generator_sha256 = hashlib.sha256(generator_bytes).hexdigest()
        if args.action == "verify-contract":
            print(
                json.dumps(
                    {
                        "ok": True,
                        "contractId": contract["contractId"],
                        "status": contract["status"],
                        "sourceProjectionSha256": source_contract_sha256,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            return 0
        if args.action == "verify-staging":
            verify_staging(
                contract,
                contract_file_sha256=contract_file_sha256,
                source_contract_sha256=source_contract_sha256,
                generator_sha256=generator_sha256,
            )
            print('{"ok":true,"staging":"verified"}')
            return 0
        if args.action == "verify-assets":
            verify_assets(contract)
            print('{"ok":true,"assets":"verified"}')
            return 0
        if args.action == "verify-release":
            verify_release(
                contract,
                contract_file_sha256=contract_file_sha256,
            )
            print('{"ok":true,"release":"verified"}')
            return 0
        model_root, model_files = verify_model()
        if args.action == "verify-model":
            print(
                json.dumps(
                    {
                        "ok": True,
                        "model": MODEL_REPOSITORY,
                        "revision": MODEL_REVISION,
                        "files": len(model_files),
                    },
                    separators=(",", ":"),
                )
            )
            return 0
        generate(
            contract,
            contract_file_sha256,
            model_root,
            model_files,
            source_contract_sha256,
            generator_sha256,
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "contractId": contract["contractId"],
                    "outputs": len(VOICE_SPECS),
                    "manifest": (
                        "artifacts/qa/voice-reference-provenance-v1/"
                        "generation-manifest.json"
                    ),
                },
                separators=(",", ":"),
            )
        )
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": " ".join(str(error).split())[:800]
                    or type(error).__name__,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
