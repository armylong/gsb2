"""Export read-back verification.

After writing a GIF the file is parsed again from disk and independently
re-composited, then compared against the *target* frames — i.e. the frames
after palette conversion, not the original true-color PNGs.  A GIF can only
store up to 256 palette colors and one transparency level, so demanding
pixel equality against a losslessly quantized target (rather than the
source) is the meaningful consistency check.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .compositor import render_all
from .gif_parser import parse_gif
from .quantize import QuantizedFrame, quantized_to_rgba


# Centisecond rounding is the only legal duration error (GIF time resolution).
DURATION_TOLERANCE_MS = 10


@dataclass
class IntervalCheck:
    source_frame: int
    stored_frame: int | None
    pixels_match: bool
    differing_pixels: int
    target_duration_ms: int
    actual_duration_ms: int
    duration_ok: bool


@dataclass
class ReadbackReport:
    target_frames: int
    stored_frames: int
    loop_target: int
    loop_actual: int
    loop_ok: bool
    intervals: list[IntervalCheck] = field(default_factory=list)
    size_full_bytes: int | None = None
    size_optimized_bytes: int | None = None

    @property
    def all_pixels_match(self) -> bool:
        return bool(self.intervals) and all(item.pixels_match for item in self.intervals)

    @property
    def all_durations_ok(self) -> bool:
        return all(item.duration_ok for item in self.intervals)

    @property
    def ok(self) -> bool:
        return (
            self.all_pixels_match
            and self.all_durations_ok
            and self.loop_ok
        )

    @property
    def total_target_duration_ms(self) -> int:
        return sum(item.target_duration_ms for item in self.intervals)

    @property
    def total_actual_duration_ms(self) -> int:
        # A merged stored frame covers several source intervals but has one
        # physical duration, so count each stored frame only once.
        seen: set[int] = set()
        total = 0
        for item in self.intervals:
            key = item.stored_frame if item.stored_frame is not None else item.source_frame
            if key not in seen:
                seen.add(key)
                total += item.actual_duration_ms
        return total

    def size_summary(self) -> str:
        if self.size_full_bytes is None or self.size_optimized_bytes is None:
            return "体积对比不可用"
        saved = self.size_full_bytes - self.size_optimized_bytes
        pct = (
            100.0 * saved / self.size_full_bytes
            if self.size_full_bytes
            else 0.0
        )
        return (
            f"完整帧 {self.size_full_bytes} B / 局部优化 {self.size_optimized_bytes} B"
            f"（节省 {saved} B，{pct:.1f}%）"
        )


def _target_rgba_frames(targets: list[QuantizedFrame]) -> list[np.ndarray]:
    return [quantized_to_rgba(frame) for frame in targets]


def verify_export(
    gif_bytes: bytes,
    targets: list[QuantizedFrame],
    target_durations_ms: list[int],
    target_loop: int,
    source_groups: list[list[int]] | None = None,
) -> ReadbackReport:
    """Parse an exported GIF and verify it against the quantized targets.

    ``source_groups`` maps each stored frame to the target indices it covers
    (needed when identical frames were merged).  When omitted a 1:1 mapping is
    assumed.
    """
    doc = parse_gif(gif_bytes)
    composited = render_all(doc)
    target_rgba = _target_rgba_frames(targets)

    if source_groups is None:
        source_groups = [[i] for i in range(len(targets))]

    report = ReadbackReport(
        target_frames=len(targets),
        stored_frames=len(doc.frames),
        loop_target=target_loop,
        loop_actual=doc.loop_count,
        loop_ok=doc.loop_count == target_loop,
    )

    if len(composited) != len(source_groups):
        msg = (
            f"readback frame count {len(composited)} does not match "
            f"{len(source_groups)} stored groups"
        )
        raise AssertionError(msg)

    for stored_index, group in enumerate(source_groups):
        actual = composited[stored_index]
        actual_duration = doc.frames[stored_index].duration_ms
        # A merged frame must last exactly as long as the intervals it covers.
        expected_duration = sum(target_durations_ms[i] for i in group)
        for source_index in group:
            expected = target_rgba[source_index]
            match, differing = _compare_rgba(expected, actual)
            report.intervals.append(
                IntervalCheck(
                    source_frame=source_index,
                    stored_frame=stored_index,
                    pixels_match=match,
                    differing_pixels=differing,
                    target_duration_ms=target_durations_ms[source_index],
                    actual_duration_ms=actual_duration,
                    duration_ok=abs(actual_duration - expected_duration)
                    <= DURATION_TOLERANCE_MS,
                )
            )

    return report


def _compare_rgba(expected: np.ndarray, actual: np.ndarray) -> tuple[bool, int]:
    """Compare two RGBA canvases.

    Fully transparent pixels carry no defined RGB value in GIF (the palette
    slot is irrelevant once alpha is 0), so only the alpha channel matters
    there; opaque pixels must match on all four channels.
    """
    if expected.shape != actual.shape:
        return False, int(expected.size // 4)
    expected_opaque = expected[..., 3] != 0
    actual_opaque = actual[..., 3] != 0
    alpha_mismatch = expected_opaque != actual_opaque
    both_opaque = expected_opaque & actual_opaque
    color_mismatch = np.zeros_like(alpha_mismatch)
    if both_opaque.any():
        color_mismatch[both_opaque] = np.any(
            expected[..., :3][both_opaque] != actual[..., :3][both_opaque],
            axis=1,
        )
    mismatch = alpha_mismatch | color_mismatch
    differing = int(mismatch.sum())
    return differing == 0, differing
