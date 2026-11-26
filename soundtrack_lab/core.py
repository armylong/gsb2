from __future__ import annotations

import io
import json
import math
import struct
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np

# ---------------------------------------------------------------------------
# Classroom calibration
# ---------------------------------------------------------------------------
# The image has one analytical row for each ROW_RATE time slices.  The physical
# pitch is intentionally a round classroom value; it is stored in exported PNG
# metadata so a reopened file still explains its own calibration.
ROW_RATE = 8000
AUDIO_RATE = 22050
ROW_PITCH_MM = 0.05
FILM_SPEED_MM_S = ROW_RATE * ROW_PITCH_MM  # 400 mm/s in this teaching model
DEFAULT_CAL_MM = 10.0

TRACK_WIDTH_PX = 420
CENTER_X = 210.0
TRACK_LEFT = 28
TRACK_RIGHT = 392
BASE_HALF_PX = 72.0
MOD_PX = 50.0
BASE_WIDTH_PX = 2.0 * BASE_HALF_PX
PX_PER_UNIT = 2.0 * MOD_PX
EDGE_GATE_RADIUS = MOD_PX + 22.0

DARK_GRAY = 28
PAPER_GRAY = 218
LIGHT_GRAY = 248

META_KEY = "soundtrack_lab_json"
META_VERSION = 1


@dataclass
class Segment:
    name: str
    label: str
    start: float
    end: float
    kind: str = "tone"
    frequency: float | None = None

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "start": self.start,
            "end": self.end,
            "kind": self.kind,
            "frequency": self.frequency,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Segment":
        return cls(
            name=str(d["name"]),
            label=str(d.get("label", d["name"])),
            start=float(d["start"]),
            end=float(d["end"]),
            kind=str(d.get("kind", "tone")),
            frequency=d.get("frequency"),
        )


@dataclass
class EncodedTrack:
    samples_row: np.ndarray
    left: np.ndarray
    right: np.ndarray
    segments: list[Segment]
    meta: dict
    gray: np.ndarray | None = None

    @property
    def n_rows(self) -> int:
        return len(self.samples_row)

    @property
    def duration(self) -> float:
        return self.n_rows / ROW_RATE


@dataclass
class ReadParams:
    window_rows: int = 1
    offset_px: float = 0.0
    exposure_ev: float = 0.0
    dc_remove: bool = True

    def clamped(self) -> "ReadParams":
        return ReadParams(
            window_rows=max(1, int(round(self.window_rows))),
            offset_px=float(np.clip(self.offset_px, -90, 90)),
            exposure_ev=float(np.clip(self.exposure_ev, -1.5, 1.5)),
            dc_remove=bool(self.dc_remove),
        )


@dataclass
class DefectInterval:
    kind: str
    start_row: int
    end_row: int
    uncertain_start_row: int | None = None
    uncertain_end_row: int | None = None
    status: str = "marked"  # marked | review
    reason: str = ""

    @property
    def core_start_row(self) -> int:
        return self.start_row

    @property
    def core_end_row(self) -> int:
        return self.end_row

    @property
    def review_start_row(self) -> int:
        return self.uncertain_start_row if self.uncertain_start_row is not None else self.start_row

    @property
    def review_end_row(self) -> int:
        return self.uncertain_end_row if self.uncertain_end_row is not None else self.end_row

    @property
    def start_time(self) -> float:
        return self.review_start_row / ROW_RATE

    @property
    def end_time(self) -> float:
        return self.review_end_row / ROW_RATE

    @property
    def duration(self) -> float:
        return max(0, self.review_end_row - self.review_start_row) / ROW_RATE

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "start_row": int(self.start_row),
            "end_row": int(self.end_row),
            "uncertain_start_row": self.uncertain_start_row,
            "uncertain_end_row": self.uncertain_end_row,
            "status": self.status,
            "reason": self.reason,
        }


@dataclass
class DecodeResult:
    raw_width: np.ndarray
    smooth_width: np.ndarray
    samples_row: np.ndarray
    samples_audio: np.ndarray
    left_x: np.ndarray
    right_x: np.ndarray
    confidence: np.ndarray
    line_width_left: np.ndarray
    line_width_right: np.ndarray
    dc_offset: float
    params: ReadParams
    meta: dict
    defects: list[DefectInterval] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return len(self.samples_row) / ROW_RATE


