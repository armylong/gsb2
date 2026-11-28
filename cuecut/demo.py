"""Generate a demo master WAV + cue with known points, used to verify splitting.

The generated audio deliberately contains:
* a short marker tone at the start of every INDEX 00 / INDEX 01 point,
* one continuous tone that spans every boundary (so a cut is audible),
* a distinct "click" sample-level pattern at track 1 sample 0 and at EOF.

The generator returns ground truth (sample positions of every marker and of
the boundary-spanning tone) so the self-test can assert against it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

SAMPLERATE = 44100


@dataclass
class Marker:
    sample: int
    freq: float
    kind: str  # "index00" | "index01"
    track: int


@dataclass
class DemoTruth:
    path: str
    cue_path: str
    samplerate: int
    channels: int
    total_samples: int
    markers: List[Marker] = field(default_factory=list)
    # Boundary-spanning tone: (frequency, sample range) it covers.
    spanning: List[tuple] = field(default_factory=list)
    true_starts: List[tuple] = field(default_factory=list)  # (track, index01 sample)

    def marker_at(self, kind: str, track: int) -> int:
        for m in self.markers:
            if m.kind == kind and m.track == track:
                return m.sample
        raise KeyError((kind, track))

    def spanning_at(self, sample: int) -> Optional[tuple]:
        """The boundary-spanning tone spec covering ``sample``, if any."""
        for freq, s0, s1 in self.spanning:
            if s0 <= sample <= s1:
                return (freq, s0, s1)
        return None


DEMO_TRACKS = [
    # (title, INDEX 00 at second or None, INDEX 01 at second)
    ("Intro", None, 4.0),
    ("Song A", 34.0, 40.0),
    ("Song B", 70.0, 76.0),
    ("Song C", 100.0, 106.0),
]
TOTAL_SECONDS = 130.0


def _tone(sr: int, count: int, freq: float, amp: float) -> np.ndarray:
    t = np.arange(count, dtype=np.float64) / sr
    return amp * np.sin(2 * np.pi * freq * t)


def _marker(sr: int, freq: float, length: int = 1024, amp: float = 0.5) -> np.ndarray:
    """Short tone burst with sharp edges at both ends (easy to detect)."""
    t = np.arange(length, dtype=np.float64) / sr
    win = np.hanning(length + 2)[1:-1]  # keep edges near zero to avoid splatter
    return amp * np.sin(2 * np.pi * freq * t) * win


def generate_demo(out_dir: str, title: str = "demo") -> DemoTruth:
    os.makedirs(out_dir, exist_ok=True)
    sr = SAMPLERATE
    total = int(TOTAL_SECONDS * sr)
    # Three channels are overkill; stereo keeps it realistic.
    data = np.zeros((total, 2), dtype=np.float64)

    # Low-level noise floor so a "silent" cut is still auditable.
    rng = np.random.default_rng(20261128)
    data[:, 0] += rng.normal(0, 1e-4, total)
    data[:, 1] += rng.normal(0, 1e-4, total)

    # A quiet bed so we can hear the edits.
    bed = 0.02 * np.sin(2 * np.pi * 220 * np.arange(total) / sr)
    data[:, 0] += bed
    data[:, 1] += 0.02 * np.sin(2 * np.pi * 220 * np.arange(total) / sr + 0.3)

    truth = DemoTruth(
        path="",
        cue_path="",
        samplerate=sr,
        channels=2,
        total_samples=total,
    )

    # Tones that span boundaries contiguously.  We place a distinct
    # frequency per boundary so an export seam is immediately visible:
    # the tone must continue across the join, not restart.
    spanning_specs = [
        # (freq, start_s, end_s) — each crosses one INDEX 01 (or INDEX 00) point
        (523.25, 30.0, 44.0),
        (659.25, 66.0, 80.0),
        (783.99, 96.0, 110.0),
        (440.00, 1.0, 6.0),   # crosses track 1 start? no, starts after; keep for texture
    ]
    for freq, a, b in spanning_specs:
        s0 = int(a * sr)
        s1 = int(b * sr)
        seg = _tone(sr, s1 - s0, freq, 0.08)
        data[s0:s1, 0] += seg
        data[s0:s1, 1] += seg
        truth.spanning.append((freq, s0, s1 - 1))

    # Distinct marker frequencies.
    freqs = [880.0, 1000.0, 1120.0, 1240.0, 1360.0, 1480.0]
    fi = 0
    for track_no, (name, lead_s, start_s) in enumerate(DEMO_TRACKS, 1):
        if lead_s is not None:
            s0 = int(lead_s * sr)
            f = freqs[fi % len(freqs)]
            fi += 1
            m = _marker(sr, f)
            data[s0:s0 + len(m), 0] += m
            data[s0:s0 + len(m), 1] += m
            truth.markers.append(Marker(s0, f, "index00", track_no))
        s1 = int(start_s * sr)
        f = freqs[fi % len(freqs)]
        fi += 1
        m = _marker(sr, f)
        data[s1:s1 + len(m), 0] += m
        data[s1:s1 + len(m), 1] += m
        truth.markers.append(Marker(s1, f, "index01", track_no))
        truth.true_starts.append((track_no, s1))

    # Extremely first and last samples get a uniquely identifiable value so
    # boundary trimming bugs surface in exact comparisons.
    data[0, 0] = 0.123456789
    data[-1, 1] = -0.123456789

    # Keep in [-1, 1]; tiny markers plus beds stay well inside.
    np.clip(data, -0.999, 0.999, out=data)

    wav_path = os.path.join(out_dir, f"{title}.wav")
    import soundfile as sf

    sf.write(wav_path, data, sr, subtype="PCM_24", format="WAV")

    cue_lines = [
        f'TITLE "{title}"',
        'PERFORMER "CueCut Demo"',
        f'FILE "{os.path.basename(wav_path)}" WAVE',
    ]

    def fmt(seconds: float) -> str:
        # write the exact CD frame
        fr = int(round(seconds * 75))
        mm, rest = divmod(fr, 75)
        mm_, ss = divmod(mm, 60)
        return f"{mm_:02d}:{ss:02d}:{rest:02d}"

    for track_no, (name, lead_s, start_s) in enumerate(DEMO_TRACKS, 1):
        cue_lines.append(f"  TRACK {track_no:02d} AUDIO")
        cue_lines.append(f'    TITLE "{name}"')
        cue_lines.append('    PERFORMER "CueCut Demo"')
        if lead_s is not None:
            cue_lines.append(f"    INDEX 00 {fmt(lead_s)}")
        cue_lines.append(f"    INDEX 01 {fmt(start_s)}")

    cue_path = os.path.join(out_dir, f"{title}.cue")
    with open(cue_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(cue_lines) + "\n")

    truth.path = wav_path
    truth.cue_path = cue_path
    return truth
