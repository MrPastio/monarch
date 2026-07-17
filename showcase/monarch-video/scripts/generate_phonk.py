from __future__ import annotations

import math
import random
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 44_100
FPS = 30
DURATION_FRAMES = 456
DURATION_SECONDS = DURATION_FRAMES / FPS
BPM = 150
BEAT_SECONDS = 60 / BPM
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "monarch-phonk-original.wav"


def add_tone(
    track: list[float],
    start: float,
    duration: float,
    frequency: float,
    gain: float,
    decay: float,
    overtone: float = 0.0,
) -> None:
    start_sample = int(start * SAMPLE_RATE)
    sample_count = int(duration * SAMPLE_RATE)
    phase = 0.0
    for offset in range(sample_count):
        index = start_sample + offset
        if index >= len(track):
            break
        t = offset / SAMPLE_RATE
        envelope = math.exp(-decay * t)
        phase += 2 * math.pi * frequency / SAMPLE_RATE
        signal = math.sin(phase)
        if overtone:
            signal += overtone * math.sin(phase * 1.49)
        track[index] += signal * envelope * gain


def add_kick(track: list[float], start: float, gain: float = 1.0) -> None:
    start_sample = int(start * SAMPLE_RATE)
    sample_count = int(0.32 * SAMPLE_RATE)
    phase = 0.0
    for offset in range(sample_count):
        index = start_sample + offset
        if index >= len(track):
            break
        t = offset / SAMPLE_RATE
        frequency = 42 + 115 * math.exp(-34 * t)
        phase += 2 * math.pi * frequency / SAMPLE_RATE
        click = math.sin(2 * math.pi * 1800 * t) * math.exp(-85 * t)
        body = math.sin(phase) * math.exp(-11 * t)
        track[index] += (body + click * 0.13) * gain


def add_noise_hit(
    track: list[float],
    rng: random.Random,
    start: float,
    duration: float,
    gain: float,
    decay: float,
    metallic: bool = False,
) -> None:
    start_sample = int(start * SAMPLE_RATE)
    sample_count = int(duration * SAMPLE_RATE)
    previous = 0.0
    for offset in range(sample_count):
        index = start_sample + offset
        if index >= len(track):
            break
        t = offset / SAMPLE_RATE
        white = rng.uniform(-1, 1)
        high = white - previous * 0.76
        previous = white
        signal = high
        if metallic:
            signal += math.sin(2 * math.pi * 7200 * t) * 0.22
        track[index] += signal * math.exp(-decay * t) * gain


def add_cowbell(track: list[float], start: float, frequency: float, gain: float) -> None:
    start_sample = int(start * SAMPLE_RATE)
    sample_count = int(0.19 * SAMPLE_RATE)
    for offset in range(sample_count):
        index = start_sample + offset
        if index >= len(track):
            break
        t = offset / SAMPLE_RATE
        envelope = math.exp(-18 * t)
        carrier = math.sin(2 * math.pi * frequency * t)
        upper = math.sin(2 * math.pi * frequency * 1.482 * t)
        track[index] += math.tanh((carrier + upper * 0.78) * 2.3) * envelope * gain


def add_impact(track: list[float], rng: random.Random, start: float) -> None:
    add_kick(track, start, 1.35)
    add_noise_hit(track, rng, start, 0.42, 0.35, 7.2, metallic=True)
    add_tone(track, start, 0.7, 31, 0.48, 4.8, overtone=0.16)


def build_track() -> None:
    rng = random.Random(0x4D4F4E41524348)
    track = [0.0] * int(DURATION_SECONDS * SAMPLE_RATE)
    bass_pattern = [55.0, 55.0, 49.0, 65.41, 43.65, 49.0, 55.0, 73.42]
    cowbell_pattern = [659.25, 523.25, 587.33, 493.88, 659.25, 783.99, 587.33, 523.25]
    beat_count = math.ceil(DURATION_SECONDS / BEAT_SECONDS)

    for beat in range(beat_count):
        start = beat * BEAT_SECONDS
        add_kick(track, start, 0.88 if beat % 4 else 1.08)
        add_tone(track, start, 0.36, bass_pattern[beat % len(bass_pattern)], 0.42, 6.2, 0.12)
        if beat % 4 in (1, 3):
            add_noise_hit(track, rng, start, 0.22, 0.3, 18, metallic=True)
            add_tone(track, start, 0.18, 188, 0.14, 21)
        if beat % 4 == 3:
            add_kick(track, start + BEAT_SECONDS * 0.72, 0.5)

        for subdivision in range(4):
            hat_start = start + subdivision * BEAT_SECONDS / 4
            gain = 0.09 if subdivision % 2 == 0 else 0.13
            add_noise_hit(track, rng, hat_start, 0.055, gain, 58, metallic=True)

        for subdivision in range(2):
            melody_index = (beat * 2 + subdivision) % len(cowbell_pattern)
            add_cowbell(
                track,
                start + subdivision * BEAT_SECONDS / 2,
                cowbell_pattern[melody_index],
                0.115 if subdivision else 0.16,
            )

    for frame in (0, 48, 96, 180, 276, 372):
        add_impact(track, rng, frame / FPS)

    fade_samples = int(0.18 * SAMPLE_RATE)
    for index, value in enumerate(track):
        fade_in = min(1.0, index / fade_samples)
        fade_out = min(1.0, (len(track) - 1 - index) / fade_samples)
        driven = math.tanh(value * 2.55) * 0.82
        track[index] = driven * fade_in * fade_out

    peak = max(abs(value) for value in track) or 1.0
    scale = 0.965 / peak
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUTPUT), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for value in track:
            frames.extend(struct.pack("<h", int(max(-1, min(1, value * scale)) * 32767)))
        wav.writeframes(frames)

    print(f"Generated {OUTPUT} ({DURATION_SECONDS:.1f}s, {BPM} BPM)")


if __name__ == "__main__":
    build_track()