# ---------------------------------------------------------------------------
# Time / calibration helpers
# ---------------------------------------------------------------------------

def calibration_rows(distance_mm: float) -> int:
    return int(round(distance_mm / ROW_PITCH_MM))


def calibration_seconds(distance_mm: float) -> float:
    return distance_mm / FILM_SPEED_MM_S


def window_description(window_rows: int) -> str:
    mm = window_rows * ROW_PITCH_MM
    ms = window_rows / ROW_RATE * 1000.0
    return f"{window_rows} 行 · {mm:.2f} mm · {ms:.3f} ms"


def calibration_summary(distance_mm: float = DEFAULT_CAL_MM) -> str:
    rows = calibration_rows(distance_mm)
    ms = calibration_seconds(distance_mm) * 1000.0
    return (
        f"课堂标定：行间距 {ROW_PITCH_MM:.3f} mm，"
        f"走片速度 {FILM_SPEED_MM_S:.1f} mm/s。"
        f"{distance_mm:g} mm 对应 {rows} 行、{ms:.2f} ms。"
    )


def time_to_row(t: float) -> int:
    return int(np.clip(round(t * ROW_RATE), 0, 10**12))


def row_to_time(row: int) -> float:
    return row / ROW_RATE


# ---------------------------------------------------------------------------
# Audio IO and deterministic classroom material
# ---------------------------------------------------------------------------

