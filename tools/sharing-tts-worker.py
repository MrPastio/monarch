#!/usr/bin/env python3
"""One-shot WAV synthesis worker for Monarch Sharing.

The worker deliberately accepts only model IDs and built-in voice controls. It
never accepts arbitrary model, reference-audio, or output paths from an HTTP
caller; the Oscar bridge owns the command line and response file lifecycle.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
import wave
from pathlib import Path
from typing import Any


PROTOCOL_STDOUT = sys.stdout
sys.stdout = sys.stderr

MAX_INPUT_CHARS = 3_000
MAX_INSTRUCTION_CHARS = 320
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
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolve_request(args: argparse.Namespace) -> tuple[Path, str, dict[str, str]]:
    payload = json.loads(sys.stdin.read() or "{}")
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    model_id = clean_text(payload.get("model"), field="model", maximum=120, required=True).lower()
    spec = MODEL_MODES.get(model_id)
    if spec is None:
        raise ValueError("unsupported TTS model")
    model_path = (args.model_root / spec[0]).resolve()
    if not is_inside(args.model_root, model_path) or not (model_path / "config.json").is_file():
        raise FileNotFoundError("selected local TTS model is unavailable")

    output_dir = args.output_dir.resolve()
    output = args.output.resolve()
    if not is_inside(output_dir, output) or output.suffix.lower() != ".wav":
        raise ValueError("output path is outside the trusted WAV directory")
    output_dir.mkdir(parents=True, exist_ok=True)

    request = {
        "model": model_id,
        "mode": spec[1],
        "text": clean_text(payload.get("input"), field="input", maximum=MAX_INPUT_CHARS, required=True),
        "voice": clean_text(payload.get("voice"), field="voice", maximum=160),
        "language": qwen_language(clean_text(payload.get("language"), field="language", maximum=32) or "ru-RU"),
        "instructions": clean_text(payload.get("instructions"), field="instructions", maximum=MAX_INSTRUCTION_CHARS),
    }
    return output, spec[1], request


def write_wav(path: Path, samples: Any, sample_rate: int) -> None:
    import numpy as np

    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not values.size:
        raise RuntimeError("Qwen TTS produced no audio")
    encoded = (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(int(sample_rate))
        stream.writeframes(encoded)


def synthesize(args: argparse.Namespace) -> dict[str, Any]:
    output, mode, request = resolve_request(args)
    import numpy as np
    import torch
    from faster_qwen3_tts import FasterQwen3TTS

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable for local Qwen TTS")
    torch.set_grad_enabled(False)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    model_dir = args.model_root / MODEL_MODES[request["model"]][0]
    model = FasterQwen3TTS.from_pretrained(
        str(model_dir),
        device="cuda",
        dtype="bfloat16",
        attn_implementation="sdpa",
        max_seq_len=1024,
        local_files_only=True,
    )
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
        voice_id = (request["voice"] or "oscar").lower()
        references = {
            "oscar": args.workspace_root / "assets" / "voice" / "oscar-reference.wav",
            "oscar-clear": args.workspace_root / "assets" / "voice" / "oscar-clear-reference.wav",
            "aurora": args.workspace_root / "assets" / "voice" / "aurora-reference.wav",
        }
        reference = references.get(voice_id)
        if reference is None or not reference.is_file():
            raise ValueError("base TTS accepts only installed voices: oscar, oscar-clear, aurora")
        generator = model.generate_voice_clone_streaming(
            **common,
            ref_audio=reference,
            ref_text="Привет. Меня зовут Оскар. Я говорю спокойно, уверенно и по делу.",
            append_silence=True,
            instruct=request["instructions"] or None,
        )
    elif mode == "custom":
        speaker = (request["voice"] or "ryan").lower()
        if speaker not in SUPPORTED_SPEAKERS:
            raise ValueError("custom TTS voice must be one of the installed Qwen speakers")
        canonical_speaker = SUPPORTED_SPEAKERS[speaker]
        generator = model.generate_custom_voice_streaming(
            **common,
            speaker=canonical_speaker,
            instruct=request["instructions"] or None,
        )
    else:
        instruction = request["instructions"] or request["voice"]
        if not instruction:
            raise ValueError("voice-design TTS requires instructions describing the desired voice")
        generator = model.generate_voice_design_streaming(**common, instruct=instruction)

    chunks: list[Any] = []
    sample_rate = 0
    for chunk, current_sample_rate, _timing in generator:
        chunks.append(np.asarray(chunk, dtype=np.float32).reshape(-1))
        sample_rate = int(current_sample_rate)
    if sample_rate <= 0:
        raise RuntimeError("Qwen TTS returned no valid sample rate")
    write_wav(output, np.concatenate(chunks) if chunks else np.zeros((0,), dtype=np.float32), sample_rate)
    return {"ok": True, "model": request["model"], "sample_rate": sample_rate}


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
