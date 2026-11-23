"""Built-in demo samples: a short clipping peak and a long flat top.

Both are synthetic voiced-speech-like audio with a bit of room noise so the
waveform is not a pure tone.  They are deterministic (fixed seed) so tests can
rely on the exact sample positions.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .wavio import save_wav

SAMPLE_RATE = 22050

# Bump whenever the demo synthesis changes so existing generated WAVs are
# replaced instead of silently keeping the old audio.
SAMPLE_VERSION = "2"


@dataclass(frozen=True)
class SampleSpec:
    key: str
    title: str
    filename: str
    description: str
    seconds: float


SAMPLES = (
    SampleSpec(
        key="short_peak",
        title="短峰削顶",
        filename="demo_short_peak.wav",
        description="左声道一处约 3 ms 的削顶尖峰，右声道干净；缺口短，可参考波形接续。",
        seconds=6.0,
    ),
    SampleSpec(
        key="long_flat",
        title="长平顶",
        filename="demo_long_flat.wav",
        description="左声道一处约 220 ms 的满幅平顶，信息缺失长，只应作连接推测。",
        seconds=7.0,
    ),
)


def _voiced_phrase(n: int, sr: int, rng: np.random.Generator) -> np.ndarray:
    """A crude voiced phrase: harmonics of a moving pitch under a formant envelope.

    Building it from harmonics (rather than driving resonators with a pulse
    train) keeps the pitch period clearly readable in the waveform, which is
    what makes the demo's short-gap repair meaningful.
    """
    t = np.arange(n) / float(sr)
    f0 = 118.0 + 14.0 * np.sin(2 * np.pi * 0.7 * t)
    out = np.zeros(n)
    max_harmonic = int(0.42 * sr / float(np.max(f0)))
    # Formant peaks (roughly /a/-like) as Gaussian bumps in log-frequency.
    formants = ((620.0, 0.28, 1.0), (1180.0, 0.30, 0.55), (2500.0, 0.32, 0.22))
    for k in range(1, max_harmonic + 1):
        hf = f0 * k
        amp = np.zeros(n)
        for fc, bw, gain in formants:
            amp += gain * np.exp(-0.5 * (np.log(np.maximum(hf, 1.0) / fc) / bw) ** 2)
        amp = amp / (k**1.15)
        phase = rng.uniform(0, 2 * np.pi)
        out += amp * np.sin(2 * np.pi * np.cumsum(hf) / sr + phase)
    out /= max(1e-9, np.max(np.abs(out)))
    # Rough syllable envelope: ~4.3 syllables per second with pauses.
    env = 0.35 + 0.65 * np.clip(np.sin(2 * np.pi * 2.15 * t) ** 2, 0, 1)
    env *= np.clip(0.5 + 0.5 * np.sin(2 * np.pi * 0.35 * t + 0.4), 0.15, 1.0)
    return out * env


def _add_clip_bump(
    x: np.ndarray, centre: int, sigma_ms: float, target_peak: float, polarity: int
) -> np.ndarray:
    """Add a smooth Gaussian bump that pushes one local extreme past full scale.

    Aiming at a local extreme means the surrounding waveform still slopes into
    the plateau, which is what a real short overload looks like.
    """
    window = int(0.03 * SAMPLE_RATE)
    seg = x[max(0, centre - window) : centre + window + 1]
    pick = np.argmax(seg) if polarity > 0 else np.argmin(seg)
    idx = max(0, centre - window) + int(pick)
    sigma = sigma_ms / 1000.0 * SAMPLE_RATE
    bump = target_peak * np.exp(-0.5 * ((np.arange(x.size) - idx) / sigma) ** 2)
    return x + (bump if polarity > 0 else -bump)


def _add_square_beep(
    x: np.ndarray, centre: int, seconds: float, freq: float
) -> np.ndarray:
    """Mix in a square tone whose plateaus sit exactly at full scale.

    This is content that is *supposed* to be flat, so it must be excluded
    rather than repaired.  The edges are gently sloped so the beep itself does
    not click, but the plateaus are hard-flat at +/-1.
    """
    n = int(seconds * SAMPLE_RATE)
    start = max(0, centre)
    end = min(x.size, start + n)
    t = np.arange(end - start) / float(SAMPLE_RATE)
    square = np.where(np.sin(2 * np.pi * freq * t) >= 0.0, 1.0, -1.0)
    # Smooth only the transition edges (~0.4 ms) using a short moving average.
    edge = max(3, int(0.0004 * SAMPLE_RATE) | 1)
    kernel = np.hanning(edge)
    kernel /= kernel.sum()
    square = np.convolve(square, kernel, mode="same")
    fade = int(0.004 * SAMPLE_RATE)
    if fade > 1 and square.size > 2 * fade:
        ramp = np.linspace(0.0, 1.0, fade)
        square[:fade] *= ramp
        square[-fade:] *= ramp[::-1]
    out = x.copy()
    # Crossfade into and out of the beep so it does not click, then hold the
    # plateaus hard-flat at full scale (this is deliberately *not* clipping).
    ramp = int(0.004 * SAMPLE_RATE)
    level = 1.0
    out[start:end] = level * square
    if ramp > 1 and end - start > 2 * ramp:
        fade = np.linspace(0.0, 1.0, ramp)
        out[start : start + ramp] = x[start : start + ramp] * (1 - fade) + level * square[:ramp] * fade
        out[end - ramp : end] = x[end - ramp : end] * fade + level * square[-ramp:] * (1 - fade)
    return out


def _build_channels(spec: SampleSpec) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(20240517 if spec.key == "short_peak" else 20240518)
    n = int(spec.seconds * SAMPLE_RATE)
    left = _voiced_phrase(n, SAMPLE_RATE, rng)
    right = _voiced_phrase(n, SAMPLE_RATE, rng)
    right = np.roll(right, 211) * 0.9  # slightly different, still speech-like

    # Tone-like ambience can make the repair visibly wrong; keep only light noise.
    left += rng.normal(0.0, 0.004, n)
    right += rng.normal(0.0, 0.004, n)

    # Normalize to a comfortable level before clipping.
    peak = max(np.max(np.abs(left)), np.max(np.abs(right)))
    left = left / peak * 0.82
    right = right / peak * 0.82

    if spec.key == "short_peak":
        # Add a smooth narrow bump so exactly one peak hits the ceiling and
        # leaves a short plateau (roughly 1 ms at this rate).
        left = _add_clip_bump(left, int(2.6 * SAMPLE_RATE), 1.5, 1.05, +1)
        left = _add_clip_bump(left, int(4.15 * SAMPLE_RATE), 1.2, 1.05, -1)
        # A deliberately square-like beep: naturally flat at full scale, not
        # clipping.  It gives the "exclude what is supposed to be flat" flow
        # something real to try (detector tags it with a hint).
        left = _add_square_beep(left, int(5.0 * SAMPLE_RATE), 0.12, 55.0)
    else:
        # Long sustained handling bump pushed well over full scale.  Its shape
        # is smooth on both sides, so most of the width becomes one flat top.
        start = int(3.0 * SAMPLE_RATE)
        length = int(0.22 * SAMPLE_RATE)
        t = np.linspace(-1.0, 1.0, length)
        bump = 9.0 * (0.5 + 0.5 * np.cos(np.pi * t))
        left[start : start + length] += bump
        # A small negative clip on the right channel so it is a separate event.
        right = _add_clip_bump(right, int(5.7 * SAMPLE_RATE), 1.3, 1.05, -1)

    left = np.clip(left, -1.0, 1.0)
    right = np.clip(right, -1.0, 1.0)
    return left, right


def ensure_samples(directory: str | Path) -> dict[str, Path]:
    """Write demo WAVs if missing or stale and return key -> path."""
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    marker = out / ".sample_version"
    stale = True
    if marker.exists():
        try:
            stale = marker.read_text(encoding="utf-8").strip() != SAMPLE_VERSION
        except OSError:
            stale = True
    for spec in SAMPLES:
        path = out / spec.filename
        if stale or not path.exists():
            left, right = _build_channels(spec)
            save_wav(path, np.stack([left, right], axis=1), SAMPLE_RATE, 16)
        paths[spec.key] = path
    if stale:
        marker.write_text(SAMPLE_VERSION + "\n", encoding="utf-8")
    return paths
