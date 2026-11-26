"""FFmpeg operations used by the packer."""

from __future__ import annotations

import re
import subprocess

from .imagetools import ffmpeg_color


_CROP_RE = re.compile(r"crop=(\d+):(\d+):(-?\d+):(-?\d+)")


class FFmpegError(RuntimeError):
    pass


def detect_black_crop(
    video_path: str,
    ffmpeg_bin: str = "ffmpeg",
    limit: int = 24,
) -> dict[str, int] | None:
    """Return the largest stable crop suggested by cropdetect.

    The largest candidate is the least aggressive crop: it removes permanent
    bars while avoiding cropping genuinely dark scene content.
    """
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-i",
        video_path,
        "-vf",
        f"cropdetect=limit={int(limit)}:round=2:reset=0",
        "-an",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    text = proc.stderr.decode("utf-8", "replace")
    candidates: list[dict[str, int]] = []
    for match in _CROP_RE.finditer(text):
        w, h, x, y = map(int, match.groups())
        if w > 0 and h > 0:
            candidates.append({"width": w, "height": h, "x": x, "y": y})
    if not candidates:
        return None
    return max(candidates, key=lambda c: c["width"] * c["height"])


def build_frame_filter(
    frame_index: int,
    thumb_width: int,
    thumb_height: int,
    fit: str = "contain",
    letterbox_color: str = "#000000",
    crop: dict[str, int] | None = None,
) -> str:
    parts = [f"select=eq(n\\,{int(frame_index)})"]
    if crop:
        parts.append(
            "crop={w}:{h}:{x}:{y}".format(
                w=crop["width"], h=crop["height"], x=crop["x"], y=crop["y"]
            )
        )
    tw, th = int(thumb_width), int(thumb_height)
    if fit == "contain":
        color = ffmpeg_color(letterbox_color)
        parts.extend(
            [
                f"scale={tw}:{th}:force_original_aspect_ratio=decrease:flags=lanczos",
                "setsar=1",
                f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color={color}",
            ]
        )
    elif fit == "cover":
        parts.extend(
            [
                f"scale={tw}:{th}:force_original_aspect_ratio=increase:flags=lanczos",
                "setsar=1",
                f"crop={tw}:{th}",
            ]
        )
    elif fit == "stretch":
        parts.extend([f"scale={tw}:{th}:flags=lanczos", "setsar=1"])
    else:
        raise ValueError(f"unknown fit mode {fit!r}")
    parts.append("format=rgb24")
    return ",".join(parts)


def extract_processed_frame(
    video_path: str,
    frame_index: int,
    thumb_width: int,
    thumb_height: int,
    *,
    ffmpeg_bin: str = "ffmpeg",
    fit: str = "contain",
    letterbox_color: str = "#000000",
    crop: dict[str, int] | None = None,
    timeout: int | None = 120,
) -> bytes:
    vf = build_frame_filter(
        frame_index,
        thumb_width,
        thumb_height,
        fit=fit,
        letterbox_color=letterbox_color,
        crop=crop,
    )
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video_path,
        "-vf",
        vf,
        "-an",
        "-sn",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"frame {frame_index} extraction timed out") from exc
    expected = thumb_width * thumb_height * 3
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr.decode("utf-8", "replace").strip() or "ffmpeg failed")
    if len(proc.stdout) != expected:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise FFmpegError(
            f"frame {frame_index}: expected {expected} raw bytes, got {len(proc.stdout)}. {detail}"
        )
    return proc.stdout
