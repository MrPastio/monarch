from __future__ import annotations

import importlib.util
import math
import unittest
from pathlib import Path

import numpy
import torch
import torchaudio


WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "monarch_local_neural_tts", WORKSPACE_ROOT / "tools" / "local-neural-tts.py"
)
assert SPEC and SPEC.loader
TTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TTS)


class LocalNeuralTtsTests(unittest.TestCase):
    def test_dsp_changes_duration_and_pitch_without_unbounded_resampling(self) -> None:
        sample_rate = 24_000
        signal = (0.2 * numpy.sin(
            2 * math.pi * 220 * numpy.arange(sample_rate) / sample_rate
        )).astype(numpy.float32)

        slow = TTS.apply_audio_dsp(
            signal, sample_rate, {"speed": 80, "pitch": 0},
            torch, torchaudio, numpy,
        )
        fast = TTS.apply_audio_dsp(
            signal, sample_rate, {"speed": 120, "pitch": 0},
            torch, torchaudio, numpy,
        )
        low = TTS.apply_audio_dsp(
            signal, sample_rate, {"speed": 100, "pitch": -2},
            torch, torchaudio, numpy,
        )
        high = TTS.apply_audio_dsp(
            signal, sample_rate, {"speed": 100, "pitch": 2},
            torch, torchaudio, numpy,
        )

        self.assertAlmostEqual(len(slow) / sample_rate, 1.25, places=3)
        self.assertAlmostEqual(len(fast) / sample_rate, 1 / 1.2, places=3)
        self.assertEqual(len(low), sample_rate)
        self.assertEqual(len(high), sample_rate)
        self.assertTrue(numpy.isfinite(low).all())
        self.assertTrue(numpy.isfinite(high).all())
        self.assertLess(self._frequency(low, sample_rate), 205)
        self.assertGreater(self._frequency(high, sample_rate), 235)

    def test_qwen_base_receives_plain_russian_orthography(self) -> None:
        source = "Старинный за́мок, дверной замоˊк, з+амок и C++."
        self.assertEqual(
            TTS.prepare_qwen_speech_text(source),
            "Старинный замок, дверной замок, замок и C++.",
        )
        self.assertFalse(hasattr(TTS.NeuralSpeechEngine(), "accentor"))

    @staticmethod
    def _frequency(signal: numpy.ndarray, sample_rate: int) -> float:
        crossings = numpy.where(numpy.diff(numpy.signbit(signal)))[0]
        return len(crossings) / 2 / (len(signal) / sample_rate)


if __name__ == "__main__":
    unittest.main()
