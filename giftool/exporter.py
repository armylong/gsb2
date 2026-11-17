"""High-level export pipeline: RGBA frames -> verified GIF file."""

from __future__ import annotations

from dataclasses import dataclass

from .gif_writer import encode_gif
from .optimizer import StorageFrame, build_full_storage, build_optimized_storage
from .quantize import QuantizedFrame, quantize_frames
from .readback import ReadbackReport, verify_export


@dataclass
class ExportResult:
    optimized_bytes: bytes
    full_bytes: bytes | None  # None when only one mode was requested
    quantized: list[QuantizedFrame]
    storage: list[StorageFrame]
    full_storage: list[StorageFrame] | None
    source_groups: list[list[int]]
    report: ReadbackReport
    optimized_mode: bool


def export_gif(
    rgba_frames: list,
    durations_ms: list[int],
    loop_count: int,
    *,
    colors: int = 256,
    transparent_background: bool = True,
    optimize: bool = True,
    compare_full: bool = True,
) -> ExportResult:
    """Run the full export pipeline in memory and verify the result.

    Parameters
    ----------
    rgba_frames:
        Full-canvas RGBA numpy arrays (all identical size).
    durations_ms:
        One display duration per input frame.
    loop_count:
        Netscape loop count (0 == infinite).
    colors / transparent_background:
        Palette conversion settings, see :mod:`giftool.quantize`.
    optimize:
        When true, store local tiles; otherwise full-canvas frames.
    compare_full:
        Also build the full-frame encoding so the caller can show the size
        difference between the two storage modes.
    """
    if len(rgba_frames) != len(durations_ms):
        msg = "frame count and duration count must match"
        raise ValueError(msg)
    if not rgba_frames:
        msg = "at least one frame is required"
        raise ValueError(msg)

    height, width = rgba_frames[0].shape[:2]
    quantized = quantize_frames(rgba_frames, colors, transparent_background)

    if optimize:
        storage = build_optimized_storage(quantized, durations_ms)
    else:
        storage = build_full_storage(quantized, durations_ms)
    source_groups = [frame.source_indices for frame in storage]

    optimized_bytes = encode_gif((width, height), storage, loop_count)

    full_storage = None
    full_bytes = None
    if compare_full:
        full_storage = build_full_storage(quantized, durations_ms)
        full_bytes = encode_gif((width, height), full_storage, loop_count)

    report = verify_export(
        optimized_bytes,
        quantized,
        durations_ms,
        loop_count,
        source_groups=source_groups,
    )
    if full_bytes is not None:
        report.size_optimized_bytes = len(optimized_bytes)
        report.size_full_bytes = len(full_bytes)
    else:
        report.size_optimized_bytes = len(optimized_bytes)

    return ExportResult(
        optimized_bytes=optimized_bytes,
        full_bytes=full_bytes,
        quantized=quantized,
        storage=storage,
        full_storage=full_storage,
        source_groups=source_groups,
        report=report,
        optimized_mode=optimize,
    )
