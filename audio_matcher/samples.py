"""Synthetic interview clips for demos and the headless verification run.

The samples are generated, not bundled.  Four speakers with clearly different
levels and crest factors, deliberate leading/trailing room silence, breath
pauses, and on one clip a loud hand clap that makes a peak ceiling actually
bite.  Generation is deterministic for a given seed, so tests can assert on
measured numbers.

The demo selections mirror what an editor would mark:

* every speaker gets three speech regions;
* the clap in the peak-limited clip is inside an explicit exclusion region, so
  it still affects the clip peak (and therefore the ceiling) but not the
  loudness estimate.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 48000


@dataclass(frozen=True)
class SampleSpec:
    name: str
    duration_s: float
    speech_rms_dbfs: float
    speech_crest_db: float
    phrases: tuple[tuple[float, float], ...]
    pause_amplitude_dbfs: float = -60.0
    click_at_s: float | None = None
    click_dbfs: float = -1.0


SAMPLES: tuple[SampleSpec, ...] = (
    SampleSpec(
        name="speaker_a_reference.wav",
        duration_s=7.8,
        speech_rms_dbfs=-18.0,
        speech_crest_db=10.0,
        phrases=((0.80, 2.40), (3.00, 4.60), (5.20, 6.80)),
        pause_amplitude_dbfs=-61.0,
    ),
    SampleSpec(
        name="speaker_b_quiet.wav",
        duration_s=7.8,
        speech_rms_dbfs=-28.0,
        speech_crest_db=9.0,
        phrases=((0.90, 2.10), (2.80, 4.40), (5.10, 6.90)),
        pause_amplitude_dbfs=-64.0,
    ),
    SampleSpec(
        name="speaker_c_peak_clap.wav",
        duration_s=7.8,
        speech_rms_dbfs=-26.0,
        speech_crest_db=9.0,
        phrases=((0.70, 2.30), (3.10, 4.50), (5.00, 6.70)),
        pause_amplitude_dbfs=-64.0,
        click_at_s=3.62,
        click_dbfs=-1.0,
    ),
    SampleSpec(
        name="speaker_d_loud.wav",
        duration_s=7.8,
        speech_rms_dbfs=-11.0,
        speech_crest_db=11.0,
        phrases=((0.75, 2.35), (2.95, 4.55), (5.15, 6.75)),
        pause_amplitude_dbfs=-60.0,
    ),
    SampleSpec(
        name="speaker_e_peak_knock.wav",
        duration_s=7.8,
        speech_rms_dbfs=-24.0,
        speech_crest_db=9.0,
        phrases=((0.85, 2.25), (2.95, 4.45), (5.05, 6.65)),
        pause_amplitude_dbfs=-64.0,
        # A table knock inside the pause, outside every speech region.  Under
        # "lower the whole gain" this clips the achievable level the same way
        # a real knock does: the quiet speech cannot be raised to the target
        # without the knock crossing the ceiling.
        click_at_s=4.70,
        click_dbfs=-2.0,
    ),
)


# What an editor marks on first load.  Second phrase interiors avoid the
# 10 ms fades at each phrase edge.
DEMO_SPEECH: dict[str, tuple[tuple[float, float], ...]] = {
    spec.name: tuple((start + 0.05, end - 0.05) for start, end in spec.phrases)
    for spec in SAMPLES
}
DEMO_EXCLUDE: dict[str, tuple[tuple[float, float], ...]] = {
    "speaker_c_peak_clap.wav": ((3.55, 3.72),),
}


class _Rng:
    """Tiny xorshift so generated material is stable across numpy versions."""

    def __init__(self, seed: int) -> None:
        self._state = np.uint64(seed or 1)

    def normal(self, count: int) -> np.ndarray:
        """Box-Muller from a deterministic integer stream.

        The 64-bit xorshift is unrolled in Python (measured at ~1.5 ms per
        100k samples) and then vectorized into a uniform pair per output
        sample, so the material is identical on every machine and numpy
        version.
        """
        state = self._state
        total = 2 * count + 1
        words = np.empty(total, dtype=np.uint64)
        value = state
        mask = np.uint64(0xFFFFFFFFFFFFFFFF)
        for index in range(total):
            value ^= (value << np.uint64(13)) & mask
            value ^= value >> np.uint64(7)
            value ^= (value << np.uint64(17)) & mask
            words[index] = value
        self._state = value
        uniforms = (words & np.uint64(0xFFFFFFFF)).astype(np.float64) / float(0xFFFFFFFF)
        u1 = np.maximum(uniforms[:count], 1e-12)
        u2 = uniforms[count : 2 * count]
        return np.sqrt(-2.0 * np.log(u1)) * np.cos(2.0 * np.pi * u2)


def _db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def _speech_shape(count: int, rate: int, rng: _Rng) -> np.ndarray:
    """Wobbling amplitude with syllable-rate movement: speech, not a sine."""
    t = np.arange(count, dtype=np.float64) / rate
    slow = 1.0 + 0.24 * np.sin(2.0 * np.pi * 1.7 * t + 0.4) + 0.12 * np.sin(
        2.0 * np.pi * 0.41 * t
    )
    syllable = 0.55 + 0.45 * np.abs(np.sin(2.0 * np.pi * 4.3 * t + 0.9))
    grain = np.abs(rng.normal(count)) * 0.18 + 0.82
    shape = (0.6 * rng.normal(count) + 0.4 * np.sin(2.0 * np.pi * 173.0 * t)) * slow
    shape *= syllable * grain
    return shape


def _fit_crest(shape: np.ndarray, crest_db: float) -> np.ndarray:
    """Normalize RMS to 1 and softly clip so peak/RMS matches ``crest_db``."""
    ratio = _db_to_amp(crest_db)
    signal = np.asarray(shape, dtype=np.float64).copy()
    rms = float(np.sqrt(np.mean(np.square(signal))))
    if rms <= 0:
        return signal
    signal /= rms
    for _ in range(24):
        peak = float(np.max(np.abs(signal)))
        if peak <= ratio * 1.001:
            break
        # tanh is smooth, so the crest estimate converges without clicks.
        drive = 1.6
        signal = np.tanh(signal * (drive / ratio)) * (ratio / np.tanh(drive))
        rms = float(np.sqrt(np.mean(np.square(signal))))
        if rms <= 0:
            break
        signal /= rms
    return signal


def _make_phrase(count: int, rate: int, spec: SampleSpec, rng: _Rng) -> np.ndarray:
    shape = _speech_shape(count, rate, rng)
    signal = _fit_crest(shape, spec.speech_crest_db)
    # _fit_crest leaves RMS 1, so this sets the active-speech level directly.
    signal *= _db_to_amp(spec.speech_rms_dbfs)
    fade = max(1, int(0.010 * rate))
    if signal.size > 2 * fade:
        ramp = np.linspace(0.0, 1.0, fade)
        signal[:fade] *= ramp
        signal[-fade:] *= ramp[::-1]
    return signal


def build_sample(spec: SampleSpec, seed: int = 7) -> np.ndarray:
    rate = SAMPLE_RATE
    count = int(round(spec.duration_s * rate))
    rng = _Rng(seed + sum(ord(c) for c in spec.name))
    out = rng.normal(count) * _db_to_amp(spec.pause_amplitude_dbfs)
    for start_s, end_s in spec.phrases:
        start = int(round(start_s * rate))
        end = min(count, int(round(end_s * rate)))
        if end <= start:
            continue
        out[start:end] += _make_phrase(end - start, rate, spec, rng)
    if spec.click_at_s is not None:
        at = int(round(spec.click_at_s * rate))
        click_len = max(1, int(0.008 * rate))
        click = rng.normal(click_len) * _db_to_amp(spec.click_dbfs)
        click *= np.exp(-np.arange(click_len) / (0.0014 * rate))
        out[at : at + click.size] += click
    # Keep the file itself below full scale; the clap is allowed to sit at
    # -1 dBFS but overlapping speech must not push the source into clipping.
    peak = float(np.max(np.abs(out)))
    if peak > 0.999:
        out *= 0.999 / peak
    return out


def write_samples(directory: str | Path, seed: int = 7) -> list[Path]:
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for spec in SAMPLES:
        data = build_sample(spec, seed=seed)
        path = target / spec.name
        sf.write(str(path), data, SAMPLE_RATE, subtype="PCM_24")
        paths.append(path)
    return paths


def sample_spec(name: str) -> SampleSpec | None:
    for spec in SAMPLES:
        if spec.name == name:
            return spec
    return None


def demo_regions(name: str) -> tuple[tuple[float, float], ...]:
    return DEMO_SPEECH.get(name, ())


def demo_exclusions(name: str) -> tuple[tuple[float, float], ...]:
    return DEMO_EXCLUDE.get(name, ())
