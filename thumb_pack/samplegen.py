"""Generate deterministic frame-numbered test videos with FFmpeg."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Sequence

from .imagetools import RGBImage, text_size
from .probe import resolve_binary


def render_numbered_frame(
    width: int,
    height: int,
    index: int,
    frame_count: int,
    intended_time: float | None = None,
) -> RGBImage:
    width = max(32, int(width) - (int(width) % 2))
    height = max(32, int(height) - (int(height) % 2))
    img = RGBImage.new(width, height, (18, 24, 44))

    # Index-dependent background makes adjacent wrong pointers perceptually
    # different even before the burned number is read.
    base_r = 18 + (index * 17) % 70
    base_g = 28 + (index * 29) % 80
    base_b = 58 + (index * 43) % 110
    for y in range(height):
        shade = int(28 * y / max(1, height - 1))
        color = (
            min(255, base_r + shade // 2),
            min(255, base_g + shade // 2),
            min(255, base_b + shade),
        )
        start = y * width * 3
        row = bytes(color) * width
        img.pixels[start : start + len(row)] = row

    accent = (
        80 + (index * 61) % 175,
        180 + (index * 37) % 75,
        220 - (index * 47) % 160,
    )
    img.draw_rect(5, 5, width - 10, height - 10, (245, 248, 255), 4)
    img.fill_rect(10, 10, width - 20, 8, accent)
    img.fill_rect(10, height - 18, width - 20, 8, accent)

    heading = "FRAME"
    hscale = 2 if width >= 180 else 1
    hw, _ = text_size(heading, hscale)
    img.draw_text(heading, (width - hw) // 2, 22, hscale, (235, 240, 255), (0, 0, 0))

    number = str(index).zfill(max(3, len(str(frame_count - 1))))
    scale = 1
    while scale < 16:
        tw, th = text_size(number, scale + 1)
        if tw > width * 0.86 or th > height * 0.48:
            break
        scale += 1
    tw, th = text_size(number, scale)
    img.draw_text(
        number,
        (width - tw) // 2,
        int(height * 0.42 - th / 2),
        scale,
        (255, 255, 255),
        (0, 0, 0),
    )

    orientation = "PORTRAIT" if height > width else "LANDSCAPE"
    footer = f"{index + 1}/{frame_count} {orientation}"
    fscale = 1
    fw, fh = text_size(footer, fscale)
    if fw > width - 20:
        footer = f"{index + 1}/{frame_count}"
        fw, fh = text_size(footer, fscale)
    img.draw_text(footer, (width - fw) // 2, height - 30, fscale, (245, 247, 252), (0, 0, 0))

    if intended_time is not None and width >= 220:
        time_label = f"T={intended_time:.3f}S"
        tw2, _ = text_size(time_label, 1)
        img.draw_text(time_label, (width - tw2) // 2, height - 48, 1, (250, 204, 21), (0, 0, 0))

    # Machine-friendly corner blocks: binary frame index in eight squares.
    block = max(4, min(width, height) // 18)
    bx, by = 14, height - 14 - block
    for bit in range(8):
        on = (index >> bit) & 1
        color = (250, 204, 21) if on else (55, 65, 81)
        img.fill_rect(bx + bit * (block + 2), by, block, block, color)
    return img


def default_frame_times(frame_count: int, fps: float = 10.0, vfr: bool = False) -> list[float]:
    if not vfr:
        return [i / fps for i in range(frame_count)]
    # Repeating irregular cadence.  Several gaps are deliberately much shorter
    # than 1/fps so target-time collisions are easy to construct.
    gaps = [0.16, 0.06, 0.22, 0.09, 0.13]
    times = [0.0]
    for i in range(1, frame_count):
        times.append(round(times[-1] + gaps[(i - 1) % len(gaps)], 6))
    return times


def generate_sample(
    output_path: str,
    *,
    frame_count: int = 24,
    fps: float = 10.0,
    width: int = 320,
    height: int = 180,
    vfr: bool = False,
    frame_times: Sequence[float] | None = None,
    start_offset: float = 0.0,
    ffmpeg_bin: str | None = None,
    write_sidecar: bool = True,
) -> dict[str, Any]:
    ffmpeg = resolve_binary("ffmpeg", ffmpeg_bin)
    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    width -= width % 2
    height -= height % 2
    if width < 64 or height < 64:
        raise ValueError("sample dimensions must be at least 64x64 even pixels")

    if frame_times is None:
        times = default_frame_times(frame_count, fps=fps, vfr=vfr)
    else:
        times = [float(t) for t in frame_times]
        if len(times) != frame_count:
            raise ValueError("frame_times length must equal frame_count")
        if any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError("frame_times must be strictly increasing")

    if vfr or frame_times is not None:
        _encode_vfr_raw(
            ffmpeg, output, width, height, frame_count, times, start_offset
        )
    else:
        _encode_cfr_raw(
            ffmpeg, output, width, height, frame_count, times, fps, start_offset
        )

    metadata = {
        "schema": "thumb-pack-sample@1",
        "file": str(output),
        "width": width,
        "height": height,
        "frameCount": frame_count,
        "intendedZeroTimelinePts": times,
        "outputTsOffset": start_offset,
        "intendedRawPts": [round(t + start_offset, 6) for t in times],
        "vfr": vfr or frame_times is not None,
        "note": "Frames contain a burned zero-based index; binary corner blocks also encode it.",
    }
    if write_sidecar:
        Path(str(output) + ".frames.json").write_text(
            json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return metadata


def _encode_cfr_raw(
    ffmpeg: str,
    output: Path,
    width: int,
    height: int,
    count: int,
    times: list[float],
    fps: float,
    start_offset: float,
) -> None:
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        str(fps),
        "-i",
        "pipe:0",
    ]
    if start_offset:
        cmd.extend(["-output_ts_offset", str(start_offset)])
    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for i in range(count):
        frame = render_numbered_frame(width, height, i, count, times[i])
        proc.stdin.write(bytes(frame.pixels))
    _, err_bytes = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(err_bytes.decode("utf-8", "replace") or f"ffmpeg sample generation failed with {proc.returncode}")


def _encode_vfr_raw(
    ffmpeg: str,
    output: Path,
    width: int,
    height: int,
    count: int,
    times: list[float],
    start_offset: float,
) -> None:
    # Feed at a 1000 Hz raw timebase, then overwrite every PTS with the exact
    # requested millisecond value.  This avoids concat demuxer's repeated
    # final image and keeps decoded frame count equal to the generated count.
    pts_ms = [max(0, round(t * 1000)) for t in times]
    expression = str(pts_ms[-1])
    for i in range(count - 2, -1, -1):
        expression = f"if(eq(N\\,{i})\\,{pts_ms[i]}\\,{expression})"
    vf = f"setpts={expression}"

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        "1000",
        "-i",
        "pipe:0",
        "-vf",
        vf,
        "-fps_mode",
        "vfr",
    ]
    if start_offset:
        cmd.extend(["-output_ts_offset", str(start_offset)])
    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-bf",
            "0",
            "-video_track_timescale",
            "90000",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for i in range(count):
        frame = render_numbered_frame(width, height, i, count, times[i])
        proc.stdin.write(bytes(frame.pixels))
    _, err_bytes = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(err_bytes.decode("utf-8", "replace") or f"ffmpeg VFR sample generation failed with {proc.returncode}")
