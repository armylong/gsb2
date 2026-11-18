"""Audio loading, slice boundaries, onset detection and rendering.

All sample positions are integer sample indices into the loaded source
array.  Slice ``i`` covers ``[boundaries[i], boundaries[i + 1])``; the
final slice ends at the source length, so slices never overlap and never
sample outside the material.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

try:  # scipy is used for the onset strength envelope; optional fallback below
    from scipy.signal import resample_poly
except Exception:  # pragma: no cover - only hit in stripped environments
    resample_poly = None


MAX_SECONDS = 8.0
MAX_SLICES = 16
STEPS = 16


class AudioLoadError(RuntimeError):
    pass


@dataclass
class SourceAudio:
    """Loaded mono/stereo material, kept at its native sample rate."""

    samples: np.ndarray  # shape (frames,) or (frames, channels), float32
    samplerate: int
    name: str = "source"

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return 1 if self.samples.ndim == 1 else int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.frames / float(self.samplerate)


def read_wav(path: str | Path) -> SourceAudio:
    """Read a wav via soundfile.  >8 s or multichannel (>2) is rejected."""
    import soundfile as sf

    path = Path(path)
    try:
        info = sf.info(str(path))
    except Exception as exc:  # pragma: no cover - soundfile raises many types
        raise AudioLoadError(f"无法读取音频文件: {exc}") from exc

    if info.frames / float(info.samplerate) > MAX_SECONDS + 1e-6:
        raise AudioLoadError(
            f"素材时长 {info.frames / info.samplerate:.2f}s 超过上限 {MAX_SECONDS:.0f}s"
        )
    if info.channels > 2:
        raise AudioLoadError(f"只支持单声道或立体声, 当前为 {info.channels} 声道")

    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    data = np.asarray(data, dtype=np.float32)
    if data.ndim == 2 and data.shape[1] == 1:
        data = data[:, 0]
    if data.ndim not in (1, 2):
        raise AudioLoadError("音频维度异常")
    return SourceAudio(samples=np.ascontiguousarray(data), samplerate=int(sr), name=path.stem)


def write_wav(path: str | Path, samples: np.ndarray, samplerate: int) -> None:
    import soundfile as sf

    data = np.asarray(samples, dtype=np.float32)
    if data.ndim == 2 and data.shape[1] == 1:
        data = data[:, 0]
    sf.write(str(path), data, int(samplerate), subtype="FLOAT")


# ---------------------------------------------------------------------------
# Onset detection
# ---------------------------------------------------------------------------

def onset_strength(mono: np.ndarray, samplerate: int) -> np.ndarray:
    """Spectral-flux-ish onset strength envelope (hop = 256 samples).

    A short-time spectral flux on a 1024-sample Hann frame is used; it is
    robust enough for percussion and keeps scipy/numpy the only hard
    dependencies.  Frame ``k`` covers samples ``[k*256, k*256+1024)``.
    """
    mono = np.asarray(mono, dtype=np.float64)
    if mono.ndim == 2:  # defence: accept stereo without collapsing downstream
        mono = mono.mean(axis=1)
    if mono.size == 0:
        return np.zeros(0)
    frame = 1024
    hop = 256
    if mono.size < frame:
        padded = np.pad(mono, (0, frame - mono.size))
    else:
        padded = mono
    n_frames = 1 + max(0, (padded.size - frame) // hop)
    window = np.hanning(frame)
    freqs = np.fft.rfftfreq(frame, d=1.0 / samplerate)
    band = (freqs >= 40.0) & (freqs <= 10000.0)
    env_out = np.empty(n_frames, dtype=np.float64)
    prev_spec = None
    for k in range(n_frames):
        chunk = padded[k * hop:k * hop + frame] * window
        spec = np.abs(np.fft.rfft(chunk))[band]
        if prev_spec is None:
            flux = 0.0
        else:
            flux = float(np.sum(np.maximum(spec - prev_spec, 0.0)))
        prev_spec = spec
        env_out[k] = flux
    peak = env_out.max()
    if peak > 0:
        env_out /= peak
    return env_out


def detect_onsets(samples: np.ndarray, samplerate: int, limit: int = MAX_SLICES - 1) -> list[int]:
    """Return suggested boundary sample positions (excluding 0 and the end).

    Detection is deliberately approximate: it only seeds the editor.  Peaks
    are found on the onset strength envelope and the position is corrected
    for the analysis frame's centre delay.  Returned positions are always
    strictly inside ``(0, frames)``.
    """
    mono = to_mono(samples)
    frames = int(samples.shape[0])
    if frames < 2 or limit <= 0:
        return []
    env = onset_strength(mono, samplerate)
    if env.size == 0 or env.max() <= 0:
        return []
    hop = 256
    frame = 1024
    min_gap = max(1, int(round(0.05 * samplerate / hop)))
    try:
        from scipy.signal import find_peaks

        peak_idx, _ = find_peaks(env, distance=min_gap, prominence=0.05, height=0.02)
    except Exception:  # pragma: no cover - scipy always present in practice
        peak_idx = np.array(
            [k for k in range(1, env.size - 1)
             if env[k] >= env[k - 1] and env[k] > env[k + 1] and env[k] >= 0.08]
        )
    positions = sorted({int(k) * hop + frame // 2 for k in peak_idx})
    positions = [p for p in positions if 0 < p < frames]
    if len(positions) > limit:
        # keep the strongest peaks, then restore time order
        strength = {p: float(env[min(env.size - 1, max(0, (p - frame // 2) // hop))])
                    for p in positions}
        positions = sorted(sorted(positions, key=strength.get, reverse=True)[:limit])
    return positions


def to_mono(samples: np.ndarray) -> np.ndarray:
    data = np.asarray(samples, dtype=np.float64)
    if data.ndim == 2:
        return data.mean(axis=1)
    return data


# ---------------------------------------------------------------------------
# Slice boundaries
# ---------------------------------------------------------------------------

class SliceModel:
    """Ordered cut points plus derived slices, shared by both channels."""

    def __init__(self, frames: int):
        self.frames = int(max(1, frames))
        self._cuts: list[int] = []

    @property
    def cuts(self) -> list[int]:
        """Interior cut points (excludes 0), sorted ascending."""
        return list(self._cuts)

    @property
    def boundaries(self) -> list[int]:
        return [0] + self._cuts + [self.frames]

    @property
    def count(self) -> int:
        return len(self._cuts) + 1

    def set_cuts(self, cuts) -> None:
        unique = sorted({int(c) for c in cuts if 0 < int(c) < self.frames})
        if len(unique) > MAX_SLICES - 1:
            raise ValueError(f"最多 {MAX_SLICES} 个切片, 切点不能超过 {MAX_SLICES - 1} 个")
        self._cuts = unique

    def add_cut(self, position: int) -> bool:
        position = int(position)
        if not (0 < position < self.frames):
            return False
        if position in self._cuts:
            return False
        if len(self._cuts) + 1 >= MAX_SLICES:
            return False
        self._cuts.append(position)
        self._cuts.sort()
        return True

    def move_cut(self, index: int, position: int) -> bool:
        if not (0 <= index < len(self._cuts)):
            return False
        position = int(position)
        if not (0 < position < self.frames):
            return False
        others = self._cuts[:index] + self._cuts[index + 1:]
        if position in others:
            return False
        self._cuts[index] = position
        self._cuts.sort()
        return True

    def remove_cut(self, index: int) -> bool:
        if 0 <= index < len(self._cuts):
            del self._cuts[index]
            return True
        return False

    def slice_bounds(self) -> list[tuple[int, int]]:
        b = self.boundaries
        return [(b[i], b[i + 1]) for i in range(len(b) - 1)]

    def slice_of_position(self, position: int) -> int | None:
        """Index of the slice whose audio contains ``position`` (cut at that sample)."""
        for i, (start, end) in enumerate(self.slice_bounds()):
            if start <= position < end:
                return i
        return None

    def clamp_move(self, index: int, position: int) -> int:
        """Clamp ``position`` between neighbours so order never flips."""
        lo = (self._cuts[index - 1] + 1) if index > 0 else 1
        hi = (self._cuts[index + 1] - 1) if index + 1 < len(self._cuts) else self.frames - 1
        return max(lo, min(hi, int(position)))


# ---------------------------------------------------------------------------
# Transport / rendering
# ---------------------------------------------------------------------------

@dataclass
class Sequence:
    """16-step pattern.  ``steps[i]`` is a slice index or None (empty)."""

    steps: list[int | None] = field(default_factory=lambda: [None] * STEPS)

    def __post_init__(self) -> None:
        if len(self.steps) != STEPS:
            raise ValueError("序列必须是 16 格")

    def set_step(self, i: int, value: int | None) -> None:
        if not (0 <= i < STEPS):
            raise IndexError(i)
        self.steps[i] = value

    def used_slices(self) -> set[int]:
        return {s for s in self.steps if s is not None}


def step_samples(bpm: float, samplerate: int, steps: int = STEPS) -> list[int]:
    """Exact integer sample offset of each 16th-note step.

    Computed from the cumulative grid position rather than by repeatedly
    adding a rounded step length, so drift stays under one sample over the
    whole sequence.
    """
    if bpm <= 0:
        raise ValueError("速度必须为正")
    sec_per_16th = 60.0 / float(bpm) / 4.0
    out = []
    for i in range(steps):
        out.append(int(round(i * sec_per_16th * samplerate)))
    return out


def sequence_length_samples(bpm: float, samplerate: int) -> int:
    sec_per_16th = 60.0 / float(bpm) / 4.0
    return int(round(STEPS * sec_per_16th * samplerate))


def peak_of(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.max(np.abs(samples)))


def fade_curve(length: int, mode: str) -> np.ndarray:
    """Linear fade; returns a multiplier array of ``length`` samples."""
    if length <= 0:
        return np.zeros(0, dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, length, dtype=np.float32)
    return ramp if mode == "in" else ramp[::-1].copy()


@dataclass
class RenderResult:
    audio: np.ndarray
    gain: float
    peak_before: float
    peak_after: float
    length: int
    step_offsets: list[int]


def render_sequence(
    source: SourceAudio,
    model: SliceModel,
    sequence: Sequence,
    bpm: float,
    fade_in_s: float = 0.005,
    fade_out_s: float = 0.005,
    *,
    apply_protection: bool = True,
    target_peak: float = 0.98,
) -> RenderResult:
    """Render the full 16-step sequence at source speed.

    * each slice plays at original rate; tails are never shortened to fit
      the next step and may overlap it additively;
    * anything past the end of the whole sequence is discarded;
    * fades apply per triggered slice only (last slice included);
    * if the mix clips past ``target_peak`` a single visible gain is applied
      to the whole output — the same rule is used by preview and export.
    """
    sr = source.samplerate
    offsets = step_samples(bpm, sr)
    total = sequence_length_samples(bpm, sr)
    channels = source.channels
    mix = np.zeros((total, channels), dtype=np.float64)

    bounds = model.slice_bounds()
    fin = int(round(max(0.0, float(fade_in_s)) * sr))
    fout = int(round(max(0.0, float(fade_out_s)) * sr))

    for i, slice_idx in enumerate(sequence.steps):
        if slice_idx is None:
            continue
        if not (0 <= slice_idx < len(bounds)):
            continue
        start, end = bounds[slice_idx]
        clip = np.asarray(source.samples[start:end], dtype=np.float64)
        if clip.size == 0:
            continue
        if clip.ndim == 1:
            clip = clip[:, None]
        clip = clip.copy()

        n = clip.shape[0]
        fi = min(fin, n)
        fo = min(fout, n)
        if fi > 0:
            clip[:fi] *= fade_curve(fi, "in")[:, None]
        if fo > 0:
            clip[n - fo:] *= fade_curve(fo, "out")[:, None]

        pos = offsets[i]
        end_pos = min(pos + n, total)
        take = max(0, end_pos - pos)
        if take == 0:
            continue
        mix[pos:end_pos] += clip[:take]

    peak_before = peak_of(mix)
    gain = 1.0
    if apply_protection and peak_before > target_peak > 0:
        gain = target_peak / peak_before
        mix *= gain
    peak_after = peak_of(mix)
    mix = np.clip(mix, -1.0, 1.0)

    audio = mix.astype(np.float32)
    if channels == 1:
        audio = audio[:, 0]
    return RenderResult(
        audio=audio,
        gain=gain,
        peak_before=peak_before,
        peak_after=peak_after,
        length=total,
        step_offsets=offsets,
    )
