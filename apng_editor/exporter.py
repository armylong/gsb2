"""APNG export plus an independent read-back verification step.

Frames are written as full-canvas RGBA images (blend = source, dispose = keep),
so every display slot is exactly one composited canvas.  That keeps the file
simple and avoids relying on encoder-side delta optimisation, which is not a
goal for this tool.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np
from apng import APNG, PNG
from PIL import Image

from .apng_codec import DecodedAPNG, decode_apng
from .model import Project, compose_project, summarize_difference

# The APNG fcTL delay is a fraction of 16-bit integers.  We always write
# milliseconds / 1000, so no rounding happens for the integer millisecond
# values this editor accepts.  A tolerance is still applied on read-back so
# that externally re-encoded files (which may use another denominator) are
# judged fairly.
DURATION_TOLERANCE_MS = 0.5 + 1e-6


@dataclass
class FrameCheck:
    index: int
    expected_ms: int
    actual_ms: float
    pixels_match: bool
    duration_ok: bool
    detail: str = ""


@dataclass
class VerificationReport:
    ok: bool
    path: Path
    canvas_match: bool
    loop_match: bool
    frame_count_ok: bool
    frames: list[FrameCheck] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.ok:
            return (
                f"导出回读验证通过：{len(self.frames)} 帧画面逐像素一致，"
                "画布、逐帧时长和循环行为均匹配。"
            )
        lines = ["导出回读验证失败："]
        lines.extend(f"- {problem}" for problem in self.problems)
        return "\n".join(lines)


def _png_bytes(pixels: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(pixels, mode="RGBA").save(
        buffer, format="PNG", optimize=False, compress_level=6
    )
    return buffer.getvalue()


def build_apng(project: Project) -> bytes:
    """Encode the project as an APNG byte string after re-composing it."""

    project.validate(require_frames=True)
    displayed = compose_project(project)
    animation = APNG(num_plays=project.loop_count)
    for frame, pixels in zip(project.frames, displayed):
        png = PNG.from_bytes(_png_bytes(pixels))
        animation.append(
            png,
            delay=int(frame.duration_ms),
            delay_den=1000,
            depose_op=0,  # keep
            blend_op=0,  # source
        )
    return animation.to_bytes()


def export_apng(project: Project, path: str | Path) -> Path:
    """Write the project to ``path`` and return the normalised path."""

    path = Path(path)
    if path.suffix.lower() != ".png":
        path = path.with_suffix(".png")
    data = build_apng(project)
    path.write_bytes(data)
    return path


def verify_export(project: Project, path: str | Path) -> VerificationReport:
    """Decode ``path`` with the independent reader and compare every slot.

    Pixel comparison is exact and covers the whole canvas, so any leaked
    checkerboard, selection outline or disposal mistake is reported.  The
    duration comparison allows the documented APNG rational-delay rounding.
    """

    path = Path(path)
    report = VerificationReport(
        ok=False,
        path=path,
        canvas_match=False,
        loop_match=False,
        frame_count_ok=False,
    )
    expected_frames = compose_project(project)

    try:
        decoded = decode_apng(path)
    except (OSError, ValueError) as exc:
        report.problems.append(f"无法解码导出的 APNG：{exc}")
        return report

    report.canvas_match = (decoded.width, decoded.height) == project.canvas_size
    if not report.canvas_match:
        report.problems.append(
            f"画布尺寸不一致：期望 {project.canvas_size}，"
            f"实际 {(decoded.width, decoded.height)}"
        )

    report.loop_match = decoded.loop_count == project.loop_count
    if not report.loop_match:
        report.problems.append(
            f"循环行为不一致：期望 {'无限' if project.loop_count == 0 else project.loop_count}，"
            f"实际 {decoded.loop_count}"
        )

    report.frame_count_ok = len(decoded.frames) == len(expected_frames)
    if not report.frame_count_ok:
        report.problems.append(
            f"帧数不一致：期望 {len(expected_frames)}，实际 {len(decoded.frames)}"
        )

    if report.canvas_match and report.frame_count_ok:
        for index, (expected, actual) in enumerate(
            zip(expected_frames, decoded.frames)
        ):
            pixels_match = bool(np.array_equal(expected, actual.pixels))
            expected_ms = project.frames[index].duration_ms
            duration_ok = (
                abs(actual.duration_ms - expected_ms) <= DURATION_TOLERANCE_MS
            )
            detail = ""
            if not pixels_match:
                detail = summarize_difference(expected, actual.pixels)
                report.problems.append(f"第 {index + 1} 帧画面不一致：{detail}")
            if not duration_ok:
                report.problems.append(
                    f"第 {index + 1} 帧时长不一致：期望 {expected_ms} ms，"
                    f"回读 {actual.duration_ms:.3f} ms"
                )
            report.frames.append(
                FrameCheck(
                    index=index,
                    expected_ms=expected_ms,
                    actual_ms=actual.duration_ms,
                    pixels_match=pixels_match,
                    duration_ok=duration_ok,
                    detail=detail,
                )
            )

    report.ok = (
        report.canvas_match
        and report.loop_match
        and report.frame_count_ok
        and len(report.frames) == len(expected_frames)
        and all(f.pixels_match and f.duration_ok for f in report.frames)
    )
    return report


def describe_decoded(decoded: DecodedAPNG, frames: Sequence) -> str:
    """Small helper for diagnostics in the GUI/README examples."""

    lines = [
        f"画布 {decoded.width}×{decoded.height}，声明帧数 {decoded.declared_frames}，"
        f"{'无限循环' if decoded.loop_count == 0 else f'循环 {decoded.loop_count} 次'}"
    ]
    for index, frame in enumerate(decoded.frames):
        num, den = frame.duration_fraction
        lines.append(
            f"  第 {index + 1} 帧：矩形 {frame.rect}，"
            f"时长 {num}/{den} s = {frame.duration_ms:.3f} ms，"
            f"处置 {frame.disposal}，混合 {frame.blend}"
        )
    return "\n".join(lines)
