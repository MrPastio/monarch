from __future__ import annotations

import importlib.util
from pathlib import Path


WORKER_PATH = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "modules"
    / "voice"
    / "workers"
    / "voice-lite-worker.py"
)


def load_worker_module():
    spec = importlib.util.spec_from_file_location("monarch_voice_lite_worker", WORKER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_streamed_cyrillic_mojibake_is_repaired_without_touching_normal_russian():
    worker = load_worker_module()

    assert worker.repair_streamed_utf8_mojibake("РїСЂРёРІРµС‚") == "привет"
    assert (
        worker.repair_streamed_utf8_mojibake(
            "РіРѕР»СѓР±РѕРµ — це розмір РЅРµР±Рѕ."
        )
        == "голубое — це розмір небо."
    )
    assert worker.repair_streamed_utf8_mojibake("Размер и скорость") == "Размер и скорость"


def test_spoken_sanitizer_repairs_encoding_and_removes_hidden_reasoning():
    worker = load_worker_module()

    assert worker.sanitize_spoken_text("<think>secret</think> РџСЂРёРІРµС‚!") == "Привет!"