def resample_linear(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return x.copy()
    if sr_in == sr_out:
        return x.astype(np.float32, copy=False)
    n_out = max(1, int(round(len(x) * sr_out / sr_in)))
    pos_in = np.arange(n_out, dtype=np.float64) * (sr_in / sr_out)
    i0 = np.floor(pos_in).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    frac = pos_in - i0
    y = x[i0] * (1.0 - frac) + x[i1] * frac
    return y.astype(np.float32)


def _fade(n: int, fade_samples: int) -> np.ndarray:
    f = np.ones(n, dtype=np.float64)
    k = min(fade_samples, n // 2)
    if k > 0:
        f[:k] = np.linspace(0.0, 1.0, k)
        f[-k:] = np.linspace(1.0, 0.0, k)
    return f


def build_demo(duration: float = 3.2) -> tuple[np.ndarray, list[Segment]]:
    """Fixed low/high tones, silence floor and short pulses."""
    n = int(round(duration * AUDIO_RATE))
    t = np.arange(n, dtype=np.float64) / AUDIO_RATE
    rng = np.random.default_rng(17552)

    # A small deterministic optical/playback floor makes averaging of a wide
    # slit visible in the silence metric.
    x = 0.008 * rng.standard_normal(n)

    segments = [
        Segment("lead", "起始静音底", 0.00, 0.25, "silence"),
        Segment("low440", "低频 440 Hz", 0.25, 1.05, "tone", 440.0),
        Segment("silence", "中段静音底", 1.05, 1.55, "silence"),
        Segment("high1320", "高频 1320 Hz", 1.55, 2.35, "tone", 1320.0),
        Segment("pulses", "三个短脉冲", 2.48, 2.96, "pulse"),
        Segment("tail", "尾部静音底", 2.96, 3.20, "silence"),
    ]

    def add_tone(seg: Segment, amplitude: float) -> None:
        a, b = time_to_sample(seg.start), time_to_sample(seg.end)
        tt = np.arange(b - a) / AUDIO_RATE
        tone = amplitude * np.sin(2.0 * np.pi * (seg.frequency or 440.0) * tt)
        tone *= _fade(len(tone), int(0.012 * AUDIO_RATE))
        x[a:b] += tone

    for seg in segments:
        if seg.kind == "tone":
            add_tone(seg, 0.42 if seg.frequency and seg.frequency < 800 else 0.34)

    # Three short positive control impulses.  A unipolar Hann pulse makes the
    # broadening/peak reduction from a wide averaging window easy to see.
    pulse_len = int(0.0028 * AUDIO_RATE)
    for pt in (2.55, 2.72, 2.89):
        c = time_to_sample(pt)
        a = c - pulse_len // 2
        b = a + pulse_len
        if a < 0 or b > n:
            continue
        pulse = 0.88 * np.hanning(pulse_len) ** 0.55
        x[a:b] += pulse

    peak = float(np.max(np.abs(x))) if n else 0.0
    if peak > 0.98:
        x *= 0.98 / peak
    return x.astype(np.float32), segments


def time_to_sample(t: float) -> int:
    return int(round(t * AUDIO_RATE))


def load_wav(path: str | Path | bytes | bytearray) -> tuple[np.ndarray, int]:
    """Read mono PCM WAV from a path or WAV bytes."""
    if isinstance(path, (bytes, bytearray)):
        file_bytes = bytes(path)
    else:
        file_bytes = Path(path).read_bytes()

    audio_format = 1  # PCM
    if len(file_bytes) >= 22 and file_bytes[:4] == b"RIFF":
        audio_format = struct.unpack_from("<H", file_bytes, 20)[0]
        if audio_format == 0xFFFE and len(file_bytes) >= 46:
            audio_format = struct.unpack_from("<H", file_bytes, 44)[0]

    with wave.open(io.BytesIO(file_bytes), "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        sr = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if width == 1:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        data = (data - 128.0) / 128.0
    elif width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4 and audio_format == 3:
        data = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    elif width == 8 and audio_format == 3:
        data = np.frombuffer(raw, dtype="<f8").astype(np.float32)
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        value = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        value = np.where(value & 0x800000, value - 0x1000000, value)
        data = value.astype(np.float32) / 8388608.0
    else:
        raise ValueError(f"暂不支持的 WAV 位宽：{width * 8} bit")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)

    duration = len(data) / max(1, sr)
    if duration > 15.0:
        raise ValueError("为保证课堂演示流畅，请使用 15 秒以内的短 WAV。")

    y = resample_linear(data, sr, AUDIO_RATE)
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak > 1e-6:
        y = 0.9 * y / peak
    return y.astype(np.float32), AUDIO_RATE


def wav_bytes(samples: np.ndarray, rate: int = AUDIO_RATE) -> bytes:
    y = np.asarray(samples, dtype=np.float64)
    y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    y = np.clip(y, -1.0, 1.0)
    pcm = np.round(y * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def write_wav(path: str | Path, samples: np.ndarray, rate: int = AUDIO_RATE) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav_bytes(samples, rate))


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------

def audio_to_rows(audio: np.ndarray, sr: int = AUDIO_RATE, n_rows: int | None = None) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    if n_rows is None:
        n_rows = max(1, int(round(len(audio) / sr * ROW_RATE)))
    if len(audio) == 0:
        return np.zeros(n_rows, dtype=np.float32)
    positions = (np.arange(n_rows, dtype=np.float64) + 0.5) / ROW_RATE * sr
    i0 = np.floor(positions).astype(np.int64)
    i0 = np.clip(i0, 0, len(audio) - 1)
    i1 = np.clip(i0 + 1, 0, len(audio) - 1)
    frac = positions - i0
    return (audio[i0] * (1.0 - frac) + audio[i1] * frac).astype(np.float32)


def make_meta(n_rows: int, segments: list[Segment]) -> dict:
    return {
        "app": "soundtrack-lab",
        "version": META_VERSION,
        "row_rate": ROW_RATE,
        "audio_rate": AUDIO_RATE,
        "row_pitch_mm": ROW_PITCH_MM,
        "film_speed_mm_s": FILM_SPEED_MM_S,
        "width_px": TRACK_WIDTH_PX,
        "center_x": CENTER_X,
        "track_left": TRACK_LEFT,
        "track_right": TRACK_RIGHT,
        "base_half_px": BASE_HALF_PX,
        "mod_px": MOD_PX,
        "base_width_px": BASE_WIDTH_PX,
        "px_per_unit": PX_PER_UNIT,
        "edge_gate_radius": EDGE_GATE_RADIUS,
        "n_rows": int(n_rows),
        "segments": [s.to_dict() for s in segments],
    }


def encode_samples(
    audio: np.ndarray,
    segments: list[Segment] | None = None,
    sr: int = AUDIO_RATE,
) -> EncodedTrack:
    duration = len(audio) / max(1, sr)
    n_rows = max(1, int(round(duration * ROW_RATE)))
    rows = audio_to_rows(audio, sr, n_rows)
    u = np.clip(rows, -0.98, 0.98)
    half = BASE_HALF_PX + MOD_PX * u
    left = CENTER_X - half
    right = CENTER_X + half
    segs = list(segments or [])
    meta = make_meta(n_rows, segs)
    track = EncodedTrack(
        samples_row=rows,
        left=left.astype(np.float32),
        right=right.astype(np.float32),
        segments=segs,
        meta=meta,
    )
    track.gray = render_gray(track.left, track.right)
    return track


def _paint_dark_line(img: np.ndarray, x: np.ndarray, sigma: float = 1.25) -> np.ndarray:
    h, w = img.shape
    offsets = np.arange(-3, 4)
    xx = np.clip(np.round(x).astype(int), 3, w - 4)[:, None] + offsets[None, :]
    dist = (xx.astype(np.float32) + 0.5 - x[:, None]) / sigma
    darkness = 205.0 * np.exp(-0.5 * dist * dist)
    rows = np.arange(h)[:, None]
    old = img[rows, xx]
    img[rows, xx] = np.minimum(old, PAPER_GRAY - darkness).astype(np.uint8)
    return img


def render_gray(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    """Render a light variable-width band bounded by two dark lines."""
    n = len(left)
    img = np.full((n, TRACK_WIDTH_PX), 214, dtype=np.uint8)
    img[:, :TRACK_LEFT] = 204
    img[:, TRACK_RIGHT:] = 204

    # Light area between the two edges.
    li = np.clip(np.floor(left).astype(int), 0, TRACK_WIDTH_PX - 1)
    ri = np.clip(np.ceil(right).astype(int), 0, TRACK_WIDTH_PX)
    for y in range(n):
        a, b = int(li[y]), int(ri[y])
        if b > a:
            img[y, a:b] = LIGHT_GRAY

    # Soft antialiased dark edge lines.
    img = _paint_dark_line(img, left)
    img = _paint_dark_line(img, right)

    # A faint central alignment guide (not used by the decoder).
    img[:, int(round(CENTER_X))] = np.minimum(img[:, int(round(CENTER_X))], 190)
    return img


# ---------------------------------------------------------------------------
# Deterministic defects
# ---------------------------------------------------------------------------

def demo_defect_plan(kind: str) -> list[DefectInterval]:
    if kind == "dirty":
        return [
            DefectInterval(
                "dirty",
                time_to_row(2.55),
                time_to_row(2.73),
                uncertain_start_row=time_to_row(2.525),
                uncertain_end_row=time_to_row(2.755),
                status="review",
                reason="散布脏点边界较虚，自动检测只能给出待查外延",
            )
        ]
    if kind == "break":
        return [
            DefectInterval(
                "break",
                time_to_row(1.82),
                time_to_row(1.885),
                uncertain_start_row=time_to_row(1.812),
                uncertain_end_row=time_to_row(1.894),
                status="review",
                reason="短断线两端有羽化，精确起止行需人工复核",
            )
        ]
    if kind in {"both", "dirty_break"}:
        return demo_defect_plan("dirty") + demo_defect_plan("break")
    return []


def add_defects(gray: np.ndarray, kind: str, seed: int = 17552) -> tuple[np.ndarray, list[DefectInterval]]:
    out = np.array(gray, copy=True)
    h, w = out.shape
    rng = np.random.default_rng(seed + hash(kind) % 10000)
    plan = demo_defect_plan(kind)

    for item in plan:
        y0, y1 = item.review_start_row, item.review_end_row
        y0 = max(0, y0)
        y1 = min(h, y1)
        if item.kind == "break":
            # Erase both dark lines and smear a paper-colored gap.  Feathered
            # top/bottom boundaries deliberately make the exact edge uncertain.
            core0, core1 = item.start_row, item.end_row
            for y in range(y0, y1):
                edge_fade = min(1.0, (y - y0) / 10.0, (y1 - 1 - y) / 10.0)
                if core0 <= y < core1:
                    alpha = 1.0
                else:
                    alpha = max(0.0, edge_fade)
                if alpha <= 0:
                    continue
                smear = np.full(w, 226, dtype=np.float32)
                out[y] = (out[y].astype(np.float32) * (1 - alpha) + smear * alpha).astype(np.uint8)
                if alpha > 0.45:
                    # A faint horizontal scratch across the track.
                    out[y, TRACK_LEFT:TRACK_RIGHT] = np.minimum(
                        out[y, TRACK_LEFT:TRACK_RIGHT], 178 + int(30 * (1 - alpha))
                    )
        else:
            # Dark dust blobs and a few light scratches around the pulse area.
            for _ in range(26):
                cy = int(rng.integers(y0 + 4, max(y0 + 5, y1 - 4)))
                cx = int(rng.integers(int(CENTER_X - 125), int(CENTER_X + 126)))
                ry = int(rng.integers(2, 9))
                rx = int(rng.integers(2, 11))
                yy0, yy1 = max(0, cy - ry), min(h, cy + ry + 1)
                xx0, xx1 = max(0, cx - rx), min(w, cx + rx + 1)
                ys, xs = np.ogrid[yy0:yy1, xx0:xx1]
                mask = ((ys - cy) / max(ry, 1)) ** 2 + ((xs - cx) / max(rx, 1)) ** 2 <= 1
                region = out[yy0:yy1, xx0:xx1]
                value = int(rng.integers(8, 70)) if rng.random() < 0.82 else 238
                region[mask] = np.uint8(value)

            # A larger soft smudge is what creates the review boundary.
            cy = (y0 + y1) // 2
            for r in range(18, 0, -1):
                alpha = 0.10 + 0.025 * r
                yy0, yy1 = max(0, cy - r), min(h, cy + r + 1)
                out[yy0:yy1, int(CENTER_X - 15): int(CENTER_X + 18)] = (
                    out[yy0:yy1, int(CENTER_X - 15): int(CENTER_X + 18)].astype(np.float32) * (1 - alpha)
                    + 45 * alpha
                ).astype(np.uint8)

    return out, plan


# ---------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------

def _meta_get(meta: dict | None, key: str, default):
    if not meta:
        return default
    return meta.get(key, default)


def _decode_side(
    exposure: np.ndarray,
    center_gate: float,
    gate_radius: float,
    sigma_prior: float = 46.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    h, w = exposure.shape
    x0 = int(max(0, math.floor(center_gate - gate_radius)))
    x1 = int(min(w, math.ceil(center_gate + gate_radius) + 1))
    xs = np.arange(x0, x1, dtype=np.float32)
    block = exposure[:, x0:x1]

    # Dark-line evidence.  Squaring suppresses isolated gray background noise.
    dark = np.clip(0.50 - block, 0.0, 1.0)
    rel_center = center_gate - x0
    prior = np.exp(-0.5 * ((xs - x0 - rel_center) / sigma_prior) ** 2)
    weights = (dark**2) * prior[None, :]
    total = weights.sum(axis=1)

    rel_xs = np.arange(x1 - x0, dtype=np.float32)[None, :]
    centroid_rel = np.divide(
        (weights * rel_xs).sum(axis=1),
        total,
        out=np.full(h, np.nan, dtype=np.float32),
        where=total > 1e-5,
    )
    centroid = x0 + centroid_rel

    # Estimate visible line thickness around the centroid.  This is used as a
    # secondary confidence / exposure diagnostic, not as a hard truth.
    thickness = np.zeros(h, dtype=np.float32)
    confidence = np.zeros(h, dtype=np.float32)
    for y in range(h):
        if not np.isfinite(centroid[y]):
            continue
        c = int(round(centroid[y]))
        a = max(x0, c - 4)
        b = min(x1, c + 5)
        cols = np.arange(a, b)
        ww = np.clip(0.50 - exposure[y, a:b], 0, 1) ** 2
        if ww.sum() > 1e-5:
            local_c = (cols * ww).sum() / ww.sum()
            spread = math.sqrt(float((ww * (cols - local_c) ** 2).sum() / ww.sum()))
            thickness[y] = max(0.8, 4.0 * spread)
            peak = float(ww.max())
            confidence[y] = float(np.clip(0.35 + 2.2 * peak + 0.25 * min(ww.sum(), 1.0), 0, 1))
        else:
            centroid[y] = np.nan

    # Very low total evidence means the line was probably erased.
    confidence[total < 0.035] = 0.0
    centroid[total < 0.035] = np.nan
    return centroid.astype(np.float32), confidence, thickness


def _interpolate_bad(values: np.ndarray, bad: np.ndarray, max_gap: int) -> np.ndarray:
    out = values.astype(np.float64).copy()
    n = len(out)
    good = (~bad) & np.isfinite(out)
    if good.sum() < 2:
        return np.full(n, np.nan, dtype=np.float64)

    good_idx = np.flatnonzero(good)
    bad_idx = np.flatnonzero(bad | ~np.isfinite(out))
    if len(bad_idx) == 0:
        return out

    # Only interpolate short gaps.  Long gaps are returned as NaN and handled
    # by the caller as a dropout (time is not deleted).
    result = out.copy()
    gaps: list[tuple[int, int]] = []
    start = None
    prev = -1
    for i in bad_idx:
        if start is None:
            start = prev_i = i
        elif i == prev_i + 1:
            prev_i = i
        else:
            gaps.append((start, prev_i + 1))
            start = prev_i = i
    if start is not None:
        gaps.append((start, prev_i + 1))

    for a, b in gaps:
        if b - a <= max_gap:
            left = max(0, a - 1)
            right = min(n - 1, b)
            if good[left] and good[right]:
                result[a:b] = np.linspace(out[left], out[right], b - a + 2)[1:-1]
            elif good[left]:
                result[a:b] = out[left]
            elif good[right]:
                result[a:b] = out[right]
    return result


def decode_image(gray: np.ndarray, params: ReadParams | None = None, meta: dict | None = None) -> DecodeResult:
    p = (params or ReadParams()).clamped()
    h, w = gray.shape
    center = float(_meta_get(meta, "center_x", CENTER_X))
    base_half = float(_meta_get(meta, "base_half_px", BASE_HALF_PX))
    base_width = float(_meta_get(meta, "base_width_px", BASE_WIDTH_PX))
    px_per_unit = float(_meta_get(meta, "px_per_unit", PX_PER_UNIT))
    gate_radius = float(_meta_get(meta, "edge_gate_radius", EDGE_GATE_RADIUS))

    # Exposure model: EV scales scanner brightness.  Extreme negative EV pushes
    # the gray track floor toward the dark-line threshold; positive EV washes
    # the line contrast toward the fog floor.
    ev_gain = float(2.0 ** p.exposure_ev)
    exposure = np.clip(gray.astype(np.float32) / 255.0 * ev_gain + max(0.0, p.exposure_ev) * 0.035, 0, 1)

    left_gate_center = center - base_half + p.offset_px
    right_gate_center = center + base_half + p.offset_px
    left, conf_l, thick_l = _decode_side(exposure, left_gate_center, gate_radius)
    right, conf_r, thick_r = _decode_side(exposure, right_gate_center, gate_radius)
    confidence = np.minimum(conf_l, conf_r)

    messages: list[str] = []
    left_bad = ~np.isfinite(left)
    right_bad = ~np.isfinite(right)
    missing = left_bad | right_bad | (confidence < 0.42)

    left_f = _interpolate_bad(left, missing | left_bad, max_gap=10)
    right_f = _interpolate_bad(right, missing | right_bad, max_gap=10)

    raw_width = right_f - left_f
    plausible = (raw_width > base_width - 2.1 * MOD_PX - 8) & (
        raw_width < base_width + 2.1 * MOD_PX + 8
    )
    outlier = ~plausible & np.isfinite(raw_width)
    if outlier.any():
        confidence[outlier] = np.minimum(confidence[outlier], 0.25)
        raw_width[outlier] = np.nan

    # Long missing/outlier sections become the zero-signal bias width.  This
    # preserves every row and makes dropouts audible instead of deleting time.
    raw_width = _interpolate_bad(raw_width, ~np.isfinite(raw_width), max_gap=12)
    still_bad = ~np.isfinite(raw_width)
    raw_width[still_bad] = base_width
    if missing.any() or outlier.any():
        messages.append(
            f"{int(missing.sum() + outlier.sum())} 行边缘证据不足或越界，短缺口已插值、长缺口按静音宽度保留。"
        )
    if abs(p.offset_px) > EDGE_GATE_RADIUS - MOD_PX - 6:
        messages.append("横向偏移已接近或超过容差，外侧暗线可能离开读取门。")
    if abs(p.exposure_ev) >= 1.0:
        messages.append("曝光接近极端，暗线判读阈值可能不稳定。")

    k = p.window_rows
    if k > 1:
        kernel = np.ones(k, dtype=np.float64) / k
        padded = np.pad(raw_width, (k // 2, k - 1 - k // 2), mode="edge")
        smooth_width = np.convolve(padded, kernel, mode="valid")[:h]
    else:
        smooth_width = raw_width.astype(np.float64)

    dc = float(np.median(smooth_width) - base_width)
    signal = (smooth_width - base_width) / px_per_unit
    if p.dc_remove:
        # A robust median is less disturbed by short pulses/defects than mean.
        signal = signal - float(np.median(signal))

    audio = resample_linear(signal.astype(np.float32), ROW_RATE, AUDIO_RATE)
    result = DecodeResult(
        raw_width=raw_width.astype(np.float32),
        smooth_width=smooth_width.astype(np.float32),
        samples_row=signal.astype(np.float32),
        samples_audio=audio,
        left_x=left,
        right_x=right,
        confidence=confidence,
        line_width_left=thick_l,
        line_width_right=thick_r,
        dc_offset=dc,
        params=p,
        meta=meta or {},
        messages=messages,
    )
    result.defects = detect_defects(result, gray)
    return result


def detect_defects(result: DecodeResult, gray: np.ndarray | None = None) -> list[DefectInterval]:
    """Propose affected row intervals from edge confidence and foreign pixels.

    The detector is intentionally conservative: scattered weak rows receive a
    wider "review" span rather than a falsely precise boundary.
    """
    h = len(result.confidence)
    bad = result.confidence < 0.34
    weak = result.confidence < 0.68

    dark_inside = np.zeros(h, dtype=np.int16)
    if gray is not None:
        left = result.left_x
        right = result.right_x
        for y in range(h):
            if not (np.isfinite(left[y]) and np.isfinite(right[y])):
                continue
            a = int(math.ceil(float(left[y]) + 4))
            b = int(math.floor(float(right[y]) - 4))
            if b - a >= 3:
                dark_inside[y] = int(np.count_nonzero(gray[y, a:b] < 105))
        bad |= dark_inside >= 5
        weak |= dark_inside >= 2
    else:
        # Without pixels, only confidence is available.  Do not use the width
        # residual against a slow median: ordinary high-frequency zigzags would
        # otherwise be mistaken for damage.
        pass

    rows = np.flatnonzero(bad)
    if len(rows) == 0:
        return []

    groups: list[tuple[int, int]] = []
    start = prev = int(rows[0])
    for r in rows[1:]:
        r = int(r)
        if r - prev <= 360:  # merge one dust event's scattered bad rows
            prev = r
        else:
            groups.append((start, prev + 1))
            start = prev = r
    groups.append((start, prev + 1))

    intervals: list[DefectInterval] = []
    for a, b in groups:
        if b - a < 3:
            continue
        # Expand through adjacent weak evidence.  If weak evidence trails far,
        # mark the outer boundary uncertain and preserve that time too.
        ua, ub = a, b
        while ua > 0 and weak[ua - 1] and a - ua < 45:
            ua -= 1
        while ub < h and weak[ub] and ub - b < 45:
            ub += 1
        median_conf = float(np.nanmedian(result.confidence[a:b])) if b > a else 1.0
        kind = "break" if (b - a) >= 160 and median_conf < 0.30 else "dirty"
        uncertain = (ua < a - 2) or (ub > b + 2) or (b - a < 24) or kind == "dirty"
        intervals.append(
            DefectInterval(
                kind=kind,
                start_row=int(a),
                end_row=int(b),
                uncertain_start_row=int(max(0, ua - (10 if uncertain else 0))),
                uncertain_end_row=int(min(h, ub + (10 if uncertain else 0))),
                status="review" if uncertain else "marked",
                reason=(
                    "脏点散布/断线羽化使边界证据不连续，已保留待查外延与对应时间"
                    if uncertain
                    else "连续低置信度或异常像素区间，核心边界相对明确"
                ),
            )
        )
    return intervals


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def band_amplitude(samples: np.ndarray, start: float, end: float, freq: float, rate: int) -> float:
    a = max(0, int(start * rate))
    b = min(len(samples), int(end * rate))
    if b - a < max(8, int(rate / max(freq, 1) * 2)):
        return 0.0
    y = np.asarray(samples[a:b], dtype=np.float64)
    y = y - np.mean(y)
    n = len(y)
    t = np.arange(n) / rate
    mat = np.column_stack([np.sin(2 * np.pi * freq * t), np.cos(2 * np.pi * freq * t)])
    coef, *_ = np.linalg.lstsq(mat, y, rcond=None)
    return float(np.hypot(coef[0], coef[1]))


def rms_dbfs(samples: np.ndarray, start: float, end: float, rate: int) -> float:
    a = max(0, int(start * rate))
    b = min(len(samples), int(end * rate))
    if b <= a:
        return -120.0
    y = np.asarray(samples[a:b], dtype=np.float64)
    rms = float(np.sqrt(np.mean(y * y)))
    return 20.0 * math.log10(max(rms, 1e-7))


def pulse_metric(samples: np.ndarray, seg: Segment, rate: int) -> tuple[float, float]:
    a = max(0, int(seg.start * rate))
    b = min(len(samples), int(seg.end * rate))
    y = np.abs(np.asarray(samples[a:b], dtype=np.float64))
    if len(y) == 0 or y.max() < 1e-5:
        return -120.0, 0.0
    peak_idx = int(np.argmax(y))
    peak = float(y[peak_idx])
    half = peak * 0.5
    l = peak_idx
    while l > 0 and y[l] > half:
        l -= 1
    r = peak_idx
    while r < len(y) - 1 and y[r] > half:
        r += 1
    width_ms = (r - l) / rate * 1000.0
    return 20 * math.log10(max(peak, 1e-7)), width_ms


def find_segment(segments: Iterable[Segment], name: str) -> Segment | None:
    for s in segments:
        if s.name == name:
            return s
    return None


def metrics_rows(
    source: np.ndarray,
    baseline: DecodeResult | None,
    trial: DecodeResult | None,
    segments: list[Segment],
) -> list[dict]:
    rate = AUDIO_RATE
    rows: list[dict] = []

    def level_pair(freq_seg_name: str, freq: float):
        seg = find_segment(segments, freq_seg_name)
        if seg is None:
            return
        src = band_amplitude(source, seg.start + 0.03, seg.end - 0.03, freq, rate)
        row = {
            "metric": f"{freq:g} Hz 恢复电平",
            "source": _fmt_db(20 * math.log10(max(src / math.sqrt(2), 1e-7))),
        }
        for key, res in (("baseline", baseline), ("trial", trial)):
            if res is None:
                row[key] = "—"
                row[key + "_ratio"] = "—"
                continue
            amp = band_amplitude(res.samples_audio, seg.start + 0.03, seg.end - 0.03, freq, rate)
            db = 20 * math.log10(max(amp / math.sqrt(2), 1e-7))
            ratio = 100.0 * amp / max(src, 1e-7)
            row[key] = f"{db:.1f} dBFS"
            row[key + "_ratio"] = f"{ratio:.0f}%"
        rows.append(row)

    level_pair("low440", 440.0)
    level_pair("high1320", 1320.0)

    sil = find_segment(segments, "silence") or find_segment(segments, "tail")
    if sil:
        row = {
            "metric": "静音底 RMS",
            "source": f"{rms_dbfs(source, sil.start, sil.end, rate):.1f} dBFS",
        }
        for key, res in (("baseline", baseline), ("trial", trial)):
            row[key] = f"{rms_dbfs(res.samples_audio, sil.start, sil.end, rate):.1f} dBFS" if res else "—"
            row[key + "_ratio"] = ""
        rows.append(row)

    pulse_seg = find_segment(segments, "pulses")
    if pulse_seg:
        src_peak, src_w = pulse_metric(source, pulse_seg, rate)
        row = {"metric": "脉冲峰值 / 半高宽", "source": f"{src_peak:.1f} dB / {src_w:.2f} ms"}
        for key, res in (("baseline", baseline), ("trial", trial)):
            if res:
                pk, wid = pulse_metric(res.samples_audio, pulse_seg, rate)
                row[key] = f"{pk:.1f} dB / {wid:.2f} ms"
            else:
                row[key] = "—"
            row[key + "_ratio"] = ""
        rows.append(row)

    return rows


def _fmt_db(db: float) -> str:
    return f"{db:.1f} dBFS"
